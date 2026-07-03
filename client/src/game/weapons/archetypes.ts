import type { WeaponArchetypeId } from "../../types/character";
import { mix, shade, withAlpha } from "../../render/color";

/**
 * Drawn vector weapon templates. Local space: the GRIP (where the hand holds
 * it) sits at the origin and the business end points along +X. Sizes are in
 * px at fighter scale 1 — the renderer applies the fighter's scale.
 *
 * Every template is procedural canvas drawing (no assets) and tints itself
 * toward the fighter's accent color, with an outer glow in the VFX color.
 */

export interface WeaponStyle {
  /** Fighter body fill — used to tie wood/cloth parts to the character. */
  fill: string;
  accent: string;
  glow: string;
  outline: string;
}

export interface ArchetypeDef {
  /** How far past the grip the weapon reaches — used for swing-trail tips. */
  tip: number;
  /** True for weapons that should not rotate with the arm (orbs float). */
  floating?: boolean;
  draw(ctx: CanvasRenderingContext2D, style: WeaponStyle, time: number): void;
}

const steel = (s: WeaponStyle) => mix("#ccd3de", s.accent, 0.3);
const steelEdge = (s: WeaponStyle) => mix("#f0f4fa", s.glow, 0.35);
const wood = (s: WeaponStyle) => mix("#7a5a3c", s.fill, 0.25);

function glowOn(ctx: CanvasRenderingContext2D, s: WeaponStyle, blur = 10): void {
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = blur;
}

function glowOff(ctx: CanvasRenderingContext2D): void {
  ctx.shadowBlur = 0;
}

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function strokedFill(ctx: CanvasRenderingContext2D, fill: string, outline: string): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

export const ARCHETYPES: Record<WeaponArchetypeId, ArchetypeDef> = {
  sword: {
    tip: 50,
    draw(ctx, s) {
      // Hilt + pommel behind the grip.
      ctx.beginPath();
      ctx.roundRect(-10, -2, 13, 4, 2);
      strokedFill(ctx, shade(wood(s), 0.7), s.outline);
      ctx.beginPath();
      ctx.arc(-11, 0, 2.8, 0, Math.PI * 2);
      strokedFill(ctx, s.accent, s.outline);
      // Crossguard.
      ctx.beginPath();
      ctx.roundRect(3, -8, 4.5, 16, 2);
      strokedFill(ctx, s.accent, s.outline);
      // Blade with glow, edge highlight and a center ridge.
      glowOn(ctx, s, 12);
      poly(ctx, [[7, -3.6], [42, -2.4], [50, 0], [42, 2.4], [7, 3.6]]);
      strokedFill(ctx, steel(s), s.outline);
      glowOff(ctx);
      poly(ctx, [[7, -3.6], [42, -2.4], [50, 0], [43, -0.4], [7, -0.6]]);
      ctx.fillStyle = steelEdge(s);
      ctx.fill();
      ctx.strokeStyle = withAlpha(s.glow, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(44, 0);
      ctx.stroke();
    },
  },

  spear: {
    tip: 62,
    draw(ctx, s) {
      // Long shaft, back-weighted.
      ctx.beginPath();
      ctx.roundRect(-18, -2, 56, 4, 2);
      strokedFill(ctx, wood(s), s.outline);
      // Binding wraps near the head.
      ctx.fillStyle = s.accent;
      ctx.fillRect(32, -2.6, 2.4, 5.2);
      ctx.fillRect(36, -2.6, 2.4, 5.2);
      // Leaf-shaped head.
      glowOn(ctx, s, 11);
      poly(ctx, [[38, 0], [45, -4.6], [62, 0], [45, 4.6]]);
      strokedFill(ctx, steel(s), s.outline);
      glowOff(ctx);
      poly(ctx, [[38, 0], [45, -4.6], [62, 0], [46, -0.8]]);
      ctx.fillStyle = steelEdge(s);
      ctx.fill();
    },
  },

  staff: {
    tip: 46,
    draw(ctx, s, t) {
      // Gnarled shaft.
      ctx.beginPath();
      ctx.roundRect(-20, -2.4, 56, 4.8, 2.4);
      strokedFill(ctx, shade(wood(s), 0.85), s.outline);
      ctx.fillStyle = s.accent;
      ctx.fillRect(26, -3, 2.6, 6);
      // Floating focus orb with a pulsing halo.
      const pulse = 0.7 + 0.3 * Math.sin(t * 4);
      ctx.strokeStyle = withAlpha(s.glow, 0.35 * pulse);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(42, 0, 10 + pulse * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      glowOn(ctx, s, 14);
      ctx.beginPath();
      ctx.arc(42, 0, 6.5, 0, Math.PI * 2);
      strokedFill(ctx, mix(s.glow, "#ffffff", 0.25), s.outline);
      glowOff(ctx);
      ctx.fillStyle = withAlpha("#ffffff", 0.7);
      ctx.beginPath();
      ctx.arc(40, -2, 2, 0, Math.PI * 2);
      ctx.fill();
    },
  },

  bow: {
    tip: 26,
    draw(ctx, s) {
      // String first, behind the limbs.
      ctx.strokeStyle = withAlpha("#f5f2e6", 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4, -27);
      ctx.lineTo(4, 27);
      ctx.stroke();
      // Recurve limbs.
      glowOn(ctx, s, 8);
      ctx.strokeStyle = wood(s);
      ctx.lineWidth = 4.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(4, -27);
      ctx.quadraticCurveTo(22, -14, 20, 0);
      ctx.quadraticCurveTo(22, 14, 4, 27);
      ctx.stroke();
      glowOff(ctx);
      ctx.strokeStyle = withAlpha(s.glow, 0.5);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(6, -24);
      ctx.quadraticCurveTo(21, -12, 19.5, 0);
      ctx.quadraticCurveTo(21, 12, 6, 24);
      ctx.stroke();
      // Accent-wrapped grip riser.
      ctx.beginPath();
      ctx.roundRect(15, -6, 6.5, 12, 3);
      strokedFill(ctx, s.accent, s.outline);
    },
  },

  thrown: {
    tip: 18,
    draw(ctx, s, t) {
      // Round bomb / flask body in the palm.
      glowOn(ctx, s, 9);
      ctx.beginPath();
      ctx.arc(9, 0, 7.5, 0, Math.PI * 2);
      strokedFill(ctx, mix("#3a3f4a", s.accent, 0.35), s.outline);
      glowOff(ctx);
      // Glass highlight.
      ctx.fillStyle = withAlpha("#ffffff", 0.35);
      ctx.beginPath();
      ctx.arc(6.5, -2.5, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // Cap + fuse with a flickering spark.
      ctx.beginPath();
      ctx.roundRect(7, -10.5, 4, 4, 1.2);
      strokedFill(ctx, s.accent, s.outline);
      ctx.strokeStyle = shade(wood(s), 0.8);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(9, -10.5);
      ctx.quadraticCurveTo(12, -14, 14, -13);
      ctx.stroke();
      const spark = 0.6 + 0.4 * Math.sin(t * 12);
      glowOn(ctx, s, 10);
      ctx.fillStyle = withAlpha(s.glow, spark);
      ctx.beginPath();
      ctx.arc(14.5, -13, 2 * spark + 0.8, 0, Math.PI * 2);
      ctx.fill();
      glowOff(ctx);
    },
  },

  shield: {
    tip: 16,
    draw(ctx, s) {
      // Rounded kite shield held ahead of the grip.
      glowOn(ctx, s, 7);
      ctx.beginPath();
      ctx.moveTo(8, -15);
      ctx.quadraticCurveTo(20, -12, 19, 2);
      ctx.quadraticCurveTo(18, 12, 8, 18);
      ctx.quadraticCurveTo(-2, 12, -3, 2);
      ctx.quadraticCurveTo(-4, -12, 8, -15);
      ctx.closePath();
      strokedFill(ctx, mix("#8d99ab", s.accent, 0.45), s.outline);
      glowOff(ctx);
      // Rim + boss + rivets.
      ctx.strokeStyle = withAlpha(s.glow, 0.5);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(8, -12);
      ctx.quadraticCurveTo(17, -9.5, 16.2, 2);
      ctx.quadraticCurveTo(15.4, 10, 8, 15);
      ctx.quadraticCurveTo(0.5, 10, -0.2, 2);
      ctx.quadraticCurveTo(-1, -9.5, 8, -12);
      ctx.closePath();
      ctx.stroke();
      glowOn(ctx, s, 9);
      ctx.beginPath();
      ctx.arc(8, 1, 3.6, 0, Math.PI * 2);
      strokedFill(ctx, s.glow, s.outline);
      glowOff(ctx);
      ctx.fillStyle = s.accent;
      for (const [rx, ry] of [[8, -8.5], [8, 11], [1.5, 1], [14.5, 1]] as const) {
        ctx.beginPath();
        ctx.arc(rx, ry, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  gauntlet: {
    tip: 12,
    draw(ctx, s) {
      // Chunky fist wrap around the hand itself.
      glowOn(ctx, s, 8);
      ctx.beginPath();
      ctx.roundRect(-4, -6.5, 15, 13, 4.5);
      strokedFill(ctx, mix("#9aa3b2", s.accent, 0.4), s.outline);
      glowOff(ctx);
      // Wrist band.
      ctx.beginPath();
      ctx.roundRect(-7, -5, 4, 10, 2);
      strokedFill(ctx, s.accent, s.outline);
      // Knuckle studs.
      glowOn(ctx, s, 6);
      ctx.fillStyle = s.glow;
      for (const ky of [-3.6, 0, 3.6]) {
        ctx.beginPath();
        ctx.arc(10, ky, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      glowOff(ctx);
      // Plate seams.
      ctx.strokeStyle = withAlpha(s.outline, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(2, -6.5);
      ctx.lineTo(2, 6.5);
      ctx.moveTo(6.5, -6.5);
      ctx.lineTo(6.5, 6.5);
      ctx.stroke();
    },
  },

  orb: {
    tip: 14,
    floating: true,
    draw(ctx, s, t) {
      const bob = Math.sin(t * 3) * 2.5;
      const y = -10 + bob;
      // Halo ring.
      const pulse = 0.6 + 0.4 * Math.sin(t * 4.5);
      ctx.strokeStyle = withAlpha(s.glow, 0.3 * pulse + 0.1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(8, y, 12 + pulse * 2, 0, Math.PI * 2);
      ctx.stroke();
      // Core sphere.
      glowOn(ctx, s, 16);
      ctx.beginPath();
      ctx.arc(8, y, 7.5, 0, Math.PI * 2);
      strokedFill(ctx, mix(s.glow, s.accent, 0.35), s.outline);
      glowOff(ctx);
      ctx.fillStyle = withAlpha("#ffffff", 0.6);
      ctx.beginPath();
      ctx.arc(5.5, y - 2.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
      // Two orbiting motes.
      ctx.fillStyle = withAlpha(s.glow, 0.9);
      for (const phase of [0, Math.PI]) {
        const a = t * 2.5 + phase;
        ctx.beginPath();
        ctx.arc(8 + Math.cos(a) * 12, y + Math.sin(a) * 4.5, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
};
