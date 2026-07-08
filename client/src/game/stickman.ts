import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import { resolveStyle, type ResolvedOutfit, type ResolvedStyle } from "../generation/enrich";
import type { BehaviorRuntime } from "./engine/interpreter";
import { mix, parseColor, shade, withAlpha } from "../render/color";
import { playSfx } from "../audio/sfx";
import { drawGearBack, drawGearFront, drawHeadgear } from "./gear";
import { emptyInjuries, goreOf, injurySeverity, injuryTier, type InjuryState } from "./injury";
import {
  drawWeapon as drawParametricWeapon,
  weaponIsFloating,
  weaponTipLength,
  type WeaponRenderStyle,
} from "./weapons/archetypes";
import {
  ATTACK_TIMINGS,
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
  /** Theme/element/color of the active shield (drives the dome's look). */
  shieldStyle: { color: string; element: string; theme: string | null } | null;
  /** Rooted in place (vines/ice): movement zeroed, can still act. */
  rootedTimer: number;
  /** Marked/cursed: the NEXT hit taken is amplified by markMul. */
  markTimer: number;
  markMul: number;
  /** Counter stance: the next MELEE hit taken is negated + riposted. */
  counterTimer: number;
  /** Charge rush: while >0, body contact delivers chargeDamage once. */
  chargeTimer: number;
  chargeDamage: number;
  chargeSpeed: number;
  chargeHit: boolean;
  /** Weapon-clash debounce (simultaneous active swings spark, not spam). */
  clashCd: number;
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
  // Movement-primitive juice (dash/blink/leap — set by movementFx.ts).
  /** While > 0, ghost silhouettes drop along the movement path. */
  afterimageTimer: number;
  afterimageAcc: number;
  /** Mid-blink: the fighter isn't drawn for a beat. */
  blinkVanishTimer: number;
  /** Leap landing: 0 idle, 1 armed (awaiting liftoff), 2 airborne. */
  leapLandState: 0 | 1 | 2;
  /** Gap-closer poke: while > 0, passing through the foe lands one light hit. */
  dashPokeTimer: number;
  dashPokeHit: boolean;
  /** Ambient state-VFX emission accumulator (effectsJuice upkeep). */
  fxAcc: number;
  /** Cumulative absorbed damage per body region (injury system). */
  injuries: InjuryState;
  /** Combo: index of the NEXT swing variant (0–3). */
  comboIndex: number;
  /** Combo: variant of the CURRENT/most-recent swing (drives the animator). */
  comboVariant: number;
  /** Combo: true while every gap in the chain beat the fast window. */
  comboChainOk: boolean;
  /** Combo: time left to CHAIN (fast window → finisher eligibility). */
  comboChainTimer: number;
  /** Combo: time left to keep CYCLING variants (lenient window). */
  comboCycleTimer: number;
  /** Combo: the current swing is a qualified finisher (launch on hit). */
  comboFinisher: boolean;
  /** What this fighter bleeds (robots spark instead). */
  gore: "blood" | "sparks";
  /** Full (attack-speed-scaled) duration of the current swing — drawWeapon
   * uses it to sync mounted-weapon attack motion to the phase windows. */
  attackTotal: number;
  /** Weapon form is a shield (or named one) — shield parries reflect shots. */
  hasShield: boolean;
  /** Guard re-engage cooldown after release/parry (anti block-mash). */
  guardCooldown: number;
  /** LLM-drawn head accessory runtime (onRenderHead); null = keyword shape. */
  headRenderRuntime: BehaviorRuntime | null;
  /** Weapon motion-smear this frame (world angles), from the animator. */
  weaponSmear: { from: number; to: number } | null;
  /** Mid-air jumps spent since last grounded (wings grant extra). */
  airJumpsUsed: number;
  /** Block indicator fade 0→1 (render-only). */
  blockVis: number;

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
    shieldStyle: null,
    rootedTimer: 0,
    markTimer: 0,
    markMul: 1.5,
    counterTimer: 0,
    chargeTimer: 0,
    chargeDamage: 0,
    chargeSpeed: 22,
    chargeHit: false,
    clashCd: 0,
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
    afterimageTimer: 0,
    afterimageAcc: 0,
    blinkVanishTimer: 0,
    leapLandState: 0,
    dashPokeTimer: 0,
    dashPokeHit: false,
    fxAcc: 0,
    injuries: emptyInjuries(),
    comboIndex: 0,
    comboVariant: 0,
    comboChainOk: true,
    comboChainTimer: 0,
    comboCycleTimer: 0,
    comboFinisher: false,
    gore: goreOf(`${spec.name} ${spec.flavor ?? ""} ${spec.appearance.accessories.join(" ")}`),
    attackTotal: 0,
    hasShield,
    guardCooldown: 0,
    blockVis: 0,
    headRenderRuntime: null,
    weaponSmear: null,
    airJumpsUsed: 0,
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
      // Blocking: the construct sweeps to the FRONT as a tight barrier
      // instead of orbiting the whole body (pose-only; coverage unchanged).
      if (fighter.blocking) {
        const b = time * 5;
        return {
          x: fighter.root.position.x + fighter.facing * 26 * fighter.scale + Math.cos(b) * 5 * fighter.scale,
          y: fighter.root.position.y - 24 * fighter.scale + Math.sin(b) * 12 * fighter.scale,
        };
      }
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
    // Motion smear: on the strike's fastest transition the weapon renders as
    // ghosted copies fanned along its arc (plus a glow streak) instead of a
    // crisp weapon — one-frame speed. Angles come from the animator.
    if (fighter.weaponSmear) {
      // BOLD slash streak: a filled tapered wedge sweeping the whole arc
      // (weapon-glow fill + hot white leading edge), bracketed by a faint
      // ghost blade at the start and a crisp blade at the leading end.
      const { from, to } = fighter.weaponSmear;
      let span = to - from;
      while (span > Math.PI) span -= Math.PI * 2;
      while (span < -Math.PI) span += Math.PI * 2;
      const tip = weaponTipLength(fighter.style.weapon.form, fighter.style.weapon.size) * fighter.scale;
      const rOut = tip * 1.08;
      // Comet streak over the LEADING portion of the sweep: a tapered wedge
      // that starts as a point at the trailing edge and widens to the full
      // blade at the leading edge — reads as a hard directional slash.
      const start = from + span * 0.3;
      const cSpan = to - start;
      ctx.save();
      const trail = (kIn: number, alpha: number) => {
        ctx.beginPath();
        ctx.moveTo(hand.x + Math.cos(start) * rOut * 0.55, hand.y + Math.sin(start) * rOut * 0.55);
        ctx.arc(hand.x, hand.y, rOut, start, to, cSpan < 0);
        ctx.lineTo(hand.x + Math.cos(to) * rOut * kIn, hand.y + Math.sin(to) * rOut * kIn);
        // Inner edge sweeps back to the trailing point.
        ctx.arc(hand.x, hand.y, rOut * kIn, to, start + cSpan * 0.15, cSpan >= 0);
        ctx.closePath();
        ctx.fillStyle = withAlpha(fighter.style.glow, alpha);
        ctx.shadowColor = fighter.style.glow;
        ctx.shadowBlur = 9;
        ctx.fill();
      };
      trail(0.3, 0.8); // body of the streak
      trail(0.66, 0.6); // brighter outer band
      // Hot white leading edge along the final blade position.
      ctx.strokeStyle = withAlpha("#ffffff", 0.95);
      ctx.lineWidth = 3.5 * fighter.scale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(hand.x + Math.cos(to) * rOut * 0.25, hand.y + Math.sin(to) * rOut * 0.25);
      ctx.lineTo(hand.x + Math.cos(to) * rOut, hand.y + Math.sin(to) * rOut);
      ctx.stroke();
      ctx.restore();
      // Ghost blade at the start of the arc, crisp blade at the leading end.
      ctx.save();
      ctx.globalAlpha = 0.3;
      paint(hand, from);
      ctx.restore();
      paint(hand, to);
      if (mount !== "dual") return;
    } else {
      paint(hand, angle);
    }
    if (mount === "dual") {
      // Mirror of the main weapon in the off hand, idle-angled.
      paint({ x: fighter.skeleton.handL.x, y: fighter.skeleton.handL.y }, -angle, true);
    }
    return;
  }

  // head / body / floating without a renderProgram: hover the parametric
  // weapon at the mount with a gentle bob — and during an attack, the
  // WEAPON performs the strike itself: coil back from the mount, dart at
  // the target through the active frames, ease home in recovery. Synced to
  // the same phase windows via attackTotal; the hitbox already lives at the
  // mount (weaponMountAnchor), this makes the visible motion match it.
  const anchor = weaponMountAnchor(fighter, time);
  const s = fighter.scale;
  let ox = 0;
  let oy = 0;
  // Orientation follows FACING: the sprite is authored pointing right and
  // mirrored when the fighter faces left, so a mounted weapon always aims
  // at the enemy side (rotations below are in right-facing terms).
  const mirror = fighter.facing < 0;
  let rot = Math.sin(time * 1.8) * 0.15 - 0.35;
  if (fighter.attackAnim > 0 && fighter.attackTotal > 0) {
    const style = attackStyleOf(fighter.style.weapon.form, fighter.spec.weapon.type);
    const tim = ATTACK_TIMINGS[style];
    const u = 1 - fighter.attackAnim / fighter.attackTotal; // 0→1 over the swing
    const wF = tim.windup / tim.total;
    const aF = (tim.windup + tim.active) / tim.total;
    const f = fighter.facing;
    const lunge = (28 + weaponTipLength(fighter.style.weapon.form, fighter.style.weapon.size) * 0.9) * s;
    if (u < wF) {
      // Coil: draw back behind the mount, blade cocking up.
      const k = u / wF;
      const K = 1 - (1 - k) * (1 - k);
      ox = -f * 12 * s * K;
      oy = -5 * s * K;
      rot = -(0.35 + 0.9 * K);
    } else if (u < aF) {
      // Strike: dart at the target, whipping level through the hit.
      const k = (u - wF) / (aF - wF);
      const D = k * k;
      ox = f * (-12 * s + (lunge + 12 * s) * D);
      oy = -5 * s + 7 * s * D;
      rot = -(1.25 - 1.35 * D);
    } else {
      // Recovery: ease home with a touch of follow-through.
      const k = Math.min(1, (u - aF) / (1 - aF));
      const K = 1 - (1 - k) * (1 - k);
      const c = Math.sin(Math.min(1, k * 2.2) * Math.PI) * 0.15;
      ox = f * lunge * (1 - K) + f * c * 8 * s;
      oy = 2 * s * (1 - K);
      rot = 0.1 * (1 - K) + c;
    }
  }
  paint(
    { x: anchor.x + ox, y: anchor.y + oy - 6 * s + Math.sin(time * 2.4) * 2 },
    rot,
    mirror,
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

/** Torso / shoulders / arms / legs: LEGACY (v4.1 dropped the body outfit;
 * kept exported for reference/reuse). */
export function drawOutfitBody(
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
 * Afterimage — a frozen ghost of a fighter's silhouette, dropped along
 * dash/blink/leap paths and faded out by combat.updateEffects. Drawn with
 * the SAME body-path code as renderFighter, so the ghost always matches the
 * real silhouette.
 */
export interface Afterimage {
  sk: Skeleton;
  scale: number;
  facing: 1 | -1;
  color: string;
  ttl: number;
  maxTtl: number;
}

/** Deep-copy the pose (joints are mutated in place every frame). */
export function snapshotSkeleton(sk: Skeleton): Skeleton {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(sk)) {
    out[k] = typeof v === "number" ? v : { x: (v as Vec).x, y: (v as Vec).y };
  }
  return out as unknown as Skeleton;
}

export function drawAfterimage(ctx: CanvasRenderingContext2D, a: Afterimage): void {
  const life = Math.max(0, a.ttl / a.maxTtl); // 1 → 0
  const sk = a.sk;
  const s = a.scale;
  ctx.save();
  ctx.globalAlpha = 0.28 * life;
  ctx.shadowColor = a.color;
  ctx.shadowBlur = 8;
  flatBody(
    ctx,
    [
      taperedPath(sk.shoulderL, flourish(sk.shoulderL, sk.elbowL, sk.handL), sk.handL, 2.6 * s, 1.55 * s),
      taperedPath(sk.hipL, flourish(sk.hipL, sk.kneeL, sk.footL), sk.footL, 3.3 * s, 1.95 * s),
      taperedPath(
        sk.neck,
        { x: (sk.neck.x + sk.hips.x) / 2, y: (sk.neck.y + sk.hips.y) / 2 },
        sk.hips,
        3.9 * s,
        2.9 * s,
      ),
      taperedPath(sk.hipR, flourish(sk.hipR, sk.kneeR, sk.footR), sk.footR, 3.3 * s, 1.95 * s),
      capsulePath(sk.neck.x, sk.neck.y, sk.head.x, sk.head.y, 2.1 * s, 2.1 * s),
      circlePath(sk.head.x, sk.head.y, 9.2 * s),
      taperedPath(sk.shoulderR, flourish(sk.shoulderR, sk.elbowR, sk.handR), sk.handR, 2.6 * s, 1.55 * s),
    ],
    a.color,
  );
  ctx.restore();
}

/** Fixed gash layouts per region (deterministic — wounds don't flicker). */
const GASHES: Record<"head" | "torso" | "arm" | "legs", [number, number, number][]> = {
  // [offsetX, offsetY, angle] per gash, in fighter units around the anchor.
  head: [[-2, -2, 0.6], [3, 1, -0.4]],
  torso: [[-2, -4, 0.9], [3, 2, 0.4], [-1, 6, -0.5]],
  arm: [[0, -2, 0.7], [2, 3, -0.3]],
  legs: [[-1, 0, 0.5], [2, 6, -0.6]],
};

function drawWounds(ctx: CanvasRenderingContext2D, f: Fighter): void {
  if (!f.alive && !f.ragdoll) return;
  const sk = f.skeleton;
  const s = f.scale;
  const dark = f.gore === "sparks" ? "#3a3f4a" : "#6e1219";
  const bright = f.gore === "sparks" ? "#8a94a6" : "#a31f28";
  const anchors: Record<"head" | "torso" | "arm" | "legs", { x: number; y: number }> = {
    head: sk.head,
    torso: { x: (sk.neck.x + sk.hips.x) / 2, y: (sk.neck.y + sk.hips.y) / 2 },
    arm: { x: (sk.shoulderR.x + sk.elbowR.x) / 2, y: (sk.shoulderR.y + sk.elbowR.y) / 2 },
    legs: { x: (sk.hipL.x + sk.kneeL.x) / 2, y: (sk.hipL.y + sk.kneeL.y) / 2 },
  };
  ctx.save();
  ctx.lineCap = "round";
  for (const region of ["head", "torso", "arm", "legs"] as const) {
    const sev = injurySeverity(f, region);
    if (sev < 0.99 && injuryTier(f, region) === 0) continue;
    const at = anchors[region];
    const maimed = injuryTier(f, region) === 2;
    // Darkened bruise patch.
    ctx.globalAlpha = 0.25 + 0.3 * sev;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(at.x, at.y, (region === "torso" ? 6.5 : 4.5) * s * (0.7 + 0.5 * sev), 0, Math.PI * 2);
    ctx.fill();
    // Gash strokes (more + bolder when maimed).
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = bright;
    ctx.lineWidth = (maimed ? 1.8 : 1.2) * s;
    const gashes = GASHES[region].slice(0, maimed ? 3 : 2);
    for (const [gx, gy, ga] of gashes) {
      const len = (maimed ? 4.5 : 3) * s;
      ctx.beginPath();
      ctx.moveTo(at.x + gx * s - Math.cos(ga) * len, at.y + gy * s - Math.sin(ga) * len);
      ctx.lineTo(at.x + gx * s + Math.cos(ga) * len, at.y + gy * s + Math.sin(ga) * len);
      ctx.stroke();
    }
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
  if (fighter.blinkVanishTimer > 0 && fighter.alive) return; // mid-blink
  const s = fighter.scale;
  const fill =
    fighter.tintTimer > 0 && fighter.tintColor
      ? mix(fighter.style.fill, fighter.tintColor, 0.65)
      : fighter.style.fill;

  const sk = fighter.ragdoll
    ? skeletonFromRagdoll(fighter.ragdoll, fighter.facing)
    : fighter.skeleton;
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

  // Athletic build (v4.1): ~35% more mass than the old spindly frame —
  // Hyun's-Dojo weight, still a flat solid-color stickman.
  const armR0 = 2.6 * s, armR1 = 1.55 * s;
  const legR0 = 3.3 * s, legR1 = 1.95 * s;

  // Back gear (wings) sits BEHIND the body silhouette.
  drawGearBack(ctx, fighter, time);

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
        3.9 * s,
        2.9 * s,
      ),
      taperedPath(sk.hipR, flourish(sk.hipR, sk.kneeR, sk.footR), sk.footR, legR0, legR1),
      capsulePath(sk.neck.x, sk.neck.y, sk.head.x, sk.head.y, 2.1 * s, 2.1 * s),
      circlePath(sk.head.x, sk.head.y, 9.2 * s),
      taperedPath(sk.shoulderR, flourish(sk.shoulderR, sk.elbowR, sk.handR), sk.handR, armR0, armR1),
    ],
    fill,
  );

  // Functional gear over the body (chest plate etc.).
  drawGearFront(ctx, fighter, time);

  // INJURIES: darkened/reddened patches + gash marks on hurt regions,
  // scaling with severity (drawn deterministically — no flicker).
  drawWounds(ctx, fighter);

  // Head accessory: an LLM onRenderHead program owns the look when alive;
  // otherwise the keyword-derived parametric shape (viking → horned helm…).
  const hgRt = fighter.headRenderRuntime;
  if ((!hgRt || hgRt.done) && fighter.style.headgear) {
    drawHeadgear(ctx, fighter, fighter.style.headgear, time);
  }

  // Swing trail + weapon attached to the hand joint.
  updateAndDrawTrail(ctx, fighter, sk.handR, weaponAngle, time);
  drawWeapon(ctx, fighter, sk.handR, weaponAngle, time);

  // Casting weapons flare at the tip during the active frames.
  if (
    fighter.attackWindow > 0 &&
    attackStyleOf(fighter.style.weapon.form, fighter.spec.weapon.type) === "cast"
  ) {
    const len = weaponTipLength(fighter.style.weapon.form, fighter.style.weapon.size) * s;
    const tipX = sk.handR.x + Math.cos(weaponAngle) * len;
    const tipY = sk.handR.y + Math.sin(weaponAngle) * len;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = withAlpha(fighter.style.glow, 0.8);
    ctx.fillStyle = withAlpha(fighter.style.glow, 0.8);
    // Element-shaped CHARGE at the tip — gathering energy, not a glow disc.
    const el = fighter.style.element;
    const flick = Math.sin(time * 22);
    if (el === "fire") {
      // Flame licks: three flickering triangles leaning off the tip.
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.7 + flick * 0.15;
        const h = (6 + 3 * Math.sin(time * 17 + i * 2)) * s;
        ctx.beginPath();
        ctx.moveTo(tipX + Math.cos(a - 0.5) * 3 * s, tipY + Math.sin(a - 0.5) * 3 * s);
        ctx.lineTo(tipX + Math.cos(a) * h, tipY + Math.sin(a) * h);
        ctx.lineTo(tipX + Math.cos(a + 0.5) * 3 * s, tipY + Math.sin(a + 0.5) * 3 * s);
        ctx.closePath();
        ctx.fill();
      }
    } else if (el === "ice") {
      // Orbiting shard points.
      for (let i = 0; i < 4; i++) {
        const a = time * 4 + (i / 4) * Math.PI * 2;
        const px = tipX + Math.cos(a) * 7 * s;
        const py = tipY + Math.sin(a) * 7 * s;
        ctx.beginPath();
        ctx.moveTo(px, py - 3 * s);
        ctx.lineTo(px + 2 * s, py);
        ctx.lineTo(px, py + 3 * s);
        ctx.lineTo(px - 2 * s, py);
        ctx.closePath();
        ctx.fill();
      }
    } else if (el === "lightning") {
      // Two mini crackling bolts around the tip.
      ctx.lineWidth = 1.6 * s;
      for (let i = 0; i < 2; i++) {
        const a = time * 9 + i * Math.PI;
        const ex = tipX + Math.cos(a) * 9 * s;
        const ey = tipY + Math.sin(a) * 9 * s;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo((tipX + ex) / 2 + flick * 3 * s, (tipY + ey) / 2 - flick * 2 * s);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    } else if (el === "holy") {
      // Short rotating rays.
      ctx.lineWidth = 1.8 * s;
      for (let i = 0; i < 4; i++) {
        const a = time * 2 + (i / 4) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(tipX + Math.cos(a) * 3 * s, tipY + Math.sin(a) * 3 * s);
        ctx.lineTo(tipX + Math.cos(a) * (8 + flick) * s, tipY + Math.sin(a) * (8 + flick) * s);
        ctx.stroke();
      }
    } else {
      // Default/arcane/shadow: converging wisp arcs spiraling into the tip.
      ctx.lineWidth = 1.6 * s;
      for (let i = 0; i < 3; i++) {
        const a = -time * 5 + (i / 3) * Math.PI * 2;
        const r0 = (9 - ((time * 14 + i * 3) % 6)) * s;
        ctx.beginPath();
        ctx.arc(tipX, tipY, Math.max(1.5 * s, r0), a, a + 1.1);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Guard stance: a translucent one-sided shield arc on the FRONT — reads
  // as "blocking" and shows the guard only covers that side. Fades via
  // blockVis; on guard-break combat bursts it apart.
  if (fighter.blockVis > 0.03 && fighter.alive) {
    const v = fighter.blockVis;
    const cxb = sk.hips.x;
    const cyb = sk.hips.y - 22 * s;
    const rb = 40 * s;
    const mid = fighter.facing > 0 ? 0 : Math.PI; // arc faces forward
    const span = 1.05;
    ctx.save();
    ctx.globalAlpha = 0.5 * v;
    ctx.lineCap = "round";
    ctx.strokeStyle = withAlpha(fighter.style.glow, 0.9);
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(cxb, cyb, rb, mid - span, mid + span);
    ctx.stroke();
    // Soft translucent fill wedge behind the rim.
    ctx.globalAlpha = 0.14 * v;
    ctx.fillStyle = fighter.style.glow;
    ctx.beginPath();
    ctx.moveTo(cxb, cyb);
    ctx.arc(cxb, cyb, rb, mid - span, mid + span);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Dodge i-frames: a visible shimmer so invulnerability reads as a state.
  if (fighter.invulnTimer > 0 && fighter.alive) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55 + 0.3 * Math.sin(time * 26);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 14;
    const cy = sk.hips.y - 24 * s;
    const spin = time * 9;
    ctx.beginPath();
    ctx.arc(sk.hips.x, cy, 42 * s, spin, spin + Math.PI * 0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sk.hips.x, cy, 42 * s, spin + Math.PI, spin + Math.PI * 1.7);
    ctx.stroke();
    ctx.restore();
  }

  // Shield: a SOFT translucent energy dome — gentle rim, low alpha — whose
  // accents follow the casting ability's theme/element (a fire ward wears
  // flame licks; a holy aegis, rays; frost, facets). Never one loud shape
  // for every shield. Absorb ripples come from dealDamage.
  if (fighter.shieldTimer > 0) {
    const cxs = sk.hips.x;
    const cys = sk.hips.y - 24 * s;
    const rise = Math.min(1, (3 - Math.min(3, fighter.shieldTimer)) * 6 + 0.35);
    const rr = 58 * s * rise;
    const sc = fighter.shieldStyle?.color ?? fighter.style.glow;
    const flavor = fighter.shieldStyle?.theme ?? fighter.shieldStyle?.element ?? "none";
    ctx.save();
    // Glassy fill (soft).
    const dome = ctx.createRadialGradient(cxs, cys, rr * 0.3, cxs, cys, rr);
    dome.addColorStop(0, withAlpha(sc, 0.03));
    dome.addColorStop(0.82, withAlpha(sc, 0.08));
    dome.addColorStop(1, withAlpha(sc, 0.2));
    ctx.fillStyle = dome;
    ctx.beginPath();
    ctx.arc(cxs, cys, rr, 0, Math.PI * 2);
    ctx.fill();
    // Gentle rounded rim: low alpha, slow breathing glow.
    ctx.globalAlpha = 0.24 + 0.07 * Math.sin(time * 3.2);
    ctx.strokeStyle = sc;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = sc;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cxs, cys, rr, 0, Math.PI * 2);
    ctx.stroke();
    // Drifting shimmer band (the "energy is alive" read).
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "#ffffff";
    const band = time * 1.4;
    ctx.beginPath();
    ctx.arc(cxs, cys, rr * 0.93, band, band + 0.8);
    ctx.stroke();
    // THEMED accents, all quiet (alpha ≤ 0.4).
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = sc;
    ctx.fillStyle = sc;
    if (flavor === "fire") {
      // Three flame licks flickering up the rim.
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.9 + Math.sin(time * 7 + i * 2) * 0.08;
        const bx = cxs + Math.cos(a) * rr;
        const by = cys + Math.sin(a) * rr;
        const h = (5 + 2 * Math.sin(time * 11 + i * 3)) * s;
        ctx.beginPath();
        ctx.moveTo(bx - 2 * s, by);
        ctx.lineTo(bx, by - h);
        ctx.lineTo(bx + 2 * s, by);
        ctx.closePath();
        ctx.fill();
      }
    } else if (flavor === "ice") {
      // Four still crystal facets set into the rim.
      for (let i = 0; i < 4; i++) {
        const a = 0.5 + (i / 4) * Math.PI * 2;
        const bx = cxs + Math.cos(a) * rr;
        const by = cys + Math.sin(a) * rr;
        ctx.beginPath();
        ctx.moveTo(bx, by - 3.4 * s);
        ctx.lineTo(bx + 2.2 * s, by);
        ctx.lineTo(bx, by + 3.4 * s);
        ctx.lineTo(bx - 2.2 * s, by);
        ctx.closePath();
        ctx.fill();
      }
    } else if (flavor === "bolt" || flavor === "lightning") {
      // One jagged rim segment that hops around (crackling containment).
      const seg = Math.floor(time * 5) % 6;
      const a0 = (seg / 6) * Math.PI * 2;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const a = a0 + (i / 4) * 1.0;
        const wob = i % 2 === 0 ? 1 : 0.92 + 0.1 * Math.sin(time * 31 + i);
        const px = cxs + Math.cos(a) * rr * wob;
        const py = cys + Math.sin(a) * rr * wob;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else if (flavor === "holy") {
      // Four soft rays breathing outward from the crown.
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.5;
        const l = (6 + 2 * Math.sin(time * 2.5 + i)) * s;
        ctx.beginPath();
        ctx.moveTo(cxs + Math.cos(a) * rr, cys + Math.sin(a) * rr);
        ctx.lineTo(cxs + Math.cos(a) * (rr + l), cys + Math.sin(a) * (rr + l));
        ctx.stroke();
      }
    } else if (flavor === "void" || flavor === "shadow") {
      // A smoky counter-rotating inner ring.
      ctx.lineWidth = 2.2;
      ctx.globalAlpha = 0.28;
      const sp = -time * 1.1;
      ctx.beginPath();
      ctx.arc(cxs, cys, rr * 0.8, sp, sp + 1.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cxs, cys, rr * 0.8, sp + Math.PI, sp + Math.PI + 1.4);
      ctx.stroke();
    } else if (flavor === "wall") {
      // Vertical strut shadows inside the dome (a braced barrier).
      ctx.lineWidth = 1.4;
      for (let i = -1; i <= 1; i++) {
        const bx = cxs + i * rr * 0.42;
        const half = Math.sqrt(Math.max(0, rr * rr - (bx - cxs) * (bx - cxs))) * 0.92;
        ctx.beginPath();
        ctx.moveTo(bx, cys - half);
        ctx.lineTo(bx, cys + half);
        ctx.stroke();
      }
    }
    // default/arcane: dome + shimmer band only — quiet is a look too.
    ctx.restore();
  }
  // ROOTED: binding tendrils around the shins (movement is zeroed).
  if (fighter.rootedTimer > 0 && fighter.alive) {
    ctx.save();
    ctx.strokeStyle = withAlpha("#5a8f4a", 0.85);
    ctx.lineWidth = 2 * s;
    const fx = (sk.footL.x + sk.footR.x) / 2;
    const fy = Math.max(sk.footL.y, sk.footR.y);
    for (let i = 0; i < 3; i++) {
      const px = fx + (i - 1) * 7 * s;
      const sway = Math.sin(time * 6 + i * 2.1) * 2 * s;
      ctx.beginPath();
      ctx.moveTo(px, fy);
      ctx.quadraticCurveTo(px + sway, fy - 8 * s, px - sway, fy - 15 * s);
      ctx.stroke();
    }
    ctx.restore();
  }
  // MARKED: a slowly rotating curse sigil overhead.
  if (fighter.markTimer > 0 && fighter.alive) {
    ctx.save();
    ctx.strokeStyle = withAlpha("#c77dff", 0.8);
    ctx.lineWidth = 1.6 * s;
    ctx.shadowColor = "#c77dff";
    ctx.shadowBlur = 8;
    const mx = sk.head.x;
    const my = sk.head.y - 16 * s;
    const spin = time * 2;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const a = spin + (i / 4) * Math.PI * 2;
      const px = mx + Math.cos(a) * 5 * s;
      const py = my + Math.sin(a) * 5 * s;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }
  // COUNTER STANCE: a poised glint tracing the guard arm.
  if (fighter.counterTimer > 0 && fighter.alive) {
    ctx.save();
    ctx.strokeStyle = withAlpha("#ffd75e", 0.5 + 0.3 * Math.sin(time * 12));
    ctx.lineWidth = 2.2 * s;
    ctx.shadowColor = "#ffd75e";
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(sk.hips.x + fighter.facing * 12 * s, sk.hips.y - 22 * s, 16 * s, -1.1, 1.1);
    ctx.stroke();
    ctx.restore();
  }
  // Buff aura: element-shaped orbiters (flame ticks / shards / bolts /
  // stars) — not the one-size-fits-all spinning dots.
  if (fighter.buffTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = withAlpha(fighter.style.glow, 0.8);
    ctx.strokeStyle = withAlpha(fighter.style.glow, 0.85);
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 8;
    const el = fighter.style.element;
    for (let i = 0; i < 4; i++) {
      const a = time * (4.5 + (i % 2)) + (i * Math.PI * 2) / 4;
      const px = sk.hips.x + Math.cos(a) * (26 + i * 3) * s;
      const py = sk.hips.y - 20 * s + Math.sin(a) * (34 + i * 3) * s;
      if (el === "fire") {
        ctx.beginPath();
        ctx.moveTo(px - 2 * s, py + 2.5 * s);
        ctx.lineTo(px, py - 3.5 * s);
        ctx.lineTo(px + 2 * s, py + 2.5 * s);
        ctx.closePath();
        ctx.fill();
      } else if (el === "ice") {
        ctx.beginPath();
        ctx.moveTo(px, py - 3 * s);
        ctx.lineTo(px + 2 * s, py);
        ctx.lineTo(px, py + 3 * s);
        ctx.lineTo(px - 2 * s, py);
        ctx.closePath();
        ctx.fill();
      } else if (el === "lightning") {
        ctx.lineWidth = 1.4 * s;
        ctx.beginPath();
        ctx.moveTo(px - 2 * s, py - 3 * s);
        ctx.lineTo(px + 1 * s, py - 0.5 * s);
        ctx.lineTo(px - 1 * s, py + 0.5 * s);
        ctx.lineTo(px + 2 * s, py + 3 * s);
        ctx.stroke();
      } else if (el === "holy") {
        ctx.lineWidth = 1.3 * s;
        ctx.beginPath();
        ctx.moveTo(px - 2.6 * s, py);
        ctx.lineTo(px + 2.6 * s, py);
        ctx.moveTo(px, py - 2.6 * s);
        ctx.lineTo(px, py + 2.6 * s);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, (1.6 + (i % 2)) * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  ctx.restore();
}
