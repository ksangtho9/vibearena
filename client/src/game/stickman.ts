import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";

/**
 * Ragdoll stickman: head, torso, two arms, two legs, held together with
 * constraints. While alive the torso has infinite inertia (it stays upright
 * and controllable) and the limbs dangle with real physics. On death the
 * torso's inertia is restored and the whole thing collapses into a ragdoll.
 */

export type Side = "player" | "bot";

export interface Limb {
  body: Matter.Body;
  halfLen: number;
}

export interface FighterBuffs {
  speedMul: number;
  strengthMul: number;
}

export interface Fighter {
  spec: CharacterSpec;
  side: Side;
  color: string;
  scale: number;
  facing: 1 | -1;

  root: Matter.Body;
  head: Matter.Body;
  arms: [Limb, Limb]; // [left, right] — right hand holds the weapon
  legs: [Limb, Limb];
  /** Bodies that count as "hit me here". */
  hittable: Matter.Body[];
  constraints: Matter.Constraint[];

  hp: number;
  maxHp: number;
  alive: boolean;
  grounded: boolean;

  // Countdown timers, in seconds.
  attackCooldown: number;
  attackWindow: number;
  hasHitThisSwing: boolean;
  jumpCooldown: number;
  abilityCooldown: number;
  shieldTimer: number;
  buffTimer: number;
  introTimer: number;

  buffs: FighterBuffs;
  savedInertia: number;
}

/** Untrusted LLM color → renderable color, or chalk white. */
export function safeCssColor(color: string, fallback = "#f2f0e4"): string {
  const trimmed = color.trim();
  if (typeof CSS !== "undefined" && CSS.supports("color", trimmed)) return trimmed;
  return fallback;
}

const COLLISION_GROUP: Record<Side, number> = { player: -1, bot: -2 };

export function createFighter(
  world: Matter.World,
  spec: CharacterSpec,
  x: number,
  groundY: number,
  side: Side,
): Fighter {
  const s = spec.appearance.height; // already clamped to 0.8–1.2 by the balancer
  const group = COLLISION_GROUP[side];
  const filter = { group };

  const rootHalfH = 44 * s;
  const rootY = groundY - rootHalfH;
  const headR = 11 * s;
  const armLen = 30 * s;
  const legLen = 34 * s;
  const shoulderY = -26 * s; // offsets from root center
  const hipY = 14 * s;

  const root = Matter.Bodies.rectangle(x, rootY, 16 * s, rootHalfH * 2, {
    collisionFilter: filter,
    density: 0.004,
    friction: 0.05,
    frictionAir: 0.015,
    restitution: 0,
    label: `${side}-root`,
  });
  const savedInertia = root.inertia;
  Matter.Body.setInertia(root, Infinity); // stands upright until it dies

  const head = Matter.Bodies.circle(x, rootY - rootHalfH - headR * 0.7, headR, {
    collisionFilter: filter,
    density: 0.0015,
    frictionAir: 0.02,
    label: `${side}-head`,
  });

  const limb = (
    lx: number,
    ly: number,
    thickness: number,
    length: number,
    label: string,
  ): Limb => ({
    body: Matter.Bodies.rectangle(lx, ly + length / 2, thickness, length, {
      collisionFilter: filter,
      density: 0.0008,
      frictionAir: 0.03,
      friction: 0.4,
      label,
    }),
    halfLen: length / 2,
  });

  const arms: [Limb, Limb] = [
    limb(x - 3 * s, rootY + shoulderY, 5 * s, armLen, `${side}-arm-l`),
    limb(x + 3 * s, rootY + shoulderY, 5 * s, armLen, `${side}-arm-r`),
  ];
  const legs: [Limb, Limb] = [
    limb(x - 4 * s, rootY + hipY, 6 * s, legLen, `${side}-leg-l`),
    limb(x + 4 * s, rootY + hipY, 6 * s, legLen, `${side}-leg-r`),
  ];

  const pin = (
    bodyB: Matter.Body,
    pointA: Matter.Vector,
    pointB: Matter.Vector,
    stiffness = 0.9,
  ): Matter.Constraint =>
    Matter.Constraint.create({
      bodyA: root,
      bodyB,
      pointA,
      pointB,
      length: 0,
      stiffness,
      damping: 0.1,
    });

  /** Soft spring that keeps a dangling limb loosely at rest — the jiggle. */
  const restSpring = (
    limbOf: Limb,
    anchorOnRoot: Matter.Vector,
    stiffness: number,
  ): Matter.Constraint =>
    Matter.Constraint.create({
      bodyA: root,
      bodyB: limbOf.body,
      pointA: anchorOnRoot,
      pointB: { x: 0, y: limbOf.halfLen },
      length: 8 * s,
      stiffness,
      damping: 0.05,
    });

  const constraints = [
    // Neck: head bobbles above the torso.
    pin(head, { x: 0, y: -rootHalfH }, { x: 0, y: headR * 0.7 }, 0.7),
    // Shoulders and hips.
    pin(arms[0].body, { x: -3 * s, y: shoulderY }, { x: 0, y: -arms[0].halfLen }),
    pin(arms[1].body, { x: 3 * s, y: shoulderY }, { x: 0, y: -arms[1].halfLen }),
    pin(legs[0].body, { x: -4 * s, y: hipY }, { x: 0, y: -legs[0].halfLen }),
    pin(legs[1].body, { x: 4 * s, y: hipY }, { x: 0, y: -legs[1].halfLen }),
    // Rest springs so limbs hang instead of flailing.
    restSpring(arms[0], { x: -9 * s, y: shoulderY + armLen * 0.8 }, 0.012),
    restSpring(arms[1], { x: 9 * s, y: shoulderY + armLen * 0.8 }, 0.012),
    restSpring(legs[0], { x: -6 * s, y: rootHalfH }, 0.02),
    restSpring(legs[1], { x: 6 * s, y: rootHalfH }, 0.02),
  ];

  const bodies = [root, head, arms[0].body, arms[1].body, legs[0].body, legs[1].body];
  Matter.Composite.add(world, [...bodies, ...constraints]);

  return {
    spec,
    side,
    color: safeCssColor(spec.appearance.color),
    scale: s,
    facing: side === "player" ? 1 : -1,
    root,
    head,
    arms,
    legs,
    hittable: bodies,
    constraints,
    hp: maxHpOf(spec),
    maxHp: maxHpOf(spec),
    alive: true,
    grounded: false,
    attackCooldown: 0,
    attackWindow: 0,
    hasHitThisSwing: false,
    jumpCooldown: 0,
    abilityCooldown: 0,
    shieldTimer: 0,
    buffTimer: 0,
    introTimer: 0,
    buffs: { speedMul: 1, strengthMul: 1 },
    savedInertia,
  };
}

export function maxHpOf(spec: CharacterSpec): number {
  return Math.round(spec.stats.hp * 1.5);
}

/** Death: give the torso its inertia back and let physics have the body. */
export function collapse(fighter: Fighter): void {
  fighter.alive = false;
  Matter.Body.setInertia(fighter.root, fighter.savedInertia);
  Matter.Body.setAngularVelocity(fighter.root, -fighter.facing * (0.15 + Math.random() * 0.1));
}

// ---------------------------------------------------------------------------
// Chalk rendering
// ---------------------------------------------------------------------------

function limbEndpoints(l: Limb): [Matter.Vector, Matter.Vector] {
  const { position, angle } = l.body;
  const dx = -Math.sin(angle) * l.halfLen;
  const dy = Math.cos(angle) * l.halfLen;
  return [
    { x: position.x - dx, y: position.y - dy },
    { x: position.x + dx, y: position.y + dy },
  ];
}

function chalkLine(ctx: CanvasRenderingContext2D, a: Matter.Vector, b: Matter.Vector): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawWeapon(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Matter.Vector,
  armAngle: number,
): void {
  const { weapon } = fighter.spec;
  const s = fighter.scale;
  ctx.save();
  ctx.translate(hand.x, hand.y);
  if (weapon.type === "melee") {
    const len = Math.min(weapon.range * 0.42, 48) * s;
    ctx.beginPath();
    if (fighter.attackWindow > 0) {
      // Mid-swing: blade thrust flat toward the opponent.
      ctx.moveTo(0, 0);
      ctx.lineTo(fighter.facing * len, 0);
      ctx.moveTo(fighter.facing * 8 * s, -5 * s);
      ctx.lineTo(fighter.facing * 8 * s, 5 * s); // crossguard
    } else {
      // At rest: blade continues along the dangling arm's axis.
      ctx.rotate(armAngle);
      ctx.moveTo(0, 0);
      ctx.lineTo(0, len * 0.9);
      ctx.moveTo(-5 * s, 8 * s);
      ctx.lineTo(5 * s, 8 * s);
    }
    ctx.stroke();
  } else if (weapon.type === "ranged") {
    ctx.strokeRect(0, -3 * s, fighter.facing * 16 * s, 6 * s);
  } else {
    ctx.beginPath();
    ctx.arc(fighter.facing * 5 * s, 0, 5 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAccessories(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  time: number,
): void {
  const n = fighter.spec.appearance.accessories.length;
  const { head, root, scale: s } = fighter;
  if (n >= 1) {
    // Hat: brim + crown riding on the head.
    ctx.save();
    ctx.translate(head.position.x, head.position.y);
    ctx.rotate(head.angle);
    const r = 11 * s;
    chalkLine(ctx, { x: -r * 1.4, y: -r * 0.7 }, { x: r * 1.4, y: -r * 0.7 });
    ctx.strokeRect(-r * 0.75, -r * 1.7, r * 1.5, r);
    ctx.restore();
  }
  if (n >= 2) {
    // Cape: a lazy waving line off the back shoulder.
    const sway = Math.sin(time * 3 + fighter.root.position.x * 0.01) * 6;
    const sx = root.position.x - fighter.facing * 8 * s;
    const sy = root.position.y - 24 * s;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx - fighter.facing * 18 * s + sway,
      sy + 22 * s,
      sx - fighter.facing * 12 * s - sway,
      sy + 44 * s,
    );
    ctx.stroke();
  }
  if (n >= 3) {
    // Belt.
    const y = root.position.y + 10 * s;
    chalkLine(
      ctx,
      { x: root.position.x - 9 * s, y },
      { x: root.position.x + 9 * s, y },
    );
  }
}

export function renderFighter(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  time: number,
): void {
  const { root, head, scale: s } = fighter;
  ctx.save();
  ctx.strokeStyle = fighter.color;
  ctx.lineWidth = 4 * s;
  ctx.lineCap = "round";
  ctx.globalAlpha = fighter.alive ? 0.95 : 0.65;

  // Torso along the root body's axis.
  const dx = -Math.sin(root.angle);
  const dy = Math.cos(root.angle);
  const torsoHalf = 30 * s;
  chalkLine(
    ctx,
    { x: root.position.x - dx * torsoHalf, y: root.position.y - dy * torsoHalf },
    { x: root.position.x + dx * torsoHalf, y: root.position.y + dy * torsoHalf },
  );

  // Limbs.
  for (const leg of fighter.legs) {
    const [a, b] = limbEndpoints(leg);
    chalkLine(ctx, a, b);
  }
  for (const arm of fighter.arms) {
    const [a, b] = limbEndpoints(arm);
    chalkLine(ctx, a, b);
  }

  // Head + face.
  ctx.beginPath();
  ctx.arc(head.position.x, head.position.y, 11 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(head.position.x, head.position.y);
  ctx.rotate(head.angle);
  ctx.lineWidth = 2 * s;
  const eyeX = fighter.facing * 4 * s;
  if (fighter.alive) {
    ctx.beginPath();
    ctx.arc(eyeX, -2 * s, 1.6 * s, 0, Math.PI * 2);
    ctx.arc(eyeX * 0.2, -2 * s, 1.6 * s, 0, Math.PI * 2);
    ctx.fillStyle = fighter.color;
    ctx.fill();
  } else {
    // X eyes.
    for (const ox of [eyeX, eyeX * 0.2]) {
      chalkLine(ctx, { x: ox - 2 * s, y: -4 * s }, { x: ox + 2 * s, y: 0 });
      chalkLine(ctx, { x: ox + 2 * s, y: -4 * s }, { x: ox - 2 * s, y: 0 });
    }
  }
  ctx.restore();

  // Weapon in the right hand.
  const [, weaponHandEnd] = limbEndpoints(fighter.arms[1]);
  ctx.lineWidth = 3 * s;
  drawWeapon(ctx, fighter, weaponHandEnd, fighter.arms[1].body.angle);

  ctx.lineWidth = 2.5 * s;
  drawAccessories(ctx, fighter, time);

  // Shield ring.
  if (fighter.shieldTimer > 0) {
    ctx.globalAlpha = 0.35 + 0.2 * Math.sin(time * 10);
    ctx.beginPath();
    ctx.arc(root.position.x, root.position.y - 10 * s, 58 * s, 0, Math.PI * 2);
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Buff sparks.
  if (fighter.buffTimer > 0) {
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < 3; i++) {
      const a = time * 6 + (i * Math.PI * 2) / 3;
      const px = root.position.x + Math.cos(a) * 30 * s;
      const py = root.position.y - 20 * s + Math.sin(a) * 40 * s;
      chalkLine(ctx, { x: px - 3, y: py }, { x: px + 3, y: py });
    }
  }

  ctx.restore();
}

/**
 * Static chalk portrait for the preview card — no physics, just the pose.
 */
export function drawStickmanPreview(
  ctx: CanvasRenderingContext2D,
  spec: CharacterSpec,
  w: number,
  h: number,
): void {
  const s = spec.appearance.height;
  const cx = w / 2;
  const groundY = h * 0.88;
  const color = safeCssColor(spec.appearance.color);
  const u = (h / 180) * s; // unit scale fitted to the canvas

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = 4 * u;

  const hipY = groundY - 48 * u;
  const shoulderY = hipY - 40 * u;
  const headR = 11 * u;

  // Ground scuff.
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(cx - 42 * u, groundY);
  ctx.lineTo(cx + 42 * u, groundY);
  ctx.stroke();
  ctx.globalAlpha = 0.95;

  // Legs (slight stance), torso, arms (right arm raised with weapon).
  ctx.beginPath();
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx - 14 * u, groundY);
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx + 14 * u, groundY);
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx, shoulderY);
  ctx.moveTo(cx, shoulderY + 6 * u);
  ctx.lineTo(cx - 20 * u, shoulderY + 24 * u); // left arm down
  ctx.moveTo(cx, shoulderY + 6 * u);
  ctx.lineTo(cx + 22 * u, shoulderY - 6 * u); // right arm up, holds weapon
  ctx.stroke();

  // Head.
  ctx.beginPath();
  ctx.arc(cx, shoulderY - headR, headR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 4 * u, shoulderY - headR - 2 * u, 1.6 * u, 0, Math.PI * 2);
  ctx.arc(cx + 0.5 * u, shoulderY - headR - 2 * u, 1.6 * u, 0, Math.PI * 2);
  ctx.fill();

  // Weapon in the raised hand.
  const hx = cx + 22 * u;
  const hy = shoulderY - 6 * u;
  ctx.lineWidth = 3 * u;
  ctx.beginPath();
  if (spec.weapon.type === "melee") {
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + 26 * u, hy - 26 * u);
    ctx.moveTo(hx + 4 * u, hy - 10 * u);
    ctx.lineTo(hx + 11 * u, hy - 3 * u);
  } else if (spec.weapon.type === "ranged") {
    ctx.rect(hx, hy - 4 * u, 18 * u, 7 * u);
  } else {
    ctx.arc(hx + 6 * u, hy - 4 * u, 6 * u, 0, Math.PI * 2);
  }
  ctx.stroke();

  // Hat if they earned one.
  if (spec.appearance.accessories.length > 0) {
    ctx.lineWidth = 2.5 * u;
    const hatY = shoulderY - headR * 2 - 2 * u;
    ctx.beginPath();
    ctx.moveTo(cx - headR * 1.5, hatY + 2 * u);
    ctx.lineTo(cx + headR * 1.5, hatY + 2 * u);
    ctx.stroke();
    ctx.strokeRect(cx - headR * 0.75, hatY - headR, headR * 1.5, headR);
  }
}
