import type { ElementKind } from "../types/character";

/**
 * Procedural SFX engine — every sound is synthesized live from oscillators
 * and filtered noise through a master gain; there are no audio files.
 *
 * Safety rails:
 * - AudioContext is created lazily and resumed on the FIRST trusted user
 *   gesture (autoplay policy). Until then playSfx is a silent no-op — it
 *   never throws and never console-spams.
 * - Voice cap (~16 concurrent) + per-kind retrigger throttle (~30ms), so a
 *   particle storm or a spammy behavior can't machine-gun the mixer.
 * - Mute + volume persist to localStorage and act on the master gain.
 */

export type SfxKind =
  | "hit" | "hitHeavy" | "swing" | "cast" | "projectile" | "explosion"
  | "zap" | "heal" | "block" | "parry" | "guardBreak" | "jump" | "ko"
  | "uiClick" | "generate" | "win" | "lose";

export const SFX_KINDS: SfxKind[] = [
  "hit", "hitHeavy", "swing", "cast", "projectile", "explosion", "zap",
  "heal", "block", "parry", "guardBreak", "jump", "ko", "uiClick",
  "generate", "win", "lose",
];

export interface SfxOpts {
  /** Playback pitch multiplier (0.5–2). */
  pitch?: number;
  /** Per-sound volume (0–1). */
  volume?: number;
  /** Tints the timbre of hits/casts (fire crackles, ice rings, zap bites). */
  element?: ElementKind;
}

const VOICE_CAP = 16;
const RETRIGGER_MS = 30;
const MUTE_KEY = "vibearena-muted";
const VOLUME_KEY = "vibearena-volume";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let voices = 0;
const lastTrigger = new Map<SfxKind, number>();

let muted = false;
let volume = 0.8;

function loadPrefs(): void {
  try {
    muted = localStorage.getItem(MUTE_KEY) === "1";
    const v = Number(localStorage.getItem(VOLUME_KEY));
    if (Number.isFinite(v) && v > 0 && v <= 1) volume = v;
  } catch {
    /* storage unavailable — defaults stand */
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null; // node (tests/smoke)
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    loadPrefs();
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    // White-noise source material, shared by every burst.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      // Dev-only handle for debugging/verification (never in prod builds).
      (window as unknown as Record<string, unknown>).__sfx = {
        ctx: () => ctx,
        master: () => master,
        voices: () => voices,
        play: playSfx,
        setMuted,
      };
    }
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Install one-time unlock listeners: the first trusted click/keypress
 * resumes the (autoplay-suspended) context. Call once at app start.
 */
export function initAudio(): void {
  if (typeof window === "undefined") return;
  const unlock = () => {
    const c = ensureCtx();
    if (c && c.state === "suspended") {
      c.resume().catch(() => {
        /* still blocked — the next gesture will retry via the game's calls */
      });
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

export function isMuted(): boolean {
  if (ctx === null) loadPrefs();
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* fine */
  }
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : volume, ctx.currentTime, 0.01);
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* fine */
  }
  if (master && ctx && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
}

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  /** Glide target frequency (exponential ramp over the duration). */
  freq2?: number;
  dur: number;
  vol?: number;
  delay?: number;
  /** Optional lowpass/bandpass/highpass on this tone. */
  filter?: { type: BiquadFilterType; freq: number };
}

function tone(spec: ToneSpec): void {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + (spec.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = spec.type ?? "sine";
  osc.frequency.setValueAtTime(Math.max(20, spec.freq), t0);
  if (spec.freq2) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.freq2), t0 + spec.dur);
  }
  const g = ctx.createGain();
  const v = spec.vol ?? 0.5;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(v, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
  let head: AudioNode = osc;
  if (spec.filter) {
    const f = ctx.createBiquadFilter();
    f.type = spec.filter.type;
    f.frequency.value = spec.filter.freq;
    head.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + spec.dur + 0.02);
}

interface BurstSpec {
  dur: number;
  vol?: number;
  delay?: number;
  filterType?: BiquadFilterType;
  freq?: number;
  /** Filter glide target. */
  freq2?: number;
  q?: number;
}

function burst(spec: BurstSpec): void {
  if (!ctx || !master || !noiseBuffer) return;
  const t0 = ctx.currentTime + (spec.delay ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = spec.filterType ?? "lowpass";
  f.frequency.setValueAtTime(spec.freq ?? 1200, t0);
  if (spec.freq2) f.frequency.exponentialRampToValueAtTime(Math.max(40, spec.freq2), t0 + spec.dur);
  f.Q.value = spec.q ?? 0.8;
  const g = ctx.createGain();
  const v = spec.vol ?? 0.35;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(v, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0, Math.random());
  src.stop(t0 + spec.dur + 0.02);
}

/** A small extra layer that tints hits/casts by element. */
function elementLayer(element: ElementKind | undefined, k: number, vol: number): void {
  switch (element) {
    case "fire":
      burst({ dur: 0.22, vol: vol * 0.5, filterType: "bandpass", freq: 900 * k, freq2: 300 * k, q: 1.4 });
      break;
    case "ice":
      tone({ type: "triangle", freq: 1900 * k, freq2: 2600 * k, dur: 0.12, vol: vol * 0.4 });
      break;
    case "lightning":
      tone({ type: "sawtooth", freq: 1400 * k, freq2: 180 * k, dur: 0.09, vol: vol * 0.45 });
      burst({ dur: 0.06, vol: vol * 0.35, filterType: "highpass", freq: 2500 });
      break;
    case "poison":
      tone({ type: "sine", freq: 300 * k, freq2: 420 * k, dur: 0.2, vol: vol * 0.4 });
      tone({ type: "sine", freq: 460 * k, freq2: 330 * k, dur: 0.2, vol: vol * 0.3, delay: 0.05 });
      break;
    case "shadow":
      tone({ type: "sawtooth", freq: 130 * k, freq2: 70 * k, dur: 0.25, vol: vol * 0.4, filter: { type: "lowpass", freq: 500 } });
      break;
    case "holy":
      tone({ type: "sine", freq: 880 * k, dur: 0.25, vol: vol * 0.35 });
      tone({ type: "sine", freq: 1320 * k, dur: 0.25, vol: vol * 0.25 });
      break;
    case "arcane":
      tone({ type: "triangle", freq: 620 * k, freq2: 950 * k, dur: 0.18, vol: vol * 0.35 });
      tone({ type: "triangle", freq: 633 * k, freq2: 970 * k, dur: 0.18, vol: vol * 0.25 });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// The public trigger
// ---------------------------------------------------------------------------

export function playSfx(kind: SfxKind, opts: SfxOpts = {}): void {
  try {
    const c = ensureCtx();
    if (!c || c.state !== "running" || !master) return; // blocked/locked: silent no-op
    if (muted) return;

    // Anti-spam: per-kind retrigger throttle + global voice cap.
    const now = performance.now();
    if (now - (lastTrigger.get(kind) ?? -1e9) < RETRIGGER_MS) return;
    lastTrigger.set(kind, now);
    if (voices >= VOICE_CAP) return;
    voices++;
    setTimeout(() => {
      voices = Math.max(0, voices - 1);
    }, 700);

    const k = Math.max(0.5, Math.min(2, opts.pitch ?? 1));
    const v = Math.max(0, Math.min(1, opts.volume ?? 1));

    switch (kind) {
      case "hit":
        tone({ type: "sine", freq: 160 * k, freq2: 70 * k, dur: 0.09, vol: 0.55 * v });
        burst({ dur: 0.05, vol: 0.3 * v, filterType: "bandpass", freq: 1800 * k, q: 0.7 });
        elementLayer(opts.element, k, 0.5 * v);
        break;
      case "hitHeavy":
        tone({ type: "sine", freq: 120 * k, freq2: 45 * k, dur: 0.22, vol: 0.7 * v });
        tone({ type: "sawtooth", freq: 90 * k, freq2: 50 * k, dur: 0.12, vol: 0.25 * v, filter: { type: "lowpass", freq: 600 } });
        burst({ dur: 0.12, vol: 0.4 * v, filterType: "lowpass", freq: 2500 * k, freq2: 300 });
        elementLayer(opts.element, k, 0.6 * v);
        break;
      case "swing":
        burst({ dur: 0.13, vol: 0.28 * v, filterType: "bandpass", freq: 500 * k, freq2: 1600 * k, q: 1.6 });
        break;
      case "cast":
        tone({ type: "triangle", freq: 420 * k, freq2: 900 * k, dur: 0.18, vol: 0.35 * v });
        tone({ type: "sine", freq: 630 * k, freq2: 1250 * k, dur: 0.2, vol: 0.25 * v, delay: 0.03 });
        elementLayer(opts.element, k, 0.5 * v);
        break;
      case "projectile":
        tone({ type: "square", freq: 900 * k, freq2: 320 * k, dur: 0.09, vol: 0.22 * v });
        break;
      case "explosion":
        tone({ type: "sine", freq: 110 * k, freq2: 40 * k, dur: 0.4, vol: 0.6 * v });
        burst({ dur: 0.38, vol: 0.5 * v, filterType: "lowpass", freq: 3000 * k, freq2: 200 });
        break;
      case "zap":
        tone({ type: "sawtooth", freq: 1500 * k, freq2: 160 * k, dur: 0.11, vol: 0.4 * v });
        burst({ dur: 0.08, vol: 0.3 * v, filterType: "highpass", freq: 2200 });
        break;
      case "heal":
        tone({ type: "triangle", freq: 520 * k, dur: 0.12, vol: 0.3 * v });
        tone({ type: "triangle", freq: 660 * k, dur: 0.12, vol: 0.3 * v, delay: 0.09 });
        tone({ type: "triangle", freq: 780 * k, dur: 0.18, vol: 0.3 * v, delay: 0.18 });
        break;
      case "block":
        tone({ type: "triangle", freq: 820 * k, freq2: 640 * k, dur: 0.07, vol: 0.4 * v });
        burst({ dur: 0.05, vol: 0.28 * v, filterType: "highpass", freq: 1800 });
        break;
      case "parry":
        tone({ type: "sine", freq: 1250 * k, freq2: 1900 * k, dur: 0.14, vol: 0.42 * v });
        burst({ dur: 0.09, vol: 0.22 * v, filterType: "highpass", freq: 3200 });
        break;
      case "guardBreak":
        tone({ type: "sawtooth", freq: 320 * k, freq2: 70 * k, dur: 0.32, vol: 0.5 * v, filter: { type: "lowpass", freq: 900 } });
        burst({ dur: 0.25, vol: 0.45 * v, filterType: "lowpass", freq: 2600, freq2: 250 });
        break;
      case "jump":
        tone({ type: "sine", freq: 260 * k, freq2: 520 * k, dur: 0.1, vol: 0.22 * v });
        break;
      case "ko":
        tone({ type: "sine", freq: 150 * k, freq2: 42 * k, dur: 0.55, vol: 0.7 * v });
        tone({ type: "sawtooth", freq: 220 * k, freq2: 55 * k, dur: 0.5, vol: 0.22 * v, filter: { type: "lowpass", freq: 700 } });
        burst({ dur: 0.3, vol: 0.45 * v, filterType: "lowpass", freq: 2800, freq2: 180 });
        break;
      case "uiClick":
        tone({ type: "sine", freq: 950 * k, dur: 0.035, vol: 0.18 * v });
        break;
      case "generate":
        tone({ type: "triangle", freq: 330 * k, freq2: 990 * k, dur: 0.3, vol: 0.3 * v });
        tone({ type: "sine", freq: 1320 * k, dur: 0.08, vol: 0.2 * v, delay: 0.22 });
        tone({ type: "sine", freq: 1760 * k, dur: 0.1, vol: 0.2 * v, delay: 0.3 });
        break;
      case "win":
        tone({ type: "triangle", freq: 523 * k, dur: 0.14, vol: 0.35 * v });
        tone({ type: "triangle", freq: 659 * k, dur: 0.14, vol: 0.35 * v, delay: 0.12 });
        tone({ type: "triangle", freq: 784 * k, dur: 0.3, vol: 0.4 * v, delay: 0.24 });
        break;
      case "lose":
        tone({ type: "triangle", freq: 392 * k, dur: 0.18, vol: 0.35 * v });
        tone({ type: "triangle", freq: 330 * k, dur: 0.18, vol: 0.35 * v, delay: 0.16 });
        tone({ type: "triangle", freq: 262 * k, dur: 0.35, vol: 0.4 * v, delay: 0.32 });
        break;
    }
  } catch {
    // Audio must never break the game.
  }
}
