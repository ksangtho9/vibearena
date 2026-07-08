import type { CombatCtx } from "./combat";
import { pushEffect } from "./combat";
import type { Fighter } from "./stickman";
import { solveIK, type Vec } from "./animation";

/**
 * INJURY SYSTEM — location-based, cumulative, match-long.
 *
 * Fighters accrue absorbed damage per body region; crossing thresholds
 * (relative to max HP) moves the region HEALTHY → HURT → MAIMED. Injuries
 * apply MODEST, HARD-CAPPED stat penalties (no death spiral) and drive
 * visible wounds + a hurt-posture overlay layered on top of whatever pose
 * the animator produced (keyframe tables untouched).
 */

export type InjuryRegion = "head" | "torso" | "arm" | "legs";
export type InjuryState = Record<InjuryRegion, number>;

export const INJURY_REGIONS: InjuryRegion[] = ["head", "torso", "arm", "legs"];

/** Severity thresholds as fractions of max HP absorbed by ONE region. */
const HURT_AT = 0.2;
const MAIMED_AT = 0.45;

/**
 * Heal knob: absorbed-damage points regenerated per second, per region.
 * 0 = injuries persist for the whole match (current design). Flip to a
 * small positive value (e.g. maxHp * 0.01) for slow-regen later.
 */
export const INJURY_HEAL_PER_SEC = 0;

export const emptyInjuries = (): InjuryState => ({ head: 0, torso: 0, arm: 0, legs: 0 });

/** 0 = healthy, 1 = hurt, 2 = maimed. */
export function injuryTier(f: Fighter, region: InjuryRegion): 0 | 1 | 2 {
  const frac = f.injuries[region] / Math.max(1, f.maxHp);
  return frac >= MAIMED_AT ? 2 : frac >= HURT_AT ? 1 : 0;
}

/** 0..1 progress within the current look (drives wound intensity). */
export function injurySeverity(f: Fighter, region: InjuryRegion): number {
  return Math.min(1, f.injuries[region] / Math.max(1, f.maxHp) / MAIMED_AT);
}

// ---------------------------------------------------------------------------
// Region picking
// ---------------------------------------------------------------------------

/**
 * Which region a landed hit injures: contact height when known (upper third
 * → head, middle → torso/arm, lower → legs); blocked hits bias to the ARM
 * (the guard soaked it); weighted random fallback (torso-heavy, head-light).
 */
export function pickInjuryRegion(
  target: Fighter,
  hitY?: number,
  opts: { blocked?: boolean } = {},
): InjuryRegion {
  if (opts.blocked) return Math.random() < 0.7 ? "arm" : "torso";
  if (hitY !== undefined && Number.isFinite(hitY)) {
    const top = target.root.position.y - 44 * target.scale;
    const k = (hitY - top) / (88 * target.scale); // 0 head-top → 1 feet
    if (k < 0.3) return "head";
    if (k < 0.62) return Math.random() < 0.6 ? "torso" : "arm";
    return "legs";
  }
  const r = Math.random();
  return r < 0.45 ? "torso" : r < 0.7 ? "arm" : r < 0.9 ? "legs" : "head";
}

/** Accrue absorbed damage into a region (call where HP is decremented). */
export function accrueInjury(target: Fighter, region: InjuryRegion, amount: number): void {
  target.injuries[region] += Math.max(0, amount);
}

/** Heal tick (no-op while INJURY_HEAL_PER_SEC is 0). */
export function tickInjuries(f: Fighter, dt: number): void {
  if (INJURY_HEAL_PER_SEC <= 0) return;
  for (const r of INJURY_REGIONS) {
    f.injuries[r] = Math.max(0, f.injuries[r] - INJURY_HEAL_PER_SEC * dt);
  }
}

// ---------------------------------------------------------------------------
// Stat modifiers — modest, and the AGGREGATE is hard-capped
// ---------------------------------------------------------------------------

const T = (f: Fighter, r: InjuryRegion) => injuryTier(f, r);

/** LEGS: move speed. Aggregate floor: never below 60% of base. */
export function injuryMoveMul(f: Fighter): number {
  const legs = T(f, "legs");
  const mul = legs === 2 ? 0.7 : legs === 1 ? 0.85 : 1;
  return Math.max(0.6, mul);
}

/** LEGS: jump velocity. */
export function injuryJumpMul(f: Fighter): number {
  const legs = T(f, "legs");
  return Math.max(0.75, legs === 2 ? 0.85 : legs === 1 ? 0.9 : 1);
}

/** LEGS maimed: dash burst halved. */
export function injuryDashMul(f: Fighter): number {
  return T(f, "legs") === 2 ? 0.5 : 1;
}

/** ARM: attack damage. Aggregate floor: never below 65%. */
export function injuryDamageMul(f: Fighter): number {
  const arm = T(f, "arm");
  const mul = arm === 2 ? 0.75 : arm === 1 ? 0.88 : 1;
  return Math.max(0.65, mul);
}

/** ARM: attack timing (slower windup). Aggregate cap: never above +35%. */
export function injuryWindupMul(f: Fighter): number {
  const arm = T(f, "arm");
  const mul = arm === 2 ? 1.2 : arm === 1 ? 1.1 : 1;
  return Math.min(1.35, mul);
}

/** HEAD + TORSO: flinch/stagger scaling on incoming hits. Capped ×1.6. */
export function injuryFlinchMul(f: Fighter): number {
  const head = T(f, "head");
  const torso = T(f, "torso");
  const mul =
    1 + (head === 2 ? 0.3 : head === 1 ? 0.25 : 0) + (torso === 2 ? 0.25 : torso === 1 ? 0.15 : 0);
  return Math.min(1.6, mul);
}

/** TORSO: guard drains faster (block less stable). */
export function injuryGuardDrainMul(f: Fighter): number {
  const torso = T(f, "torso");
  return Math.min(1.35, torso === 2 ? 1.3 : torso === 1 ? 1.15 : 1);
}

/** HEAD maimed: shorter parry window. */
export function injuryParryMul(f: Fighter): number {
  return T(f, "head") === 2 ? 0.7 : 1;
}

// ---------------------------------------------------------------------------
// Gore + wound visuals
// ---------------------------------------------------------------------------

/** Non-organic fighters bleed sparks/oil instead of blood (best effort). */
export function goreOf(text: string): "blood" | "sparks" {
  return /robot|mech|golem|construct|android|automaton|machine|clockwork|drone|statue|puppet/i.test(
    text,
  )
    ? "sparks"
    : "blood";
}

/** Directional spatter from the contact point, sprayed along the hit dir. */
export function hitSpatter(
  ctx: CombatCtx,
  target: Fighter,
  x: number,
  y: number,
  dir: number,
  amount: number,
): void {
  const n = Math.min(9, 3 + Math.round(amount / 8));
  const spark = target.gore === "sparks";
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(-0.5 - Math.random() * 0.8, dir * (0.5 + Math.random()));
    const v = 90 + Math.random() * 140;
    pushEffect(ctx, {
      kind: "particle",
      x,
      y: y + (Math.random() - 0.5) * 8,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      gravity: spark ? 260 : 380,
      size: spark ? 2 : 2.4,
      particleShape: spark ? "spark" : "circle",
      color: spark ? (Math.random() < 0.5 ? "#ffd75e" : "#2a2a30") : "#b3202a",
      ttl: 0.4 + Math.random() * 0.2,
    });
  }
}

/** Slow drip from a maimed region (called on a cadence from combat). */
export function maimedDrip(ctx: CombatCtx, f: Fighter): void {
  const spots: [InjuryRegion, Vec][] = [
    ["head", f.skeleton.head],
    ["torso", { x: (f.skeleton.neck.x + f.skeleton.hips.x) / 2, y: (f.skeleton.neck.y + f.skeleton.hips.y) / 2 }],
    ["arm", f.skeleton.elbowR],
    ["legs", f.skeleton.kneeL],
  ];
  for (const [region, at] of spots) {
    if (injuryTier(f, region) !== 2) continue;
    pushEffect(ctx, {
      kind: "particle",
      x: at.x + (Math.random() - 0.5) * 4,
      y: at.y,
      vx: 0,
      vy: 12,
      gravity: 220,
      size: 1.8,
      particleShape: "circle",
      color: f.gore === "sparks" ? "#2a2a30" : "#8f1a22",
      ttl: 0.5,
    });
  }
}

// ---------------------------------------------------------------------------
// Hurt-posture OVERLAY — additive offsets on the ANIMATED skeleton (never
// touches the keyframe tables). Limbs are re-solved with IK so joints stay
// coherent; hitbox-relevant state (root capsule, attack-time weapon hand)
// is untouched — the arm overlay only applies OUTSIDE attacks.
// ---------------------------------------------------------------------------

export function applyInjuryPosture(f: Fighter, time: number): void {
  if (!f.alive || f.ragdoll) return;
  const sk = f.skeleton;
  const s = f.scale;
  const legsMaimed = injuryTier(f, "legs") === 2;
  const armMaimed = injuryTier(f, "arm") === 2;
  const lowHp = f.hp < f.maxHp * 0.3;
  if (!legsMaimed && !armMaimed && !lowHp) return;

  let hipsShift = 0;
  let neckShift: Vec = { x: 0, y: 0 };

  // Overall low HP: heavier, slightly hunched carriage.
  if (lowHp) {
    hipsShift += 1.5 * s;
    neckShift = { x: f.facing * 1.8 * s, y: 1.6 * s };
  }
  // LIMP: a per-step hitch while moving (hips dip rhythmically).
  if (legsMaimed && Math.abs(f.root.velocity.x) > 0.6 && f.grounded) {
    hipsShift += (Math.sin(time * 11) * 0.5 + 0.5) * 2.4 * s;
  }

  if (hipsShift !== 0 || neckShift.x !== 0) {
    sk.hips = { x: sk.hips.x, y: sk.hips.y + hipsShift };
    sk.neck = { x: sk.neck.x + neckShift.x, y: sk.neck.y + hipsShift * 0.7 + neckShift.y };
    sk.head = { x: sk.head.x + neckShift.x * 1.3, y: sk.head.y + hipsShift * 0.7 + neckShift.y * 1.2 };
    // Re-solve limbs to the SAME endpoints so knees/elbows stay coherent.
    const legL = solveIK(sk.hips, sk.footL, f.bones.thigh, f.bones.shin, (-f.facing as 1 | -1));
    const legR = solveIK(sk.hips, sk.footR, f.bones.thigh, f.bones.shin, (-f.facing as 1 | -1));
    sk.kneeL = legL.mid;
    sk.kneeR = legR.mid;
    const armL = solveIK(sk.neck, sk.handL, f.bones.upperArm, f.bones.foreArm, (f.facing as 1 | -1));
    const armR = solveIK(sk.neck, sk.handR, f.bones.upperArm, f.bones.foreArm, (f.facing as 1 | -1));
    sk.elbowL = armL.mid;
    sk.elbowR = armR.mid;
    sk.shoulderL = sk.neck;
    sk.shoulderR = sk.neck;
  }

  // ARM maimed: outside attacks, the weapon arm hangs in, guarding the ribs.
  if (armMaimed && f.attackAnim <= 0 && f.castTimer <= 0) {
    const ribs: Vec = { x: sk.hips.x + f.facing * 5 * s, y: sk.hips.y - 10 * s };
    const arm = solveIK(sk.neck, ribs, f.bones.upperArm, f.bones.foreArm, (f.facing as 1 | -1));
    sk.elbowR = arm.mid;
    sk.handR = arm.end;
    f.weaponAngle = f.facing > 0 ? -0.9 : Math.PI + 0.9; // blade tucked upward
  }
}
