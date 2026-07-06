import type { CharacterSpec, GearKind } from "../types/character";
import type { Fighter } from "./stickman";
import { materialColor } from "./stickman";
import { shade, withAlpha } from "../render/color";

/**
 * FUNCTIONAL GEAR registry — every kind pairs a drawn look with a mechanical
 * effect, and only appears when the prompt grants it (LLM-emitted or enrich
 * keyword backstop). Extensible: add a kind here (draw + numbers) and it
 * works everywhere — renderFighter draws it, combat reads the numbers.
 *
 * Also home of the parametric HEADGEAR shape set: the reliable keyword
 * fallback when the LLM doesn't author an onRenderHead program.
 */

interface GearDef {
  /** Flat defense added to damage mitigation (armor). */
  defenseBonus: number;
  /** Extra mid-air jumps granted (wings). */
  airJumps: number;
  /** Drawn BEHIND the body (wings). */
  drawBack?: (ctx: CanvasRenderingContext2D, f: Fighter, time: number) => void;
  /** Drawn OVER the body (chest plate). */
  drawFront?: (ctx: CanvasRenderingContext2D, f: Fighter, time: number) => void;
}

export const GEAR_REGISTRY: Record<GearKind, GearDef> = {
  armor: { defenseBonus: 60, airJumps: 0, drawFront: drawArmor },
  wings: { defenseBonus: 0, airJumps: 1, drawBack: drawWings },
};

const gearOf = (spec: CharacterSpec): GearKind[] => (spec.appearance.gear ?? []).map((g) => g.kind);

export function gearDefenseBonus(spec: CharacterSpec): number {
  return Math.min(120, gearOf(spec).reduce((sum, k) => sum + GEAR_REGISTRY[k].defenseBonus, 0));
}

export function gearAirJumps(spec: CharacterSpec): number {
  return Math.min(2, gearOf(spec).reduce((sum, k) => sum + GEAR_REGISTRY[k].airJumps, 0));
}

export function drawGearBack(ctx: CanvasRenderingContext2D, f: Fighter, time: number): void {
  for (const k of gearOf(f.spec)) GEAR_REGISTRY[k].drawBack?.(ctx, f, time);
}

export function drawGearFront(ctx: CanvasRenderingContext2D, f: Fighter, time: number): void {
  for (const k of gearOf(f.spec)) GEAR_REGISTRY[k].drawFront?.(ctx, f, time);
}

// ---------------------------------------------------------------------------
// Gear drawing
// ---------------------------------------------------------------------------

/** Chest plate + shoulder pauldrons, material-tinted to the accent. */
function drawArmor(ctx: CanvasRenderingContext2D, f: Fighter, _time: number): void {
  const sk = f.skeleton;
  const s = f.scale;
  const plate = materialColor("metal", f.style.accent);
  const edge = shade(plate, 0.7);
  const mx = (sk.neck.x + sk.hips.x) / 2;
  const my = (sk.neck.y + sk.hips.y) / 2;
  const ang = Math.atan2(sk.hips.x - sk.neck.x, -(sk.hips.y - sk.neck.y));
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(ang);
  // Chest plate: tapered slab over the torso.
  ctx.fillStyle = plate;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-7 * s, -11 * s);
  ctx.lineTo(7 * s, -11 * s);
  ctx.lineTo(5.5 * s, 10 * s);
  ctx.lineTo(-5.5 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Center ridge.
  ctx.strokeStyle = shade(plate, 1.25);
  ctx.beginPath();
  ctx.moveTo(0, -10 * s);
  ctx.lineTo(0, 9 * s);
  ctx.stroke();
  ctx.restore();
  // Pauldrons: domes on each shoulder (at the neck joint, offset out).
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(sk.neck.x + side * 6.5 * s, sk.neck.y + 1 * s);
    ctx.fillStyle = plate;
    ctx.strokeStyle = edge;
    ctx.beginPath();
    ctx.arc(0, 0, 5.2 * s, Math.PI * 0.95, Math.PI * 2.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** Back wings: spread when airborne, drooping at rest, slight flap. */
function drawWings(ctx: CanvasRenderingContext2D, f: Fighter, time: number): void {
  const sk = f.skeleton;
  const s = f.scale;
  const color = withAlpha(f.style.glow, 0.75);
  const inner = withAlpha(shade(f.style.glow, 1.4), 0.85);
  const spread = f.grounded ? 0.35 : 1; // open up in the air
  const flap = Math.sin(time * (f.grounded ? 2 : 9)) * 0.15 * spread;
  const bx = sk.neck.x - f.facing * 3 * s;
  const by = sk.neck.y + 3 * s;
  for (const side of [-1, 1]) {
    const dir = -f.facing; // wings sweep behind the fighter
    const tilt = (-0.5 - 0.9 * spread) * side * 0 + flap; // vertical fan per side
    ctx.save();
    ctx.translate(bx, by);
    // Wing membrane: three feather lobes fanning back-up (side = upper/lower).
    const baseAng = dir > 0 ? Math.PI : 0;
    const lift = (side < 0 ? -0.85 : -0.35) * spread + 0.25 + tilt;
    ctx.rotate(baseAng + (dir > 0 ? -lift : lift));
    const L = (side < 0 ? 26 : 20) * s * (0.6 + 0.4 * spread);
    ctx.fillStyle = side < 0 ? color : inner;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(L * 0.55, -L * 0.42, L, -L * 0.14);
    ctx.quadraticCurveTo(L * 0.62, L * 0.1, L * 0.42, L * 0.06);
    ctx.quadraticCurveTo(L * 0.32, L * 0.22, 0, L * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Headgear: keyword-derived parametric shapes (the reliable fallback)
// ---------------------------------------------------------------------------

export const HEADGEAR_KINDS = [
  "viking", "knight", "wizard", "cowboy", "crown", "tophat", "plague",
  "kabuto", "ninja", "tricorn", "toque", "halo", "horns", "gasmask", "hood",
] as const;
export type HeadgearKind = (typeof HEADGEAR_KINDS)[number];

/** Keyword → shape. First match wins; order = specificity. */
const HEADGEAR_KEYWORDS: [RegExp, HeadgearKind][] = [
  [/viking|norse|valhalla|berserk/i, "viking"],
  [/samurai|ronin|shogun|kabuto/i, "kabuto"],
  [/ninja|shinobi/i, "ninja"],
  [/plague|beak(ed)? mask/i, "plague"],
  [/knight|paladin|crusader|great-?helm/i, "knight"],
  [/wizard|mage|sorcer|warlock|witch/i, "wizard"],
  [/cowboy|sheriff|gunslinger|ranch/i, "cowboy"],
  [/king|queen|royal|monarch|emperor|empress|prince(ss)?/i, "crown"],
  [/baron|dapper|gentleman|butler|magician|top ?hat/i, "tophat"],
  [/pirate|corsair|buccaneer|tricorn/i, "tricorn"],
  [/chef|cook|baker|barista/i, "toque"],
  [/angel|seraph|celestial|halo/i, "halo"],
  [/demon|devil|imp|infernal|hellspawn/i, "horns"],
  [/gas ?mask|apocalyp|wasteland|raider|fallout/i, "gasmask"],
  [/monk|reaper|cultist|hooded|assassin/i, "hood"],
];

export function headgearFromText(text: string): HeadgearKind | null {
  for (const [re, kind] of HEADGEAR_KEYWORDS) if (re.test(text)) return kind;
  return null;
}

/**
 * Draw a headgear shape anchored to the head joint. Flat solid fills in the
 * fighter's accent/glow palette — same visual language as the body.
 */
export function drawHeadgear(
  ctx: CanvasRenderingContext2D,
  f: Fighter,
  kind: HeadgearKind,
  _time: number,
): void {
  const sk = f.skeleton;
  const s = f.scale;
  const r = 9.2 * s; // head radius (post-v4.1 beef-up)
  const main = materialColor("metal", f.style.accent);
  const cloth = f.style.accent;
  const dark = shade(f.style.fill, 0.55);
  ctx.save();
  ctx.translate(sk.head.x, sk.head.y);
  ctx.rotate(sk.torsoAngle * 1.1);
  const F = f.facing;
  const fill = (c: string) => {
    ctx.fillStyle = c;
    ctx.fill();
  };
  switch (kind) {
    case "viking": {
      // Skull cap + two out-curving horns.
      ctx.beginPath();
      ctx.arc(0, -r * 0.12, r * 1.02, Math.PI, 0);
      fill(main);
      ctx.fillRect(-r * 1.02, -r * 0.22, r * 2.04, r * 0.24);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.82, -r * 0.5);
        ctx.quadraticCurveTo(side * r * 1.7, -r * 0.9, side * r * 1.5, -r * 1.9);
        ctx.quadraticCurveTo(side * r * 1.25, -r * 1.05, side * r * 0.55, -r * 0.88);
        ctx.closePath();
        fill("#e8e2d4");
      }
      break;
    }
    case "knight": {
      // Full great-helm with a visor slit.
      ctx.beginPath();
      ctx.arc(0, -r * 0.05, r * 1.08, Math.PI * 0.95, Math.PI * 2.05);
      ctx.lineTo(r * 1.05, r * 0.75);
      ctx.lineTo(-r * 1.05, r * 0.75);
      ctx.closePath();
      fill(main);
      ctx.fillStyle = dark;
      ctx.fillRect(F > 0 ? -r * 0.1 : -r * 0.95, -r * 0.28, r * 1.05, r * 0.22);
      // Plume nub.
      ctx.beginPath();
      ctx.arc(0, -r * 1.15, r * 0.22, 0, Math.PI * 2);
      fill(cloth);
      break;
    }
    case "wizard": {
      // Tall pointed hat, slightly bent tip + brim.
      ctx.beginPath();
      ctx.moveTo(-r * 1.05, -r * 0.5);
      ctx.quadraticCurveTo(-r * 0.1, -r * 0.9, F * r * 0.55, -r * 2.6);
      ctx.quadraticCurveTo(F * r * 0.15, -r * 1.1, r * 1.05, -r * 0.5);
      ctx.closePath();
      fill(cloth);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.48, r * 1.35, r * 0.28, 0, 0, Math.PI * 2);
      fill(shade(cloth, 0.75));
      break;
    }
    case "cowboy": {
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.55, r * 1.55, r * 0.32, 0, 0, Math.PI * 2);
      fill(cloth);
      ctx.beginPath();
      ctx.arc(0, -r * 0.55, r * 0.78, Math.PI, 0);
      fill(shade(cloth, 1.15));
      ctx.fillRect(-r * 0.78, -r * 0.62, r * 1.56, r * 0.12);
      break;
    }
    case "crown": {
      ctx.beginPath();
      ctx.moveTo(-r * 0.85, -r * 0.45);
      for (let i = 0; i < 4; i++) {
        const x0 = -r * 0.85 + (i * r * 1.7) / 3.0;
        ctx.lineTo(x0 + r * 0.28, -r * 1.25);
        ctx.lineTo(x0 + r * 0.56, -r * 0.45);
      }
      ctx.lineTo(r * 0.85, -r * 0.05);
      ctx.lineTo(-r * 0.85, -r * 0.05);
      ctx.closePath();
      fill("#e8b33c");
      break;
    }
    case "tophat": {
      ctx.fillStyle = dark;
      ctx.fillRect(-r * 0.75, -r * 2.1, r * 1.5, r * 1.6);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.5, r * 1.25, r * 0.24, 0, 0, Math.PI * 2);
      fill(dark);
      ctx.fillStyle = cloth;
      ctx.fillRect(-r * 0.75, -r * 0.85, r * 1.5, r * 0.3);
      break;
    }
    case "plague": {
      // Beaked mask + round goggle.
      ctx.beginPath();
      ctx.arc(0, -r * 0.1, r * 1.02, Math.PI * 0.9, Math.PI * 2.1);
      fill(dark);
      ctx.beginPath();
      ctx.moveTo(F * r * 0.3, -r * 0.15);
      ctx.quadraticCurveTo(F * r * 1.5, r * 0.05, F * r * 1.9, r * 0.55);
      ctx.quadraticCurveTo(F * r * 1.1, r * 0.5, F * r * 0.2, r * 0.55);
      ctx.closePath();
      fill(dark);
      ctx.beginPath();
      ctx.arc(F * r * 0.42, -r * 0.15, r * 0.26, 0, Math.PI * 2);
      fill("#c9ced9");
      break;
    }
    case "kabuto": {
      // Samurai helm: bowl + flared neck guard + crest.
      ctx.beginPath();
      ctx.arc(0, -r * 0.15, r * 1.06, Math.PI, 0);
      fill(main);
      ctx.beginPath();
      ctx.moveTo(-r * 1.06, -r * 0.15);
      ctx.lineTo(-r * 1.35, r * 0.45);
      ctx.lineTo(r * 1.35, r * 0.45);
      ctx.lineTo(r * 1.06, -r * 0.15);
      ctx.closePath();
      fill(shade(main, 0.8));
      // Maedate crest.
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9);
      ctx.lineTo(-r * 0.5, -r * 1.7);
      ctx.lineTo(0, -r * 1.25);
      ctx.lineTo(r * 0.5, -r * 1.7);
      ctx.closePath();
      fill("#e8b33c");
      break;
    }
    case "ninja": {
      // Wrap mask + trailing headband.
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.02, Math.PI * 1.15, Math.PI * 1.85);
      ctx.lineTo(r * 1.02, r * 0.5);
      ctx.lineTo(-r * 1.02, r * 0.5);
      ctx.closePath();
      fill(dark);
      ctx.fillStyle = cloth;
      ctx.fillRect(-r * 1.02, -r * 0.5, r * 2.04, r * 0.3);
      ctx.beginPath();
      ctx.moveTo(-F * r * 0.95, -r * 0.4);
      ctx.lineTo(-F * r * 1.9, -r * 0.1);
      ctx.lineTo(-F * r * 1.6, -r * 0.55);
      ctx.closePath();
      fill(cloth);
      break;
    }
    case "tricorn": {
      ctx.beginPath();
      ctx.moveTo(-r * 1.4, -r * 0.45);
      ctx.quadraticCurveTo(0, -r * 1.5, r * 1.4, -r * 0.45);
      ctx.quadraticCurveTo(0, -r * 0.75, -r * 1.4, -r * 0.45);
      ctx.closePath();
      fill(dark);
      ctx.beginPath();
      ctx.arc(F * r * 0.45, -r * 0.85, r * 0.16, 0, Math.PI * 2);
      fill("#e8b33c");
      break;
    }
    case "toque": {
      ctx.fillStyle = "#f2f0e4";
      ctx.fillRect(-r * 0.8, -r * 1.05, r * 1.6, r * 0.55);
      ctx.beginPath();
      ctx.ellipse(-r * 0.4, -r * 1.35, r * 0.45, r * 0.5, 0, 0, Math.PI * 2);
      ctx.ellipse(r * 0.05, -r * 1.5, r * 0.5, r * 0.55, 0, 0, Math.PI * 2);
      ctx.ellipse(r * 0.5, -r * 1.32, r * 0.42, r * 0.48, 0, 0, Math.PI * 2);
      fill("#f2f0e4");
      break;
    }
    case "halo": {
      ctx.strokeStyle = "#ffe6a3";
      ctx.lineWidth = 2.5 * s;
      ctx.shadowColor = "#ffe6a3";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.ellipse(0, -r * 1.6, r * 0.85, r * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "horns": {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.55, -r * 0.6);
        ctx.quadraticCurveTo(side * r * 1.15, -r * 1.15, side * r * 0.75, -r * 1.9);
        ctx.quadraticCurveTo(side * r * 0.75, -r * 1.1, side * r * 0.25, -r * 0.92);
        ctx.closePath();
        fill(shade(f.style.fill, 0.45));
      }
      break;
    }
    case "gasmask": {
      ctx.beginPath();
      ctx.arc(F * r * 0.15, r * 0.1, r * 0.85, 0, Math.PI * 2);
      fill(dark);
      ctx.beginPath();
      ctx.arc(F * r * 0.42, -r * 0.18, r * 0.3, 0, Math.PI * 2);
      fill("#9ba69e");
      ctx.beginPath();
      ctx.arc(F * r * 0.55, r * 0.45, r * 0.34, 0, Math.PI * 2);
      fill(shade(dark, 1.5));
      break;
    }
    case "hood": {
      ctx.beginPath();
      ctx.arc(0, -r * 0.05, r * 1.25, Math.PI * 0.85, Math.PI * 2.15);
      ctx.quadraticCurveTo(F * r * 0.9, r * 0.9, F * r * 0.4, r * 1.0);
      ctx.lineTo(-F * r * 1.1, r * 0.9);
      ctx.closePath();
      fill(shade(cloth, 0.6));
      break;
    }
  }
  ctx.restore();
}
