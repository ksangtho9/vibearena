import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import { resolveStyle, type ResolvedStyle } from "../generation/enrich";
import { mix, parseColor, shade, withAlpha } from "../render/color";
import { ARCHETYPES, type WeaponStyle } from "./weapons/archetypes";
import {
  bonesFor,
  createAnimator,
  type Animator,
  type Bones,
  type Skeleton,
  type Vec,
} from "./animation";

// Re-exported for UI code that colors HP bars etc.
export { safeCssColor } from "../render/color";

/**
 * A fighter is ONE kinematic root capsule in Matter (collision, walking,
 * jumping, knockback) plus a Skeleton posed by the AnimationController every
 * step — skeletal animation is the source of truth for motion. Physics takes
 * over only for the KO ragdoll: on death a full multi-body ragdoll is spawned
 * seeded from the current pose and velocity, and rendering switches to it.
 *
 * Rendering is flat "animator" style: slim continuous tapered limbs drawn
 * from the skeleton joints (real IK elbows/knees), one uniform body color,
 * ground contact shadow only, weapon archetype attached to the hand joint.
 */

export type Side = "player" | "bot";

export interface FighterBuffs {
  speedMul: number;
  strengthMul: number;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

interface RagdollLimb {
  body: Matter.Body;
  halfLen: number;
}

export interface Ragdoll {
  torso: RagdollLimb;
  head: Matter.Body;
  armL: RagdollLimb;
  armR: RagdollLimb;
  legL: RagdollLimb;
  legR: RagdollLimb;
  all: Matter.Body[];
}

export interface Fighter {
  spec: CharacterSpec;
  side: Side;
  color: string;
  style: ResolvedStyle;
  scale: number;
  facing: 1 | -1;

  /** The only physics body during normal play. */
  root: Matter.Body;
  bones: Bones;
  animator: Animator;
  /** Last posed skeleton — combat reads hand joints, rendering draws it. */
  skeleton: Skeleton;
  weaponAngle: number;
  /** Spawned on KO; when set, rendering and shadows read from it. */
  ragdoll: Ragdoll | null;

  hp: number;
  maxHp: number;
  alive: boolean;
  grounded: boolean;

  // Countdown timers, in seconds.
  attackCooldown: number;
  /** Remaining time of the whole attack animation (windup+active+recovery). */
  attackAnim: number;
  /** >0 during the attack's ACTIVE frames (bot AI + trail read this). */
  attackWindow: number;
  hasHitThisSwing: boolean;
  projectileFired: boolean;
  jumpCooldown: number;
  abilityCooldown: number;
  shieldTimer: number;
  buffTimer: number;
  introTimer: number;
  hitstunTimer: number;
  launchedTimer: number;
  castTimer: number;

  buffs: FighterBuffs;
  trail: TrailPoint[];
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

  const root = Matter.Bodies.rectangle(x, groundY - 44 * s, 18 * s, 88 * s, {
    chamfer: { radius: 9 * s },
    collisionFilter: { group },
    inertia: Infinity, // kinematic capsule: never tips over
    density: 0.004,
    friction: 0.05,
    frictionAir: 0.015,
    restitution: 0,
    label: `${side}-root`,
  });
  Matter.Composite.add(world, root);

  const bones = bonesFor(s);
  const animator = createAnimator(bones);
  const facing: 1 | -1 = side === "player" ? 1 : -1;

  // Pose once so the skeleton is valid before the first step.
  const frame = animator.update(0, {
    rootX: x,
    rootY: groundY - 44 * s,
    vx: 0,
    vy: 0,
    grounded: true,
    facing,
    moving: false,
    alive: true,
    attackElapsed: -1,
    missileWeapon: spec.weapon.type !== "melee",
    castTimer: 0,
    hitstunTimer: 0,
    launchedTimer: 0,
    groundY,
    time: 0,
  });

  const style = resolveStyle(spec);

  return {
    spec,
    side,
    color: style.fill,
    style,
    scale: s,
    facing,
    root,
    bones,
    animator,
    skeleton: frame.skeleton,
    weaponAngle: frame.weaponAngle,
    ragdoll: null,
    hp: maxHpOf(spec),
    maxHp: maxHpOf(spec),
    alive: true,
    grounded: false,
    attackCooldown: 0,
    attackAnim: 0,
    attackWindow: 0,
    hasHitThisSwing: false,
    projectileFired: false,
    jumpCooldown: 0,
    abilityCooldown: 0,
    shieldTimer: 0,
    buffTimer: 0,
    introTimer: 0,
    hitstunTimer: 0,
    launchedTimer: 0,
    castTimer: 0,
    buffs: { speedMul: 1, strengthMul: 1 },
    trail: [],
  };
}

export function maxHpOf(spec: CharacterSpec): number {
  return Math.round(spec.stats.hp * 1.5);
}

/** X position that stays meaningful after death (camera, distances). */
export function fighterX(fighter: Fighter): number {
  return fighter.ragdoll ? fighter.ragdoll.torso.body.position.x : fighter.root.position.x;
}

// ---------------------------------------------------------------------------
// KO ragdoll: physics takes over from the animator
// ---------------------------------------------------------------------------

/** A limb body laid along from→to, so its endpoints match skeleton joints. */
function limbBody(
  from: Vec,
  to: Vec,
  thickness: number,
  group: number,
  label: string,
): RagdollLimb {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(8, Math.hypot(dx, dy));
  const body = Matter.Bodies.rectangle((from.x + to.x) / 2, (from.y + to.y) / 2, thickness, len, {
    collisionFilter: { group },
    density: 0.0008,
    frictionAir: 0.02,
    friction: 0.4,
    label,
  });
  Matter.Body.setAngle(body, Math.atan2(-dx / len, dy / len));
  return { body, halfLen: len / 2 };
}

/**
 * Death: spawn a full multi-body ragdoll seeded from the current skeleton
 * pose and the root's velocity, remove the kinematic capsule, and flop.
 */
export function collapse(fighter: Fighter, world: Matter.World): void {
  if (!fighter.alive) return;
  fighter.alive = false;

  const sk = fighter.skeleton;
  const s = fighter.scale;
  const group = fighter.root.collisionFilter.group ?? 0;
  const vel = fighter.root.velocity;
  const side = fighter.side;

  const torso = limbBody(sk.hips, sk.neck, 7 * s, group, `${side}-rag-torso`);
  const head = Matter.Bodies.circle(sk.head.x, sk.head.y, 8.5 * s, {
    collisionFilter: { group },
    density: 0.0015,
    frictionAir: 0.02,
    label: `${side}-rag-head`,
  });
  const armL = limbBody(sk.shoulderL, sk.handL, 4 * s, group, `${side}-rag-armL`);
  const armR = limbBody(sk.shoulderR, sk.handR, 4 * s, group, `${side}-rag-armR`);
  const legL = limbBody(sk.hipL, sk.footL, 5 * s, group, `${side}-rag-legL`);
  const legR = limbBody(sk.hipR, sk.footR, 5 * s, group, `${side}-rag-legR`);

  const pin = (
    a: Matter.Body,
    b: Matter.Body,
    pointA: Vec,
    pointB: Vec,
  ): Matter.Constraint =>
    Matter.Constraint.create({
      bodyA: a,
      bodyB: b,
      pointA,
      pointB,
      length: 0,
      stiffness: 0.9,
      damping: 0.1,
    });

  const local = (body: Matter.Body, world: Vec): Vec => {
    const c = Math.cos(-body.angle);
    const sn = Math.sin(-body.angle);
    const rx = world.x - body.position.x;
    const ry = world.y - body.position.y;
    return { x: rx * c - ry * sn, y: rx * sn + ry * c };
  };

  const constraints = [
    pin(torso.body, head, local(torso.body, sk.neck), local(head, sk.neck)),
    pin(torso.body, armL.body, local(torso.body, sk.shoulderL), { x: 0, y: -armL.halfLen }),
    pin(torso.body, armR.body, local(torso.body, sk.shoulderR), { x: 0, y: -armR.halfLen }),
    pin(torso.body, legL.body, local(torso.body, sk.hipL), { x: 0, y: -legL.halfLen }),
    pin(torso.body, legR.body, local(torso.body, sk.hipR), { x: 0, y: -legR.halfLen }),
  ];

  const all = [torso.body, head, armL.body, armR.body, legL.body, legR.body];
  for (const body of all) {
    Matter.Body.setVelocity(body, {
      x: vel.x + (Math.random() - 0.5) * 2,
      y: vel.y + (Math.random() - 0.5) * 2,
    });
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.4);
  }

  Matter.Composite.remove(world, fighter.root);
  Matter.Composite.add(world, [...all, ...constraints]);

  fighter.ragdoll = { torso, head, armL, armR, legL, legR, all };
}

function limbJoints(l: RagdollLimb): [Vec, Vec] {
  const { position, angle } = l.body;
  const dx = -Math.sin(angle) * l.halfLen;
  const dy = Math.cos(angle) * l.halfLen;
  return [
    { x: position.x - dx, y: position.y - dy },
    { x: position.x + dx, y: position.y + dy },
  ];
}

/** Rebuild a drawable skeleton from the ragdoll bodies (KO rendering). */
function skeletonFromRagdoll(r: Ragdoll, facing: 1 | -1): Skeleton {
  const [hips, neck] = limbJoints(r.torso);
  const [shL, handL] = limbJoints(r.armL);
  const [shR, handR] = limbJoints(r.armR);
  const [hipL, footL] = limbJoints(r.legL);
  const [hipR, footR] = limbJoints(r.legR);
  return {
    hips,
    neck,
    head: { x: r.head.position.x, y: r.head.position.y },
    torsoAngle: r.torso.body.angle,
    shoulderL: shL,
    elbowL: bendPoint(shL, handL, facing * 0.12),
    handL,
    shoulderR: shR,
    elbowR: bendPoint(shR, handR, facing * 0.12),
    handR,
    hipL,
    kneeL: bendPoint(hipL, footL, -facing * 0.1),
    footL,
    hipR,
    kneeR: bendPoint(hipR, footR, -facing * 0.1),
    footR,
  };
}

// ---------------------------------------------------------------------------
// Flat solid-fill rendering (Pass A style, driven by skeleton joints)
// ---------------------------------------------------------------------------

const TRAIL_SECONDS = 0.22;

/** Tapered capsule between two points: round-capped, r1 at p1 → r2 at p2. */
function capsulePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r1: number,
  r2: number,
): Path2D {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = new Path2D();
  p.arc(x1, y1, r1, a + Math.PI / 2, a - Math.PI / 2);
  p.arc(x2, y2, r2, a - Math.PI / 2, a + Math.PI / 2);
  p.closePath();
  return p;
}

function circlePath(x: number, y: number, r: number): Path2D {
  const p = new Path2D();
  p.arc(x, y, r, 0, Math.PI * 2);
  return p;
}

/**
 * ONE continuous smoothly-tapered stroke: a quadratic curve from `p0`
 * through the joint point `via` to `p2`, whose half-width interpolates from
 * r0 to r2 along the whole path, with round caps at both ends. Elbows and
 * knees are BENDS in this single silhouette — never a separate capsule per
 * bone and never a ball at the joint.
 */
function taperedPath(p0: Vec, via: Vec, p2: Vec, r0: number, r2: number): Path2D {
  // Control point chosen so the curve passes through `via` at t = 0.5.
  const cx = 2 * via.x - (p0.x + p2.x) / 2;
  const cy = 2 * via.y - (p0.y + p2.y) / 2;

  const N = 10;
  const left: Vec[] = [];
  const right: Vec[] = [];
  let nStart: Vec = { x: 0, y: 0 };
  let nEnd: Vec = { x: 0, y: 0 };
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * cx + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * cy + t * t * p2.y;
    let tx = 2 * mt * (cx - p0.x) + 2 * t * (p2.x - cx);
    let ty = 2 * mt * (cy - p0.y) + 2 * t * (p2.y - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const n = { x: ty, y: -tx };
    if (i === 0) nStart = n;
    if (i === N) nEnd = n;
    const r = r0 + (r2 - r0) * t;
    left.push({ x: x + n.x * r, y: y + n.y * r });
    right.push({ x: x - n.x * r, y: y - n.y * r });
  }

  const p = new Path2D();
  p.moveTo(left[0].x, left[0].y);
  for (let i = 1; i <= N; i++) p.lineTo(left[i].x, left[i].y);
  const aEnd = Math.atan2(nEnd.y, nEnd.x);
  p.arc(p2.x, p2.y, r2, aEnd, aEnd + Math.PI); // round tip cap
  for (let i = N; i >= 0; i--) p.lineTo(right[i].x, right[i].y);
  const aStart = Math.atan2(nStart.y, nStart.x);
  p.arc(p0.x, p0.y, r0, aStart + Math.PI, aStart + 2 * Math.PI); // round base cap
  p.closePath();
  return p;
}

/**
 * Relaxed joint position for a straight segment: the midpoint pushed
 * perpendicular to the base→tip axis by `frac` of the length (sign = side).
 * Used only where no real joint exists (KO ragdoll limbs, preview).
 */
function bendPoint(base: Vec, tip: Vec, frac: number): Vec {
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  return {
    x: (base.x + tip.x) / 2 + dy * frac,
    y: (base.y + tip.y) / 2 - dx * frac,
  };
}

function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Flat silhouette fill — one uniform color, no gradient, rim, gloss or core
 * shadow. Light-colored fills get a thin, slightly-darker edge so they still
 * read against a busy background; dark fills get no outline at all.
 */
function flatPart(ctx: CanvasRenderingContext2D, path: Path2D, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fill(path);
  const lum = luminance(fill);
  if (lum > 0.5) {
    const alpha = Math.min(0.85, (lum - 0.5) * 3);
    ctx.strokeStyle = shade(fill, 0.7, alpha);
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }
}

/**
 * Whole-body flat fill: strokes every part FIRST, then fills them all, so
 * the fills bury each part's internal stroke edges wherever parts overlap —
 * the figure reads as ONE continuous silhouette with only an outer edge
 * (and, for dark fighters, no edge at all).
 */
function flatBody(ctx: CanvasRenderingContext2D, paths: Path2D[], fill: string): void {
  const lum = luminance(fill);
  if (lum > 0.5) {
    const alpha = Math.min(0.85, (lum - 0.5) * 3);
    ctx.strokeStyle = shade(fill, 0.7, alpha);
    ctx.lineWidth = 2; // half of it sticks out; the inner half gets filled over
    for (const p of paths) ctx.stroke(p);
  }
  ctx.fillStyle = fill;
  for (const p of paths) ctx.fill(p);
}

/** Soft blurred ellipse under the fighter — sells the weight. */
export function drawContactShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  footY: number,
  scale: number,
): void {
  const air = Math.max(0, Math.min(1, (groundY - footY) / 240));
  const spread = 1 - air * 0.55;
  const alpha = 0.28 * (1 - air * 0.7);
  const rx = 30 * scale * spread;
  const ry = 6 * scale * spread;
  ctx.save();
  ctx.translate(x, groundY + 4);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(10, 14, 10, ${alpha})`);
  g.addColorStop(0.7, `rgba(10, 14, 10, ${alpha * 0.55})`);
  g.addColorStop(1, "rgba(10, 14, 10, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function weaponStyle(style: ResolvedStyle): WeaponStyle {
  return {
    fill: style.fill,
    accent: style.accent,
    glow: style.glow,
    outline: style.outline,
  };
}

function drawWeapon(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Vec,
  angle: number,
  time: number,
): void {
  const def = ARCHETYPES[fighter.style.archetype];
  ctx.save();
  ctx.translate(hand.x, hand.y);
  if (!def.floating) ctx.rotate(angle);
  ctx.scale(fighter.scale * 0.95, fighter.scale * 0.95);
  def.draw(ctx, weaponStyle(fighter.style), time);
  ctx.restore();
}

/** Fading ribbon behind the weapon tip during a swing's active frames. */
function updateAndDrawTrail(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Vec,
  angle: number,
  time: number,
): void {
  if (!fighter.style.trail) return;
  const def = ARCHETYPES[fighter.style.archetype];

  if (fighter.attackWindow > 0 && fighter.alive) {
    const len = def.tip * fighter.scale * 0.95;
    fighter.trail.push({
      x: hand.x + Math.cos(angle) * len,
      y: hand.y + Math.sin(angle) * len,
      t: time,
    });
  }
  while (fighter.trail.length > 0 && time - fighter.trail[0].t > TRAIL_SECONDS) {
    fighter.trail.shift();
  }
  if (fighter.trail.length < 2) return;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.shadowColor = fighter.style.glow;
  ctx.shadowBlur = 10;
  for (let i = 1; i < fighter.trail.length; i++) {
    const a = fighter.trail[i - 1];
    const b = fighter.trail[i];
    const age = (time - b.t) / TRAIL_SECONDS;
    ctx.strokeStyle = withAlpha(fighter.style.glow, Math.max(0, 0.5 * (1 - age)));
    ctx.lineWidth = Math.max(1.5, 9 * (1 - age));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAccessories(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  sk: Skeleton,
  headAngle: number,
  which: "back" | "front",
  time: number,
): void {
  const n = fighter.spec.appearance.accessories.length;
  const { scale: s, style } = fighter;

  if (which === "back" && n >= 2) {
    // Cape: filled flowing shape off the back shoulder, drawn behind the body.
    const sway = Math.sin(time * 3 + sk.hips.x * 0.01) * 6 * s;
    const sx = sk.neck.x - fighter.facing * 4 * s;
    const sy = sk.neck.y + 2 * s;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx - fighter.facing * 24 * s + sway,
      sy + 24 * s,
      sx - fighter.facing * 16 * s - sway,
      sy + 52 * s,
    );
    ctx.quadraticCurveTo(
      sx - fighter.facing * 4 * s + sway * 0.4,
      sy + 34 * s,
      sx + fighter.facing * 3 * s,
      sy + 12 * s,
    );
    ctx.closePath();
    ctx.fillStyle = mix(style.accent, "#20242a", 0.25);
    ctx.fill();
    ctx.restore();
  }

  if (which !== "front") return;

  if (n >= 1) {
    // Hat riding on the head: brim capsule + crown.
    ctx.save();
    ctx.translate(sk.head.x, sk.head.y);
    ctx.rotate(headAngle);
    const r = 8.5 * s;
    flatPart(ctx, capsulePath(-r * 1.45, -r * 0.72, r * 1.45, -r * 0.72, 2.2 * s, 2.2 * s), style.accent);
    const crown = new Path2D();
    crown.roundRect(-r * 0.75, -r * 1.75, r * 1.5, r, 2.5 * s);
    flatPart(ctx, crown, style.accent);
    ctx.restore();
  }
  if (n >= 3) {
    // Belt with a glowing buckle.
    const y = sk.hips.y - 4 * s;
    flatPart(ctx, capsulePath(sk.hips.x - 6 * s, y, sk.hips.x + 6 * s, y, 2.6 * s, 2.6 * s), style.accent);
    ctx.save();
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 6;
    ctx.fillStyle = fighter.style.glow;
    ctx.beginPath();
    ctx.arc(sk.hips.x + fighter.facing * 2 * s, y, 1.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderFighter(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  time: number,
  groundY: number,
): void {
  const s = fighter.scale;
  const fill = fighter.style.fill;

  const sk = fighter.ragdoll
    ? skeletonFromRagdoll(fighter.ragdoll, fighter.facing)
    : fighter.skeleton;
  const headAngle = fighter.ragdoll ? fighter.ragdoll.head.angle : sk.torsoAngle;
  const weaponAngle = fighter.ragdoll
    ? Math.atan2(sk.handR.y - sk.elbowR.y, sk.handR.x - sk.elbowR.x)
    : fighter.weaponAngle;

  // Contact shadow first, under everything — the only shadow on a fighter.
  const feetY = Math.max(sk.footL.y, sk.footR.y);
  drawContactShadow(ctx, sk.hips.x, groundY, feetY, s);

  ctx.save();
  ctx.globalAlpha = fighter.alive ? 1 : 0.8;

  // Lean build: thin arms (finer than legs), slim legs, half-width spine.
  const armR0 = 1.9 * s, armR1 = 1.1 * s;
  const legR0 = 2.4 * s, legR1 = 1.4 * s;

  drawAccessories(ctx, fighter, sk, headAngle, "back", time);

  // Every body part in one batch so overlaps merge into a single continuous
  // silhouette. Joints come straight from the animated skeleton.
  flatBody(
    ctx,
    [
      taperedPath(sk.shoulderL, sk.elbowL, sk.handL, armR0, armR1),
      taperedPath(sk.hipL, sk.kneeL, sk.footL, legR0, legR1),
      taperedPath(
        sk.neck,
        { x: (sk.neck.x + sk.hips.x) / 2, y: (sk.neck.y + sk.hips.y) / 2 },
        sk.hips,
        2.8 * s,
        2 * s,
      ),
      taperedPath(sk.hipR, sk.kneeR, sk.footR, legR0, legR1),
      capsulePath(sk.neck.x, sk.neck.y, sk.head.x, sk.head.y, 1.5 * s, 1.5 * s),
      circlePath(sk.head.x, sk.head.y, 8.5 * s),
      taperedPath(sk.shoulderR, sk.elbowR, sk.handR, armR0, armR1),
    ],
    fill,
  );

  drawAccessories(ctx, fighter, sk, headAngle, "front", time);

  // Swing trail + weapon attached to the hand joint.
  updateAndDrawTrail(ctx, fighter, sk.handR, weaponAngle, time);
  drawWeapon(ctx, fighter, sk.handR, weaponAngle, time);

  // Shield bubble.
  if (fighter.shieldTimer > 0) {
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.15 * Math.sin(time * 10);
    ctx.strokeStyle = fighter.style.glow;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 12;
    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    ctx.arc(sk.hips.x, sk.hips.y - 24 * s, 58 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  // Buff motes.
  if (fighter.buffTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = withAlpha(fighter.style.glow, 0.8);
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 8;
    for (let i = 0; i < 3; i++) {
      const a = time * 6 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(
        sk.hips.x + Math.cos(a) * 30 * s,
        sk.hips.y - 20 * s + Math.sin(a) * 40 * s,
        2.2 * s,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Static solid-fill portrait for the preview card — no physics, just a posed
 * figure with its mapped weapon, spotlight and contact shadow.
 */
export function drawStickmanPreview(
  ctx: CanvasRenderingContext2D,
  spec: CharacterSpec,
  w: number,
  h: number,
): void {
  const style = resolveStyle(spec);
  const s = spec.appearance.height;
  const cx = w / 2;
  const groundY = h * 0.88;
  const u = (h / 180) * s; // unit scale fitted to the canvas
  const fill = style.fill;

  ctx.clearRect(0, 0, w, h);

  // Soft spotlight behind the figure.
  const spot = ctx.createRadialGradient(cx, h * 0.5, 0, cx, h * 0.5, h * 0.55);
  spot.addColorStop(0, withAlpha(style.glow, 0.12));
  spot.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);

  const hipY = groundY - 48 * u;
  const shoulderY = hipY - 40 * u;
  const headR = 8.5 * u;
  const headY = shoulderY - 11.5 * u;

  const armR0 = 1.9 * u, armR1 = 1.1 * u;
  const legR0 = 2.4 * u, legR1 = 1.4 * u;
  const hip = { x: cx, y: hipY };
  const shoulder = { x: cx, y: shoulderY + 4 * u };

  drawContactShadow(ctx, cx, groundY, groundY, u);

  // Whole body in one batch: legs in a slight stance (knees bent), slim
  // spine, off arm down with a relaxed elbow, thin neck, small round head.
  const lFoot = { x: cx - 14 * u, y: groundY };
  const rFoot = { x: cx + 14 * u, y: groundY };
  const offHand = { x: cx - 20 * u, y: shoulderY + 26 * u };
  const weaponHand = { x: cx + 23 * u, y: shoulderY - 8 * u };
  flatBody(
    ctx,
    [
      taperedPath(hip, bendPoint(hip, lFoot, -0.1), lFoot, legR0, legR1),
      taperedPath(hip, bendPoint(hip, rFoot, 0.1), rFoot, legR0, legR1),
      taperedPath({ x: cx, y: shoulderY }, { x: cx, y: (shoulderY + hipY) / 2 }, hip, 2.8 * u, 2 * u),
      taperedPath(shoulder, bendPoint(shoulder, offHand, -0.16), offHand, armR0, armR1),
      capsulePath(cx, shoulderY, cx, headY, 1.5 * u, 1.5 * u),
      circlePath(cx, headY, headR),
      taperedPath(shoulder, bendPoint(shoulder, weaponHand, 0.12), weaponHand, armR0, armR1),
    ],
    fill,
  );

  // Hat.
  if (spec.appearance.accessories.length > 0) {
    flatPart(
      ctx,
      capsulePath(cx - headR * 1.45, headY - headR * 0.72, cx + headR * 1.45, headY - headR * 0.72, 2.2 * u, 2.2 * u),
      style.accent,
    );
    const crown = new Path2D();
    crown.roundRect(cx - headR * 0.75, headY - headR * 1.75, headR * 1.5, headR, 2.5 * u);
    flatPart(ctx, crown, style.accent);
  }

  // Weapon in the raised hand.
  const def = ARCHETYPES[style.archetype];
  ctx.save();
  ctx.translate(weaponHand.x, weaponHand.y);
  if (!def.floating) ctx.rotate(-Math.PI / 5);
  ctx.scale(u * 1.05, u * 1.05);
  def.draw(
    ctx,
    { fill: style.fill, accent: style.accent, glow: style.glow, outline: style.outline },
    1.7, // frozen time: mid-pulse so glows read in a still image
  );
  ctx.restore();
}
