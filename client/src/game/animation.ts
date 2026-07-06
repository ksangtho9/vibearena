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
      const atkTiming = ATTACK_TIMINGS[style];
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
        const mounted =
          inp.weaponMount === "head" || inp.weaponMount === "body" || inp.weaponMount === "floating";
        atk = mounted
          ? commandContribution(phase, k)
          : attackContribution(style, phase, k, inp.weaponForm, inp.weaponSize, twoHanded);
      }

      // --- Hips: track the physics root, plus per-state bob/weight. ---
      // speedK: 0 at a walk, 1 at full sprint — scales stride/lean/bounce.
      const speedK = Math.min(1, (Math.abs(inp.vx) * 60) / 420);
      let bob = 0;
      if (state === "idle") bob = Math.sin(t * 2.2) * 1.2 * s + 2.2 * s; // crouched guard
      if (state === "block") bob = 3.4 * s; // sunk into the guard
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
      if (state === "block") lean = -0.05; // weight back behind the guard
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
        // Wide braced stance while swinging.
        footTargetL = { x: hips.x + f * 11 * s, y: groundFootY };
        footTargetR = { x: hips.x - f * 9 * s, y: groundFootY };
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
        // Guard: weapon raised steeply across the body, off-hand braced
        // behind it, slight tremble under pressure.
        const tremble = Math.sin(t * 18) * 0.5 * s;
        handTargetR = { x: neck.x + f * 8 * s, y: neck.y + 1 * s + tremble };
        handTargetL = { x: neck.x + f * 4 * s, y: neck.y + 7 * s };
        dirRel = -1.15; // blade/haft held up like a wall
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

      const frame: AnimFrame = { skeleton, weaponAngle: outAngle, state };
      lastOut = frame;
      lastRoot = { x: inp.rootX, y: inp.rootY };
      return frame;
    },
  };

  return animator;
}
