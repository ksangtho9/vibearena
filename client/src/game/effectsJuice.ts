import type { ElementKind } from "../types/character";
import type { CombatCtx } from "./combat";
import { pushEffect } from "./combat";
import type { Fighter } from "./stickman";
import { playSfx } from "../audio/sfx";
import { withAlpha } from "../render/color";

/**
 * SHARED effect-juice library — the single vocabulary of ability/effect
 * visuals. Every ability kind (abilities.ts), every visual engine verb
 * (engine/api.ts) and combat itself (projectile impacts, shield ripples)
 * compose these blocks instead of pushing one-off effects, so AI-authored
 * behaviors automatically look as good as the built-ins.
 *
 * Everything rides the existing Effect pipeline (pushEffect's 450 cap +
 * updateEffects ttl decay), the SFX voice caps and the element tinting —
 * these helpers only compose, they never bypass a cap. Per-call particle
 * counts are clamped so one spammy behavior can't flood the pool.
 */

const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Modest, capped screen shake — big moments only, never over-shake. */
export function shake(ctx: CombatCtx, amp: number, duration: number): void {
  ctx.shakeAmp = Math.max(ctx.shakeAmp, cl(amp, 0, 11));
  ctx.shakeTimer = Math.max(ctx.shakeTimer, cl(duration, 0, 0.5));
}

/** Subtle full-screen color wash (reuses the loop's flash overlay). */
export function fieldTint(ctx: CombatCtx, color: string, ttl = 0.4): void {
  // flashMax is scaled up so the overlay alpha stays LOW (wash, not flash).
  ctx.flashColor = color;
  ctx.flashMax = Math.max(ctx.flashMax, ttl * 3);
  ctx.flashTimer = Math.max(ctx.flashTimer, ttl);
}

export interface RingOpts {
  radius?: number;
  color?: string;
  thickness?: number;
  expand?: number;
  ttl?: number;
}

/** Expanding glowing ring — THE impact silhouette. */
export function shockwaveRing(ctx: CombatCtx, x: number, y: number, o: RingOpts = {}): void {
  pushEffect(ctx, {
    kind: "ring",
    x,
    y,
    ttl: o.ttl ?? 0.4,
    color: o.color ?? "#ffe6a3",
    radius: o.radius ?? 14,
    expand: o.expand ?? 260,
    width: o.thickness ?? 4,
  });
}

export interface BurstOpts {
  count?: number;
  color?: string;
  speed?: number;
  /** Arc width in radians (2π = full radial). */
  spread?: number;
  baseAngle?: number;
  gravity?: number;
  size?: number;
  shape?: "circle" | "square" | "spark" | "star";
  ttl?: number;
}

/** Radial (or fanned) particle burst. */
export function particleBurst(ctx: CombatCtx, x: number, y: number, o: BurstOpts = {}): void {
  const count = cl(Math.round(o.count ?? 10), 1, 24);
  const spread = o.spread ?? Math.PI * 2;
  const base = o.baseAngle ?? -Math.PI / 2;
  const speed = o.speed ?? 160;
  for (let i = 0; i < count; i++) {
    const a = base + (i / count - 0.5) * spread + (Math.random() - 0.5) * 0.25;
    const v = speed * (0.55 + Math.random() * 0.7);
    pushEffect(ctx, {
      kind: "particle",
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      gravity: o.gravity ?? 220,
      size: o.size ?? 3.5,
      particleShape: o.shape ?? "spark",
      color: o.color ?? "#ffe6a3",
      ttl: (o.ttl ?? 0.45) * (0.7 + Math.random() * 0.5),
    });
  }
}

/** Upward-drifting sparkles (heals, buffs, blessings). */
export function risingMotes(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { count?: number; color?: string; ttl?: number } = {},
): void {
  const count = cl(Math.round(o.count ?? 6), 1, 14);
  for (let i = 0; i < count; i++) {
    pushEffect(ctx, {
      kind: "particle",
      x: x + (Math.random() - 0.5) * 34,
      y: y + (Math.random() - 0.5) * 30,
      vx: (Math.random() - 0.5) * 16,
      vy: -40 - Math.random() * 45,
      gravity: -18, // accelerate gently upward
      size: 2.5 + Math.random() * 1.5,
      particleShape: Math.random() < 0.4 ? "star" : "circle",
      color: o.color ?? "#8fd18a",
      ttl: (o.ttl ?? 0.8) * (0.7 + Math.random() * 0.6),
    });
  }
}

/** One pulse of body-hugging glow — emit periodically for a sustained aura. */
export function auraGlow(
  ctx: CombatCtx,
  f: Fighter,
  o: { color?: string; ttl?: number; radius?: number } = {},
): void {
  const { x, y } = f.root.position;
  pushEffect(ctx, {
    kind: "ring",
    x,
    y: y - 20 * f.scale,
    ttl: o.ttl ?? 0.35,
    color: withAlpha(o.color ?? f.style.glow, 0.75),
    radius: o.radius ?? 34 * f.scale,
    expand: 26,
    width: 2.5,
  });
}

/** Persistent flat mark under AoEs and hazards. */
export function groundDecal(
  ctx: CombatCtx,
  x: number,
  groundY: number,
  o: { kind?: "scorch" | "frost" | "crack"; color?: string; radius?: number; ttl?: number } = {},
): void {
  pushEffect(ctx, {
    kind: "decal",
    x,
    y: groundY,
    ttl: o.ttl ?? 2.6,
    color: o.color ?? "#2a2118",
    radius: o.radius ?? 46,
    decalKind: o.kind ?? "scorch",
  });
}

/** Inward-converging particles — a wind-up that telegraphs a payoff. */
export function chargeUp(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { color?: string; count?: number; radius?: number; ttl?: number } = {},
): void {
  const count = cl(Math.round(o.count ?? 8), 1, 16);
  const radius = o.radius ?? 46;
  const ttl = o.ttl ?? 0.22;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const r = radius * (0.8 + Math.random() * 0.5);
    pushEffect(ctx, {
      kind: "particle",
      x: x + Math.cos(a) * r,
      y: y + Math.sin(a) * r,
      vx: (-Math.cos(a) * r) / ttl,
      vy: (-Math.sin(a) * r) / ttl,
      gravity: 0,
      size: 2.5,
      particleShape: "spark",
      color: o.color ?? "#ffe6a3",
      ttl,
    });
  }
}

/** Short sharp sparks at a hit point. */
export function impactSparks(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { color?: string; count?: number } = {},
): void {
  particleBurst(ctx, x, y, {
    count: o.count ?? 6,
    color: o.color,
    speed: 220,
    gravity: 320,
    size: 2.5,
    shape: "spark",
    ttl: 0.25,
  });
  pushEffect(ctx, { kind: "spark", x, y, ttl: 0.2, color: o.color ?? "#ffe6a3", radius: 10 });
}

/** Wobbled expanding shockwave (NOT a clean circle) — aoe/impact. */
export function shockwave(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { radius?: number; expand?: number; color?: string; thickness?: number; ttl?: number } = {},
): void {
  pushEffect(ctx, {
    kind: "shockwave",
    x,
    y,
    ttl: o.ttl ?? 0.4,
    color: o.color ?? "#ffe6a3",
    radius: o.radius ?? 14,
    expand: o.expand ?? 260,
    width: o.thickness ?? 5,
    seed: (x * 13 + y * 7) % 97,
  });
}

/** Jagged branching lightning between two points. */
export function lightningArc(
  ctx: CombatCtx,
  from: { x: number; y: number },
  to: { x: number; y: number },
  o: { color?: string; width?: number; ttl?: number } = {},
): void {
  pushEffect(ctx, {
    kind: "lightning",
    x: from.x,
    y: from.y,
    x2: to.x,
    y2: to.y,
    ttl: o.ttl ?? 0.22,
    color: o.color ?? "#9be8ff",
    width: o.width ?? 2.5,
    seed: (from.x + to.y) % 89,
  });
}

/** Crescent swipe, thick-to-thin, oriented by angle. */
export function slashArc(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { radius?: number; angle?: number; spread?: number; color?: string; width?: number; ttl?: number } = {},
): void {
  const angle = o.angle ?? 0;
  const spread = cl(o.spread ?? 1.4, 0.3, Math.PI * 1.6);
  pushEffect(ctx, {
    kind: "slasharc",
    x,
    y,
    ttl: o.ttl ?? 0.22,
    color: o.color ?? "#f2f0e4",
    radius: o.radius ?? 42,
    a0: angle - spread / 2,
    a1: angle + spread / 2,
    width: o.width ?? 10,
  });
}

/** Angular rotating debris (ice/earth/shatter). */
export function shardBurst(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { count?: number; color?: string; speed?: number; ttl?: number } = {},
): void {
  const count = cl(Math.round(o.count ?? 8), 1, 16);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const v = (o.speed ?? 150) * (0.5 + Math.random() * 0.8);
    pushEffect(ctx, {
      kind: "particle",
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 40,
      gravity: 340,
      size: 3 + Math.random() * 2.5,
      particleShape: "shard",
      color: o.color ?? "#bfe8f2",
      ttl: (o.ttl ?? 0.5) * (0.7 + Math.random() * 0.6),
      seed: Math.floor(Math.random() * 97),
    });
  }
}

/** Radial spike-line impact pop with a quick bloom (no filled disc). */
export function impactFlash(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { color?: string; radius?: number; ttl?: number } = {},
): void {
  pushEffect(ctx, {
    kind: "flash",
    x,
    y,
    ttl: o.ttl ?? 0.18,
    color: o.color ?? "#ffffff",
    radius: o.radius ?? 18,
    seed: (x + y) % 83,
  });
}

/** Soft glow column rising from a point (heals, blessings). */
export function glowColumn(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { color?: string; height?: number; ttl?: number } = {},
): void {
  const h = o.height ?? 70;
  const color = o.color ?? "#8fd18a";
  pushEffect(ctx, { kind: "shape", shape: "line", x, y, x2: x, y2: y - h, color: withAlpha(color, 0.28), width: 16, ttl: o.ttl ?? 0.5 });
  pushEffect(ctx, { kind: "shape", shape: "line", x, y, x2: x, y2: y - h * 0.8, color: withAlpha(color, 0.5), width: 6, ttl: o.ttl ?? 0.5 });
}

/** Orbiting aura particles around a body (buffs). */
export function orbitMotes(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { count?: number; color?: string; radius?: number; ttl?: number } = {},
): void {
  const count = cl(Math.round(o.count ?? 6), 1, 12);
  const radius = o.radius ?? 26;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pushEffect(ctx, {
      kind: "particle",
      x: x + Math.cos(a) * radius,
      y: y + Math.sin(a) * radius * 0.6,
      vx: -Math.sin(a) * 70,
      vy: Math.cos(a) * 42 - 14,
      gravity: 0,
      size: 2.6,
      particleShape: "star",
      color: o.color ?? "#ffe6a3",
      ttl: (o.ttl ?? 0.55) * (0.8 + Math.random() * 0.4),
    });
  }
}

/**
 * Element garnish — the flavor layer that kills the circle monoculture:
 * fire embers, ice shards, lightning arcs, holy rays, void tendrils.
 */
export function elementGarnish(
  ctx: CombatCtx,
  x: number,
  y: number,
  element: ElementKind | undefined,
  radius: number,
  color: string,
): void {
  switch (element) {
    case "fire":
      particleBurst(ctx, x, y, { count: 8, color: "#ff8c1a", speed: radius * 1.4, gravity: -120, shape: "spark", ttl: 0.55 });
      break;
    case "ice":
      shardBurst(ctx, x, y, { count: 9, color: "#bfe8f2", speed: radius * 1.6 });
      break;
    case "lightning": {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        lightningArc(ctx, { x, y }, { x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius * 0.8 }, { color });
      }
      break;
    }
    case "holy":
      impactFlash(ctx, x, y, { color: "#fff3c4", radius: radius * 0.5, ttl: 0.25 });
      risingMotes(ctx, x, y, { count: 7, color: "#ffe6a3", ttl: 0.8 });
      break;
    case "shadow":
      vortex(ctx, x, y, { color: "#5a3d8a", radius, dir: 1, count: 9 });
      break;
    case "poison":
      particleBurst(ctx, x, y, { count: 8, color: "#8fd18a", speed: radius, gravity: -40, shape: "circle", ttl: 0.6 });
      break;
    case "arcane":
      orbitMotes(ctx, x, y, { count: 7, color, radius: radius * 0.55 });
      break;
    default:
      shardBurst(ctx, x, y, { count: 6, color, speed: radius * 1.3 });
      break;
  }
}

/** Something appearing out of nothing (entity spawns, phase onsets). */
export function materialize(ctx: CombatCtx, x: number, y: number, o: { color?: string } = {}): void {
  const color = o.color ?? "#e8e2ff";
  shockwaveRing(ctx, x, y, { color, radius: 8, expand: 150, thickness: 2.5, ttl: 0.3 });
  chargeUp(ctx, x, y, { color, count: 6, radius: 34, ttl: 0.18 });
  risingMotes(ctx, x, y, { count: 4, color, ttl: 0.5 });
}

/** Swirling suction (void zones, pulls). dir=1 inward, -1 outward. */
export function vortex(
  ctx: CombatCtx,
  x: number,
  y: number,
  o: { color?: string; radius?: number; dir?: 1 | -1; count?: number } = {},
): void {
  const count = cl(Math.round(o.count ?? 7), 1, 14);
  const radius = o.radius ?? 52;
  const dir = o.dir ?? 1;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const r = radius * (0.6 + Math.random() * 0.6);
    // Tangential + radial velocity → visible swirl.
    const tangent = a + (Math.PI / 2) * dir;
    pushEffect(ctx, {
      kind: "particle",
      x: x + Math.cos(a) * r,
      y: y + Math.sin(a) * r,
      vx: Math.cos(tangent) * 90 - Math.cos(a) * 70 * dir,
      vy: Math.sin(tangent) * 90 - Math.sin(a) * 70 * dir,
      gravity: 0,
      size: 2.5,
      particleShape: "circle",
      color: o.color ?? "#9257e8",
      ttl: 0.4,
    });
  }
}

/** Bright beam core + soft outer glow between two points (one frame slice —
 * the beam entity re-emits while sustained). */
export function beamCore(
  ctx: CombatCtx,
  from: { x: number; y: number },
  to: { x: number; y: number },
  o: { color?: string; width?: number; ttl?: number } = {},
): void {
  const color = o.color ?? "#ff5a5a";
  const w = o.width ?? 10;
  pushEffect(ctx, { kind: "shape", shape: "line", x: from.x, y: from.y, x2: to.x, y2: to.y, color: withAlpha(color, 0.4), width: w * 2.2, ttl: o.ttl ?? 0.08 });
  pushEffect(ctx, { kind: "shape", shape: "line", x: from.x, y: from.y, x2: to.x, y2: to.y, color: "#ffffff", width: w * 0.45, ttl: o.ttl ?? 0.08 });
}

/**
 * The full AoE detonation package: shockwave + radial debris + scorch +
 * shake + boom, all scaled by radius so small pulses stay small.
 */
export function aoeDetonation(
  ctx: CombatCtx,
  x: number,
  y: number,
  radius: number,
  color: string,
  groundY: number,
  element?: ElementKind,
): void {
  const k = cl(radius / 120, 0.35, 1.6);
  shockwave(ctx, x, y, { color, radius: 12, expand: radius * 2.6, thickness: 5 * k + 2, ttl: 0.4 });
  impactFlash(ctx, x, y, { color: "#ffffff", radius: radius * 0.5, ttl: 0.16 });
  particleBurst(ctx, x, y, { count: Math.round(8 * k), color, speed: radius * 1.7, gravity: 260, ttl: 0.4 });
  elementGarnish(ctx, x, y, element, radius * 0.8, color);
  if (Math.abs(groundY - y) < radius + 40) {
    groundDecal(ctx, x, groundY - 2, { kind: "scorch", radius: radius * 0.7, ttl: 2.4 });
  }
  shake(ctx, 4 + 5 * k, 0.22 + 0.1 * k);
  playSfx("explosion", { volume: cl(0.4 + 0.5 * k, 0, 1), pitch: cl(1.25 - 0.35 * k, 0.5, 2), element });
}
