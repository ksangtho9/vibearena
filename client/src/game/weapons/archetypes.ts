import type {
  ElementKind,
  PartMaterial,
  WeaponForm,
  WeaponSize,
} from "../../types/character";
import type { ResolvedBlade, ResolvedHead, ResolvedParts } from "../../generation/enrich";
import { mix, shade, withAlpha } from "../../render/color";

/**
 * COMPOSITIONAL weapon renderer. Weapons are ASSEMBLED from parts along the
 * grip axis — pommel → haft → guard → blade(s) or head → adornments — so a
 * katana (gentle single-edge curve, tsuba disc, wrapped grip, tanto tip) and
 * a rapier (needle blade, basket guard) are structurally different drawings,
 * not recolors. `form` still drives mechanics/animation; TIP lengths and the
 * grip anchor are unchanged, so reach, trails and hitboxes stay identical.
 *
 * Local space: grip at the origin, business end along +X. Dimensions are for
 * a medium weapon at fighter scale 1; `size` scales the DRAWING only.
 */

export interface WeaponRenderStyle {
  form: WeaponForm;
  size: WeaponSize;
  curve: number; // 0–1 (legacy modifier; parts.blade curvature dominates)
  spikes: number; // 0–4
  doubleEnded: boolean;
  element: ElementKind;
  parts: ResolvedParts;
  /** Fighter body color — ties wood/leather parts to the character. */
  fill: string;
  accent: string;
  glow: string;
  outline: string;
}

const SIZE_SCALE: Record<WeaponSize, number> = { small: 0.8, medium: 1, large: 1.3 };

/** Visual tip length (for trails/FX placement) — NOT the hitbox reach. */
const TIP: Record<WeaponForm, number> = {
  sword: 46, greatsword: 60, dagger: 26, axe: 36, hammer: 34, warhammer: 40,
  mace: 34, rapier: 50, spear: 62, halberd: 62, scythe: 52, whip: 56,
  flail: 42, staff: 46, bow: 26, gun: 32, cannon: 38, orb: 14, shield: 16,
  claw: 22, chakram: 22, bomb: 16, fist: 10, gauntlet: 13,
};

export function weaponTipLength(form: WeaponForm, size: WeaponSize): number {
  return TIP[form] * SIZE_SCALE[size];
}

/** Orbs hover beside the hand instead of rotating with the arm. */
export function weaponIsFloating(form: WeaponForm): boolean {
  return form === "orb";
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const MATERIAL_BASE: Record<Exclude<PartMaterial, "energy">, string> = {
  steel: "#ccd3de",
  iron: "#8f959e",
  bronze: "#c98d4e",
  gold: "#e8b33c",
  obsidian: "#453e55",
  bone: "#e8e2d0",
  wood: "#8a6844",
  crystal: "#bfe8f2",
};

interface Palette {
  metal: string; // blades / heads
  metalEdge: string;
  haft: string;
  dark: string; // grips, iron bits
}

function paletteOf(s: WeaponRenderStyle): Palette {
  const m = s.parts.material;
  let metal =
    m === "energy" ? mix(s.glow, "#ffffff", 0.2) : mix(MATERIAL_BASE[m], s.accent, 0.15);
  if (s.element !== "none") metal = mix(metal, s.glow, 0.15);
  return {
    metal,
    metalEdge: mix("#f0f4fa", s.glow, 0.35),
    haft: m === "wood" ? MATERIAL_BASE.wood : mix("#7a5a3c", s.fill, 0.25),
    dark: mix("#3a3f4a", s.accent, 0.3),
  };
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

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
  ctx.shadowBlur = s.parts.material === "energy" ? blur + 6 : blur;
}

function glowOff(ctx: CanvasRenderingContext2D): void {
  ctx.shadowBlur = 0;
}

const hash = (n: number) => {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
};

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function drawHaft(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  x0: number,
  x1: number,
  thick: number,
  wrapped: boolean,
): void {
  ctx.lineCap = "round";
  ctx.strokeStyle = s.outline;
  ctx.lineWidth = thick + 1.8;
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.lineTo(x1, 0);
  ctx.stroke();
  ctx.strokeStyle = p.haft;
  ctx.lineWidth = thick;
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.lineTo(x1, 0);
  ctx.stroke();
  if (wrapped) {
    ctx.strokeStyle = withAlpha(s.accent, 0.85);
    ctx.lineWidth = 1.1;
    const span = x1 - x0;
    const n = Math.max(2, Math.floor(span / 4));
    for (let i = 1; i < n; i++) {
      const x = x0 + (span * i) / n;
      ctx.beginPath();
      ctx.moveTo(x - 1.5, thick * 0.55);
      ctx.lineTo(x + 1.5, -thick * 0.55);
      ctx.stroke();
    }
  }
}

/**
 * A blade assembled from its profile: sampled top/bottom edges around a
 * curved centerline, tip treatment, single/double edge, fuller, serration.
 */
function drawBlade(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  blade: ResolvedBlade,
  x0: number,
  len: number,
): void {
  const w = 2.2 + blade.width * 6.5;

  // Profile parameters.
  let curveK = 0;
  let waveAmp = 0;
  let halfTop = (t: number) => w * 0.5 * (1 - t * 0.65);
  let halfBot = halfTop;
  switch (blade.profile) {
    case "straight":
      break;
    case "curved":
      curveK = 0.22;
      break;
    case "katana":
      curveK = 0.16;
      halfTop = () => w * 0.16;
      halfBot = (t) => w * 0.62 * (1 - t * 0.35);
      break;
    case "scimitar":
      curveK = 0.34;
      halfTop = () => w * 0.16;
      halfBot = (t) => w * (0.4 + t * 0.55) * (1 - Math.max(0, t - 0.8) * 4.5);
      break;
    case "rapier":
      halfTop = (t) => w * 0.16 * (1 - t * 0.5);
      halfBot = halfTop;
      break;
    case "estoc":
      halfTop = (t) => w * 0.22 * (1 - t * 0.75);
      halfBot = halfTop;
      break;
    case "leaf":
      halfTop = (t) => w * (0.28 + Math.sin(Math.min(t * 1.2, 1) * Math.PI) * 0.45);
      halfBot = halfTop;
      break;
    case "cleaver":
      halfTop = () => w * 0.28;
      halfBot = () => w * 0.95;
      break;
    case "serrated":
      halfTop = (t) => w * 0.42 * (1 - t * 0.55);
      halfBot = (t) => w * 0.42 * (1 - t * 0.55);
      break;
    case "wavy":
    case "kris":
      waveAmp = w * 0.4;
      halfTop = (t) => w * 0.38 * (1 - t * 0.6);
      halfBot = halfTop;
      break;
    case "broad":
      halfTop = (t) => w * 0.62 * (1 - t * 0.45);
      halfBot = halfTop;
      break;
    case "sickle":
      curveK = 0.55;
      halfTop = () => w * 0.16;
      halfBot = (t) => w * 0.5 * (1 - t * 0.45);
      break;
    case "dagger":
      halfTop = (t) => w * 0.42 * (1 - t * 0.8);
      halfBot = halfTop;
      break;
  }

  const centerY = (t: number) =>
    -curveK * len * t * t + (waveAmp ? Math.sin(t * Math.PI * 3) * waveAmp : 0);

  const N = 12;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = x0 + len * t;
    top.push([x, centerY(t) - halfTop(t)]);
    if (blade.profile === "serrated" && i > 0 && i < N) {
      // Sawteeth along the cutting edge.
      const tPrev = (i - 0.5) / N;
      bot.push([x0 + len * tPrev, centerY(tPrev) + halfBot(tPrev) + w * 0.42]);
    }
    bot.push([x, centerY(t) + halfBot(t)]);
  }

  // Tip treatment.
  const endY = centerY(1);
  const tipPts: [number, number][] = [];
  switch (blade.tip) {
    case "round":
      tipPts.push([x0 + len + w * 0.28, endY]);
      break;
    case "clipped":
      tipPts.push([x0 + len + w * 0.3, endY + halfBot(1) * 0.6]);
      break;
    case "tanto":
      tipPts.push([x0 + len + w * 0.45, endY + halfBot(1) * 0.85]);
      break;
    default:
      tipPts.push([x0 + len + w * 0.55, endY]);
      break;
  }

  glowOn(ctx, s, s.element !== "none" ? 12 : 8);
  ctx.beginPath();
  ctx.moveTo(top[0][0], top[0][1]);
  for (const [x, y] of top) ctx.lineTo(x, y);
  for (const [x, y] of tipPts) ctx.lineTo(x, y);
  for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
  ctx.closePath();
  strokedFill(ctx, p.metal, s.outline);
  glowOff(ctx);

  // Cutting-edge highlight (both edges when double-edged).
  ctx.strokeStyle = withAlpha(p.metalEdge, 0.85);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(bot[0][0], bot[0][1] - 0.6);
  for (const [x, y] of bot) ctx.lineTo(x, y - 0.6);
  ctx.stroke();
  if (blade.edges === 2) {
    ctx.beginPath();
    ctx.moveTo(top[0][0], top[0][1] + 0.6);
    for (const [x, y] of top) ctx.lineTo(x, y + 0.6);
    ctx.stroke();
  } else {
    // Spine shadow for single-edged blades.
    ctx.strokeStyle = withAlpha(s.outline, 0.55);
    ctx.beginPath();
    ctx.moveTo(top[0][0], top[0][1] + 0.5);
    for (const [x, y] of top) ctx.lineTo(x, y + 0.5);
    ctx.stroke();
  }

  if (blade.fuller) {
    ctx.strokeStyle = withAlpha(s.outline, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + len * 0.06, centerY(0.06));
    for (let i = 1; i <= 8; i++) {
      const t = 0.06 + (i / 8) * 0.72;
      ctx.lineTo(x0 + len * t, centerY(t));
    }
    ctx.stroke();
  }
}

/** Blade stack for count > 1 (twin blades, tridents). */
function drawBlades(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  blade: ResolvedBlade,
  x0: number,
  len: number,
): void {
  const gap = (2.2 + blade.width * 6.5) * 1.35;
  for (let i = 0; i < blade.count; i++) {
    const off = (i - (blade.count - 1) / 2) * gap;
    ctx.save();
    ctx.translate(0, off);
    drawBlade(ctx, s, p, blade, x0, len * (off === 0 ? 1 : 0.86));
    ctx.restore();
  }
}

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

/** Blunt / axe / polearm heads mounted at x. */
function drawHead(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  head: ResolvedHead,
  x: number,
): void {
  const k = 0.65 + head.size * 0.6;
  glowOn(ctx, s, 8);
  switch (head.type) {
    case "hammer": {
      ctx.beginPath();
      ctx.roundRect(x - 6 * k, -13 * k, 13 * k, 26 * k, 2.5);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      ctx.strokeStyle = withAlpha(s.outline, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 2.5 * k, -13 * k);
      ctx.lineTo(x - 2.5 * k, 13 * k);
      ctx.stroke();
      if (head.spikes > 0) {
        for (let i = 0; i < Math.min(4, head.spikes); i++) {
          const sx = x - 5 * k + (i * 10 * k) / Math.max(1, Math.min(4, head.spikes) - 1 || 1);
          poly(ctx, [[sx - 2, -13 * k], [sx + 2, -13 * k], [sx, -18 * k]]);
          strokedFill(ctx, p.metal, s.outline);
        }
      }
      break;
    }
    case "spikedBall": {
      ctx.beginPath();
      ctx.arc(x, 0, 7.5 * k, 0, Math.PI * 2);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      radialSpikes(ctx, s, p, x, 0, 7 * k, Math.max(3, head.spikes), 4.5 * k);
      break;
    }
    case "flangedMace": {
      ctx.beginPath();
      ctx.arc(x, 0, 6 * k, 0, Math.PI * 2);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        poly(ctx, [
          [x + ux * 3 * k - uy * 2.4, uy * 3 * k + ux * 2.4],
          [x + ux * 3 * k + uy * 2.4, uy * 3 * k - ux * 2.4],
          [x + ux * 9.5 * k, uy * 9.5 * k],
        ]);
        strokedFill(ctx, p.metal, s.outline);
      }
      break;
    }
    case "axeSingle":
    case "axeDouble": {
      const crescent = (dir: 1 | -1) => {
        ctx.beginPath();
        ctx.moveTo(x - 2 * k, dir * -3 * k);
        ctx.quadraticCurveTo(x + 6 * k, dir * -16 * k, x + 16 * k, dir * -12 * k);
        ctx.quadraticCurveTo(x + 13 * k, dir * -4 * k, x + 13 * k, dir * 3 * k);
        ctx.quadraticCurveTo(x + 6 * k, dir * 2 * k, x - 2 * k, dir * 3 * k);
        ctx.closePath();
        strokedFill(ctx, p.metal, s.outline);
      };
      crescent(1);
      if (head.type === "axeDouble") {
        ctx.save();
        ctx.translate(x, 0);
        ctx.scale(-1, 1);
        ctx.translate(-x, 0);
        crescent(1);
        ctx.restore();
      }
      glowOff(ctx);
      break;
    }
    case "pick": {
      ctx.beginPath();
      ctx.moveTo(x - 2 * k, -3 * k);
      ctx.quadraticCurveTo(x + 12 * k, -9 * k, x + 18 * k, -2 * k);
      ctx.quadraticCurveTo(x + 10 * k, -3.5 * k, x - 2 * k, 3 * k);
      ctx.closePath();
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      break;
    }
    case "warpick": {
      ctx.beginPath();
      ctx.roundRect(x - 3 * k, -10 * k, 8 * k, 20 * k, 2);
      strokedFill(ctx, p.metal, s.outline);
      poly(ctx, [[x - 3 * k, -4 * k], [x - 3 * k, 4 * k], [x - 15 * k, 0]]);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      break;
    }
    case "halberd": {
      poly(ctx, [[x + 8 * k, 0], [x + 12 * k, -3.4 * k], [x + 22 * k, 0], [x + 12 * k, 3.4 * k]]);
      strokedFill(ctx, p.metal, s.outline);
      ctx.beginPath();
      ctx.moveTo(x - 4 * k, -3 * k);
      ctx.quadraticCurveTo(x + 2 * k, -16 * k, x + 9 * k, -13 * k);
      ctx.quadraticCurveTo(x + 7 * k, -6 * k, x + 6 * k, -3 * k);
      ctx.closePath();
      strokedFill(ctx, p.metal, s.outline);
      poly(ctx, [[x - 2 * k, 3 * k], [x + 4 * k, 3 * k], [x - 1 * k, 10 * k]]);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      break;
    }
  }
  glowOff(ctx);
}

function drawGuard(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  guard: ResolvedParts["guard"],
  x: number,
  gripLen: number,
): void {
  switch (guard) {
    case "crossbar": {
      ctx.beginPath();
      ctx.roundRect(x, -8, 4, 16, 2);
      strokedFill(ctx, s.accent, s.outline);
      break;
    }
    case "disc": {
      // Tsuba: a flat vertical ellipse.
      ctx.beginPath();
      ctx.ellipse(x + 2, 0, 2, 7.5, 0, 0, Math.PI * 2);
      strokedFill(ctx, mix(p.dark, s.accent, 0.4), s.outline);
      break;
    }
    case "circular": {
      ctx.strokeStyle = s.accent;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(x + 2, 0, 3.2, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "basket": {
      ctx.strokeStyle = p.metal;
      ctx.lineWidth = 1.6;
      for (const drop of [5, 8, 11]) {
        ctx.beginPath();
        ctx.moveTo(x + 2, -2);
        ctx.quadraticCurveTo(x - gripLen * 0.6, drop, x - gripLen, 1.5);
        ctx.stroke();
      }
      break;
    }
    case "knuckle": {
      ctx.strokeStyle = p.metal;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 2, 0);
      ctx.quadraticCurveTo(x - gripLen * 0.5, 9, x - gripLen, 1);
      ctx.stroke();
      break;
    }
    case "ornate": {
      ctx.beginPath();
      ctx.roundRect(x, -7, 3.5, 14, 1.6);
      strokedFill(ctx, mix(MATERIAL_BASE.gold, s.accent, 0.25), s.outline);
      ctx.strokeStyle = mix(MATERIAL_BASE.gold, s.accent, 0.25);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 1.5, -7);
      ctx.quadraticCurveTo(x + 6, -10, x + 4, -13);
      ctx.moveTo(x + 1.5, 7);
      ctx.quadraticCurveTo(x + 6, 10, x + 4, 13);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
}

function drawPommel(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  pommel: ResolvedParts["pommel"],
  x: number,
): void {
  switch (pommel) {
    case "round": {
      ctx.beginPath();
      ctx.arc(x, 0, 2.7, 0, Math.PI * 2);
      strokedFill(ctx, s.accent, s.outline);
      break;
    }
    case "gem": {
      glowOn(ctx, s, 8);
      poly(ctx, [[x + 2.6, 0], [x, -2.8], [x - 2.6, 0], [x, 2.8]]);
      strokedFill(ctx, mix(s.glow, "#ffffff", 0.25), s.outline);
      glowOff(ctx);
      break;
    }
    case "spiked": {
      poly(ctx, [[x + 1.5, -2.4], [x + 1.5, 2.4], [x - 5, 0]]);
      strokedFill(ctx, p.metal, s.outline);
      break;
    }
    case "ring": {
      ctx.strokeStyle = p.metal;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(x - 2, 0, 3, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "skull": {
      ctx.beginPath();
      ctx.arc(x - 1, 0, 3, 0, Math.PI * 2);
      strokedFill(ctx, MATERIAL_BASE.bone, s.outline);
      ctx.fillStyle = s.outline;
      for (const oy of [-1.1, 1.1]) {
        ctx.beginPath();
        ctx.arc(x - 2, oy, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
}

interface AdornAnchors {
  pommelX: number;
  guardX: number;
  bladeBaseX: number;
  reach: number;
}

function drawAdornments(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  anchors: AdornAnchors,
  time: number,
): void {
  for (const adorn of s.parts.adornments) {
    switch (adorn) {
      case "gem": {
        glowOn(ctx, s, 7);
        poly(ctx, [
          [anchors.guardX + 2.2, 0], [anchors.guardX, -2.2],
          [anchors.guardX - 2.2, 0], [anchors.guardX, 2.2],
        ]);
        strokedFill(ctx, mix(s.glow, "#ffffff", 0.3), s.outline);
        glowOff(ctx);
        break;
      }
      case "engraving": {
        ctx.strokeStyle = withAlpha(s.accent, 0.6);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const x = anchors.bladeBaseX + (anchors.reach * 0.5 * i) / 6;
          const y = Math.sin(i * 1.9) * 1.2 - 0.5;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        break;
      }
      case "chain": {
        ctx.strokeStyle = p.dark;
        ctx.lineWidth = 1.2;
        const sway = Math.sin(time * 3) * 1.5;
        ctx.beginPath();
        ctx.moveTo(anchors.pommelX, 1);
        ctx.quadraticCurveTo(anchors.pommelX - 2 + sway, 6, anchors.pommelX - 4 + sway, 10);
        ctx.stroke();
        for (let i = 1; i <= 2; i++) {
          ctx.beginPath();
          ctx.arc(anchors.pommelX - 1.4 * i + sway * (i / 2), 3.5 * i + 2.5, 1.1, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case "ribbon": {
        const sway = Math.sin(time * 4) * 3;
        ctx.fillStyle = withAlpha(s.accent, 0.9);
        ctx.beginPath();
        ctx.moveTo(anchors.guardX, 3);
        ctx.quadraticCurveTo(anchors.guardX - 6 + sway, 9, anchors.guardX - 10 + sway * 1.5, 15);
        ctx.lineTo(anchors.guardX - 7 + sway * 1.5, 15.5);
        ctx.quadraticCurveTo(anchors.guardX - 3.5 + sway, 8, anchors.guardX + 1.6, 4);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "runes": {
        glowOn(ctx, s, 6);
        ctx.fillStyle = withAlpha(s.glow, 0.75 + 0.2 * Math.sin(time * 4));
        for (let i = 0; i < 3; i++) {
          const x = anchors.bladeBaseX + anchors.reach * (0.2 + i * 0.2);
          poly(ctx, [[x, -1.8], [x + 1.4, 0], [x, 1.8], [x - 1.4, 0]]);
          ctx.fill();
        }
        glowOff(ctx);
        break;
      }
      case "feather": {
        ctx.fillStyle = withAlpha(s.accent, 0.85);
        ctx.beginPath();
        ctx.ellipse(anchors.pommelX - 2, 5.5, 1.8, 4.5, -0.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "tassel": {
        const sway = Math.sin(time * 3.5) * 1.6;
        ctx.strokeStyle = s.accent;
        ctx.lineWidth = 1.1;
        for (const off of [-1, 0, 1]) {
          ctx.beginPath();
          ctx.moveTo(anchors.pommelX, 1);
          ctx.lineTo(anchors.pommelX + off * 1.6 + sway, 8);
          ctx.stroke();
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/** Hilted blades: pommel → grip → guard → blade(s). */
function composeBladed(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  time: number,
): void {
  const T = TIP[s.form];
  const parts = s.parts;
  const gripLen = 6 + parts.haft.length * 16;
  const bladeStart = 5;
  const blade = parts.blade ?? {
    profile: "straight" as const, length: 0.6, width: 0.35, edges: 2 as const,
    count: 1 as const, fuller: false, tip: "point" as const,
  };
  const bladeLen = Math.max(10, (T - bladeStart) * (0.7 + 0.35 * blade.length));

  drawPommel(ctx, s, p, parts.pommel, -gripLen - 1.5);
  drawHaft(ctx, s, p, -gripLen, 0, 3, parts.haft.wrapped);
  drawBlades(ctx, s, p, blade, bladeStart, bladeLen);
  drawGuard(ctx, s, p, parts.guard, 1.5, gripLen);
  drawAdornments(ctx, s, p, { pommelX: -gripLen - 1.5, guardX: 2.5, bladeBaseX: bladeStart + 2, reach: bladeLen }, time);
}

/** Hafted: long handle with a head (axe/hammer) or chained ball (flail). */
function composeHafted(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  time: number,
): void {
  const T = TIP[s.form];
  const parts = s.parts;
  const head = parts.head ?? { type: "hammer" as const, size: 0.6, spikes: 0 };

  if (s.form === "flail") {
    const haftEnd = 8 + parts.haft.length * 12;
    drawHaft(ctx, s, p, 0, haftEnd, 3.2, parts.haft.wrapped);
    const swing = Math.sin(time * 3) * 0.22 + 0.3;
    const chainLen = 15 + s.curve * 8;
    const dx = Math.cos(swing);
    const dy = Math.sin(swing);
    ctx.strokeStyle = p.dark;
    ctx.lineWidth = 1.2;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(haftEnd + (dx * i * chainLen) / 4, (dy * i * chainLen) / 4, 1.7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(haftEnd + dx * (chainLen + 6), dy * (chainLen + 6));
    drawHead(ctx, s, p, head, 0);
    ctx.restore();
    drawPommel(ctx, s, p, parts.pommel, -2);
    return;
  }

  const haftEnd = T * (0.55 + parts.haft.length * 0.25);
  drawPommel(ctx, s, p, parts.pommel, -13);
  drawHaft(ctx, s, p, -12, haftEnd, 3.4, parts.haft.wrapped);
  drawHead(ctx, s, p, head, haftEnd - 2);
  drawAdornments(ctx, s, p, { pommelX: -13, guardX: 0, bladeBaseX: 6, reach: haftEnd }, time);
}

/** Polearms: very long haft, blade or head mounted at the far end. */
function composePolearm(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  time: number,
): void {
  const T = TIP[s.form];
  const parts = s.parts;
  const haftBack = -(10 + parts.haft.length * 10);
  const haftEnd = T * 0.74;

  drawHaft(ctx, s, p, haftBack, haftEnd, 3, parts.haft.wrapped);
  if (s.doubleEnded) {
    poly(ctx, [[haftBack, -2.4], [haftBack, 2.4], [haftBack - 8, 0]]);
    strokedFill(ctx, p.metal, s.outline);
  }
  ctx.fillStyle = s.accent;
  ctx.fillRect(haftEnd - 7, -2.6, 2.4, 5.2);

  if (s.form === "scythe") {
    // Transverse reaping blade.
    const blade = parts.blade ?? {
      profile: "sickle" as const, length: 0.55, width: 0.35, edges: 1 as const,
      count: 1 as const, fuller: false, tip: "point" as const,
    };
    ctx.save();
    ctx.translate(haftEnd - 1, -2);
    ctx.rotate(Math.PI / 2 - 0.35 - s.curve * 0.25);
    drawBlade(ctx, s, p, blade, 0, T * 0.55 * (0.7 + 0.5 * blade.length));
    ctx.restore();
  } else if (parts.head) {
    drawHead(ctx, s, p, parts.head, haftEnd - 2);
  } else {
    const blade = parts.blade ?? {
      profile: "leaf" as const, length: 0.25, width: 0.3, edges: 2 as const,
      count: 1 as const, fuller: false, tip: "point" as const,
    };
    drawBlades(ctx, s, p, blade, haftEnd - 2, (T - haftEnd) * (0.8 + blade.length * 0.9) + 6);
  }
  drawAdornments(ctx, s, p, { pommelX: haftBack, guardX: haftEnd - 8, bladeBaseX: haftEnd, reach: T - haftEnd }, time);
}

/** Fist weapon: wrist wrap + talon blades. */
/**
 * Fist family — WORN on the striking hand, not held. Local origin = the hand
 * joint, +x = the strike direction (weaponAngle), so everything hugs the
 * fist/lower forearm and claws project forward past the knuckles.
 */
function composeClaw(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
): void {
  const parts = s.parts;
  // Knuckle band wrapping the fist (over the hand joint).
  ctx.beginPath();
  ctx.roundRect(-4, -5, 8, 10, 3);
  strokedFill(ctx, mix("#9aa3b2", s.accent, 0.4), s.outline);
  // Short wrist strap trailing the forearm.
  ctx.beginPath();
  ctx.roundRect(-9, -3.5, 5, 7, 2);
  strokedFill(ctx, s.accent, s.outline);
  // Talons rake FORWARD past the knuckles.
  const blade = parts.blade ?? {
    profile: "dagger" as const, length: 0.3, width: 0.2, edges: 1 as const,
    count: 3 as const, fuller: false, tip: "point" as const,
  };
  const talons = Math.max(2, Math.min(4, blade.count + 1));
  for (let i = 0; i < talons; i++) {
    const y = -4.5 + (i * 9) / Math.max(1, talons - 1);
    ctx.save();
    ctx.translate(3.5, y);
    ctx.rotate(y * 0.03); // slight fan
    drawBlade(ctx, s, p, { ...blade, count: 1 }, 0, 12 + blade.length * 10);
    ctx.restore();
  }
}

/** Bare/wrapped fist or brass knuckles: a band + studs over the fist. */
function composeFist(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
): void {
  // Hand wrap over the fist.
  ctx.beginPath();
  ctx.roundRect(-5, -5, 9, 10, 4);
  strokedFill(ctx, s.accent, s.outline);
  // Wrist wrap on the forearm side.
  ctx.beginPath();
  ctx.roundRect(-10, -3.5, 5, 7, 2);
  strokedFill(ctx, mix(s.accent, "#3a352c", 0.35), s.outline);
  // Brass-knuckle studs across the leading edge.
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(4.5, -4 + i * 2.7, 1.5, 0, Math.PI * 2);
    strokedFill(ctx, p.metal, s.outline);
  }
}

/** Armored power gauntlet: forearm sleeve + plated fist + knuckle ridge. */
function composeGauntlet(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
): void {
  // Forearm sleeve.
  ctx.beginPath();
  ctx.roundRect(-15, -4.5, 10, 9, 3);
  strokedFill(ctx, mix(p.metal, "#5a616e", 0.35), s.outline);
  // Big armored fist over the hand.
  ctx.beginPath();
  ctx.roundRect(-6, -6.5, 12, 13, 4.5);
  strokedFill(ctx, p.metal, s.outline);
  // Plate ridges.
  ctx.strokeStyle = s.outline;
  ctx.lineWidth = 1;
  for (const x of [-2, 1.5]) {
    ctx.beginPath();
    ctx.moveTo(x, -6);
    ctx.lineTo(x, 6);
    ctx.stroke();
  }
  // Knuckle ridge plate on the striking face.
  ctx.beginPath();
  ctx.roundRect(5, -5.5, 3.5, 11, 1.5);
  strokedFill(ctx, mix(p.metal, "#ffffff", 0.25), s.outline);
}

// ---------------------------------------------------------------------------
// Specials (whip, staff, bow, gun, orb, shield, chakram, bomb) — parametric
// forms restyled by material/adornments.
// ---------------------------------------------------------------------------

function composeSpecial(
  ctx: CanvasRenderingContext2D,
  s: WeaponRenderStyle,
  p: Palette,
  time: number,
): void {
  const parts = s.parts;
  switch (s.form) {
    case "whip": {
      drawHaft(ctx, s, p, 0, 8, 3.4, parts.haft.wrapped);
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
      break;
    }
    case "staff": {
      drawHaft(ctx, s, p, -20, 36, 3, parts.haft.wrapped);
      ctx.fillStyle = s.accent;
      ctx.fillRect(26, -3, 2.6, 6);
      // Focus at the tip (the staff's "pommel" gem became its head).
      const pulse = 0.7 + 0.3 * Math.sin(time * 4);
      ctx.strokeStyle = withAlpha(s.glow, 0.35 * pulse);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(42, -s.curve * 6, 10 + pulse * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      glowOn(ctx, s, 14);
      ctx.beginPath();
      ctx.arc(42, -s.curve * 6, 6.5, 0, Math.PI * 2);
      strokedFill(ctx, mix(s.glow, "#ffffff", 0.25), s.outline);
      glowOff(ctx);
      if (parts.pommel !== "none") drawPommel(ctx, s, p, parts.pommel, -22);
      drawAdornments(ctx, s, p, { pommelX: -22, guardX: 20, bladeBaseX: 8, reach: 34 }, time);
      break;
    }
    case "bow": {
      const reach = 6;
      const depth = 14 + s.curve * 10;
      ctx.strokeStyle = withAlpha("#f5f2e6", 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(reach, -27);
      ctx.lineTo(reach, 27);
      ctx.stroke();
      glowOn(ctx, s, 8);
      ctx.strokeStyle = parts.material === "wood" ? p.haft : p.metal;
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
      drawAdornments(ctx, s, p, { pommelX: reach + depth - 3, guardX: reach + depth - 3, bladeBaseX: reach, reach: 20 }, time);
      break;
    }
    case "cannon": {
      // Stout barrel with a reinforced muzzle ring and a smoldering breech.
      ctx.beginPath();
      ctx.roundRect(0, 2, 6, 10, 2);
      strokedFill(ctx, p.dark, s.outline);
      glowOn(ctx, s, 8);
      ctx.beginPath();
      ctx.roundRect(-4, -7, 34, 13, 5);
      strokedFill(ctx, p.metal, s.outline);
      glowOff(ctx);
      ctx.beginPath();
      ctx.roundRect(26, -8.4, 5, 15.8, 2);
      strokedFill(ctx, p.dark, s.outline);
      ctx.beginPath();
      ctx.arc(-4, -0.5, 5.4, 0, Math.PI * 2);
      strokedFill(ctx, p.dark, s.outline);
      const fusePulse = 0.5 + 0.5 * Math.sin(time * 8);
      glowOn(ctx, s, 10);
      ctx.fillStyle = withAlpha(s.glow, 0.4 + 0.5 * fusePulse);
      ctx.beginPath();
      ctx.arc(-7.5, -4.5, 1.6 + fusePulse, 0, Math.PI * 2);
      ctx.fill();
      glowOff(ctx);
      break;
    }
    case "gun": {
      ctx.beginPath();
      ctx.roundRect(0, 1, 5.5, 10, 2);
      strokedFill(ctx, p.dark, s.outline);
      glowOn(ctx, s, 7);
      ctx.beginPath();
      ctx.roundRect(-2, -5, 18, 9, 2.5);
      strokedFill(ctx, p.metal, s.outline);
      ctx.beginPath();
      ctx.roundRect(15, -3.4, 16, 4.4, 1.5);
      strokedFill(ctx, p.dark, s.outline);
      if (s.doubleEnded) {
        ctx.beginPath();
        ctx.roundRect(15, -8.4, 16, 4.4, 1.5);
        strokedFill(ctx, p.dark, s.outline);
      }
      glowOff(ctx);
      ctx.beginPath();
      ctx.roundRect(3, -7.5, 4, 3, 1);
      strokedFill(ctx, s.accent, s.outline);
      const pulse = 0.5 + 0.5 * Math.sin(time * 5);
      ctx.fillStyle = withAlpha(s.glow, 0.35 + 0.3 * pulse);
      ctx.beginPath();
      ctx.arc(32, -1.2, 1.8 + pulse, 0, Math.PI * 2);
      ctx.fill();
      if (s.spikes > 0) {
        poly(ctx, [[24, 1], [24, 4], [36, 2.5]]);
        strokedFill(ctx, p.metal, s.outline);
      }
      break;
    }
    case "orb": {
      const bob = Math.sin(time * 3) * 2.5;
      const y = -10 + bob;
      const pulse = 0.6 + 0.4 * Math.sin(time * 4.5);
      ctx.strokeStyle = withAlpha(s.glow, 0.3 * pulse + 0.1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(8, y, 12 + pulse * 2, 0, Math.PI * 2);
      ctx.stroke();
      glowOn(ctx, s, 16);
      ctx.beginPath();
      ctx.arc(8, y, 7.5, 0, Math.PI * 2);
      strokedFill(ctx, mix(p.metal, s.glow, 0.5), s.outline);
      glowOff(ctx);
      ctx.fillStyle = withAlpha("#ffffff", 0.6);
      ctx.beginPath();
      ctx.arc(5.5, y - 2.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = withAlpha(s.glow, 0.9);
      for (const phase of [0, Math.PI]) {
        const a = time * 2.5 + phase;
        ctx.beginPath();
        ctx.arc(8 + Math.cos(a) * 12, y + Math.sin(a) * 4.5, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "shield": {
      glowOn(ctx, s, 7);
      ctx.beginPath();
      ctx.moveTo(8, -15);
      ctx.quadraticCurveTo(20, -12, 19, 0);
      ctx.quadraticCurveTo(18, 12, 8, 18);
      ctx.quadraticCurveTo(-2, 12, -3, 0);
      ctx.quadraticCurveTo(-4, -12, 8, -15);
      ctx.closePath();
      strokedFill(ctx, mix(p.metal, s.accent, 0.3), s.outline);
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
      drawAdornments(ctx, s, p, { pommelX: 8, guardX: 8, bladeBaseX: 2, reach: 14 }, time);
      break;
    }
    case "chakram": {
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
      break;
    }
    case "bomb":
    default: {
      glowOn(ctx, s, 9);
      ctx.beginPath();
      ctx.arc(9, 0, 7.5, 0, Math.PI * 2);
      strokedFill(ctx, mix(p.dark, p.metal, 0.35), s.outline);
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
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Element FX — unchanged, layered on any composed weapon
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

const BLADED: WeaponForm[] = ["sword", "greatsword", "dagger", "rapier"];
const HAFTED: WeaponForm[] = ["axe", "hammer", "warhammer", "mace", "flail"];
const POLEARM: WeaponForm[] = ["spear", "halberd", "scythe"];

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

  if (BLADED.includes(style.form)) composeBladed(ctx, style, p, time);
  else if (HAFTED.includes(style.form)) composeHafted(ctx, style, p, time);
  else if (POLEARM.includes(style.form)) composePolearm(ctx, style, p, time);
  else if (style.form === "claw") composeClaw(ctx, style, p);
  else if (style.form === "fist") composeFist(ctx, style, p);
  else if (style.form === "gauntlet") composeGauntlet(ctx, style, p);
  else composeSpecial(ctx, style, p, time);

  drawElementFX(ctx, style, time);
  ctx.restore();
}
