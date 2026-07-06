import type { Fighter } from "./stickman";
import type { CombatCtx } from "./combat";
import { pushEffect } from "./combat";
import { playSfx } from "../audio/sfx";

/**
 * Movement-primitive juice — dash, blink and leap/lunge share these helpers
 * so the engine verbs (api.ts), the legacy dash ability (abilities.ts) and
 * anything a behavior program authors all get the SAME afterimages, dust,
 * flashes and sounds from one place.
 *
 * Mechanics set here (read by combat.updateFighter):
 * - afterimageTimer: while > 0, ghost silhouettes are dropped along the path.
 * - dashPokeTimer:  while > 0, passing through the opponent lands ONE light
 *   hit + small knockback (gap-closer poke, deliberately weak).
 * - leapLandState:  armed → airborne → landing impact on touchdown.
 * - blinkVanishTimer: the fighter isn't drawn for a beat (mid-blink).
 */

/** Speed lines behind a burst of motion. */
function speedLines(ctx: CombatCtx, x: number, y: number, dir: number, color: string): void {
  for (let i = 0; i < 3; i++) {
    const oy = -34 + i * 16;
    pushEffect(ctx, {
      kind: "shape",
      shape: "line",
      x: x - dir * (18 + i * 8),
      y: y + oy,
      x2: x - dir * (66 + i * 14),
      y2: y + oy + 3,
      color,
      width: 2,
      ttl: 0.18,
    });
  }
}

/** Dust/energy puff at a point (launches, dashes, landings). */
function puff(ctx: CombatCtx, x: number, y: number, color: string, count: number, speed: number, up = -40): void {
  for (let i = 0; i < count; i++) {
    const a = Math.PI * (0.9 + 0.2 * Math.random()) + (i / count) * Math.PI * 0.2 - Math.PI * 0.1;
    pushEffect(ctx, {
      kind: "particle",
      x: x + (Math.random() - 0.5) * 14,
      y,
      vx: Math.cos(a) * speed * (0.5 + Math.random()),
      vy: up * (0.4 + Math.random() * 0.6),
      gravity: 160,
      size: 3 + Math.random() * 2.5,
      particleShape: "circle",
      color,
      ttl: 0.3 + Math.random() * 0.15,
    });
  }
}

/** Dash: dust puff + speed lines + afterimage trail + poke window + whoosh. */
export function dashJuice(f: Fighter, ctx: CombatCtx, glow?: string): void {
  const color = glow ?? f.style.glow;
  const { x, y } = f.root.position;
  puff(ctx, x - f.facing * 10, y + 34 * f.scale, color, 6, 60);
  speedLines(ctx, x, y, f.facing, color);
  f.afterimageTimer = Math.max(f.afterimageTimer, 0.26);
  f.dashPokeTimer = 0.22;
  f.dashPokeHit = false;
  playSfx("swing", { pitch: 1.2, volume: 0.85 });
}

/** Blink: implosion at origin, vanish, streak, flash + burst at destination. */
export function blinkJuice(
  f: Fighter,
  ctx: CombatCtx,
  from: { x: number; y: number },
  to: { x: number; y: number },
  glow?: string,
): void {
  const color = glow ?? f.style.glow;
  // Origin implosion: particles rush INTO the departure point.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = 26 + Math.random() * 10;
    pushEffect(ctx, {
      kind: "particle",
      x: from.x + Math.cos(a) * r,
      y: from.y - 20 + Math.sin(a) * r,
      vx: -Math.cos(a) * 160,
      vy: -Math.sin(a) * 160,
      gravity: 0,
      size: 2.5,
      particleShape: "spark",
      color,
      ttl: 0.16,
    });
  }
  // Thin streak connecting the two points.
  pushEffect(ctx, {
    kind: "shape",
    shape: "line",
    x: from.x,
    y: from.y - 20,
    x2: to.x,
    y2: to.y - 20,
    color,
    width: 1.5,
    ttl: 0.22,
  });
  // Destination: bright flash ring + outward burst.
  pushEffect(ctx, { kind: "ring", x: to.x, y: to.y - 20, ttl: 0.3, color: "#ffffff", radius: 6, expand: 220, width: 3 });
  pushEffect(ctx, { kind: "ring", x: to.x, y: to.y - 20, ttl: 0.4, color, radius: 4, expand: 130, width: 2.5 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    pushEffect(ctx, {
      kind: "particle",
      x: to.x,
      y: to.y - 20,
      vx: Math.cos(a) * 180,
      vy: Math.sin(a) * 180,
      gravity: 0,
      size: 2.5,
      particleShape: "spark",
      color,
      ttl: 0.22,
    });
  }
  f.blinkVanishTimer = 0.09;
  f.invulnTimer = Math.max(f.invulnTimer, 0.12); // a blink IS a dodge
  playSfx("zap", { pitch: 1.35, volume: 0.55 });
}

/** Leap/lunge: launch dust + airborne trail + armed landing impact. */
export function leapJuice(f: Fighter, ctx: CombatCtx, glow?: string, lunge = false): void {
  const color = glow ?? f.style.glow;
  const { x, y } = f.root.position;
  puff(ctx, x, y + 34 * f.scale, color, 8, 80);
  pushEffect(ctx, { kind: "ring", x, y: y + 30 * f.scale, ttl: 0.3, color, radius: 16, expand: 90, width: 2.5 });
  f.afterimageTimer = Math.max(f.afterimageTimer, 0.55);
  f.leapLandState = 1; // waiting for liftoff → airborne → impact
  if (lunge) {
    f.dashPokeTimer = 0.3;
    f.dashPokeHit = false;
  }
  playSfx("swing", { pitch: 0.7, volume: 0.8 });
}

/** Touchdown after a leap: dust ring + shockwave + thud. */
export function landingImpact(f: Fighter, ctx: CombatCtx): void {
  const color = f.style.glow;
  const { x, y } = f.root.position;
  const feet = y + 34 * f.scale;
  puff(ctx, x, feet, "#c9c2ae", 8, 110, -25);
  pushEffect(ctx, { kind: "ring", x, y: feet, ttl: 0.35, color, radius: 10, expand: 240, width: 3.5 });
  pushEffect(ctx, { kind: "ring", x, y: feet, ttl: 0.25, color: "#c9c2ae", radius: 6, expand: 140, width: 2 });
  playSfx("hitHeavy", { pitch: 0.85, volume: 0.5, element: f.style.element });
}
