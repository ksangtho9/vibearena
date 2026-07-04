import type { ElementKind, WeaponForm, WeaponSize } from "../../types/character";
import { mix, shade, withAlpha } from "../../render/color";

/**
 * PARAMETRIC weapon renderer. Every weapon is drawn from primitives (haft,
 * blade, head, string…) selected by `form` and modulated by size / curve /
 * spikes / doubleEnded, with element-driven FX layered on top — so a hammer
 * looks like a hammer, a scythe like a scythe, and two swords still differ.
 *
 * Local space: the GRIP sits at the origin and the business end points along
 * +X. Dimensions are for a medium weapon at fighter scale 1; `size` scales
 * the DRAWING only — mechanical reach always comes from the balanced
 * weapon.range in combat.ts, never from here.
 */

export interface WeaponRenderStyle {
  form: WeaponForm;
  size: WeaponSize;
  curve: number; // 0–1
  spikes: number; // 0–4
  doubleEnded: boolean;
  element: ElementKind;
  /** Fighter body color — ties wood/leather parts to the character. */
  fill: string;
  accent: string;
  glow: string;
  outline: string;
}

const SIZE_SCALE: Record<WeaponSize, number> = { small: 0.8, medium: 1, large: 1.3 };

/** Visual tip length (for trails/FX placement) — NOT the hitbox reach. */
const TIP: Record<WeaponForm, number> = {
  sword: 46, greatsword: 60, dagger: 26, axe: 36, hammer: 34, spear: 62,
  halberd: 62, scythe: 52, whip: 56, flail: 42, staff: 46, bow: 26, gun: 32,
  orb: 14, shield: 16, claw: 22, chakram: 22, bomb: 16,
};

export function weaponTipLength(form: WeaponForm, size: WeaponSize): number {
  return TIP[form] * SIZE_SCALE[size];
}

/** Orbs hover beside the hand instead of rotating with the arm. */
export function weaponIsFloating(form: WeaponForm): boolean {
  return form === "orb";
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

interface Palette {
  metal: string;
  metalEdge: string;
  haft: string;
  dark: string;
}

function paletteOf(s: WeaponRenderStyle): Palette {
  let metal = mix("#ccd3de", s.accent, 0.3);
  if (s.element !== "none") metal = mix(metal, s.glow, 0.18);
  return {
    metal,
    metalEdge: mix("#f0f4fa", s.glow, 0.35),
    haft: mix("#7a5a3c", s.fill, 0.25),
    dark: mix("#3a3f4a", s.accent, 0.3),
  };
}

function strokedFill(ctx: CanvasRenderingContext2D, fill: string, outline: string): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.1;
  ctx.stroke();
}

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function glowOn(ctx: CanvasRenderingContext2D, s: WeaponRenderStyle, blur = 10): void {
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = blur;
}

function glowOff(ctx: CanvasRenderingContext2D): void {
  ctx.shadowBlur = 0;
}

/** A shaft from x0 to x1, bent by `curve`, with a thin outline. */
function haft(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  thick: number,
  color: string,
  outline: string,
  curve = 0,
): void {
  const bend = -curve * (x1 - x0) * 0.16;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.quadraticCurveTo((x0 + x1) / 2, bend, x1, 0);
  };
  ctx.lineCap = "round";
  ctx.strokeStyle = outline;
  ctx.lineWidth = thick + 1.8;
  trace();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = thick;
  trace();
  ctx.stroke();
}

/** Tapered blade from x0, length len, bending up by curve. */
function blade(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  x0: number,
  len: number,
  width: number,
): void {
  const w2 = width / 2;
  const tipX = x0 + len;
  const tipY = -s.curve * len * 0.32;
  glowOn(ctx, s, s.element !== "none" ? 12 : 8);
  ctx.beginPath();
  ctx.moveTo(x0, -w2);
  ctx.quadraticCurveTo(x0 + len * 0.55, -w2 - s.curve * len * 0.24, tipX, tipY);
  ctx.quadraticCurveTo(x0 + len * 0.55, w2 * 0.85 - s.curve * len * 0.1, x0, w2);
  ctx.closePath();
  strokedFill(ctx, p.metal, s.outline);
  glowOff(ctx);
  // Edge highlight along the spine.
  ctx.strokeStyle = withAlpha(p.metalEdge, 0.85);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x0 + 1, -w2 + 0.8);
  ctx.quadraticCurveTo(x0 + len * 0.55, -w2 - s.curve * len * 0.24 + 1, tipX - 1, tipY + 0.5);
  ctx.stroke();
  // Back-edge barbs.
  spikeRow(ctx, s, p, x0 + len * 0.25, -w2 - s.curve * len * 0.1, x0 + len * 0.75, -w2 - s.curve * len * 0.22, -1);
}

/** Up to `s.spikes` small triangles along a line segment. */
function spikeRow(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  side: 1 | -1,
): void {
  if (s.spikes <= 0) return;
  const n = Math.min(4, s.spikes);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    poly(ctx, [[x - 2.2, y], [x + 2.2, y], [x, y + side * 5]]);
    strokedFill(ctx, p.metal, s.outline);
  }
}

/** Spikes radiating from a circle (flail ball, bomb studs, chakram teeth). */
function radialSpikes(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  cx: number,
  cy: number,
  r: number,
  count: number,
  len = 4,
): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    poly(ctx, [
      [cx + ux * r - uy * 1.8, cy + uy * r + ux * 1.8],
      [cx + ux * r + uy * 1.8, cy + uy * r - ux * 1.8],
      [cx + ux * (r + len), cy + uy * (r + len)],
    ]);
    strokedFill(ctx, p.metal, s.outline);
  }
}

function focusOrb(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  cx: number,
  cy: number,
  r: number,
  time: number,
): void {
  const pulse = 0.7 + 0.3 * Math.sin(time * 4);
  ctx.strokeStyle = withAlpha(s.glow, 0.35 * pulse);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3.5 + pulse * 1.5, 0, Math.PI * 2);
  ctx.stroke();
  glowOn(ctx, s, 14);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  strokedFill(ctx, mix(s.glow, "#ffffff", 0.25), s.outline);
  glowOff(ctx);
  ctx.fillStyle = withAlpha("#ffffff", 0.7);
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  if (s.spikes > 0) radialSpikes(ctx, s, p, cx, cy, r + 1, Math.min(4, s.spikes) + 2, 3.5);
}

/** Deterministic pseudo-random in [0,1). */
const hash = (n: number) => {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
};

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

type FormDrawer = (
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  time: number,
) => void;

const FORMS: Record<WeaponForm, FormDrawer> = {
  sword(ctx, s, p) {
    if (!s.doubleEnded) {
      ctx.beginPath();
      ctx.arc(-11, 0, 2.6, 0, Math.PI * 2);
      strokedFill(ctx, s.accent, s.outline);
    }
    haft(ctx, -9, 0, 3, p.dark, s.outline);
    ctx.beginPath();
    ctx.roundRect(2, -8, 4, 16, 2);
    strokedFill(ctx, s.accent, s.outline);
    blade(ctx, s, p, 6, 38, 7);
    if (s.doubleEnded) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.beginPath();
      ctx.roundRect(2, -8, 4, 16, 2);
      strokedFill(ctx, s.accent, s.outline);
      blade(ctx, s, p, 6, 32, 6);
      ctx.restore();
    }
  },

  greatsword(ctx, s, p) {
    ctx.beginPath();
    ctx.arc(-16, 0, 3.2, 0, Math.PI * 2);
    strokedFill(ctx, s.accent, s.outline);
    haft(ctx, -15, 0, 3.6, p.dark, s.outline);
    ctx.beginPath();
    ctx.roundRect(2, -11, 5, 22, 2);
    strokedFill(ctx, s.accent, s.outline);
    blade(ctx, s, p, 7, 51, 10);
    ctx.strokeStyle = withAlpha(s.glow, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(52, -s.curve * 14);
    ctx.stroke();
  },

  dagger(ctx, s, p) {
    haft(ctx, -8, 0, 2.6, p.dark, s.outline);
    ctx.beginPath();
    ctx.roundRect(0.5, -5, 3, 10, 1.5);
    strokedFill(ctx, s.accent, s.outline);
    blade(ctx, s, p, 4, 21, 5);
    if (s.doubleEnded) {
      ctx.save();
      ctx.scale(-1, 1);
      blade(ctx, s, p, 4, 18, 4.5);
      ctx.restore();
    }
  },

  axe(ctx, s, p) {
    haft(ctx, -12, 30, 3.4, p.haft, s.outline, s.curve);
    const head = (dir: 1 | -1) => {
      glowOn(ctx, s, 8);
      ctx.beginPath();
      ctx.moveTo(24, dir * -3);
      ctx.quadraticCurveTo(31 + s.curve * 4, dir * -16, 40, dir * -13);
      ctx.quadraticCurveTo(38, dir * -4, 38, dir * 4);
      ctx.quadraticCurveTo(31, dir * 2, 24, dir * 3);
      ctx.closePath();
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
    };
    head(1);
    if (s.doubleEnded) {
      ctx.save();
      ctx.translate(48, 0);
      ctx.scale(-1, 1);
      ctx.translate(-14, 0);
      head(1);
      ctx.restore();
    }
    if (s.spikes > 0) {
      poly(ctx, [[30, -2.5], [30, 2.5], [30 + 4 + s.spikes * 2, 0]]);
      strokedFill(ctx, p.metal, s.outline);
    }
  },

  hammer(ctx, s, p) {
    haft(ctx, -12, 26, 3.4, p.haft, s.outline, s.curve);
    glowOn(ctx, s, 8);
    ctx.beginPath();
    ctx.roundRect(22, -13, 13, 26, 2.5);
    strokedFill(ctx, p.metal, s.outline);
    glowOff(ctx);
    // Banding + face highlight.
    ctx.strokeStyle = withAlpha(s.outline, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(25.5, -13);
    ctx.lineTo(25.5, 13);
    ctx.moveTo(31.5, -13);
    ctx.lineTo(31.5, 13);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(p.metalEdge, 0.85);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(23.5, -12);
    ctx.lineTo(33.5, -12);
    ctx.stroke();
    // Striking-face studs.
    if (s.spikes > 0) {
      const n = Math.min(4, s.spikes);
      for (let i = 0; i < n; i++) {
        const x = 24.5 + (i * 9) / Math.max(1, n - 1);
        poly(ctx, [[x - 2, -13], [x + 2, -13], [x, -18]]);
        strokedFill(ctx, p.metal, s.outline);
      }
    }
    if (s.doubleEnded) {
      poly(ctx, [[22, -6], [22, 6], [12, 0]]);
      strokedFill(ctx, p.metal, s.outline);
    }
  },

  spear(ctx, s, p) {
    haft(ctx, -16, 46, 3, p.haft, s.outline, s.curve * 0.5);
    ctx.fillStyle = s.accent;
    ctx.fillRect(40, -2.6, 2.4, 5.2);
    ctx.fillRect(44, -2.6, 2.4, 5.2);
    glowOn(ctx, s, 10);
    poly(ctx, [[46, 0], [51, -4.6], [62, 0], [51, 4.6]]);
    strokedFill(ctx, p.metal, s.outline);
    glowOff(ctx);
    spikeRow(ctx, s, p, 47, -3, 51, -4, -1);
    if (s.doubleEnded) {
      poly(ctx, [[-16, -2.6], [-16, 2.6], [-25, 0]]);
      strokedFill(ctx, p.metal, s.outline);
    }
  },

  halberd(ctx, s, p) {
    haft(ctx, -16, 48, 3.2, p.haft, s.outline, s.curve * 0.4);
    // Top spike.
    glowOn(ctx, s, 9);
    poly(ctx, [[46, 0], [50, -3.4], [60, 0], [50, 3.4]]);
    strokedFill(ctx, p.metal, s.outline);
    // Axe blade below the spike.
    ctx.beginPath();
    ctx.moveTo(34, -3);
    ctx.quadraticCurveTo(40 + s.curve * 4, -17, 47, -14);
    ctx.quadraticCurveTo(45, -6, 44, -3);
    ctx.closePath();
    strokedFill(ctx, p.metal, s.outline);
    glowOff(ctx);
    // Back hook.
    poly(ctx, [[36, 3], [42, 3], [37, 10]]);
    strokedFill(ctx, p.metal, s.outline);
    spikeRow(ctx, s, p, 20, -2.8, 32, -2.8, -1);
  },

  scythe(ctx, s, p) {
    haft(ctx, -14, 34, 3, p.haft, s.outline, 0.25 + s.curve * 0.25);
    ctx.save();
    ctx.translate(33, -2);
    ctx.rotate(Math.PI / 2 - 0.35 - s.curve * 0.25);
    // The blade sweeps back with a strong inner curve.
    const swept = { ...s, curve: 0.55 + s.curve * 0.4 };
    blade(ctx, swept, p, 0, 30, 6.5);
    ctx.restore();
    ctx.fillStyle = s.accent;
    ctx.fillRect(28, -4.4, 2.4, 6);
  },

  whip(ctx, s, p, time) {
    haft(ctx, 0, 8, 3.4, p.dark, s.outline);
    const N = 9;
    const amp = 3 + s.curve * 5;
    let px = 8;
    let py = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const x = 8 + t * 46;
      const y = Math.sin(time * 6 + i * 0.85) * amp * t + t * t * 6;
      ctx.strokeStyle = i % 2 ? mix(p.dark, s.accent, 0.4) : p.dark;
      ctx.lineWidth = Math.max(1, 3.4 * (1 - t * 0.75));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      px = x;
      py = y;
    }
    if (s.spikes > 0) {
      glowOn(ctx, s, 6);
      poly(ctx, [[px - 2, py - 2.5], [px - 2, py + 2.5], [px + 5, py]]);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
    }
  },

  flail(ctx, s, p, time) {
    haft(ctx, 0, 15, 3.2, p.haft, s.outline);
    const swing = Math.sin(time * 3) * 0.22 + 0.3;
    const chainLen = 15 + s.curve * 8;
    const dx = Math.cos(swing);
    const dy = Math.sin(swing);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(15 + dx * (i * chainLen) / 4, dy * (i * chainLen) / 4, 1.7, 0, Math.PI * 2);
      strokedFill(ctx, p.dark, s.outline);
    }
    const bx = 15 + dx * (chainLen + 6);
    const by = dy * (chainLen + 6);
    glowOn(ctx, s, 8);
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, Math.PI * 2);
    strokedFill(ctx, p.metal, s.outline);
    glowOff(ctx);
    radialSpikes(ctx, s, p, bx, by, 6.5, s.spikes > 0 ? Math.min(4, s.spikes) + 3 : 0, 4);
  },

  staff(ctx, s, p, time) {
    haft(ctx, -20, 36, 3, shade(p.haft, 0.85), s.outline, s.curve * 0.6);
    ctx.fillStyle = s.accent;
    ctx.fillRect(26, -3, 2.6, 6);
    focusOrb(ctx, s, p, 42, -s.curve * 6, 6.5, time);
    if (s.doubleEnded) focusOrb(ctx, s, p, -26, 0, 4.5, time + 1.2);
  },

  bow(ctx, s, p) {
    const reach = 6;
    const depth = 14 + s.curve * 10;
    ctx.strokeStyle = withAlpha("#f5f2e6", 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(reach, -27);
    ctx.lineTo(reach, 27);
    ctx.stroke();
    glowOn(ctx, s, 8);
    ctx.strokeStyle = p.haft;
    ctx.lineWidth = 4.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(reach, -27);
    ctx.quadraticCurveTo(reach + depth, -14, reach + depth - 2, 0);
    ctx.quadraticCurveTo(reach + depth, 14, reach, 27);
    ctx.stroke();
    glowOff(ctx);
    ctx.strokeStyle = withAlpha(s.glow, 0.5);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(reach + 2, -24);
    ctx.quadraticCurveTo(reach + depth - 1, -12, reach + depth - 3, 0);
    ctx.quadraticCurveTo(reach + depth - 1, 12, reach + 2, 24);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(reach + depth - 6, -6, 6.5, 12, 3);
    strokedFill(ctx, s.accent, s.outline);
    if (s.spikes > 0) {
      poly(ctx, [[reach - 2, -27], [reach + 4, -27], [reach + 1, -33]]);
      strokedFill(ctx, p.metal, s.outline);
      poly(ctx, [[reach - 2, 27], [reach + 4, 27], [reach + 1, 33]]);
      strokedFill(ctx, p.metal, s.outline);
    }
  },

  gun(ctx, s, p, time) {
    // Grip below, body, barrel(s), sight.
    ctx.beginPath();
    ctx.roundRect(0, 1, 5.5, 10, 2);
    strokedFill(ctx, p.dark, s.outline);
    glowOn(ctx, s, 7);
    ctx.beginPath();
    ctx.roundRect(-2, -5, 18, 9, 2.5);
    strokedFill(ctx, p.metal, s.outline);
    const barrel = (y: number) => {
      ctx.beginPath();
      ctx.roundRect(15, y, 16, 4.4, 1.5);
      strokedFill(ctx, p.dark, s.outline);
    };
    barrel(-3.4);
    if (s.doubleEnded) barrel(-8.4);
    glowOff(ctx);
    ctx.beginPath();
    ctx.roundRect(3, -7.5, 4, 3, 1);
    strokedFill(ctx, s.accent, s.outline);
    // Muzzle glow.
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    ctx.fillStyle = withAlpha(s.glow, 0.35 + 0.3 * pulse);
    ctx.beginPath();
    ctx.arc(32, -1.2, 1.8 + pulse, 0, Math.PI * 2);
    ctx.fill();
    if (s.spikes > 0) {
      poly(ctx, [[24, 1], [24, 4], [36, 2.5]]);
      strokedFill(ctx, p.metal, s.outline);
    }
  },

  orb(ctx, s, p, time) {
    const bob = Math.sin(time * 3) * 2.5;
    focusOrb(ctx, s, p, 8, -10 + bob, 7.5, time);
    ctx.fillStyle = withAlpha(s.glow, 0.9);
    for (const phase of [0, Math.PI]) {
      const a = time * 2.5 + phase;
      ctx.beginPath();
      ctx.arc(8 + Math.cos(a) * 12, -10 + bob + Math.sin(a) * 4.5, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (s.doubleEnded) focusOrb(ctx, s, p, 8, 8 - bob * 0.7, 4.5, time + 2);
  },

  shield(ctx, s, p) {
    const soft = 0.5 + s.curve * 0.5; // curve rounds the silhouette
    glowOn(ctx, s, 7);
    ctx.beginPath();
    ctx.moveTo(8, -15);
    ctx.quadraticCurveTo(8 + 12 * soft, -12, 19, 2 - 4 * soft);
    ctx.quadraticCurveTo(18, 12, 8, 18);
    ctx.quadraticCurveTo(-2, 12, -3, 2 - 4 * soft);
    ctx.quadraticCurveTo(8 - 12 * soft, -12, 8, -15);
    ctx.closePath();
    strokedFill(ctx, mix("#8d99ab", s.accent, 0.45), s.outline);
    glowOff(ctx);
    ctx.strokeStyle = withAlpha(s.glow, 0.5);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(8, 1.5, 8.5, 0, Math.PI * 2);
    ctx.stroke();
    glowOn(ctx, s, 9);
    ctx.beginPath();
    ctx.arc(8, 1.5, 3.6, 0, Math.PI * 2);
    strokedFill(ctx, s.glow, s.outline);
    glowOff(ctx);
    if (s.spikes > 0) radialSpikes(ctx, s, p, 8, 1.5, 13, Math.min(4, s.spikes) + 2, 4.5);
  },

  claw(ctx, s, p) {
    ctx.beginPath();
    ctx.roundRect(-6, -5.5, 4, 11, 2);
    strokedFill(ctx, s.accent, s.outline);
    ctx.beginPath();
    ctx.roundRect(-2, -6, 9, 12, 3.5);
    strokedFill(ctx, mix("#9aa3b2", s.accent, 0.4), s.outline);
    const talons = Math.max(2, Math.min(4, 2 + s.spikes));
    for (let i = 0; i < talons; i++) {
      const y = -5 + (i * 10) / Math.max(1, talons - 1);
      ctx.save();
      ctx.translate(7, y);
      ctx.rotate(y * 0.02);
      blade(ctx, { ...s, curve: 0.3 + s.curve * 0.4, spikes: 0 }, p, 0, 15, 3.2);
      ctx.restore();
    }
  },

  chakram(ctx, s, p, time) {
    ctx.save();
    ctx.translate(11, 0);
    ctx.rotate(time * 1.5);
    glowOn(ctx, s, 9);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.strokeStyle = p.metal;
    ctx.lineWidth = 4.2;
    ctx.stroke();
    glowOff(ctx);
    ctx.strokeStyle = s.outline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 12.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 7.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(p.metalEdge, 0.8);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 10, -0.5, 1.2);
    ctx.stroke();
    if (s.spikes > 0) radialSpikes(ctx, s, p, 0, 0, 12, Math.min(4, s.spikes) + 3, 3.5);
    ctx.restore();
  },

  bomb(ctx, s, p, time) {
    glowOn(ctx, s, 9);
    ctx.beginPath();
    ctx.arc(9, 0, 7.5, 0, Math.PI * 2);
    strokedFill(ctx, p.dark, s.outline);
    glowOff(ctx);
    ctx.fillStyle = withAlpha("#ffffff", 0.35);
    ctx.beginPath();
    ctx.arc(6.5, -2.5, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(7, -10.5, 4, 4, 1.2);
    strokedFill(ctx, s.accent, s.outline);
    ctx.strokeStyle = shade(p.haft, 0.8);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(9, -10.5);
    ctx.quadraticCurveTo(12, -14, 14, -13);
    ctx.stroke();
    const spark = 0.6 + 0.4 * Math.sin(time * 12);
    glowOn(ctx, s, 10);
    ctx.fillStyle = withAlpha(s.glow, spark);
    ctx.beginPath();
    ctx.arc(14.5, -13, 2 * spark + 0.8, 0, Math.PI * 2);
    ctx.fill();
    glowOff(ctx);
    if (s.spikes > 0) radialSpikes(ctx, s, p, 9, 0, 7, Math.min(4, s.spikes) + 2, 3.5);
  },
};

// ---------------------------------------------------------------------------
// Element FX — layered on any form along its business length
// ---------------------------------------------------------------------------

function drawElementFX(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  time: number,
): void {
  if (s.element === "none") return;
  const T = TIP[s.form];
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = 8;

  switch (s.element) {
    case "fire": {
      // Rising embers.
      for (let i = 0; i < 3; i++) {
        const ph = (time * 1.3 + i * 0.37) % 1;
        const x = T * (0.35 + 0.2 * i) + hash(i) * 4;
        ctx.fillStyle = withAlpha(s.glow, (1 - ph) * 0.8);
        ctx.beginPath();
        ctx.arc(x, -3 - ph * 9, 1.6 - ph * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "ice": {
      // Frost shards.
      ctx.fillStyle = withAlpha(s.glow, 0.75);
      for (let i = 0; i < 3; i++) {
        const x = T * (0.45 + 0.2 * i);
        const y = (i % 2 ? 3 : -3) - 1;
        poly(ctx, [[x - 1.8, y], [x + 1.8, y], [x, y - 6]]);
        ctx.fill();
      }
      break;
    }
    case "lightning": {
      // A jagged arc crawling along the weapon, re-rolled ~10×/sec.
      const frame = Math.floor(time * 10);
      ctx.strokeStyle = withAlpha(s.glow, 0.85);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(T * 0.25, 0);
      for (let i = 1; i <= 5; i++) {
        const x = T * (0.25 + (0.7 * i) / 5);
        const y = (hash(frame * 7 + i) - 0.5) * 9;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case "poison": {
      // Dripping goo.
      for (let i = 0; i < 2; i++) {
        const ph = (time * 0.9 + i * 0.5) % 1;
        const x = T * (0.5 + 0.25 * i);
        ctx.fillStyle = withAlpha(s.glow, (1 - ph) * 0.8);
        ctx.beginPath();
        ctx.arc(x, 3 + ph * 8, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "shadow": {
      // Trailing wisps.
      ctx.shadowBlur = 12;
      for (let i = 0; i < 3; i++) {
        const ph = (time * 0.7 + i * 0.33) % 1;
        const x = T * (0.3 + 0.5 * hash(i + 3)) - ph * 8;
        ctx.fillStyle = withAlpha(s.glow, 0.28 * (1 - ph));
        ctx.beginPath();
        ctx.arc(x, Math.sin(time * 2 + i * 2) * 3, 3 - ph, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "holy": {
      // Twinkling cross sparkles.
      ctx.strokeStyle = withAlpha(s.glow, 0.5 + 0.4 * Math.sin(time * 5));
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 2; i++) {
        const x = T * (0.45 + 0.35 * i);
        const y = i % 2 ? -5 : 4;
        const r = 3 + Math.sin(time * 5 + i * 2) * 1;
        ctx.beginPath();
        ctx.moveTo(x - r, y);
        ctx.lineTo(x + r, y);
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
        ctx.stroke();
      }
      break;
    }
    case "arcane": {
      // Orbiting rune glyphs.
      ctx.fillStyle = withAlpha(s.glow, 0.7);
      for (let i = 0; i < 2; i++) {
        const a = time * 2.2 + i * Math.PI;
        const x = T * 0.6 + Math.cos(a) * T * 0.22;
        const y = Math.sin(a) * 6;
        poly(ctx, [[x, y - 2.6], [x + 2.2, y], [x, y + 2.6], [x - 2.2, y]]);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------

/** Draw a weapon in local space (grip at origin, +X outward). */
export function drawWeapon(
  ctx: CanvasRenderingContext2D,
  style: WeaponRenderStyle,
  time: number,
): void {
  const p = paletteOf(style);
  ctx.save();
  const k = SIZE_SCALE[style.size];
  ctx.scale(k, k);
  FORMS[style.form](ctx, style, p, time);
  drawElementFX(ctx, style, time);
  ctx.restore();
}
