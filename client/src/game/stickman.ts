import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import { resolveStyle, type ResolvedOutfit, type ResolvedStyle } from "../generation/enrich";
import type { BehaviorRuntime } from "./engine/interpreter";
import { mix, parseColor, shade, withAlpha } from "../render/color";
import { playSfx } from "../audio/sfx";
import {
  drawWeapon as drawParametricWeapon,
  weaponIsFloating,
  weaponTipLength,
  type WeaponRenderStyle,
} from "./weapons/archetypes";
import {
  attackStyleOf,
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
  defenseMul: number;
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
  /** Grounded specifically on a one-way platform (enables drop-through). */
  onPlatform: boolean;
  /** While > 0, one-way platforms are pass-through for this fighter. */
  dropThrough: number;
  /** Capsule-bottom Y last step — detects crossing a platform surface. */
  prevBottom: number;

  // Countdown timers, in seconds.
  attackCooldown: number;
  /** Remaining time of the whole attack animation (windup+active+recovery). */
  attackAnim: number;
  /** >0 during the attack's ACTIVE frames (bot AI + trail read this). */
  attackWindow: number;
  hasHitThisSwing: boolean;
  projectileFired: boolean;
  /** Weapon behavior's onAttack already fired for this swing. */
  weaponAttackFired: boolean;
  jumpCooldown: number;
  /** ATTACK ability cooldown. */
  abilityCooldown: number;
  /** UTILITY ability cooldown (separate key, separate clock). */
  utilityCooldown: number;
  shieldTimer: number;
  /** Fraction of damage the active shield blocks (from ability params). */
  shieldCoverage: number;
  buffTimer: number;
  introTimer: number;
  hitstunTimer: number;
  launchedTimer: number;
  castTimer: number;
  // Block + parry (shared mechanic; see dealDamage in combat.ts).
  /** Guard meter: frontal blocked hits drain it; broken at 0. */
  guard: number;
  guardMax: number;
  /** Shield-carriers drain slower (harder to guard-break). */
  guardDrainMul: number;
  /** Seconds until guard starts refilling after blocking/being hit. */
  guardRegenDelay: number;
  /** Guard stance is up this frame (negates frontal hits at guard cost). */
  blocking: boolean;
  /** Previous frame's block input — press edges arm the parry window. */
  blockHeld: boolean;
  /** While > 0, a frontal hit is PARRIED (free, staggers the attacker). */
  parryTimer: number;
  /** This fighter's parry window in seconds (from parrySkill/speed). */
  parryWindow: number;
  /** Dash i-frames: while > 0, incoming damage misses entirely. */
  invulnTimer: number;
  /** Heal-over-time: hp += regenRate per second while regenTimer > 0. */
  regenTimer: number;
  regenRate: number;
  // Behavior-engine transform state — all timers auto-revert in combat.ts,
  // and everything resets on death. Anti-softlock, not balance.
  /** Personal gravity multiplier (negative = floats up). */
  gravityScale: number;
  gravityTimer: number;
  /** Personal time scale: slows/hastens motion, timers and attacks. */
  timeFactor: number;
  timeFactorTimer: number;
  /** Visual + reach scale (grow/shrink). */
  displayScale: number;
  displayScaleTimer: number;
  /** Intangible: attacks and projectiles pass through. */
  phaseTimer: number;
  /** Parry window: reflects projectiles and returns damage. */
  reflectTimer: number;
  tintColor: string | null;
  tintTimer: number;
  /** recall(): where to snap back to when recallTimer hits 0. */
  recallPoint: { x: number; y: number } | null;
  recallTimer: number;
  /** customScript persistent state, keyed by ability slot / "weapon". */
  scriptState: Record<string, Record<string, unknown>>;
  /** Persistent weapon-behavior runtime (set by equipWeaponBehavior). */
  weaponRuntime: BehaviorRuntime | null;
  /** LLM-drawn weapon look runtime (onRenderWeapon at ~30Hz); null = parametric. */
  weaponRenderRuntime: BehaviorRuntime | null;
  /** Last ability this fighter cast — scripts can sense the OPPONENT's. */
  lastAbility: { name: string; kind: string } | null;
  /** Damage-over-time (bleed / elemental) from weapon properties. */
  dotTimer: number;
  dotPerSec: number;
  dotColor: string;
  dotTickAcc: number;

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
    // FIGHTER_CATEGORY: platforms mask this out (landings are kinematic).
    collisionFilter: { group, category: 0x0002 },
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
  const style = resolveStyle(spec);

  // Block/parry tuning: MODEST per-fighter variation. blockPower/parrySkill
  // (0–10, clamped by balance) win; otherwise derive from defense/speed.
  // Shield-carriers get Kal's bonus: tankier guard, slower drain.
  const cl = (v: number) => Math.max(0, Math.min(10, v));
  const blockPower = spec.blockPower ?? cl(spec.stats.defense / 20);
  const parrySkill = spec.parrySkill ?? cl(spec.stats.speed / 20);
  const hasShield =
    style.weapon.form === "shield" ||
    /shield|buckler|aegis/.test(spec.weapon.name.toLowerCase());
  const guardMax = Math.round((40 + blockPower * 6) * (hasShield ? 1.5 : 1));
  const parryWindow = 0.1 + (parrySkill / 10) * 0.12; // 100–220ms

  // Pose once so the skeleton is valid before the first step.
  const frame = animator.update(0, {
    rootX: x,
    rootY: groundY - 44 * s,
    vx: 0,
    vy: 0,
    grounded: true,
    facing,
    moving: false,
    blocking: false,
    alive: true,
    attackElapsed: -1,
    weaponForm: style.weapon.form,
    weaponSize: style.weapon.size,
    weaponType: spec.weapon.type,
    castTimer: 0,
    hitstunTimer: 0,
    launchedTimer: 0,
    groundY,
    time: 0,
  });

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
    onPlatform: false,
    dropThrough: 0,
    prevBottom: groundY,
    attackCooldown: 0,
    attackAnim: 0,
    attackWindow: 0,
    hasHitThisSwing: false,
    projectileFired: false,
    jumpCooldown: 0,
    abilityCooldown: 0,
    utilityCooldown: 0,
    shieldTimer: 0,
    shieldCoverage: 0.7,
    buffTimer: 0,
    introTimer: 0,
    hitstunTimer: 0,
    launchedTimer: 0,
    castTimer: 0,
    guard: guardMax,
    guardMax,
    guardDrainMul: hasShield ? 0.65 : 1,
    guardRegenDelay: 0,
    blocking: false,
    blockHeld: false,
    parryTimer: 0,
    parryWindow,
    invulnTimer: 0,
    regenTimer: 0,
    regenRate: 0,
    gravityScale: 1,
    gravityTimer: 0,
    timeFactor: 1,
    timeFactorTimer: 0,
    displayScale: 1,
    displayScaleTimer: 0,
    phaseTimer: 0,
    reflectTimer: 0,
    tintColor: null,
    tintTimer: 0,
    recallPoint: null,
    recallTimer: 0,
    scriptState: {},
    weaponRuntime: null,
    weaponRenderRuntime: null,
    weaponAttackFired: false,
    lastAbility: null,
    dotTimer: 0,
    dotPerSec: 0,
    dotColor: "#e05555",
    dotTickAcc: 0,
    buffs: { speedMul: 1, strengthMul: 1, defenseMul: 1 },
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

/** Y position that stays meaningful after death (camera framing). */
export function fighterY(fighter: Fighter): number {
  return fighter.ragdoll ? fighter.ragdoll.torso.body.position.y : fighter.root.position.y;
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
  playSfx("ko");

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

/**
 * Push a joint slightly past its true position (away from the base→tip
 * chord) so limbs draw with a fuller, more organic bow — animation-reference
 * fluidity without touching the underlying IK.
 */
function flourish(base: Vec, via: Vec, tip: Vec, amt = 0.3): Vec {
  const mx = (base.x + tip.x) / 2;
  const my = (base.y + tip.y) / 2;
  return { x: via.x + (via.x - mx) * amt, y: via.y + (via.y - my) * amt };
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

export function weaponRenderStyle(style: ResolvedStyle): WeaponRenderStyle {
  return {
    ...style.weapon,
    element: style.element,
    fill: style.fill,
    accent: style.accent,
    glow: style.glow,
    outline: style.outline,
  };
}

/**
 * Where the weapon lives: the render anchor AND the attack/projectile
 * origin. "floating" orbits the fighter; combat imports this so a head
 * laser actually fires from the head.
 */
export function weaponMountAnchor(fighter: Fighter, time: number): Vec {
  const sk = fighter.skeleton;
  switch (fighter.spec.weapon.mount ?? "hand") {
    case "head":
      return { x: sk.head.x, y: sk.head.y };
    case "body":
      return { x: (sk.neck.x + sk.hips.x) / 2, y: (sk.neck.y + sk.hips.y) / 2 };
    case "floating": {
      const a = time * 1.6;
      return {
        x: fighter.root.position.x + Math.cos(a) * 44 * fighter.scale,
        y: fighter.root.position.y - 26 * fighter.scale + Math.sin(a) * 22 * fighter.scale,
      };
    }
    case "none":
    case "hand":
    case "dual":
    default:
      return { x: sk.handR.x, y: sk.handR.y };
  }
}

function drawWeapon(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Vec,
  angle: number,
  time: number,
): void {
  // An LLM-authored renderProgram owns the weapon's look entirely (it paints
  // via the draw verbs each tick); the parametric drawer stays out of the way
  // unless the program died (rt.done → permanent fallback for the match).
  const rt = fighter.weaponRenderRuntime;
  if (rt && !rt.done) return;

  const mount = fighter.spec.weapon.mount ?? "hand";
  if (mount === "none") return; // unarmed / pure emitter

  const paint = (at: Vec, rot: number, mirror = false) => {
    ctx.save();
    ctx.translate(at.x, at.y);
    if (mirror) ctx.scale(-1, 1);
    if (!weaponIsFloating(fighter.style.weapon.form)) ctx.rotate(rot);
    ctx.scale(fighter.scale * 0.95, fighter.scale * 0.95);
    drawParametricWeapon(ctx, weaponRenderStyle(fighter.style), time);
    ctx.restore();
  };

  if (mount === "hand" || mount === "dual") {
    paint(hand, angle);
    if (mount === "dual") {
      // Mirror of the main weapon in the off hand, idle-angled.
      paint({ x: fighter.skeleton.handL.x, y: fighter.skeleton.handL.y }, -angle, true);
    }
    return;
  }

  // head / body / floating without a renderProgram: hover the parametric
  // weapon at the mount with a gentle bob instead of tying it to the swing.
  const anchor = weaponMountAnchor(fighter, time);
  paint(
    { x: anchor.x, y: anchor.y - 6 * fighter.scale + Math.sin(time * 2.4) * 2 },
    Math.sin(time * 1.8) * 0.15 - fighter.facing * 0.35,
  );
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

  if (fighter.attackWindow > 0 && fighter.alive) {
    const len =
      weaponTipLength(fighter.style.weapon.form, fighter.style.weapon.size) *
      fighter.scale *
      0.95;
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

// ---------------------------------------------------------------------------
// Parametric outfit rendering — cosmetic slots layered on the body:
// back items BEHIND, armor OVER the body, head/face on top. Flat fills only.
// ---------------------------------------------------------------------------

export interface OutfitAnchors {
  facing: 1 | -1;
  s: number;
  time: number;
  head: { x: number; y: number; angle: number; r: number };
  neck: Vec;
  hips: Vec;
  arms: { elbow: Vec; hand: Vec }[];
  legs: { knee: Vec; foot: Vec }[];
}

export interface OutfitColors {
  /** Material-tinted main garment color (still flat). */
  main: string;
  /** Accent trim. */
  trim: string;
  glow: string;
}

export function materialColor(material: ResolvedOutfit["material"], accent: string): string {
  switch (material) {
    case "leather":
      return mix(accent, "#7a5a3c", 0.55);
    case "metal":
      return mix("#9aa3b2", accent, 0.25);
    case "gold":
      return mix("#e8b33c", accent, 0.2);
    case "bone":
      return mix("#e8e2d0", accent, 0.15);
    default:
      return accent; // cloth
  }
}

/** Back slot: drawn BEFORE the body so it sits behind the silhouette. */
export function drawOutfitBack(
  ctx: CanvasRenderingContext2D,
  outfit: ResolvedOutfit,
  c: OutfitColors,
  a: OutfitAnchors,
): void {
  const { facing: f, s, time: t, neck, hips } = a;
  const back = -f;

  switch (outfit.back) {
    case "cape":
    case "cloak": {
      const long = outfit.back === "cloak";
      const sway = Math.sin(t * 3 + hips.x * 0.01) * (long ? 4 : 6) * s;
      const sx = neck.x + back * 4 * s;
      const sy = neck.y + 2 * s;
      const drop = (long ? 62 : 52) * s;
      const spread = (long ? 30 : 24) * s;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx + back * spread + sway, sy + drop * 0.45, sx + back * spread * 0.66 - sway, sy + drop);
      if (long) ctx.lineTo(sx + f * 6 * s + sway * 0.5, sy + drop * 0.96);
      ctx.quadraticCurveTo(sx + back * 4 * s + sway * 0.4, sy + drop * 0.62, sx + f * 3 * s, sy + 12 * s);
      ctx.closePath();
      ctx.fillStyle = mix(c.main, "#20242a", 0.25);
      ctx.fill();
      break;
    }
    case "wings": {
      const flap = Math.sin(t * 2.2) * 0.1;
      for (const [dy, len, tilt] of [
        [-4, 30, -0.55],
        [2, 24, -0.15],
      ] as const) {
        ctx.save();
        ctx.translate(neck.x + back * 3 * s, neck.y + dy * s);
        ctx.rotate((tilt + flap) * back * -1);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(back * len * s, -10 * s, back * len * 1.35 * s, -2 * s);
        ctx.quadraticCurveTo(back * len * 0.9 * s, 4 * s, back * len * 0.55 * s, 3 * s);
        ctx.quadraticCurveTo(back * len * 0.3 * s, 7 * s, 0, 4 * s);
        ctx.closePath();
        ctx.fillStyle = mix(c.main, "#20242a", 0.2);
        ctx.fill();
        ctx.strokeStyle = withAlpha("#20242a", 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(back * len * 0.35 * s, -2 * s);
        ctx.lineTo(back * len * 0.5 * s, 3 * s);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case "quiver": {
      ctx.save();
      ctx.translate(neck.x + back * 5 * s, neck.y + 10 * s);
      ctx.rotate(back * 0.5);
      flatPart(ctx, capsulePath(0, -9 * s, 0, 9 * s, 3.2 * s, 3.2 * s), c.main);
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.6 * s;
      ctx.lineCap = "round";
      for (const ox of [-1.4, 1.4]) {
        ctx.beginPath();
        ctx.moveTo(ox * s, -9 * s);
        ctx.lineTo(ox * s, -15 * s);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case "pack": {
      ctx.save();
      ctx.translate(neck.x + back * 6 * s, neck.y + 12 * s);
      const p = new Path2D();
      p.roundRect(-5 * s, -8 * s, 10 * s, 16 * s, 3 * s);
      flatPart(ctx, p, c.main);
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-5 * s, -1 * s);
      ctx.lineTo(5 * s, -1 * s);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "sheath": {
      ctx.save();
      ctx.translate(hips.x + back * 3 * s, hips.y - 8 * s);
      ctx.rotate(back * 0.85);
      flatPart(ctx, capsulePath(0, -4 * s, 0, 16 * s, 2.2 * s, 1.7 * s), c.main);
      ctx.restore();
      break;
    }
    default:
      break;
  }
}

/** Torso / shoulders / arms / legs: drawn OVER the body silhouette. */
function drawOutfitBody(
  ctx: CanvasRenderingContext2D,
  outfit: ResolvedOutfit,
  c: OutfitColors,
  a: OutfitAnchors,
  bulk: number,
): void {
  const { facing: f, s, time: t, neck, hips } = a;
  const dxAxis = hips.x - neck.x;
  const dyAxis = hips.y - neck.y;
  const at = (k: number): Vec => ({ x: neck.x + dxAxis * k, y: neck.y + dyAxis * k });

  // Legs first (under torso hem).
  for (const leg of a.legs) {
    const mid = { x: (leg.knee.x + leg.foot.x) / 2, y: (leg.knee.y + leg.foot.y) / 2 };
    if (outfit.legs === "boots") {
      flatPart(ctx, capsulePath(mid.x, mid.y, leg.foot.x, leg.foot.y, 3 * s, 2.8 * s), c.main);
    } else if (outfit.legs === "greaves") {
      flatPart(ctx, capsulePath(leg.knee.x, leg.knee.y, leg.foot.x, leg.foot.y, 3 * s, 2.6 * s), c.main);
      flatPart(ctx, circlePath(leg.knee.x, leg.knee.y, 2.6 * s), c.trim);
    }
  }
  if (outfit.legs === "skirt") {
    const sway = Math.sin(t * 2.5) * 1.2 * s;
    ctx.beginPath();
    ctx.moveTo(hips.x - 5.5 * s, hips.y - 4 * s);
    ctx.lineTo(hips.x + 5.5 * s, hips.y - 4 * s);
    ctx.lineTo(hips.x + 9 * s + sway, hips.y + 12 * s);
    ctx.lineTo(hips.x - 9 * s + sway, hips.y + 12 * s);
    ctx.closePath();
    ctx.fillStyle = c.main;
    ctx.fill();
    ctx.strokeStyle = withAlpha("#20242a", 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Torso garment.
  switch (outfit.torso) {
    case "chestplate": {
      const w = (6.5 + bulk * 2.5) * s;
      const top = at(0.12);
      const bottom = at(0.62);
      flatPart(ctx, capsulePath(top.x, top.y, bottom.x, bottom.y, w, w * 0.78), c.main);
      ctx.strokeStyle = withAlpha("#20242a", 0.35);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y + 2 * s);
      ctx.lineTo(bottom.x, bottom.y - 1 * s);
      ctx.stroke();
      break;
    }
    case "vest": {
      const top = at(0.1);
      const bottom = at(0.66);
      flatPart(ctx, capsulePath(top.x, top.y, bottom.x, bottom.y, 5 * s, 4.4 * s), c.main);
      ctx.strokeStyle = mix(c.main, "#20242a", 0.5);
      ctx.lineWidth = 1.6 * s;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.stroke();
      break;
    }
    case "robe": {
      const sway = Math.sin(t * 2.5) * 1.6 * s;
      const top = at(0.08);
      ctx.beginPath();
      ctx.moveTo(top.x - 5.5 * s, top.y);
      ctx.lineTo(top.x + 5.5 * s, top.y);
      ctx.lineTo(hips.x + 12 * s + sway, hips.y + 20 * s);
      ctx.lineTo(hips.x - 12 * s + sway, hips.y + 20 * s);
      ctx.closePath();
      ctx.fillStyle = c.main;
      ctx.fill();
      ctx.strokeStyle = withAlpha("#20242a", 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
      // Sash.
      const waist = at(0.6);
      flatPart(ctx, capsulePath(waist.x - 5.5 * s, waist.y, waist.x + 5.5 * s, waist.y, 1.8 * s, 1.8 * s), c.trim);
      break;
    }
    case "harness": {
      const shoulder = at(0.08);
      const hip = at(0.85);
      ctx.strokeStyle = c.main;
      ctx.lineWidth = 2.6 * s;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(shoulder.x + f * 4 * s, shoulder.y);
      ctx.lineTo(hip.x - f * 4 * s, hip.y);
      ctx.stroke();
      flatPart(ctx, circlePath((shoulder.x + hip.x) / 2, (shoulder.y + hip.y) / 2, 1.8 * s), c.trim);
      break;
    }
    case "scarf": {
      const sway = Math.sin(t * 3.2) * 3 * s;
      flatPart(ctx, capsulePath(neck.x - 4 * s, neck.y + 2 * s, neck.x + 4 * s, neck.y + 2 * s, 2.6 * s, 2.6 * s), c.main);
      ctx.beginPath();
      ctx.moveTo(neck.x - f * 3 * s, neck.y + 3 * s);
      ctx.quadraticCurveTo(
        neck.x - f * 14 * s + sway,
        neck.y + 10 * s,
        neck.x - f * 18 * s + sway * 1.4,
        neck.y + 20 * s,
      );
      ctx.lineTo(neck.x - f * 12 * s + sway, neck.y + 18 * s);
      ctx.quadraticCurveTo(neck.x - f * 8 * s, neck.y + 9 * s, neck.x + f * 1 * s, neck.y + 6 * s);
      ctx.closePath();
      ctx.fillStyle = c.main;
      ctx.fill();
      break;
    }
    default:
      break;
  }

  // Shoulders.
  if (outfit.shoulders !== "none") {
    const w = (4.2 + bulk * 1.6) * s;
    const anchor = { x: neck.x, y: neck.y + 1.5 * s };
    if (outfit.shoulders === "epaulettes") {
      const p = new Path2D();
      p.roundRect(anchor.x - w, anchor.y - 2 * s, w * 2, 3 * s, 1.2 * s);
      flatPart(ctx, p, c.main);
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.2;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(anchor.x + i * w * 0.55, anchor.y + 1 * s);
        ctx.lineTo(anchor.x + i * w * 0.55, anchor.y + 4.5 * s);
        ctx.stroke();
      }
    } else {
      // Pauldron cap (a hint of the far one peeks out behind).
      flatPart(ctx, circlePath(anchor.x - f * 2 * s, anchor.y + 0.5 * s, w * 0.8), mix(c.main, "#20242a", 0.25));
      const p = new Path2D();
      p.arc(anchor.x, anchor.y, w, Math.PI, 0);
      p.closePath();
      flatPart(ctx, p, c.main);
      if (outfit.shoulders === "spikes") {
        for (const [ox, oy] of [[-w * 0.5, -w * 0.75], [w * 0.35, -w * 0.9]] as const) {
          ctx.beginPath();
          ctx.moveTo(anchor.x + ox - 1.4 * s, anchor.y + oy + 2 * s);
          ctx.lineTo(anchor.x + ox + 1.4 * s, anchor.y + oy + 2 * s);
          ctx.lineTo(anchor.x + ox, anchor.y + oy - 4 * s);
          ctx.closePath();
          ctx.fillStyle = c.main;
          ctx.fill();
        }
      }
    }
  }

  // Arms.
  if (outfit.arms !== "none") {
    for (const arm of a.arms) {
      const mid = { x: (arm.elbow.x + arm.hand.x) / 2, y: (arm.elbow.y + arm.hand.y) / 2 };
      if (outfit.arms === "gauntlets") {
        flatPart(ctx, capsulePath(mid.x, mid.y, arm.hand.x, arm.hand.y, 2.6 * s, 2.9 * s), c.main);
      } else {
        flatPart(ctx, capsulePath(arm.elbow.x, arm.elbow.y, mid.x, mid.y, 2.3 * s, 2.3 * s), c.main);
      }
    }
  }
}

/** Head + face items, on top of everything except the weapon. */
export function drawOutfitHead(
  ctx: CanvasRenderingContext2D,
  outfit: ResolvedOutfit,
  c: OutfitColors,
  a: OutfitAnchors,
): void {
  const { facing: f, s, time: t, head } = a;
  const r = head.r;

  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(head.angle);
  ctx.scale(f, 1); // local +x is always the facing side

  switch (outfit.head) {
    case "hat": {
      flatPart(ctx, capsulePath(-r * 1.45, -r * 0.72, r * 1.45, -r * 0.72, 2.2 * s, 2.2 * s), c.main);
      const crown = new Path2D();
      crown.roundRect(-r * 0.75, -r * 1.75, r * 1.5, r, 2.5 * s);
      flatPart(ctx, crown, c.main);
      break;
    }
    case "tophat": {
      flatPart(ctx, capsulePath(-r * 1.25, -r * 0.78, r * 1.25, -r * 0.78, 1.9 * s, 1.9 * s), c.main);
      const crown = new Path2D();
      crown.roundRect(-r * 0.7, -r * 2.45, r * 1.4, r * 1.7, 1.6 * s);
      flatPart(ctx, crown, c.main);
      flatPart(ctx, capsulePath(-r * 0.7, -r * 1.02, r * 0.7, -r * 1.02, 1.1 * s, 1.1 * s), c.trim);
      break;
    }
    case "helmet": {
      const dome = new Path2D();
      dome.arc(0, -r * 0.1, r * 1.18, Math.PI, 0);
      dome.closePath();
      flatPart(ctx, dome, c.main);
      // Nose guard.
      const bar = new Path2D();
      bar.roundRect(r * 0.72, -r * 0.35, r * 0.42, r * 0.95, 1.2 * s);
      flatPart(ctx, bar, c.main);
      // Crest stripe.
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.6 * s;
      ctx.beginPath();
      ctx.arc(0, -r * 0.1, r * 1.18, -Math.PI * 0.75, -Math.PI * 0.25);
      ctx.stroke();
      break;
    }
    case "hood": {
      // Crescent wrapping the head, open toward the face.
      const p = new Path2D();
      p.arc(0, 0, r * 1.32, -Math.PI * 0.38, Math.PI * 0.42);
      p.arc(r * 0.25, 0, r * 0.98, Math.PI * 0.42, -Math.PI * 0.38, true);
      p.closePath();
      flatPart(ctx, p, c.main);
      // Point at the back.
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, -r * 0.85);
      ctx.quadraticCurveTo(-r * 1.9, -r * 0.7, -r * 1.55, r * 0.1);
      ctx.quadraticCurveTo(-r * 1.35, -r * 0.2, -r * 1.05, -r * 0.3);
      ctx.closePath();
      ctx.fillStyle = c.main;
      ctx.fill();
      break;
    }
    case "crown": {
      const band = new Path2D();
      band.roundRect(-r * 0.85, -r * 1.35, r * 1.7, r * 0.55, 1 * s);
      flatPart(ctx, band, c.main);
      ctx.fillStyle = c.main;
      for (const px of [-r * 0.6, 0, r * 0.6]) {
        ctx.beginPath();
        ctx.moveTo(px - r * 0.24, -r * 1.32);
        ctx.lineTo(px + r * 0.24, -r * 1.32);
        ctx.lineTo(px, -r * 1.95);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "cap": {
      const dome = new Path2D();
      dome.arc(0, -r * 0.35, r * 0.95, Math.PI, 0);
      dome.closePath();
      flatPart(ctx, dome, c.main);
      flatPart(ctx, capsulePath(r * 0.5, -r * 0.5, r * 1.6, -r * 0.42, 1.3 * s, 1.1 * s), c.main);
      break;
    }
    case "horns": {
      ctx.fillStyle = c.main;
      for (const side of [-1, 1] as const) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.45, -r * 0.75);
        ctx.quadraticCurveTo(side * r * 1.15, -r * 1.3, side * r * 1.05, -r * 2.05);
        ctx.quadraticCurveTo(side * r * 0.8, -r * 1.35, side * r * 0.15, -r * 0.95);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "halo": {
      const bob = Math.sin(t * 2.5) * 1.2 * s;
      ctx.save();
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = mix("#ffe6a3", c.trim, 0.25);
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.ellipse(0, -r * 1.9 + bob, r * 0.85, r * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      break;
    }
    default:
      break;
  }

  switch (outfit.face) {
    case "mask": {
      const p = new Path2D();
      p.roundRect(-r * 0.1, -r * 0.1, r * 1.2, r * 0.75, 1.6 * s);
      flatPart(ctx, p, mix(c.main, "#20242a", 0.35));
      break;
    }
    case "visor": {
      const p = new Path2D();
      p.roundRect(-r * 0.15, -r * 0.55, r * 1.35, r * 0.55, 1.4 * s);
      ctx.save();
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 6;
      flatPart(ctx, p, mix(c.glow, "#20242a", 0.45));
      ctx.restore();
      break;
    }
    case "goggles": {
      flatPart(ctx, circlePath(r * 0.5, -r * 0.28, r * 0.4), c.trim);
      flatPart(ctx, circlePath(r * 0.5, -r * 0.28, r * 0.22), mix(c.glow, "#20242a", 0.3));
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(0, -r * 0.28, r * 0.92, Math.PI * 0.55, Math.PI * 1.45);
      ctx.stroke();
      break;
    }
    case "warpaint": {
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = 1.8 * s;
      ctx.lineCap = "round";
      for (const oy of [-0.15, 0.25]) {
        ctx.beginPath();
        ctx.moveTo(r * 0.15, r * oy);
        ctx.lineTo(r * 0.85, r * (oy + 0.12));
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }

  ctx.restore();
}

/**
 * THE fighter renderer — the single source of truth for drawing any fighter
 * on any surface (game, preview card, clones, future UIs). It owns body,
 * outfit, transforms (scale/phase/tint) and — via drawWeapon below — the
 * mount- and renderProgram-aware weapon. Do not add parallel render paths;
 * build a Fighter (createFighter) and call this.
 */
export function renderFighter(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  time: number,
  groundY: number,
): void {
  const s = fighter.scale;
  const fill =
    fighter.tintTimer > 0 && fighter.tintColor
      ? mix(fighter.style.fill, fighter.tintColor, 0.65)
      : fighter.style.fill;

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
  // Behavior-engine transforms: grow/shrink about the ground contact so the
  // feet stay planted; phase() renders as a ghost.
  if (fighter.displayScale !== 1) {
    ctx.translate(sk.hips.x, groundY);
    ctx.scale(fighter.displayScale, fighter.displayScale);
    ctx.translate(-sk.hips.x, -groundY);
  }
  ctx.globalAlpha = (fighter.alive ? 1 : 0.8) * (fighter.phaseTimer > 0 ? 0.4 : 1);

  // Lean build: thin arms (finer than legs), slim legs, half-width spine.
  const armR0 = 1.9 * s, armR1 = 1.1 * s;
  const legR0 = 2.4 * s, legR1 = 1.4 * s;

  // Outfit anchors + colors (material tint stays flat).
  const anchors: OutfitAnchors = {
    facing: fighter.facing,
    s,
    time,
    head: { x: sk.head.x, y: sk.head.y, angle: headAngle, r: 8.5 * s },
    neck: sk.neck,
    hips: sk.hips,
    arms: [
      { elbow: sk.elbowL, hand: sk.handL },
      { elbow: sk.elbowR, hand: sk.handR },
    ],
    legs: [
      { knee: sk.kneeL, foot: sk.footL },
      { knee: sk.kneeR, foot: sk.footR },
    ],
  };
  const outfit = fighter.style.outfit;
  const outfitColors: OutfitColors = {
    main: materialColor(outfit.material, fighter.style.accent),
    trim: fighter.style.accent,
    glow: fighter.style.glow,
  };

  // Back items sit BEHIND the body silhouette.
  drawOutfitBack(ctx, outfit, outfitColors, anchors);

  // Every body part in one batch so overlaps merge into a single continuous
  // silhouette. Joints come straight from the animated skeleton.
  flatBody(
    ctx,
    [
      taperedPath(sk.shoulderL, flourish(sk.shoulderL, sk.elbowL, sk.handL), sk.handL, armR0, armR1),
      taperedPath(sk.hipL, flourish(sk.hipL, sk.kneeL, sk.footL), sk.footL, legR0, legR1),
      taperedPath(
        sk.neck,
        { x: (sk.neck.x + sk.hips.x) / 2, y: (sk.neck.y + sk.hips.y) / 2 },
        sk.hips,
        2.8 * s,
        2 * s,
      ),
      taperedPath(sk.hipR, flourish(sk.hipR, sk.kneeR, sk.footR), sk.footR, legR0, legR1),
      capsulePath(sk.neck.x, sk.neck.y, sk.head.x, sk.head.y, 1.5 * s, 1.5 * s),
      circlePath(sk.head.x, sk.head.y, 8.5 * s),
      taperedPath(sk.shoulderR, flourish(sk.shoulderR, sk.elbowR, sk.handR), sk.handR, armR0, armR1),
    ],
    fill,
  );

  drawOutfitBody(ctx, outfit, outfitColors, anchors, fighter.style.bulk);
  drawOutfitHead(ctx, outfit, outfitColors, anchors);

  // Swing trail + weapon attached to the hand joint.
  updateAndDrawTrail(ctx, fighter, sk.handR, weaponAngle, time);
  drawWeapon(ctx, fighter, sk.handR, weaponAngle, time);

  // Casting weapons flare at the tip during the active frames.
  if (
    fighter.attackWindow > 0 &&
    attackStyleOf(fighter.style.weapon.form, fighter.spec.weapon.type) === "cast"
  ) {
    const len = weaponTipLength(fighter.style.weapon.form, fighter.style.weapon.size) * s;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 18;
    ctx.fillStyle = withAlpha(fighter.style.glow, 0.55 + 0.3 * Math.sin(time * 20));
    ctx.beginPath();
    ctx.arc(
      sk.handR.x + Math.cos(weaponAngle) * len,
      sk.handR.y + Math.sin(weaponAngle) * len,
      6 * s,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }

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
