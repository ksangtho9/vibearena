import type { WeaponForm, WeaponSize } from "../types/character";

/**
 * Skeletal animation: the source of truth for how fighters MOVE. Physics
 * only handles the root capsule (walking/jumping/knockback collisions) and
 * the KO ragdoll. Every visible pose comes from here — procedural curves
 * per state, with 2-bone IK so feet plant on the ground without sliding and
 * hands reach their targets without stretching.
 *
 * Attacks are chosen by the weapon's FORM: a hammer chops two-handed
 * overhead, a spear thrusts, a whip cracks, a bow draws — same wind-up →
 * active → recovery phases and hit windows as before, different pose curves.
 */

export interface Vec {
  x: number;
  y: number;
}

export type AnimState =
  | "idle"
  | "run"
  | "backpedal"
  | "jump"
  | "fall"
  | "attack"
  | "cast"
  | "block"
  | "hitstun"
  | "launched"
  | "ko";

/** World-space joint positions, recomputed every simulation step. */
export interface Skeleton {
  hips: Vec;
  neck: Vec;
  head: Vec;
  /** Torso lean angle — the upright head + hat track this. */
  torsoAngle: number;
  shoulderL: Vec;
  elbowL: Vec;
  handL: Vec;
  shoulderR: Vec;
  elbowR: Vec;
  handR: Vec;
  hipL: Vec;
  kneeL: Vec;
  footL: Vec;
  hipR: Vec;
  kneeR: Vec;
  footR: Vec;
}

/** Bone lengths, scaled by appearance.height. */
export interface Bones {
  scale: number;
  spine: number;
  neckLen: number;
  headR: number;
  upperArm: number;
  foreArm: number;
  thigh: number;
  shin: number;
  /** Hips joint offset below the root capsule's center. */
  hipsOffset: number;
}

export function bonesFor(scale: number): Bones {
  return {
    scale,
    spine: 26 * scale,
    neckLen: 10 * scale,
    headR: 8.5 * scale,
    upperArm: 14 * scale,
    foreArm: 13 * scale,
    thigh: 20 * scale,
    shin: 19 * scale,
    hipsOffset: 4 * scale,
  };
}

// ---------------------------------------------------------------------------
// Attack styles: which animation a weapon form performs
// ---------------------------------------------------------------------------

export type AttackStyle =
  | "slash" // one-handed diagonal cut
  | "chop" // two-handed overhead slam
  | "thrust" // two-handed stab along the reach line
  | "reap" // wide horizontal sweep
  | "crack" // whip wave-and-snap
  | "cast" // raise + push (staff/orb)
  | "draw" // bow: pull string, release
  | "shoot" // gun: aim + recoil
  | "bash" // shield shove
  | "punch" // fist-family jab / claw rake (also unarmed mount:none)
  | "throw"; // over-the-shoulder release

type MechType = "melee" | "ranged" | "thrown";

export function attackStyleOf(form: WeaponForm, type: MechType): AttackStyle {
  if (type === "thrown") return "throw";
  if (type === "ranged") {
    if (form === "bow") return "draw";
    if (form === "gun" || form === "cannon") return "shoot";
    return "cast"; // staff, orb
  }
  switch (form) {
    case "fist":
    case "gauntlet":
    case "claw":
      return "punch";
    case "greatsword":
    case "axe":
    case "hammer":
    case "warhammer":
    case "mace":
    case "flail":
      return "chop";
    case "spear":
    case "halberd":
    case "rapier":
      return "thrust";
    case "scythe":
      return "reap";
    case "whip":
      return "crack";
    case "staff":
      return "cast";
    case "shield":
      return "bash";
    default:
      return "slash"; // sword, dagger, claw + snapped fallbacks
  }
}

export interface AttackTiming {
  windup: number;
  active: number;
  recovery: number;
  total: number;
}

const timing = (windup: number, active: number, recovery: number): AttackTiming => ({
  windup,
  active,
  recovery,
  total: windup + active + recovery,
});

/** Per-style phase timing. Melee totals stay under the 0.55s cooldown. */
export const ATTACK_TIMINGS: Record<AttackStyle, AttackTiming> = {
  slash: timing(0.1, 0.14, 0.18),
  chop: timing(0.16, 0.16, 0.2),
  thrust: timing(0.1, 0.14, 0.16),
  reap: timing(0.14, 0.18, 0.2),
  crack: timing(0.12, 0.14, 0.18),
  bash: timing(0.08, 0.12, 0.16),
  punch: timing(0.1, 0.14, 0.18),
  cast: timing(0.12, 0.08, 0.16),
  draw: timing(0.18, 0.08, 0.14),
  shoot: timing(0.08, 0.08, 0.14),
  throw: timing(0.12, 0.08, 0.16),
};

export function attackTimingOf(form: WeaponForm, type: MechType): AttackTiming {
  return ATTACK_TIMINGS[attackStyleOf(form, type)];
}

/** Heavy/polearm forms keep both hands on the weapon outside attacks too. */
function isTwoHanded(form: WeaponForm, size: WeaponSize, type: MechType): boolean {
  if (type !== "melee") return false;
  const style = attackStyleOf(form, type);
  if (style === "chop" || style === "thrust" || style === "reap") return true;
  if (form === "staff") return true;
  return size === "large" && style === "slash";
}

export const CAST_TIME = 0.35;

/**
 * 2-bone IK: joint chain base→mid→end with segment lengths l1, l2 reaching
 * for `target`. Returns the mid joint and the clamped (reachable) end point.
 * `bend` picks the side the joint folds toward.
 */
export function solveIK(
  base: Vec,
  target: Vec,
  l1: number,
  l2: number,
  bend: 1 | -1,
): { mid: Vec; end: Vec } {
  const dx = target.x - base.x;
  const dy = target.y - base.y;
  const rawD = Math.hypot(dx, dy) || 0.0001;
  const d = Math.min(l1 + l2 - 0.5, Math.max(Math.abs(l1 - l2) + 0.5, rawD));
  const ux = dx / rawD;
  const uy = dy / rawD;
  const end = { x: base.x + ux * d, y: base.y + uy * d };
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  return {
    mid: { x: base.x + ux * a - uy * h * bend, y: base.y + uy * a + ux * h * bend },
    end,
  };
}

/** Everything the animator needs to know about the fighter this frame. */
export interface AnimInputs {
  rootX: number;
  rootY: number;
  vx: number;
  vy: number;
  grounded: boolean;
  facing: 1 | -1;
  moving: boolean;
  alive: boolean;
  /** Guard stance is up (block key held). */
  blocking: boolean;
  /** Seconds since the current attack started; -1 when not attacking. */
  attackElapsed: number;
  weaponForm: WeaponForm;
  weaponSize: WeaponSize;
  weaponType: MechType;
  /** Where the weapon lives; non-hand mounts swap the swing for a command
   * gesture (the weapon itself strikes — see stickman drawWeapon). */
  weaponMount?: "hand" | "head" | "body" | "floating" | "dual" | "none";
  /** Opponent chest position — keyframed strikes AIM their arc at it. */
  aimX?: number;
  aimY?: number;
  /** Combo swing variant 0–3 (sword family cycles keyframe tables;
   * variant 3 is the finisher on FINISHER_TIMING). */
  comboVariant?: number;
  castTimer: number;
  hitstunTimer: number;
  launchedTimer: number;
  groundY: number;
  time: number;
}

export interface AnimFrame {
  skeleton: Skeleton;
  weaponAngle: number;
  state: AnimState;
  /** Weapon motion-smear for this frame (world angles) — the renderer draws
   * ghosted copies along the arc instead of a crisp weapon. */
  smear?: { from: number; to: number } | null;
}

export interface Animator {
  state: AnimState;
  update(dt: number, inp: AnimInputs): AnimFrame;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Follow-through bump: rises then settles within the phase (0 at both ends). */
const carry = (k: number, amp: number) => Math.sin(Math.min(1, k * 2.2) * Math.PI) * amp;

interface FootPlant {
  locked: boolean;
  x: number;
}

type AttackPhase = "windup" | "active" | "recovery";

/** What one attack style contributes to the pose this frame. */
interface AttackContribution {
  /** Weapon-hand target, in "forward/up" units relative to the neck. */
  hand: { fwd: number; up: number };
  /** Weapon direction as an angle relative to facing (0 = forward, -90° = up). */
  dirRel: number | null;
  lean: number;
  /** Extra hips drop (+down) for weight. */
  hipsDy: number;
  /** Off-hand target override (fwd/up rel neck); null = style default. */
  offHand: { fwd: number; up: number } | null;
  // --- keyframe-path extras (undefined on the procedural path) ---
  /** Pose-only forward body nudge (returns by recovery). */
  rootDx?: number;
  /** Foot placement rel hips (fwd = facing); front → footL, back → footR. */
  footFront?: number;
  footBack?: number;
  footFrontUp?: number;
  /** Weapon smear this frame: dirRel endpoint angles of the fast transition. */
  smear?: { from: number; to: number };
}

/**
 * Pose curves per attack style and phase. All units are in fighter-scale `s`;
 * `k` is progress 0→1 within the phase. `form`/`size`/`twoHanded` let a style
 * flavor its arc per weapon (dagger flick vs sword sweep) without touching
 * the shared phase timing.
 */
function attackContribution(
  style: AttackStyle,
  phase: AttackPhase,
  k: number,
  form: WeaponForm,
  size: WeaponSize,
  twoHanded: boolean,
): AttackContribution {
  const out: AttackContribution = {
    hand: { fwd: 10, up: -14 },
    dirRel: -0.55,
    lean: 0.08,
    hipsDy: 0,
    offHand: null,
  };
  const K = easeOut(k);

  switch (style) {
    case "slash": {
      // One-handed diagonal cut with real weight: coil the weapon back+up
      // over the shoulder, whip it through the diagonal as the torso rotates
      // into the cut, then carry PAST the target before easing back to guard.
      // The hand rides an arc around the chest instead of a straight lerp.
      const flick = form === "dagger" || form === "claw"; // short snappy cut
      const arc = flick ? 0.72 : size === "large" ? 1.12 : 1;
      const rF = 21 * arc; // hand-orbit radii (fwd / up) around the chest
      const rU = 16 * arc;
      const upBase = flick ? -7 : -5;
      const cock = flick ? -1.95 : -2.35; // wind-up angle, past vertical
      const followEnd = flick ? 0.38 : 0.55; // cut exits low-forward
      const coil = flick ? -0.05 : -0.11; // torso wind-back
      const drive = flick ? 0.2 : 0.3; // torso rotation into the cut
      const sink = flick ? 1.5 : 3; // weight transfer through the hips
      const handAt = (phi: number) => ({
        fwd: Math.cos(phi) * rF,
        up: Math.sin(phi) * rU + upBase,
      });

      if (phase === "windup") {
        const phi = lerp(-0.75, cock, K);
        out.hand = handAt(phi);
        out.dirRel = lerp(-0.55, cock + 0.1, K);
        out.lean = lerp(0.08, coil, K); // shoulder/hip coil
        out.hipsDy = (flick ? -0.5 : -1.5) * K; // load the back leg
        // Free hand aims down the line of the coming cut.
        if (!twoHanded) out.offHand = { fwd: lerp(3, 10, K), up: lerp(-8, -11, K) };
      } else if (phase === "active") {
        const D = easeIn(k); // accelerate — the whip
        const phi = lerp(cock, followEnd, D);
        out.hand = handAt(phi);
        out.dirRel = lerp(cock + 0.1, followEnd + 0.15, D);
        out.lean = lerp(coil, drive, D); // lead shoulder drives through
        out.hipsDy = lerp(flick ? -0.5 : -1.5, sink, D);
        // Counter-balance: the free arm swings back across the body.
        if (!twoHanded) out.offHand = { fwd: lerp(10, -9, D), up: lerp(-11, -3, D) };
      } else {
        // Follow-through: momentum carries a touch past, then back to guard.
        const carry = Math.sin(Math.min(1, k * 2.2) * Math.PI) * (flick ? 0.1 : 0.18);
        const from = handAt(followEnd);
        out.hand = {
          fwd: lerp(from.fwd, 10, K) + carry * 6,
          up: lerp(from.up, -14, K) + carry * 4,
        };
        out.dirRel = lerp(followEnd + 0.15, -0.55, K) + carry;
        out.lean = lerp(drive, 0.08, K) + carry * 0.4;
        out.hipsDy = lerp(sink, 0, K);
        if (!twoHanded) out.offHand = { fwd: lerp(-9, 3, K), up: lerp(-3, -8, K) };
      }
      break;
    }
    case "chop": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, -4, K), up: lerp(-12, -26, K) };
        out.dirRel = lerp(-0.7, -1.75, K);
        out.lean = lerp(0.06, -0.14, K);
        out.hipsDy = -3 * K; // rise onto the toes
      } else if (phase === "active") {
        const D = easeIn(k); // accelerate into the slam
        out.hand = { fwd: lerp(-4, 18, D), up: lerp(-26, 8, D) };
        out.dirRel = lerp(-1.75, 0.85, D);
        out.lean = lerp(-0.14, 0.32, D);
        out.hipsDy = lerp(-3, 5, D); // drop the weight in
      } else {
        // Follow-through: the head buries past the target, then eases home.
        const c = carry(k, 1);
        out.hand = { fwd: lerp(18, 8, K) + c * 2.5, up: lerp(8, -12, K) + c * 3 };
        out.dirRel = lerp(0.85, -0.7, K) + c * 0.18;
        out.lean = lerp(0.32, 0.06, K) + c * 0.05;
        out.hipsDy = lerp(5, 0, K) + c * 0.8;
      }
      out.offHand = { fwd: out.hand.fwd, up: out.hand.up }; // both on the haft
      break;
    }
    case "thrust": {
      // Spear stays level: the tip travels the reach line.
      out.dirRel = -0.05;
      if (phase === "windup") {
        // Coil: hips + shoulder load back, tip stays on line.
        out.hand = { fwd: lerp(4, -9, K), up: lerp(-6, -5, K) };
        out.lean = lerp(0.08, -0.09, K);
        out.hipsDy = -1.2 * K;
      } else if (phase === "active") {
        const D = easeIn(k);
        out.hand = { fwd: lerp(-9, 15, D), up: -6 };
        out.lean = lerp(-0.09, 0.28, D); // whole body lunges down the line
        out.hipsDy = lerp(-1.2, 2.5, D);
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(15, 4, K) + c * 1.6, up: -6 };
        out.lean = lerp(0.28, 0.08, K) + c * 0.04;
        out.hipsDy = lerp(2.5, 0, K);
      }
      break;
    }
    case "reap": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(6, -13, K), up: lerp(-10, -4, K) };
        out.dirRel = lerp(-0.6, -2.4, K);
        out.lean = lerp(0.06, -0.1, K);
      } else if (phase === "active") {
        const D = easeIn(k); // the sweep ACCELERATES through the arc
        out.hand = { fwd: lerp(-13, 19, D), up: lerp(-4, -8, D) };
        out.dirRel = lerp(-2.4, 0.25, D);
        out.lean = lerp(-0.1, 0.3, D);
        out.hipsDy = 3 * D;
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(19, 6, K) + c * 2, up: lerp(-8, -10, K) };
        out.dirRel = lerp(0.25, -0.6, K) + c * 0.22;
        out.lean = lerp(0.3, 0.06, K) + c * 0.05;
        out.hipsDy = lerp(3, 0, K);
      }
      break;
    }
    case "crack": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, -9, K), up: lerp(-12, -18, K) };
        out.dirRel = lerp(-0.4, -2.1, K);
        out.lean = lerp(0.06, -0.06, K);
      } else if (phase === "active") {
        out.hand = { fwd: lerp(-9, 20, easeIn(k)), up: lerp(-18, -4, K) };
        out.dirRel = lerp(-2.1, 0.2, easeIn(k));
        out.lean = lerp(-0.06, 0.26, K);
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(20, 8, K) + c * 1.5, up: lerp(-4, -12, K) };
        out.dirRel = lerp(0.2, -0.4, K) + c * 0.25; // the lash settles in waves
        out.lean = lerp(0.26, 0.06, K) + c * 0.04;
      }
      break;
    }
    case "cast": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, 2, K), up: lerp(-12, -20, K) };
        out.dirRel = lerp(-0.55, -1.25, K);
        out.lean = lerp(0.06, -0.07, K); // gather: weight rocks back
        out.hipsDy = -1 * K;
      } else if (phase === "active") {
        const D = easeIn(k);
        out.hand = { fwd: lerp(2, 17, D), up: lerp(-20, -6, D) };
        out.dirRel = lerp(-1.25, -0.15, D);
        out.lean = lerp(-0.07, 0.22, D); // the PUSH comes from the torso
        out.hipsDy = lerp(-1, 1.5, D);
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(17, 8, K) + c * 1.4, up: lerp(-6, -12, K) };
        out.dirRel = lerp(-0.15, -0.55, K);
        out.lean = lerp(0.22, 0.06, K) + c * 0.03;
        out.hipsDy = lerp(1.5, 0, K);
      }
      break;
    }
    case "draw": {
      out.dirRel = -0.08;
      out.lean = 0.12;
      if (phase === "windup") {
        // Bow arm steady forward; string hand pulls back to the cheek and
        // the archer settles INTO the draw (weight sinks, slight lean back).
        out.hand = { fwd: 14, up: -6 };
        out.offHand = { fwd: lerp(12, -2, easeInOut(k)), up: -5 };
        out.lean = lerp(0.12, 0.05, K);
        out.hipsDy = -1 * K;
      } else if (phase === "active") {
        // Release: string hand snaps forward, slight bow recoil.
        out.hand = { fwd: lerp(14, 12.5, K), up: -6 };
        out.offHand = { fwd: lerp(-2, 10, easeOut(k)), up: -5.5 };
      } else {
        out.hand = { fwd: lerp(12.5, 10, K), up: lerp(-6, -12, K) };
        out.offHand = null;
        out.dirRel = lerp(-0.08, -0.5, K);
        out.lean = lerp(0.12, 0.08, K);
      }
      break;
    }
    case "shoot": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, 13, K), up: lerp(-12, -7, K) };
        out.dirRel = lerp(-0.5, 0, K);
        out.lean = 0.1;
      } else if (phase === "active") {
        // Recoil kick: hand back and up, muzzle climbs.
        out.hand = { fwd: lerp(13, 8.5, easeOut(k)), up: lerp(-7, -11, easeOut(k)) };
        out.dirRel = lerp(0, -0.35, easeOut(k));
        out.lean = lerp(0.1, -0.04, K);
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(8.5, 8, K), up: lerp(-11, -12, K) + c * 1.2 };
        out.dirRel = lerp(-0.35, -0.5, K) - c * 0.08; // muzzle settles down
        out.lean = lerp(-0.04, 0.08, K);
      }
      break;
    }
    case "bash": {
      out.dirRel = -0.3;
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, 1, K), up: lerp(-10, -6, K) };
        out.lean = lerp(0.06, -0.09, K); // shoulder loads behind the shield
        out.hipsDy = -1 * K;
      } else if (phase === "active") {
        const D = easeIn(k);
        out.hand = { fwd: lerp(1, 18, D), up: -8 };
        out.lean = lerp(-0.09, 0.32, D); // whole body slams in
        out.hipsDy = lerp(-1, 3, D);
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(18, 8, K) + c * 1.8, up: lerp(-8, -10, K) };
        out.lean = lerp(0.32, 0.06, K) + c * 0.05;
        out.hipsDy = lerp(3, 0, K);
      }
      break;
    }
    case "punch": {
      // A PUNCH, not a swing: retract + coil, EXPLODE straight forward with
      // the whole body behind it, snap back to guard. Claws rake — the same
      // jab with a small forward arc as the talons drag through.
      const rake = form === "claw";
      out.dirRel = -0.25; // knuckles angled slightly up at guard
      if (phase === "windup") {
        // Retract the fist to the ribs; shoulder + hip coil behind it.
        out.hand = { fwd: lerp(10, 1, K), up: lerp(-14, -9, K) };
        out.dirRel = lerp(-0.25, -0.35, K);
        out.lean = lerp(0.08, -0.12, K);
        out.hipsDy = -1.2 * K;
        out.offHand = { fwd: lerp(3, 9, K), up: -13 }; // lead guard stays up
      } else if (phase === "active") {
        const D = easeIn(k); // explode out
        const arc = rake ? Math.sin(D * Math.PI) * 4 : 0; // talons rake an arc
        out.hand = { fwd: lerp(1, 17.5, D), up: lerp(-9, rake ? -6 : -11, D) - arc };
        out.dirRel = lerp(-0.35, rake ? 0.2 : -0.02, D);
        out.lean = lerp(-0.12, 0.3, D); // hips + shoulder drive through
        out.hipsDy = lerp(-1.2, 2, D);
        out.offHand = { fwd: lerp(9, -6, D), up: lerp(-13, -8, D) }; // counter-pull
      } else {
        // Quick snap back to guard (faster than the swing recovery).
        const Q = 1 - (1 - Math.min(1, k * 1.35)) * (1 - Math.min(1, k * 1.35));
        const c = carry(k, 0.8);
        out.hand = { fwd: lerp(17.5, 10, Q) + c * 1.2, up: lerp(rake ? -6 : -11, -14, Q) };
        out.dirRel = lerp(rake ? 0.2 : -0.02, -0.25, Q);
        out.lean = lerp(0.3, 0.08, Q) + c * 0.03;
        out.hipsDy = lerp(2, 0, Q);
        out.offHand = { fwd: lerp(-6, 3, Q), up: lerp(-8, -8, Q) };
      }
      break;
    }
    case "throw": {
      if (phase === "windup") {
        out.hand = { fwd: lerp(8, -8, K), up: lerp(-10, -19, K) };
        out.dirRel = lerp(-0.5, -2.0, K);
        out.lean = lerp(0.06, -0.13, K); // hips + torso coil behind the throw
        out.hipsDy = -1.5 * K;
        out.offHand = { fwd: lerp(3, 11, K), up: -10 }; // sight down the line
      } else if (phase === "active") {
        const D = easeOut(k);
        out.hand = { fwd: lerp(-8, 19, D), up: lerp(-19, -8, D) };
        out.dirRel = lerp(-2.0, 0.1, D);
        out.lean = lerp(-0.13, 0.28, D);
        out.hipsDy = lerp(-1.5, 2.5, D);
        out.offHand = { fwd: lerp(11, -7, D), up: lerp(-10, -4, D) }; // counter-swing
      } else {
        const c = carry(k, 1);
        out.hand = { fwd: lerp(19, 8, K) + c * 2, up: lerp(-8, -11, K) + c * 1.5 };
        out.dirRel = lerp(0.1, -0.5, K);
        out.lean = lerp(0.28, 0.06, K) + c * 0.05;
        out.hipsDy = lerp(2.5, 0, K);
        out.offHand = { fwd: lerp(-7, 3, K), up: lerp(-4, -8, K) };
      }
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// KEYFRAME attacks — ordered full-silhouette key poses mapped onto the
// EXISTING phase windows (contact lands exactly at the active-window start,
// so combat timing is untouched). Styles without a table fall back to the
// procedural attackContribution path unchanged. Prototyped on `slash`.
// ---------------------------------------------------------------------------

/** One authored pose, in strike-relative space (facing-forward units). */
interface KeyPose {
  lean: number;
  hipsDy: number;
  /** Pose-only forward nudge of the whole body (returns by recovery —
   * never moves the physics root). */
  rootDx: number;
  hand: { fwd: number; up: number };
  offHand: { fwd: number; up: number };
  /** Weapon angle rel facing (matches AttackContribution.dirRel). */
  weapon: number;
  /** Foot placement rel hips (fwd = facing direction). */
  footFront: number;
  footBack: number;
  /** Lift of the FRONT foot off the ground (coil unweights it). */
  footFrontUp?: number;
  /** 0–1: how much this pose rotates toward the strike aim (the opponent). */
  aim: number;
}

interface AttackKeyframe {
  /** Position 0–1 across the whole attack (windup+active+recovery). */
  atPhase: number;
  /** Freeze at this pose for this many seconds before easing onward. */
  hold?: number;
  /** The transition INTO the next keyframe renders a weapon smear. */
  smear?: boolean;
  /** The impact pose (lands at the active-window start). */
  contact?: boolean;
  /** Easing of the transition INTO the next keyframe. */
  easeTo?: "in" | "out" | "inOut";
  pose: KeyPose;
}

/** Matches the actual IDLE guard (hand low at the hip line), so the swing
 * enters from and settles back to exactly where the fighter stands. */
const SLASH_READY: KeyPose = {
  lean: 0.08, hipsDy: 1, rootDx: 0,
  hand: { fwd: 9, up: 10 }, offHand: { fwd: 3, up: 16 },
  weapon: -0.55, footFront: 8, footBack: -7, aim: 0,
};

/** Contact must land exactly when the active window opens. */
const SLASH_CONTACT_PHASE = ATTACK_TIMINGS.slash.windup / ATTACK_TIMINGS.slash.total;

const SLASH_KEYFRAMES: AttackKeyframe[] = [
  { atPhase: 0, easeTo: "inOut", pose: SLASH_READY },
  {
    // COILED — PUSHED: blade wound far past vertical behind the shoulder,
    // torso twisted hard away, hips risen onto the back foot with the front
    // foot visibly unweighted, off-hand flung out. Unmistakably "loading".
    atPhase: 0.1,
    hold: 0.02,
    easeTo: "in",
    pose: {
      lean: -0.26, hipsDy: -3, rootDx: -4.5,
      hand: { fwd: -9, up: -22 }, offHand: { fwd: 14, up: -13 },
      weapon: -2.75, footFront: 9, footBack: -7, footFrontUp: 5, aim: 0.1,
    },
  },
  {
    // CONTACT — the blade arrives HIGH-forward, mid-cut and still moving:
    // the sweep passes through level during the active frames instead of
    // parking there. Torso upright and rotating through, weight slammed
    // onto the front foot. Only a whisper of a hold — the cut keeps going.
    atPhase: SLASH_CONTACT_PHASE,
    hold: 0.015,
    contact: true,
    smear: true, // the streak rides the overhead→forward DESCENT (a down-cut)
    easeTo: "out",
    pose: {
      // ARM FULLY EXTENDED, blade OVERHEAD: the cut arrives cocked high and
      // carves DOWN through the active frames — the tip traces a tall
      // vertical arc instead of pointing at the enemy the whole window.
      lean: 0.14, hipsDy: 5, rootDx: 6,
      hand: { fwd: 24, up: -10 }, offHand: { fwd: -14, up: -2 },
      weapon: -1.75, footFront: 18, footBack: -14, aim: 0.5,
    },
  },
  {
    // MID-CUT — the descending blade passes through FORWARD right here (the
    // one frame it points at the enemy); the extended arm keeps sweeping.
    atPhase: 0.4,
    easeTo: "in",
    pose: {
      lean: 0.18, hipsDy: 6.5, rootDx: 6,
      hand: { fwd: 25, up: -1 }, offHand: { fwd: -12, up: -3 },
      weapon: 0.1, footFront: 20, footBack: -16, aim: 0.4,
    },
  },
  {
    // FOLLOW-THROUGH — the arm carries down-across to a LOW, still-extended
    // finish (hand below chest, well out from the body). (Capped: the tip
    // stays clear of the fighter's own feet.) Eases OUT so the blade starts
    // LIFTING immediately — no dwell in the low finish.
    atPhase: 0.5714,
    easeTo: "out",
    pose: {
      lean: 0.2, hipsDy: 6, rootDx: 5,
      hand: { fwd: 20, up: 6 }, offHand: { fwd: -9, up: -4 },
      weapon: 0.5, footFront: 20, footBack: -16, aim: 0.25,
    },
  },
  {
    // LIFT — early recovery: the sword swings back UP past level while the
    // legs start pushing out of the lunge ("bring the sword back up").
    atPhase: 0.68,
    easeTo: "inOut",
    pose: {
      lean: 0.2, hipsDy: 3.5, rootDx: 3,
      hand: { fwd: 14, up: -2 }, offHand: { fwd: -5, up: -5 },
      weapon: -0.35, footFront: 16, footBack: -12, aim: 0.15,
    },
  },
  {
    // SETTLE — hand retracting in, blade already at guard pitch.
    atPhase: 0.8,
    easeTo: "inOut",
    pose: {
      lean: 0.1, hipsDy: 1.5, rootDx: 1,
      hand: { fwd: 12, up: -4 }, offHand: { fwd: -2, up: -6 },
      weapon: -0.45, footFront: 10, footBack: -7, aim: 0.1,
    },
  },
  { atPhase: 1, pose: SLASH_READY },
];

/**
 * COMBO swing 2 — BACK-SLASH: a horizontal reverse sweep. The blade whips
 * around from behind the off-shoulder and cuts LEVEL through the target —
 * upright body, flat arc (vs slash's overhead drop). Shares slash timing
 * byte-for-byte: pure visual swap.
 */
const BACKSLASH_KEYFRAMES: AttackKeyframe[] = [
  { atPhase: 0, easeTo: "inOut", pose: SLASH_READY },
  {
    // COIL — arm crosses the body, blade wrapped behind the off-shoulder,
    // torso twisted away. Front heel light, weight back.
    atPhase: 0.1,
    hold: 0.02,
    easeTo: "in",
    pose: {
      lean: -0.2, hipsDy: -2, rootDx: -3.5,
      hand: { fwd: -7, up: -14 }, offHand: { fwd: 12, up: -8 },
      weapon: -2.9, footFront: 7, footBack: -8, footFrontUp: 3, aim: 0.1,
    },
  },
  {
    // CONTACT — the blade has whipped around and cuts LEVEL, arm extended.
    // Taller than the slash lunge: a horizontal sweep stands up into it.
    atPhase: SLASH_CONTACT_PHASE,
    hold: 0.015,
    contact: true,
    smear: true,
    easeTo: "out",
    pose: {
      lean: 0.12, hipsDy: 3, rootDx: 5,
      hand: { fwd: 24, up: -6 }, offHand: { fwd: -12, up: -2 },
      weapon: -0.6, footFront: 16, footBack: -12, aim: 0.5,
    },
  },
  {
    // MID — sweeping through dead level, fully across the target line.
    atPhase: 0.4,
    easeTo: "in",
    pose: {
      lean: 0.16, hipsDy: 4, rootDx: 5,
      hand: { fwd: 25, up: -2 }, offHand: { fwd: -11, up: -3 },
      weapon: 0.3, footFront: 18, footBack: -14, aim: 0.4,
    },
  },
  {
    // FOLLOW — the arm carries ACROSS the chest (flat finish, not low).
    atPhase: 0.5714,
    easeTo: "out",
    pose: {
      lean: 0.15, hipsDy: 3, rootDx: 4,
      hand: { fwd: 12, up: 0 }, offHand: { fwd: -7, up: -4 },
      weapon: 0.45, footFront: 18, footBack: -14, aim: 0.25,
    },
  },
  {
    // LIFT — blade back up past level while the feet narrow.
    atPhase: 0.68,
    easeTo: "inOut",
    pose: {
      lean: 0.12, hipsDy: 2, rootDx: 2.5,
      hand: { fwd: 13, up: -3 }, offHand: { fwd: -4, up: -5 },
      weapon: -0.35, footFront: 14, footBack: -10, aim: 0.15,
    },
  },
  {
    atPhase: 0.8,
    easeTo: "inOut",
    pose: {
      lean: 0.1, hipsDy: 1.5, rootDx: 1,
      hand: { fwd: 12, up: -4 }, offHand: { fwd: -2, up: -6 },
      weapon: -0.45, footFront: 10, footBack: -7, aim: 0.1,
    },
  },
  { atPhase: 1, pose: SLASH_READY },
];

/**
 * COMBO swing 3 — RISING SLASH: low → up diagonal. Crouch-gather with the
 * blade tucked low behind, then a scooping upward carve that finishes HIGH
 * with the body stretched tall (the inverse of slash's drop). Shares slash
 * timing byte-for-byte: pure visual swap.
 */
const RISING_KEYFRAMES: AttackKeyframe[] = [
  { atPhase: 0, easeTo: "inOut", pose: SLASH_READY },
  {
    // COIL — CROUCH: hips sink, hand drops to the back hip, blade tucked
    // back-down behind the body.
    atPhase: 0.1,
    hold: 0.02,
    easeTo: "in",
    pose: {
      lean: 0.05, hipsDy: 4, rootDx: -3,
      hand: { fwd: -4, up: 9 }, offHand: { fwd: 10, up: -6 },
      weapon: 2.9, footFront: 8, footBack: -8, aim: 0.1,
    },
  },
  {
    // CONTACT — the blade scoops through down-forward, body rising out of
    // the crouch, arm extending.
    atPhase: SLASH_CONTACT_PHASE,
    hold: 0.015,
    contact: true,
    smear: true,
    easeTo: "out",
    pose: {
      lean: 0.15, hipsDy: 1, rootDx: 4,
      hand: { fwd: 20, up: 4 }, offHand: { fwd: -10, up: -2 },
      weapon: 0.8, footFront: 15, footBack: -11, aim: 0.5,
    },
  },
  {
    // MID — carving UP through level; the body is now taller than guard.
    atPhase: 0.4,
    easeTo: "in",
    pose: {
      lean: 0.1, hipsDy: -2, rootDx: 4,
      hand: { fwd: 24, up: -8 }, offHand: { fwd: -9, up: -1 },
      weapon: -0.6, footFront: 14, footBack: -10, aim: 0.4,
    },
  },
  {
    // FOLLOW — blade finishes HIGH, body stretched tall on its toes-feel.
    atPhase: 0.5714,
    easeTo: "out",
    pose: {
      lean: 0.02, hipsDy: -3, rootDx: 3,
      hand: { fwd: 14, up: -18 }, offHand: { fwd: -6, up: 0 },
      weapon: -1.5, footFront: 12, footBack: -8, aim: 0.25,
    },
  },
  {
    // LIFT(down) — the sword comes DOWN from the high finish toward guard.
    atPhase: 0.7,
    easeTo: "inOut",
    pose: {
      lean: 0.06, hipsDy: 0, rootDx: 2,
      hand: { fwd: 12, up: -10 }, offHand: { fwd: -3, up: -3 },
      weapon: -1.0, footFront: 10, footBack: -7, aim: 0.15,
    },
  },
  {
    atPhase: 0.82,
    easeTo: "inOut",
    pose: {
      lean: 0.08, hipsDy: 1, rootDx: 1,
      hand: { fwd: 10, up: -2 }, offHand: { fwd: 0, up: -6 },
      weapon: -0.55, footFront: 9, footBack: -7, aim: 0.1,
    },
  },
  { atPhase: 1, pose: SLASH_READY },
];

/**
 * COMBO swing 4 — FINISHER: a big committed overhead smash. Its OWN timing
 * (heavier windup with a held high cock, longer recovery) — a deliberate
 * separate attack, never a mutation of the shared slash windows. Combat
 * grants it launch/knockback only when the chain qualified.
 */
export const FINISHER_TIMING: AttackTiming = timing(0.16, 0.09, 0.27);
const FINISHER_CONTACT_PHASE = FINISHER_TIMING.windup / FINISHER_TIMING.total;

const FINISHER_KEYFRAMES: AttackKeyframe[] = [
  { atPhase: 0, easeTo: "inOut", pose: SLASH_READY },
  {
    // DEEP COIL — both hands drive the blade high overhead, big lean back,
    // body stretched. The long hold IS the heavy windup tell.
    atPhase: 0.14,
    hold: 0.05,
    easeTo: "in",
    pose: {
      lean: -0.3, hipsDy: -5, rootDx: -6,
      hand: { fwd: -5, up: -26 }, offHand: { fwd: 2, up: -24 },
      weapon: -2.4, footFront: 10, footBack: -6, footFrontUp: 6, aim: 0.1,
    },
  },
  {
    // CONTACT — the smash arrives still-overhead and driving down, with a
    // bigger step and deeper body commit than the base slash.
    atPhase: FINISHER_CONTACT_PHASE,
    hold: 0.02,
    contact: true,
    smear: true,
    easeTo: "out",
    pose: {
      lean: 0.18, hipsDy: 6, rootDx: 8,
      hand: { fwd: 22, up: -14 }, offHand: { fwd: -10, up: 0 },
      weapon: -1.9, footFront: 20, footBack: -16, aim: 0.5,
    },
  },
  {
    // MID — blasting down through level in the deepest lunge of the family.
    atPhase: 0.45,
    easeTo: "in",
    pose: {
      lean: 0.22, hipsDy: 8, rootDx: 8,
      hand: { fwd: 26, up: 2 }, offHand: { fwd: -9, up: -2 },
      weapon: 0.2, footFront: 22, footBack: -18, aim: 0.4,
    },
  },
  {
    // FOLLOW — buried low-forward, full commitment.
    atPhase: 0.58,
    easeTo: "out",
    pose: {
      lean: 0.25, hipsDy: 8, rootDx: 7,
      hand: { fwd: 22, up: 9 }, offHand: { fwd: -8, up: -3 },
      weapon: 0.6, footFront: 22, footBack: -18, aim: 0.25,
    },
  },
  {
    // LIFT — the long recovery hauls the blade back up out of the smash.
    atPhase: 0.72,
    easeTo: "inOut",
    pose: {
      lean: 0.15, hipsDy: 4, rootDx: 4,
      hand: { fwd: 15, up: -2 }, offHand: { fwd: -4, up: -4 },
      weapon: -0.3, footFront: 16, footBack: -12, aim: 0.15,
    },
  },
  {
    atPhase: 0.86,
    easeTo: "inOut",
    pose: {
      lean: 0.1, hipsDy: 2, rootDx: 1.5,
      hand: { fwd: 12, up: -4 }, offHand: { fwd: -2, up: -6 },
      weapon: -0.45, footFront: 10, footBack: -7, aim: 0.1,
    },
  },
  { atPhase: 1, pose: SLASH_READY },
];

/** Sword-family combo cycle: hit index (0–3) → swing variant. */
const SWORD_COMBO: AttackKeyframe[][] = [
  SLASH_KEYFRAMES,
  BACKSLASH_KEYFRAMES,
  RISING_KEYFRAMES,
  FINISHER_KEYFRAMES,
];

// ---------------------------------------------------------------------------
// FAMILY COMBO SWINGS — every melee family gets 4 authored whole-body swings
// (auto-cycled by the combo machine, 4th = finisher on a fast chain), built
// on the proven slash recipe: arc + arm travel + lunge + torso commit +
// recovery lift + settle to guard. Hits 1–3 ride the family's base
// ATTACK_TIMINGS untouched; each finisher exports its own heavier timing.
// ---------------------------------------------------------------------------

/** Compact pose literal: lean, hipsDy, rootDx, hand fwd/up, offHand fwd/up,
 * weapon angle, footFront, footBack, aim, optional front-heel lift. */
const KP = (
  lean: number, hipsDy: number, rootDx: number,
  hf: number, hu: number, of: number, ou: number,
  w: number, ff: number, fb: number, aim: number, ffu = 0,
): KeyPose => ({
  lean, hipsDy, rootDx,
  hand: { fwd: hf, up: hu }, offHand: { fwd: of, up: ou },
  weapon: w, footFront: ff, footBack: fb, aim,
  ...(ffu ? { footFrontUp: ffu } : {}),
});

/** The shared settle-in pose (retract low + level before the final guard). */
const SETTLE_IN: KeyPose = KP(0.1, 1.5, 1, 12, -4, -2, -6, -0.45, 10, -7, 0.1);

/** Contact lands exactly when the style's active window opens. */
const CP = (s: AttackStyle) => ATTACK_TIMINGS[s].windup / ATTACK_TIMINGS[s].total;

/** Standard swing skeleton: ready → coil → CONTACT(smear) → mid → follow →
 * lift → settle → ready. Options tune the two holds for stabs/heavies. */
function swingOf(
  contactPhase: number,
  coil: KeyPose, contact: KeyPose, mid: KeyPose, follow: KeyPose, lift: KeyPose,
  o: { coilHold?: number; contactHold?: number } = {},
): AttackKeyframe[] {
  return [
    { atPhase: 0, easeTo: "inOut", pose: SLASH_READY },
    { atPhase: 0.1, hold: o.coilHold ?? 0.02, easeTo: "in", pose: coil },
    { atPhase: contactPhase, hold: o.contactHold ?? 0.015, contact: true, smear: true, easeTo: "out", pose: contact },
    { atPhase: 0.42, easeTo: "in", pose: mid },
    { atPhase: 0.58, easeTo: "out", pose: follow },
    { atPhase: 0.7, easeTo: "inOut", pose: lift },
    { atPhase: 0.82, easeTo: "inOut", pose: SETTLE_IN },
    { atPhase: 1, pose: SLASH_READY },
  ];
}

// CHOP — axe/hammer/greatsword: heavy, weight-forward, big commits.
const CHOP_COMBO: AttackKeyframe[][] = [
  // 1: overhead split — high both-hands cock, buried low finish.
  swingOf(CP("chop"),
    KP(-0.28, -4, -5, -6, -24, 2, -22, -2.7, 9, -6, 0.1, 5),
    KP(0.16, 5, 6, 20, -12, -12, -2, -1.7, 18, -14, 0.5),
    KP(0.22, 7, 6, 24, 2, -11, -3, 0.2, 20, -16, 0.4),
    KP(0.24, 7, 5, 22, 8, -8, -3, 0.55, 20, -16, 0.25),
    KP(0.15, 3.5, 3, 14, -2, -4, -5, -0.35, 15, -11, 0.15)),
  // 2: horizontal cleave — wrapped behind, dead-level carve across.
  swingOf(CP("chop"),
    KP(-0.24, -2, -4, -8, -10, 12, -8, -3.0, 8, -7, 0.1, 4),
    KP(0.12, 3, 5, 24, -6, -12, -2, -0.5, 17, -13, 0.5),
    KP(0.16, 4, 5, 25, -2, -11, -3, 0.25, 19, -15, 0.4),
    KP(0.15, 3, 4, 12, 2, -7, -4, 0.5, 18, -14, 0.25),
    KP(0.12, 2, 2.5, 13, -3, -4, -5, -0.4, 13, -10, 0.15)),
  // 3: rising cleave — crouch-gather, carve up, finish tall + high.
  swingOf(CP("chop"),
    KP(0.06, 4, -3, -4, 10, 10, -6, 2.5, 8, -8, 0.1),
    KP(0.14, 1, 4, 20, 4, -10, -2, 0.7, 15, -11, 0.5),
    KP(0.08, -2, 4, 23, -8, -9, -1, -0.6, 14, -10, 0.4),
    KP(0.0, -3, 3, 14, -17, -6, 0, -1.5, 12, -8, 0.25),
    KP(0.06, 0, 2, 12, -10, -3, -3, -0.9, 10, -7, 0.15)),
  // 4 FINISHER: earth-splitter — long high hold, deepest lunge in the family.
  swingOf(0.3,
    KP(-0.32, -5, -7, -5, -27, 3, -25, -2.5, 10, -5, 0.1, 6),
    KP(0.2, 6, 8, 22, -14, -11, 0, -1.8, 20, -16, 0.5),
    KP(0.26, 9, 8, 26, 2, -10, -2, 0.2, 24, -18, 0.4),
    KP(0.28, 9, 7, 23, 9, -8, -3, 0.6, 24, -18, 0.25),
    KP(0.16, 4, 4, 15, -2, -4, -5, -0.35, 16, -12, 0.15),
    { coilHold: 0.05, contactHold: 0.02 }),
];

// THRUST — spear/halberd/rapier: committed stabs; pointing forward IS the
// read (variety comes from the LEVEL of each thrust + the lunging finisher).
const THRUST_COMBO: AttackKeyframe[][] = [
  // 1: mid thrust — drawn back to the hip, rammed straight out.
  swingOf(CP("thrust"),
    KP(-0.18, -1, -4, -6, -3, 10, -4, 0.05, 8, -8, 0.1, 3),
    KP(0.18, 2, 6, 26, -4, 12, -3, 0.0, 17, -13, 0.55),
    KP(0.2, 2, 6, 27, -4, 13, -3, 0.02, 18, -14, 0.45),
    KP(0.12, 1.5, 4, 16, -4, 8, -4, -0.05, 15, -11, 0.25),
    KP(0.1, 1, 2, 13, -4, 5, -3, -0.2, 12, -9, 0.15),
    { contactHold: 0.03 }),
  // 2: high thrust — at the throat, slightly downward point.
  swingOf(CP("thrust"),
    KP(-0.16, -2, -4, -5, -8, 9, -7, -0.2, 8, -8, 0.1, 3),
    KP(0.14, 0, 6, 25, -10, 12, -8, -0.22, 16, -12, 0.55),
    KP(0.16, 0, 6, 26, -10, 13, -8, -0.2, 17, -13, 0.45),
    KP(0.1, 0.5, 4, 15, -8, 8, -7, -0.3, 14, -10, 0.25),
    KP(0.08, 1, 2, 12, -5, 5, -4, -0.35, 11, -8, 0.15),
    { contactHold: 0.03 }),
  // 3: low gut-thrust — sunk stance, point driven slightly upward-in.
  swingOf(CP("thrust"),
    KP(-0.12, 3, -4, -6, 4, 9, 0, 0.3, 9, -8, 0.1),
    KP(0.2, 4, 6, 24, 3, 12, 4, 0.28, 18, -13, 0.55),
    KP(0.22, 4, 6, 25, 3, 13, 4, 0.3, 19, -14, 0.45),
    KP(0.14, 3, 4, 15, 0, 8, 0, 0.1, 15, -11, 0.25),
    KP(0.1, 2, 2, 12, -3, 5, -3, -0.15, 12, -9, 0.15),
    { contactHold: 0.03 }),
  // 4 FINISHER: piercing lunge — fencer's full extension, huge step.
  swingOf(0.32,
    KP(-0.26, -2, -7, -8, -4, 11, -5, 0.0, 9, -7, 0.1, 5),
    KP(0.26, 5, 11, 30, -5, 14, -3, 0.0, 24, -18, 0.55),
    KP(0.28, 5, 11, 31, -5, 15, -3, 0.02, 25, -19, 0.45),
    KP(0.18, 3, 6, 18, -5, 9, -4, -0.08, 18, -13, 0.25),
    KP(0.12, 2, 3, 13, -4, 5, -3, -0.25, 13, -9, 0.15),
    { coilHold: 0.05, contactHold: 0.04 }),
];

// REAP — scythe: wide hooking crescents, torso twist doing the work.
const REAP_COMBO: AttackKeyframe[][] = [
  // 1: horizontal reap — wrapped far behind, level crescent through.
  swingOf(CP("reap"),
    KP(-0.26, -2, -4, -8, -8, 13, -10, -3.1, 8, -7, 0.1, 4),
    KP(0.14, 3, 5, 23, -7, -12, -2, -0.7, 17, -13, 0.5),
    KP(0.2, 4.5, 5, 24, -2, -11, -3, 0.1, 19, -15, 0.4),
    KP(0.28, 4, 4, 8, 3, -6, -4, 0.8, 19, -15, 0.25),
    KP(0.14, 2, 2.5, 12, -4, -3, -5, -0.4, 13, -10, 0.15)),
  // 2: pull-hook — blade thrown out front, then YANKED through toward self.
  swingOf(CP("reap"),
    KP(-0.1, -1, -2, 18, -2, 8, -6, -0.2, 9, -8, 0.15),
    KP(0.12, 2, 3, 10, -9, 2, -8, -1.1, 14, -11, 0.5),
    KP(0.06, 1, 2, 4, -14, 6, -9, -2.2, 12, -9, 0.35),
    KP(-0.04, 0, 1, -2, -12, 9, -8, -2.7, 10, -8, 0.2),
    KP(0.04, 1, 1, 8, -6, 3, -6, -1.2, 10, -7, 0.15)),
  // 3: low mow — sunk crouch, blade shearing at shin height.
  swingOf(CP("reap"),
    KP(-0.14, 4, -3, -7, 2, 12, -5, -2.9, 9, -8, 0.1),
    KP(0.2, 6, 5, 21, 2, -10, 0, -0.3, 19, -14, 0.5),
    KP(0.26, 7, 5, 22, 5, -9, -1, 0.35, 21, -16, 0.4),
    KP(0.22, 6, 4, 10, 6, -6, -2, 0.7, 20, -15, 0.25),
    KP(0.12, 3, 2, 12, -3, -3, -4, -0.35, 13, -10, 0.15)),
  // 4 FINISHER: reaper's circle — the widest wrap, carried past full turn.
  swingOf(0.3,
    KP(-0.3, -3, -6, -9, -12, 14, -12, -3.4, 9, -6, 0.1, 5),
    KP(0.18, 5, 8, 24, -8, -12, -1, -1.1, 21, -16, 0.5),
    KP(0.26, 7, 8, 25, -1, -11, -2, 0.1, 24, -18, 0.4),
    KP(0.32, 6, 6, 6, 4, -6, -3, 1.0, 23, -17, 0.25),
    KP(0.16, 3, 3, 12, -4, -3, -5, -0.4, 14, -10, 0.15),
    { coilHold: 0.05, contactHold: 0.02 }),
];

// CRACK — whip: the ARM snaps, the body stays coiled; small steps only.
const CRACK_COMBO: AttackKeyframe[][] = [
  // 1: overhead crack — arm whipped from behind the shoulder.
  swingOf(CP("crack"),
    KP(-0.16, -2, -2, -6, -18, 8, -6, -2.2, 8, -7, 0.1),
    KP(0.12, 1, 2, 22, -8, -8, -3, -0.6, 12, -9, 0.5),
    KP(0.14, 1.5, 2, 20, -4, -7, -4, -0.3, 13, -10, 0.4),
    KP(0.1, 1, 1.5, 12, -2, -5, -5, -0.15, 12, -9, 0.25),
    KP(0.08, 1, 1, 11, -4, -3, -5, -0.4, 10, -8, 0.15)),
  // 2: side lash — low wrap behind the hip, level snap across.
  swingOf(CP("crack"),
    KP(-0.18, -1, -2, -8, -4, 9, -3, -2.9, 8, -7, 0.1),
    KP(0.1, 1, 2, 24, -4, -8, -2, -0.15, 12, -9, 0.5),
    KP(0.12, 1.5, 2, 21, -2, -7, -3, 0.05, 13, -10, 0.4),
    KP(0.08, 1, 1.5, 12, -1, -5, -4, 0.1, 12, -9, 0.25),
    KP(0.06, 1, 1, 11, -4, -3, -5, -0.35, 10, -8, 0.15)),
  // 3: low scourge — a downward-cutting lash at the legs.
  swingOf(CP("crack"),
    KP(-0.12, 0, -2, -5, -14, 8, -5, -1.9, 8, -7, 0.1),
    KP(0.14, 2, 2, 20, 2, -7, -1, 0.35, 13, -10, 0.5),
    KP(0.16, 2.5, 2, 18, 4, -6, -2, 0.5, 14, -10, 0.4),
    KP(0.1, 1.5, 1.5, 11, 0, -5, -3, 0.2, 12, -9, 0.25),
    KP(0.08, 1, 1, 11, -4, -3, -5, -0.35, 10, -8, 0.15)),
  // 4 FINISHER: thunder-crack — long wound coil, full-body snap.
  swingOf(0.3,
    KP(-0.26, -3, -4, -9, -20, 10, -8, -2.6, 9, -6, 0.1, 4),
    KP(0.16, 2, 4, 26, -6, -9, -2, -0.4, 16, -12, 0.5),
    KP(0.18, 2.5, 4, 23, -3, -8, -3, -0.15, 17, -13, 0.4),
    KP(0.12, 1.5, 2.5, 13, -1, -5, -4, 0.0, 13, -10, 0.25),
    KP(0.08, 1, 1.5, 11, -4, -3, -5, -0.35, 11, -8, 0.15),
    { coilHold: 0.05, contactHold: 0.025 }),
];

// BASH — shield: the BODY is the weapon; shoves, rim strikes, a charge slam.
const BASH_COMBO: AttackKeyframe[][] = [
  // 1: front shove — coil onto the back foot, drive the shield face out.
  swingOf(CP("bash"),
    KP(-0.2, 0, -4, 2, -2, -4, 2, -0.9, 8, -8, 0.1, 3),
    KP(0.18, 2, 6, 16, -4, -8, 2, -1.1, 16, -12, 0.5),
    KP(0.2, 2.5, 6, 17, -3, -8, 1, -1.05, 17, -13, 0.4),
    KP(0.12, 2, 4, 12, -3, -6, 0, -1.0, 14, -11, 0.25),
    KP(0.1, 1.5, 2, 10, -3, -3, -3, -0.8, 11, -8, 0.15)),
  // 2: rim uppercut — sunk low, shield edge driven up through the chin.
  swingOf(CP("bash"),
    KP(-0.08, 4, -3, 4, 6, -3, 6, -0.5, 9, -8, 0.1),
    KP(0.1, -1, 5, 14, -13, -6, -2, -1.7, 14, -11, 0.5),
    KP(0.06, -2, 5, 13, -15, -6, -3, -1.8, 13, -10, 0.4),
    KP(0.06, 0, 3, 10, -9, -4, -4, -1.4, 12, -9, 0.25),
    KP(0.08, 1, 1.5, 9, -4, -2, -4, -1.0, 10, -8, 0.15)),
  // 3: overhead rim smash — shield raised high, chopped down flat.
  swingOf(CP("bash"),
    KP(-0.18, -3, -3, 0, -16, -4, -10, -2.0, 8, -7, 0.1, 3),
    KP(0.16, 3, 5, 14, -2, -7, 1, -1.2, 15, -12, 0.5),
    KP(0.2, 4, 5, 15, 1, -7, 0, -1.05, 17, -13, 0.4),
    KP(0.14, 3, 3.5, 11, 0, -5, -1, -1.0, 14, -11, 0.25),
    KP(0.1, 1.5, 2, 10, -3, -3, -3, -0.85, 11, -8, 0.15)),
  // 4 FINISHER: charge slam — a shoulder-and-shield freight train.
  swingOf(0.32,
    KP(-0.26, -1, -6, 1, -3, -5, 3, -0.95, 9, -6, 0.1, 4),
    KP(0.22, 3, 9, 18, -4, -9, 2, -1.1, 20, -15, 0.5),
    KP(0.24, 4, 9, 19, -3, -9, 1, -1.05, 22, -16, 0.4),
    KP(0.16, 3, 5, 13, -3, -6, 0, -1.0, 16, -12, 0.25),
    KP(0.1, 1.5, 2.5, 10, -3, -3, -3, -0.8, 12, -9, 0.15),
    { coilHold: 0.05, contactHold: 0.025 }),
];

// PUNCH — fists/claws: boxing flow — jab, hook, uppercut, haymaker.
const PUNCH_COMBO: AttackKeyframe[][] = [
  // 1: jab — short, fast, guard barely drops.
  swingOf(CP("punch"),
    KP(-0.08, 0, -1.5, -2, -7, 6, -8, -0.3, 8, -7, 0.15),
    KP(0.12, 1, 3, 22, -7, 4, -9, -0.15, 13, -10, 0.55),
    KP(0.14, 1, 3, 23, -7, 4, -9, -0.12, 14, -10, 0.45),
    KP(0.08, 0.5, 2, 12, -6, 5, -8, -0.3, 11, -8, 0.25),
    KP(0.06, 0.5, 1, 9, -6, 5, -8, -0.4, 9, -7, 0.15)),
  // 2: cross-hook — shoulders wound, fist carried level across.
  swingOf(CP("punch"),
    KP(-0.22, 0, -3, -7, -8, 8, -9, -0.6, 8, -7, 0.1, 3),
    KP(0.2, 2, 5, 24, -5, 2, -9, -0.2, 16, -12, 0.55),
    KP(0.24, 2.5, 5, 22, -3, 1, -8, 0.1, 17, -13, 0.45),
    KP(0.16, 1.5, 3, 12, -2, 3, -8, 0.15, 13, -10, 0.25),
    KP(0.08, 1, 1.5, 9, -5, 5, -8, -0.35, 10, -8, 0.15)),
  // 3: uppercut — sunk crouch, fist driven up through the jawline.
  swingOf(CP("punch"),
    KP(-0.06, 5, -2, -3, 8, 6, -7, 0.9, 9, -8, 0.1),
    KP(0.1, -2, 4, 16, -14, 3, -8, -1.3, 13, -10, 0.55),
    KP(0.04, -3, 4, 15, -17, 3, -8, -1.5, 12, -9, 0.45),
    KP(0.02, -1, 2.5, 11, -12, 4, -8, -1.2, 11, -8, 0.25),
    KP(0.06, 0.5, 1, 9, -7, 5, -8, -0.6, 9, -7, 0.15)),
  // 4 FINISHER: haymaker — everything wound behind it, deep lunge through.
  swingOf(0.32,
    KP(-0.3, -2, -6, -9, -9, 9, -10, -0.8, 9, -6, 0.1, 5),
    KP(0.24, 4, 9, 26, -6, 1, -9, -0.15, 20, -15, 0.55),
    KP(0.28, 5, 9, 25, -3, 0, -8, 0.15, 22, -16, 0.45),
    KP(0.18, 3, 5, 14, -2, 3, -8, 0.2, 16, -12, 0.25),
    KP(0.1, 1.5, 2.5, 10, -5, 5, -8, -0.35, 12, -9, 0.15),
    { coilHold: 0.06, contactHold: 0.025 }),
];

// CAST (melee stave) — quick two-handed stave work: bonk, sweep, butt-jab.
const STAVE_COMBO: AttackKeyframe[][] = [
  // 1: overhead bonk.
  swingOf(CP("cast"),
    KP(-0.18, -2, -3, -4, -18, 6, -14, -2.3, 8, -7, 0.1, 3),
    KP(0.14, 2, 4, 20, -8, -9, -2, -1.2, 15, -11, 0.5),
    KP(0.18, 3, 4, 22, -2, -9, -3, -0.2, 16, -12, 0.4),
    KP(0.14, 2.5, 3, 14, 1, -6, -4, 0.25, 15, -11, 0.25),
    KP(0.1, 1.5, 1.5, 12, -4, -3, -5, -0.45, 11, -8, 0.15)),
  // 2: level sweep.
  swingOf(CP("cast"),
    KP(-0.2, -1, -3, -7, -8, 10, -6, -2.9, 8, -7, 0.1, 3),
    KP(0.12, 2, 4, 22, -5, -9, -2, -0.4, 15, -11, 0.5),
    KP(0.16, 3, 4, 23, -2, -9, -3, 0.2, 16, -12, 0.4),
    KP(0.12, 2, 3, 13, 0, -6, -4, 0.4, 15, -11, 0.25),
    KP(0.08, 1.5, 1.5, 12, -4, -3, -5, -0.4, 11, -8, 0.15)),
  // 3: butt-end jab — the shaft rammed straight, thrust-style.
  swingOf(CP("cast"),
    KP(-0.14, 0, -3, -4, -2, 8, -1, 0.05, 8, -7, 0.1),
    KP(0.14, 1.5, 4, 22, -4, 11, -3, 0.0, 15, -11, 0.5),
    KP(0.16, 1.5, 4, 23, -4, 12, -3, 0.02, 16, -12, 0.4),
    KP(0.1, 1, 2.5, 13, -4, 7, -3, -0.15, 13, -10, 0.25),
    KP(0.08, 1, 1.5, 12, -4, 4, -4, -0.4, 10, -8, 0.15),
    { contactHold: 0.025 }),
  // 4 FINISHER: spinning slam — big wrap, stave brought over and DOWN.
  swingOf(0.3,
    KP(-0.26, -3, -5, -6, -20, 8, -16, -2.6, 9, -6, 0.1, 4),
    KP(0.18, 4, 7, 22, -10, -10, -1, -1.5, 18, -14, 0.5),
    KP(0.24, 6, 7, 24, 0, -9, -2, -0.1, 21, -16, 0.4),
    KP(0.2, 5, 5, 14, 3, -6, -3, 0.35, 19, -14, 0.25),
    KP(0.12, 2, 2.5, 12, -4, -3, -5, -0.4, 13, -10, 0.15),
    { coilHold: 0.05, contactHold: 0.02 }),
];

/** Family combo lookup (variant 0–3). Sword defined above. */
const COMBO_TABLES: Partial<Record<AttackStyle, AttackKeyframe[][]>> = {
  slash: SWORD_COMBO,
  chop: CHOP_COMBO,
  thrust: THRUST_COMBO,
  reap: REAP_COMBO,
  crack: CRACK_COMBO,
  bash: BASH_COMBO,
  punch: PUNCH_COMBO,
  cast: STAVE_COMBO,
};

/** Per-family finisher timings — each 4th swing is its own heavier attack. */
export const FINISHER_TIMINGS: Partial<Record<AttackStyle, AttackTiming>> = {
  slash: FINISHER_TIMING,
  chop: timing(0.22, 0.1, 0.3),
  thrust: timing(0.16, 0.1, 0.24),
  reap: timing(0.2, 0.12, 0.3),
  crack: timing(0.18, 0.1, 0.26),
  bash: timing(0.14, 0.1, 0.22),
  punch: timing(0.16, 0.1, 0.24),
  cast: timing(0.15, 0.09, 0.22),
};

/**
 * The finisher timing this fighter's 4th combo swing runs on, or null when
 * the family has no keyframed combo (mounted/ranged). Combat + animator both
 * key off THIS so their clocks can never drift apart.
 */
export function comboFinisherTimingFor(
  form: WeaponForm,
  type: MechType,
  mount: string | undefined,
): AttackTiming | null {
  if (type !== "melee") return null;
  const m = mount ?? "hand";
  if (m === "head" || m === "body" || m === "floating") return null;
  const style = m === "none" ? "punch" : attackStyleOf(form, type);
  return FINISHER_TIMINGS[style] ?? null;
}

/** RANGED fire variety: tiny alternating stance/recoil offsets per shot so
 * rapid fire isn't identical frames (never a melee combo). */
const FIRE_VARIETY = [
  { up: 0, dir: 0 },
  { up: -1.5, dir: -0.05 },
  { up: 1.2, dir: 0.04 },
  { up: -0.8, dir: 0.06 },
];

/**
 * Per-weapon-family BLOCK poses — a braced guard that reads like the weapon
 * (VISUAL only; coverage/parry/guard-break mechanics are untouched).
 * `weapon: null` = the weapon just follows the forearm (whips, fists).
 */
interface BlockPose {
  hand: { fwd: number; up: number };
  off: { fwd: number; up: number };
  weapon: number | null;
  lean?: number;
  hipsDy?: number;
  footFront?: number;
  footBack?: number;
}

const BLOCK_POSES: Record<AttackStyle, BlockPose> = {
  // Sword: blade raised diagonally across the body — the classic high guard.
  slash: { hand: { fwd: 8, up: 1 }, off: { fwd: 4, up: 7 }, weapon: -1.15 },
  // Axe/hammer-family: haft horizontal across the chest, two-handed brace,
  // sunk a touch lower under the weight.
  chop: { hand: { fwd: 10, up: -1 }, off: { fwd: 3, up: 2 }, weapon: -0.08, hipsDy: 1.5 },
  // Spear/polearm: shaft braced at a shallow angle, front foot planted wide.
  thrust: { hand: { fwd: 5, up: 2 }, off: { fwd: 12, up: 0 }, weapon: -0.22, footFront: 13, footBack: -8 },
  // Scythe: shaft across the body, blade hooking outward over the shoulder.
  reap: { hand: { fwd: 6, up: 0 }, off: { fwd: -1, up: 6 }, weapon: -2.5 },
  // Whip: blocks poorly — arm up in a flinch-guard, whip dangling.
  crack: { hand: { fwd: 4, up: -9 }, off: { fwd: 6, up: -2 }, weapon: null, lean: -0.14 },
  // Staff: held horizontal in both hands, a bar across the body.
  cast: { hand: { fwd: 9, up: -2 }, off: { fwd: 4, up: 2 }, weapon: -0.15 },
  // Bow: raised as a bar — a weak, improvised block read.
  draw: { hand: { fwd: 8, up: -1 }, off: { fwd: 6, up: 1 }, weapon: -1.45 },
  // Gun: weapon-up cross-guard behind the forearms.
  shoot: { hand: { fwd: 6, up: -4 }, off: { fwd: 3, up: -2 }, weapon: -1.5 },
  // Fists: classic forearms-up cross-guard.
  punch: { hand: { fwd: 5, up: -5 }, off: { fwd: 3, up: -7 }, weapon: null },
  // Shield: raised square-on — the strongest, most natural block.
  bash: { hand: { fwd: 9, up: 0 }, off: { fwd: 1, up: 8 }, weapon: -1.3, hipsDy: 2, footFront: 12, footBack: -9 },
  // Thrown: a light slash-like guard with the held object up.
  throw: { hand: { fwd: 7, up: 0 }, off: { fwd: 3, up: 6 }, weapon: -1.1 },
};

/** Styles converted to keyframes; everything else stays procedural. */
const KEYFRAME_STYLES: Partial<Record<AttackStyle, AttackKeyframe[]>> = {
  slash: SLASH_KEYFRAMES,
};

const EASE_FN = { in: easeIn, out: easeOut, inOut: easeInOut } as const;

const lerpPose = (a: KeyPose, b: KeyPose, t: number): KeyPose => ({
  lean: lerp(a.lean, b.lean, t),
  hipsDy: lerp(a.hipsDy, b.hipsDy, t),
  rootDx: lerp(a.rootDx, b.rootDx, t),
  hand: { fwd: lerp(a.hand.fwd, b.hand.fwd, t), up: lerp(a.hand.up, b.hand.up, t) },
  offHand: { fwd: lerp(a.offHand.fwd, b.offHand.fwd, t), up: lerp(a.offHand.up, b.offHand.up, t) },
  weapon: lerp(a.weapon, b.weapon, t),
  footFront: lerp(a.footFront, b.footFront, t),
  footBack: lerp(a.footBack, b.footBack, t),
  footFrontUp: lerp(a.footFrontUp ?? 0, b.footFrontUp ?? 0, t),
  aim: lerp(a.aim, b.aim, t),
});

/**
 * Sample a keyframe timeline at `elapsed` seconds of an attack lasting
 * `total`. Holds freeze the pose in place; easing shapes each transition.
 */
function sampleKeyframes(
  frames: AttackKeyframe[],
  elapsed: number,
  total: number,
): { pose: KeyPose; smearing: boolean; from: KeyPose; to: KeyPose } {
  const t = Math.max(0, Math.min(total, elapsed));
  for (let i = frames.length - 1; i >= 0; i--) {
    const K = frames[i];
    const tK = K.atPhase * total;
    if (t < tK && i > 0) continue;
    // At or after keyframe i.
    if (i === frames.length - 1) {
      return { pose: K.pose, smearing: false, from: K.pose, to: K.pose };
    }
    const next = frames[i + 1];
    const tNext = next.atPhase * total;
    const holdEnd = Math.min(tK + (K.hold ?? 0), tNext - 0.0001);
    if (t <= holdEnd) {
      return { pose: K.pose, smearing: false, from: K.pose, to: next.pose };
    }
    const k = (t - holdEnd) / Math.max(0.0001, tNext - holdEnd);
    const eased = EASE_FN[K.easeTo ?? "inOut"](Math.min(1, k));
    return {
      pose: lerpPose(K.pose, next.pose, eased),
      smearing: Boolean(K.smear),
      from: K.pose,
      to: next.pose,
    };
  }
  return { pose: frames[0].pose, smearing: false, from: frames[0].pose, to: frames[0].pose };
}

/**
 * Attack gesture for NON-HAND mounts (floating/head/body): the fighter has
 * nothing in hand — instead of an empty swing they COMMAND the weapon:
 * gather (arm sweeps up-back), then snap the arm out pointing the strike,
 * then ease back to guard. Same phase windows; the weapon's own strike
 * motion is drawn at the mount by stickman.drawWeapon.
 */
function commandContribution(phase: AttackPhase, k: number): AttackContribution {
  const out: AttackContribution = {
    hand: { fwd: 10, up: -14 },
    dirRel: null, // nothing held — the weapon animates at its mount
    lean: 0.08,
    hipsDy: 0,
    offHand: null,
  };
  const K = easeOut(k);
  if (phase === "windup") {
    // Gather: hand sweeps up beside the head, weight coils back.
    out.hand = { fwd: lerp(10, 1, K), up: lerp(-14, -22, K) };
    out.lean = lerp(0.08, -0.07, K);
    out.hipsDy = -1 * K;
    out.offHand = { fwd: lerp(3, -5, K), up: -8 };
  } else if (phase === "active") {
    // Command: the arm snaps out, pointing the strike at the target.
    const D = easeIn(k);
    out.hand = { fwd: lerp(1, 17, D), up: lerp(-22, -12, D) };
    out.lean = lerp(-0.07, 0.24, D);
    out.hipsDy = lerp(-1, 1.5, D);
    out.offHand = { fwd: lerp(-5, -8, D), up: lerp(-8, -4, D) };
  } else {
    const c = carry(k, 1);
    out.hand = { fwd: lerp(17, 10, K) + c * 1.5, up: lerp(-12, -14, K) };
    out.lean = lerp(0.24, 0.08, K) + c * 0.04;
    out.hipsDy = lerp(1.5, 0, K);
    out.offHand = { fwd: lerp(-8, 3, K), up: -8 };
  }
  return out;
}

export function createAnimator(bones: Bones): Animator {
  const s = bones.scale;
  let runPhase = 0;
  const plants: [FootPlant, FootPlant] = [
    { locked: false, x: 0 },
    { locked: false, x: 0 },
  ];
  // Smooth state blending: on a state switch we snapshot the last output
  // pose (root-relative) and crossfade into the new state's pose.
  let fade = 0;
  let fadeDur = 0.1;
  let prevRel: Skeleton | null = null;
  let prevWeaponAngle = 0;
  let lastOut: AnimFrame | null = null;
  let lastRoot = { x: 0, y: 0 };
  // Weight timers: time since jump start (stretch → tuck) and landing
  // absorb remaining (knee-bend + settle).
  let jumpT = 0;
  let landT = 0;
  let wasAirborne = false;

  /** Reactions snap fast; locomotion blends soft. */
  const FADE_BY_STATE: Partial<Record<AnimState, number>> = {
    attack: 0.045,
    hitstun: 0.03,
    launched: 0.03,
    ko: 0,
    block: 0.06,
  };

  function pickState(inp: AnimInputs): AnimState {
    if (!inp.alive) return "ko";
    if (inp.launchedTimer > 0) return "launched";
    if (inp.hitstunTimer > 0) return "hitstun";
    if (inp.attackElapsed >= 0) return "attack";
    if (inp.castTimer > 0) return "cast";
    if (inp.blocking && inp.grounded) return "block";
    if (!inp.grounded) return inp.vy < -0.5 ? "jump" : "fall";
    if (inp.moving) {
      // Moving against the facing = a careful backpedal, not a reversed run.
      return Math.sign(inp.vx) * inp.facing < 0 ? "backpedal" : "run";
    }
    return "idle";
  }

  const animator: Animator = {
    state: "idle",

    update(dt: number, inp: AnimInputs): AnimFrame {
      const state = pickState(inp);
      if (state !== animator.state) {
        // Snapshot the outgoing pose (relative to the root) for the crossfade.
        if (lastOut) {
          const rel = {} as Record<string, unknown>;
          for (const [key, v] of Object.entries(lastOut.skeleton)) {
            rel[key] =
              typeof v === "number"
                ? v
                : { x: (v as Vec).x - lastRoot.x, y: (v as Vec).y - lastRoot.y };
          }
          prevRel = rel as unknown as Skeleton;
          prevWeaponAngle = lastOut.weaponAngle;
          fadeDur = FADE_BY_STATE[state] ?? 0.1;
          fade = fadeDur;
        }
        if (state === "jump") jumpT = 0;
        animator.state = state;
        if (state !== "run" && state !== "backpedal") {
          plants[0].locked = false;
          plants[1].locked = false;
        }
      }
      if (state === "jump" || state === "fall") jumpT += dt;
      // Landing absorb: touch-down after airtime bends the knees, then settles.
      const airborneNow = state === "jump" || state === "fall" || state === "launched";
      if (wasAirborne && !airborneNow && inp.grounded) landT = 0.16;
      wasAirborne = airborneNow;
      landT = Math.max(0, landT - dt);

      const f = inp.facing;
      const t = inp.time;
      const style = attackStyleOf(inp.weaponForm, inp.weaponType);
      const twoHanded = isTwoHanded(inp.weaponForm, inp.weaponSize, inp.weaponType);

      // --- Attack phase bookkeeping. ---
      const mounted =
        inp.weaponMount === "head" || inp.weaponMount === "body" || inp.weaponMount === "floating";
      // Unarmed (mount "none"): the BODY throws a proper punch whatever
      // form drives the mechanics; phases still follow the form's timing.
      const poseStyle = inp.weaponMount === "none" ? "punch" : style;
      const comboVariant = Math.min(3, Math.max(0, Math.floor(inp.comboVariant ?? 0)));
      // Every keyframed melee family cycles 4 authored swings; the 4th runs
      // on its own finisher timing. Combat keys off the SAME lookup
      // (comboFinisherTimingFor), so phases stay aligned.
      const comboTable =
        !mounted && inp.weaponType === "melee" ? COMBO_TABLES[poseStyle] : undefined;
      const finisherSwing = comboTable !== undefined && comboVariant === 3;
      const atkTiming = finisherSwing
        ? (FINISHER_TIMINGS[poseStyle] ?? ATTACK_TIMINGS[style])
        : ATTACK_TIMINGS[style];
      let atk: AttackContribution | null = null;
      if (state === "attack") {
        const e = inp.attackElapsed;
        let phase: AttackPhase;
        let k: number;
        if (e < atkTiming.windup) {
          phase = "windup";
          k = e / atkTiming.windup;
        } else if (e < atkTiming.windup + atkTiming.active) {
          phase = "active";
          k = (e - atkTiming.windup) / atkTiming.active;
        } else {
          phase = "recovery";
          k = Math.min(1, (e - atkTiming.windup - atkTiming.active) / atkTiming.recovery);
        }
        // The family cycles its four authored swings by combo variant.
        const keyframes = comboTable
          ? comboTable[comboVariant]
          : mounted
            ? undefined
            : KEYFRAME_STYLES[poseStyle];
        if (keyframes) {
          // KEYFRAME path: full-silhouette poses on the same timeline. The
          // whole strike AIMS at the opponent: rotate the arm/weapon arc by
          // the elevation to the target, weighted per-pose.
          const kf = sampleKeyframes(keyframes, e, atkTiming.total);
          const P = kf.pose;
          // Strike aim: the slash only LEANS toward the target. Elevation is
          // clamped tight, and it fades out entirely when the height gap
          // exceeds melee reach (a foe on a lower platform is out of range —
          // don't contort at the floor, just slash forward).
          let aimE = 0;
          if (inp.aimX !== undefined && inp.aimY !== undefined) {
            const neckYest = inp.rootY + bones.hipsOffset - bones.spine;
            const dy = inp.aimY - neckYest;
            const reachFade = Math.max(0, Math.min(1, 1 - (Math.abs(dy) - 45 * s) / (60 * s)));
            aimE =
              Math.max(-0.25, Math.min(0.25, Math.atan2(dy, Math.max(30, Math.abs(inp.aimX - inp.rootX))))) *
              reachFade;
          }
          const rot = aimE * P.aim;
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const aimVec = (v: { fwd: number; up: number }) => ({
            fwd: v.fwd * cs - v.up * sn,
            up: v.fwd * sn + v.up * cs,
          });
          atk = {
            hand: aimVec(P.hand),
            dirRel: P.weapon + rot,
            lean: P.lean,
            hipsDy: P.hipsDy,
            // Two-handed carries keep both hands on the shaft (grip logic).
            offHand: twoHanded ? null : P.offHand,
            rootDx: P.rootDx,
            footFront: P.footFront,
            footBack: P.footBack,
            footFrontUp: P.footFrontUp,
            smear: kf.smearing
              ? { from: kf.from.weapon + aimE * kf.from.aim, to: kf.to.weapon + aimE * kf.to.aim }
              : undefined,
          };
        } else {
          atk = mounted
            ? commandContribution(phase, k)
            : attackContribution(poseStyle, phase, k, inp.weaponForm, inp.weaponSize, twoHanded);
          // RANGED fire variety: tiny alternating stance/recoil offsets so
          // rapid fire isn't identical frames (draw/shoot/throw only —
          // every melee family has real keyframed swings now).
          if (
            !mounted &&
            (poseStyle === "draw" || poseStyle === "shoot" || poseStyle === "throw") &&
            atk.dirRel !== null
          ) {
            const v = FIRE_VARIETY[comboVariant];
            atk.dirRel += v.dir;
            atk.hand = { fwd: atk.hand.fwd, up: atk.hand.up + v.up };
          }
        }
      }

      // --- Hips: track the physics root, plus per-state bob/weight. ---
      // speedK: 0 at a walk, 1 at full sprint — scales stride/lean/bounce.
      const speedK = Math.min(1, (Math.abs(inp.vx) * 60) / 420);
      let bob = 0;
      if (state === "idle") bob = Math.sin(t * 2.2) * 1.2 * s + 2.2 * s; // crouched guard
      if (state === "block") bob = (3.4 + (BLOCK_POSES[style]?.hipsDy ?? 0)) * s; // sunk into the guard
      if (state === "run") bob = Math.sin(runPhase * 2) * (1 + 1.5 * speedK) * s + 1 * s;
      if (state === "backpedal") bob = Math.sin(runPhase * 2) * 0.9 * s + 1.8 * s; // shorter, busier
      if (state === "jump") {
        // Launch stretch: rise out of the crouch over the first beat.
        bob = lerp(3, -1.5, easeOut(Math.min(1, jumpT / 0.14))) * s;
      }
      if (atk) bob = atk.hipsDy * s + 1.5 * s;
      // Landing absorb: knees soak the impact, then the body settles up.
      if (landT > 0) bob += Math.sin((1 - landT / 0.16) * Math.PI) * 4.5 * s;
      let hipsX = inp.rootX;
      if (atk?.rootDx) hipsX += atk.rootDx * f * s; // pose-only step-in nudge
      if (state === "hitstun") hipsX += Math.sin(t * 45) * 1.4 * s;
      if (state === "idle") hipsX += Math.sin(t * 1.1) * 0.8 * s; // weight shift
      const hips: Vec = { x: hipsX, y: inp.rootY + bones.hipsOffset + bob };

      // --- Torso lean (positive leans toward facing). ---
      const moveDir = Math.abs(inp.vx) > 0.3 ? Math.sign(inp.vx) * f : 0;
      let lean = 0.09; // ready stance leans in by default
      if (state === "run") lean = (0.12 + 0.14 * speedK) * (moveDir || 1) + 0.04;
      if (state === "backpedal") lean = -0.08; // weight back, watching the foe
      if (state === "jump") lean = lerp(0.2, 0.1, Math.min(1, jumpT / 0.2)); // drive then float
      if (state === "fall") lean = -0.05;
      if (state === "hitstun") lean = -0.32;
      if (state === "launched") lean = -0.6;
      if (state === "cast") lean = 0.1;
      if (state === "block") lean = BLOCK_POSES[style]?.lean ?? -0.05; // weight back behind the guard
      if (atk) lean = atk.lean;

      const theta = f * lean;
      const neck: Vec = {
        x: hips.x + Math.sin(theta) * bones.spine,
        y: hips.y - Math.cos(theta) * bones.spine,
      };
      const headTheta = theta * (state === "hitstun" || state === "launched" ? 1.6 : 1.1);
      const headDist = bones.neckLen + bones.headR * 0.4;
      const head: Vec = {
        x: neck.x + Math.sin(headTheta) * headDist,
        y: neck.y - Math.cos(headTheta) * headDist,
      };

      // --- Foot targets. ---
      let footTargetL: Vec;
      let footTargetR: Vec;
      const groundFootY = inp.groundY - 1 * s;

      if (state === "run" || state === "backpedal") {
        // Backpedal: shorter, quicker, more careful steps; run: stride and
        // lift grow with speed for a real sprint gait.
        const back = state === "backpedal";
        const stride = (back ? 10 : 13 + 6 * speedK) * s;
        const lift = (back ? 4.5 : 6 + 3.5 * speedK) * s;
        const speed = Math.abs(inp.vx) * 60; // px/tick → px/s
        const omega = (Math.PI * speed) / (2 * stride);
        runPhase += omega * dt * (moveDir || 1);

        const footFromPhase = (phase: number, plant: FootPlant): Vec => {
          const swingUp = Math.sin(phase);
          const xRel = Math.cos(phase) * stride;
          if (swingUp <= 0) {
            // Stance: plant the foot in WORLD space — no sliding.
            if (!plant.locked) {
              plant.locked = true;
              plant.x = hips.x + xRel;
            }
            return { x: plant.x, y: groundFootY };
          }
          plant.locked = false;
          // Swing rides an eased arc — the foot accelerates through passing.
          const sw = easeInOut(swingUp);
          return { x: hips.x + xRel, y: groundFootY - sw * lift };
        };
        footTargetL = footFromPhase(runPhase, plants[0]);
        footTargetR = footFromPhase(runPhase + Math.PI, plants[1]);
      } else if (state === "jump") {
        // Stretch off the ground (legs trail extended), then tuck as the
        // arc tops out.
        const tuck = easeInOut(Math.min(1, Math.max(0, (jumpT - 0.12) / 0.18)));
        footTargetL = {
          x: hips.x + f * lerp(4, 9, tuck) * s,
          y: hips.y + lerp(26, 14, tuck) * s,
        };
        footTargetR = {
          x: hips.x - f * lerp(7, 3, tuck) * s,
          y: hips.y + lerp(30, 19, tuck) * s,
        };
      } else if (state === "fall") {
        footTargetL = { x: hips.x + f * 5 * s, y: hips.y + 31 * s };
        footTargetR = { x: hips.x - f * 3 * s, y: hips.y + 34 * s };
      } else if (state === "launched") {
        const nvx = Math.max(-1, Math.min(1, inp.vx * 0.3));
        const wig = Math.sin(t * 20) * 3 * s;
        footTargetL = { x: hips.x - nvx * 12 * s + wig, y: hips.y + 24 * s };
        footTargetR = { x: hips.x - nvx * 8 * s - wig, y: hips.y + 28 * s };
      } else if (state === "attack") {
        // Keyframed poses place the feet (weight shift); procedural styles
        // keep the wide braced stance.
        const front = atk?.footFront ?? 11;
        const back = atk?.footBack ?? -9;
        footTargetL = { x: hips.x + f * front * s, y: groundFootY - (atk?.footFrontUp ?? 0) * s };
        footTargetR = { x: hips.x + f * back * s, y: groundFootY };
      } else if (state === "block") {
        // Braced guard footing per family (spear plants wide, shield digs in).
        const bp = BLOCK_POSES[style] ?? BLOCK_POSES.slash;
        footTargetL = { x: hips.x + f * (bp.footFront ?? 9) * s, y: groundFootY };
        footTargetR = { x: hips.x + f * (bp.footBack ?? -8) * s, y: groundFootY };
      } else {
        // idle / cast / hitstun: ready stance, front foot leading.
        footTargetL = { x: hips.x + f * 8 * s, y: groundFootY };
        footTargetR = { x: hips.x - f * 7 * s, y: groundFootY };
      }

      // --- Hand targets. ---
      // Default: GUARD — weapon hand raised at the chest (elbow bent), off
      // hand forward, weapon angled up-forward. Not a straight stiff arm.
      const sway = Math.sin(t * 2.2 + 1) * 1 * s;
      let handTargetR: Vec = {
        x: hips.x + f * 10 * s,
        y: hips.y - 14 * s + sway * 0.5,
      };
      let handTargetL: Vec = { x: hips.x + f * 3 * s + sway * 0.4, y: hips.y - 8 * s };
      let dirRel: number | null = -0.55; // guard: blade up-forward
      if (style === "shoot" || style === "draw") dirRel = -0.35;

      if (state === "run") {
        if (twoHanded) {
          // Two-handed carry: weapon held across the body, little arm swing.
          handTargetR = { x: hips.x + f * 8 * s, y: hips.y - 11 * s };
          dirRel = -0.65;
        } else {
          // Counter-pump with OVERLAP: the hands trail the legs by a beat
          // (phase lag) and ride an arc, so the arms whip instead of piston.
          const lagPhase = runPhase - 0.55;
          const pump = (0.75 + 0.35 * speedK) * 9 * s;
          const armSwing = Math.cos(lagPhase) * pump;
          const armRise = Math.abs(Math.sin(lagPhase)) * 2.5 * s;
          handTargetL = { x: hips.x - f * armSwing, y: hips.y - (6 + armRise / s) * s };
          handTargetR = {
            x: hips.x + f * (5 * s + armSwing * 0.45),
            y: hips.y - 9 * s - armRise * 0.5,
          };
          dirRel = -0.5;
        }
      } else if (state === "backpedal") {
        // Arms up a touch for balance — a wary, watching silhouette.
        const patter = Math.cos(runPhase - 0.5) * 3 * s;
        handTargetR = { x: neck.x + f * 9 * s, y: neck.y - 1 * s + patter * 0.3 };
        handTargetL = { x: neck.x + f * 4 * s, y: neck.y + 4 * s - patter * 0.3 };
        dirRel = -0.75; // weapon held higher, guarding the retreat
      } else if (state === "jump" || state === "fall") {
        if (state === "jump") {
          // Arms swing UP with the launch, then ease to a mid-air spread.
          const up = easeOut(Math.min(1, jumpT / 0.16));
          const spread = easeInOut(Math.min(1, Math.max(0, (jumpT - 0.14) / 0.2)));
          handTargetL = {
            x: neck.x - f * lerp(2, 9, spread) * s,
            y: neck.y - lerp(1, 10, up) * s + spread * 7 * s,
          };
          handTargetR = {
            x: neck.x + f * lerp(4, 8, spread) * s,
            y: neck.y - lerp(3, 12, up) * s + spread * 7 * s,
          };
        } else {
          // Falling reach: arms out and slightly up, bracing.
          handTargetL = { x: neck.x - f * 10 * s, y: neck.y - 2 * s };
          handTargetR = { x: neck.x + f * 9 * s, y: neck.y - 4 * s };
        }
        dirRel = null; // weapon follows the forearm mid-air
      } else if (state === "hitstun") {
        handTargetL = { x: neck.x - f * 10 * s, y: neck.y + 4 * s };
        handTargetR = { x: neck.x - f * 5 * s, y: neck.y - 4 * s };
        dirRel = null;
      } else if (state === "launched") {
        const nvx = Math.max(-1, Math.min(1, inp.vx * 0.3));
        handTargetL = { x: neck.x - nvx * 10 * s, y: neck.y + 2 * s };
        handTargetR = { x: neck.x - nvx * 7 * s, y: neck.y - 5 * s };
        dirRel = null;
      } else if (state === "block") {
        // Guard: each weapon FAMILY braces its own way (BLOCK_POSES) —
        // a sword's high diagonal, an axe's horizontal haft, raised
        // forearms for fists… Slight tremble under pressure throughout.
        const bp = BLOCK_POSES[style] ?? BLOCK_POSES.slash;
        const tremble = Math.sin(t * 18) * 0.5 * s;
        handTargetR = { x: neck.x + f * bp.hand.fwd * s, y: neck.y + bp.hand.up * s + tremble };
        handTargetL = { x: neck.x + f * bp.off.fwd * s, y: neck.y + bp.off.up * s };
        dirRel = bp.weapon;
      } else if (state === "cast") {
        const k = easeOut(1 - inp.castTimer / CAST_TIME);
        handTargetL = { x: neck.x + f * (6 + 6 * k) * s, y: neck.y + 6 * s };
        handTargetR = { x: neck.x + f * (8 + 7 * k) * s, y: neck.y - 2 * s };
        dirRel = -1.1;
      } else if (atk) {
        handTargetR = { x: neck.x + f * atk.hand.fwd * s, y: neck.y + atk.hand.up * s };
        dirRel = atk.dirRel;
        handTargetL = atk.offHand
          ? { x: neck.x + f * atk.offHand.fwd * s, y: neck.y + atk.offHand.up * s }
          : { x: hips.x - f * 8 * s, y: hips.y + 3 * s }; // counterweight
      }

      // Weapon direction from the style's relative angle.
      const weaponDir: Vec | null =
        dirRel === null ? null : { x: f * Math.cos(dirRel), y: Math.sin(dirRel) };

      // Two-handed grip: the off hand holds the shaft near the lead hand
      // (ahead of it for thrusting polearms, behind it for everything else).
      const gripStates =
        state === "idle" || state === "run" || state === "backpedal" || state === "attack";
      const offHandFree = atk?.offHand != null; // style already placed it (draw)
      if (twoHanded && gripStates && weaponDir && !offHandFree) {
        const gap = (style === "thrust" ? 8.5 : -8) * s;
        handTargetL = {
          x: handTargetR.x + weaponDir.x * gap,
          y: handTargetR.y + weaponDir.y * gap,
        };
      }

      // --- Solve limbs. ---
      const kneeBend = (-f as 1 | -1);
      const elbowBend = (f as 1 | -1);
      const legL = solveIK(hips, footTargetL, bones.thigh, bones.shin, kneeBend);
      const legR = solveIK(hips, footTargetR, bones.thigh, bones.shin, kneeBend);
      const armL = solveIK(neck, handTargetL, bones.upperArm, bones.foreArm, elbowBend);
      const armR = solveIK(neck, handTargetR, bones.upperArm, bones.foreArm, elbowBend);

      const weaponAngle = weaponDir
        ? Math.atan2(weaponDir.y, weaponDir.x)
        : Math.atan2(armR.end.y - armR.mid.y, armR.end.x - armR.mid.x);

      let skeleton: Skeleton = {
        hips,
        neck,
        head,
        torsoAngle: theta,
        shoulderL: neck,
        elbowL: armL.mid,
        handL: armL.end,
        shoulderR: neck,
        elbowR: armR.mid,
        handR: armR.end,
        hipL: hips,
        kneeL: legL.mid,
        footL: legL.end,
        hipR: hips,
        kneeR: legR.mid,
        footR: legR.end,
      };
      let outAngle = weaponAngle;

      // --- State crossfade: ease from the snapshotted outgoing pose into
      // the new state (root-relative, so the body keeps tracking physics).
      if (fade > 0 && prevRel) {
        fade = Math.max(0, fade - dt);
        const w = easeInOut(1 - fade / fadeDur); // 0 = old pose, 1 = new
        const blended = {} as Record<string, unknown>;
        for (const [key, v] of Object.entries(skeleton)) {
          if (typeof v === "number") {
            blended[key] = lerp(
              (prevRel as unknown as Record<string, number>)[key],
              v,
              w,
            );
          } else {
            const pv = (prevRel as unknown as Record<string, Vec>)[key];
            blended[key] = {
              x: lerp(inp.rootX + pv.x, (v as Vec).x, w),
              y: lerp(inp.rootY + pv.y, (v as Vec).y, w),
            };
          }
        }
        skeleton = blended as unknown as Skeleton;
        // Weapon angle blends by shortest arc.
        let dAng = weaponAngle - prevWeaponAngle;
        while (dAng > Math.PI) dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        outAngle = prevWeaponAngle + dAng * w;
      }

      // Smear endpoints → world angles (same conversion as weaponDir).
      const smear = atk?.smear
        ? {
            from: Math.atan2(Math.sin(atk.smear.from), f * Math.cos(atk.smear.from)),
            to: Math.atan2(Math.sin(atk.smear.to), f * Math.cos(atk.smear.to)),
          }
        : null;
      const frame: AnimFrame = { skeleton, weaponAngle: outAngle, state, smear };
      lastOut = frame;
      lastRoot = { x: inp.rootX, y: inp.rootY };
      return frame;
    },
  };

  return animator;
}
