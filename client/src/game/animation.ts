/**
 * Skeletal animation: the source of truth for how fighters MOVE. Physics
 * only handles the root capsule (walking/jumping/knockback collisions) and
 * the KO ragdoll. Every visible pose comes from here — procedural curves
 * per state, with 2-bone IK so feet plant on the ground without sliding and
 * hands reach their targets without stretching.
 */

export interface Vec {
  x: number;
  y: number;
}

export type AnimState =
  | "idle"
  | "run"
  | "jump"
  | "fall"
  | "attack"
  | "cast"
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

/** Attack phase timing (seconds) — combat and animation share these. */
export const ATTACK_TIMING = {
  melee: { windup: 0.12, active: 0.16, recovery: 0.2, total: 0.48 },
  missile: { windup: 0.1, active: 0.08, recovery: 0.17, total: 0.35 },
} as const;

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
  /** Seconds since the current attack started; -1 when not attacking. */
  attackElapsed: number;
  /** True for ranged/thrown weapons (shoot pose instead of a swing). */
  missileWeapon: boolean;
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpVec = (a: Vec, b: Vec, t: number): Vec => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

interface FootPlant {
  locked: boolean;
  x: number;
}

export function createAnimator(bones: Bones): Animator {
  const s = bones.scale;
  let runPhase = 0;
  const plants: [FootPlant, FootPlant] = [
    { locked: false, x: 0 },
    { locked: false, x: 0 },
  ];

  function pickState(inp: AnimInputs): AnimState {
    if (!inp.alive) return "ko";
    if (inp.launchedTimer > 0) return "launched";
    if (inp.hitstunTimer > 0) return "hitstun";
    if (inp.attackElapsed >= 0) return "attack";
    if (inp.castTimer > 0) return "cast";
    if (!inp.grounded) return inp.vy < -0.5 ? "jump" : "fall";
    if (inp.moving) return "run";
    return "idle";
  }

  const animator: Animator = {
    state: "idle",

    update(dt: number, inp: AnimInputs): AnimFrame {
      const state = pickState(inp);
      if (state !== animator.state) {
        animator.state = state;
        if (state !== "run") {
          plants[0].locked = false;
          plants[1].locked = false;
        }
      }

      const f = inp.facing;
      const t = inp.time;

      // --- Hips: track the physics root, plus per-state bob/jitter. ---
      let bob = 0;
      if (state === "idle") bob = Math.sin(t * 2.2) * 1.2 * s;
      if (state === "run") bob = Math.sin(runPhase * 2) * 1.6 * s;
      let hipsX = inp.rootX;
      if (state === "hitstun") hipsX += Math.sin(t * 45) * 1.4 * s;
      const hips: Vec = { x: hipsX, y: inp.rootY + bones.hipsOffset + bob };

      // --- Torso lean (positive leans toward facing). ---
      const moveDir = Math.abs(inp.vx) > 0.3 ? Math.sign(inp.vx) * f : 0;
      let lean = 0.05;
      if (state === "run") lean = 0.16 * moveDir + 0.03;
      if (state === "jump") lean = 0.12;
      if (state === "fall") lean = -0.05;
      if (state === "hitstun") lean = -0.32;
      if (state === "launched") lean = -0.6;
      if (state === "cast") lean = 0.1;

      // --- Attack phase bookkeeping. ---
      const timing = inp.missileWeapon ? ATTACK_TIMING.missile : ATTACK_TIMING.melee;
      let atkPhase: "windup" | "active" | "recovery" | null = null;
      let atkK = 0; // 0→1 progress within the current phase
      if (state === "attack") {
        const e = inp.attackElapsed;
        if (e < timing.windup) {
          atkPhase = "windup";
          atkK = e / timing.windup;
        } else if (e < timing.windup + timing.active) {
          atkPhase = "active";
          atkK = (e - timing.windup) / timing.active;
        } else {
          atkPhase = "recovery";
          atkK = Math.min(1, (e - timing.windup - timing.active) / timing.recovery);
        }
        lean = atkPhase === "windup" ? -0.06 : atkPhase === "active" ? 0.24 : lerp(0.24, 0.05, atkK);
      }

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

      if (state === "run") {
        const stride = 17 * s;
        const lift = 8 * s;
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
          return { x: hips.x + xRel, y: groundFootY - swingUp * lift };
        };
        footTargetL = footFromPhase(runPhase, plants[0]);
        footTargetR = footFromPhase(runPhase + Math.PI, plants[1]);
      } else if (state === "jump") {
        footTargetL = { x: hips.x + f * 8 * s, y: hips.y + 15 * s };
        footTargetR = { x: hips.x - f * 4 * s, y: hips.y + 25 * s };
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
        footTargetL = { x: hips.x + f * 10 * s, y: groundFootY };
        footTargetR = { x: hips.x - f * 9 * s, y: groundFootY };
      } else {
        // idle / cast / hitstun: settled stance.
        footTargetL = { x: hips.x + f * 7 * s, y: groundFootY };
        footTargetR = { x: hips.x - f * 6 * s, y: groundFootY };
      }

      // --- Hand targets. ---
      // Defaults: relaxed hang (off hand) and a loose weapon hold (weapon hand).
      const sway = Math.sin(t * 2.2 + 1) * 1.2 * s;
      let handTargetL: Vec = { x: hips.x - f * 5 * s + sway, y: hips.y + 13 * s };
      let handTargetR: Vec = { x: hips.x + f * 8 * s, y: hips.y + 5 * s };
      let weaponDir: Vec | null = null; // world direction the weapon points

      if (state === "run") {
        const armSwing = Math.cos(runPhase) * 9 * s;
        handTargetL = { x: hips.x - f * armSwing, y: hips.y - 6 * s };
        // Weapon arm swings less — keeps the weapon presentable.
        handTargetR = { x: hips.x + f * (4 * s + armSwing * 0.45), y: hips.y - 2 * s };
      } else if (state === "jump" || state === "fall") {
        handTargetL = { x: neck.x - f * 9 * s, y: neck.y - 3 * s };
        handTargetR = { x: neck.x + f * 8 * s, y: neck.y - 5 * s };
      } else if (state === "hitstun") {
        handTargetL = { x: neck.x - f * 10 * s, y: neck.y + 4 * s };
        handTargetR = { x: neck.x - f * 5 * s, y: neck.y - 4 * s };
      } else if (state === "launched") {
        const nvx = Math.max(-1, Math.min(1, inp.vx * 0.3));
        handTargetL = { x: neck.x - nvx * 10 * s, y: neck.y + 2 * s };
        handTargetR = { x: neck.x - nvx * 7 * s, y: neck.y - 5 * s };
      } else if (state === "cast") {
        const k = easeOut(1 - inp.castTimer / CAST_TIME);
        handTargetL = { x: neck.x + f * (6 + 6 * k) * s, y: neck.y + 6 * s };
        handTargetR = { x: neck.x + f * (8 + 7 * k) * s, y: neck.y - 2 * s };
        weaponDir = { x: f * 0.4, y: -1 };
      } else if (state === "attack" && atkPhase) {
        handTargetL = { x: hips.x - f * 8 * s, y: hips.y + 3 * s }; // counterweight
        if (inp.missileWeapon) {
          // Raise, loose, then recoil.
          const raise: Vec = { x: neck.x + f * 11 * s, y: neck.y + 1 * s };
          if (atkPhase === "windup") {
            handTargetR = lerpVec({ x: hips.x + f * 8 * s, y: hips.y + 5 * s }, raise, easeOut(atkK));
          } else if (atkPhase === "active") {
            handTargetR = { x: raise.x - f * 3 * s * atkK, y: raise.y };
          } else {
            handTargetR = lerpVec(raise, { x: hips.x + f * 8 * s, y: hips.y + 5 * s }, easeOut(atkK));
          }
          weaponDir = { x: f, y: 0 };
        } else {
          // Swing arc: wind back-and-up → thrust through → settle.
          const holdPos: Vec = { x: hips.x + f * 8 * s, y: hips.y + 5 * s };
          const backPos: Vec = { x: neck.x - f * 11 * s, y: neck.y - 5 * s };
          const outPos: Vec = { x: neck.x + f * 25 * s, y: neck.y + 5 * s };
          if (atkPhase === "windup") {
            handTargetR = lerpVec(holdPos, backPos, easeOut(atkK));
            weaponDir = { x: -f * 0.5, y: -1 };
          } else if (atkPhase === "active") {
            handTargetR = lerpVec(backPos, outPos, easeOut(atkK));
            const wy = lerp(-0.9, 0, easeOut(atkK));
            weaponDir = { x: f * (1 - Math.abs(wy) * 0.4), y: wy };
          } else {
            handTargetR = lerpVec(outPos, holdPos, easeOut(atkK));
            weaponDir = { x: f, y: 0.3 * atkK };
          }
        }
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

      const skeleton: Skeleton = {
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

      return { skeleton, weaponAngle, state };
    },
  };

  return animator;
}
