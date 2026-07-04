import Matter from "matter-js";
import type { AbilityMotif, ElementKind } from "../types/character";
import type { Arena } from "./arena";
import { collapse, type Fighter, type Side } from "./stickman";
import type { InputState } from "./input";
import { useAbility } from "./abilities";
import { attackTimingOf } from "./animation";

/**
 * Damage, knockback, HP and projectiles. Weapons have NO physics bodies:
 * during an attack's ACTIVE frames the weapon's world-space segment is
 * computed from the hand joint + archetype geometry and raycast against the
 * opponent's hurtbox (their root capsule). Hits apply damage, knockback,
 * hitstun/launched reactions, VFX and a brief hit-stop.
 */

/** What dealt the damage — decides the victim's stun tier and hit-stop. */
export type DamageSource = "melee" | "ranged" | "thrown" | "ability";

export interface Projectile {
  body: Matter.Body;
  ownerSide: Side;
  damage: number; // pre-mitigation damage (attacker strength already applied)
  source: DamageSource;
  ttl: number;
  /** Thrown weapons arc under gravity and bounce; ranged shots fly flat. */
  arc: boolean;
  /** Gently steers toward the target (ability param, turn-rate capped). */
  homing: boolean;
  color: string;
  /** VFX glow color derived from the owner's weapon (render-only). */
  glow: string;
  radius: number;
}

export interface Effect {
  kind: "ring" | "spark" | "text" | "motif";
  x: number;
  y: number;
  ttl: number;
  maxTtl: number;
  color: string;
  text?: string;
  radius?: number;
  /** Ability VFX shape + element styling (kind "motif"). */
  motif?: AbilityMotif;
  element?: ElementKind;
  /** Facing for directional motifs (beam/wave/slash). */
  dir?: number;
}

export interface CombatCtx {
  arena: Arena;
  projectiles: Projectile[];
  effects: Effect[];
  /** Global freeze remaining (seconds) — set on weapon hits for punch. */
  hitstop: number;
  /** Game clock, fed by the loop; the animators sway/bob off it. */
  time: number;
}

const DAMAGE_SCALE = 2.2;
const MELEE_ATTACK_COOLDOWN = 0.55;
const MISSILE_ATTACK_COOLDOWN = 0.8;

/**
 * Victim control-lockout per damage source. Knockback is untouched — these
 * only govern how fast the victim regains control. Melee interrupts briefly;
 * ranged/thrown are a flinch, never a lockdown; abilities stagger like melee
 * (their launches are handled separately below).
 */
const HITSTUN_BY_SOURCE: Record<DamageSource, number> = {
  melee: 0.13,
  ranged: 0.025,
  thrown: 0.025,
  ability: 0.13,
};

const LAUNCH_TIME = 0.5;
/**
 * Weapon-hit launch threshold: high enough that normal melee trades stagger
 * instead of launching. Ranged/thrown weapon hits NEVER launch; abilities
 * launch via their knockback multiplier regardless of this number.
 */
const LAUNCH_DAMAGE = 26;

/** Hit-stop per source: melee/ability hits punch; projectiles read "light". */
const HITSTOP_BY_SOURCE: Record<DamageSource, number> = {
  melee: 0.07,
  ranged: 0.035,
  thrown: 0.035,
  ability: 0.07,
};

const speedOf = (f: Fighter) => (3 + f.spec.stats.speed * 0.035) * f.buffs.speedMul;
const jumpVelOf = (f: Fighter) => 11 + f.spec.stats.speed * 0.015;

const isMissile = (f: Fighter) => f.spec.weapon.type !== "melee";
/** Phase timing follows the weapon's form (chop ≠ thrust ≠ shoot…). */
const attackTiming = (f: Fighter) => attackTimingOf(f.style.weapon.form, f.spec.weapon.type);

/** Attacker-side damage before the defender's mitigation. */
export function rawDamage(attacker: Fighter, base: number): number {
  return base * (0.7 + attacker.spec.stats.strength / 250) * attacker.buffs.strengthMul;
}

export function pushEffect(ctx: CombatCtx, effect: Omit<Effect, "maxTtl">): void {
  ctx.effects.push({ ...effect, maxTtl: effect.ttl });
}

export interface DamageOpts {
  knockbackMul?: number;
  source?: DamageSource;
}

/**
 * Apply mitigated damage + knockback + hit reaction. The knockback impulse
 * is the same for every source; only the CONTROL LOCKOUT is tiered — melee
 * staggers briefly, projectiles barely flinch, and launching is reserved for
 * abilities and genuinely heavy melee hits.
 */
export function dealDamage(
  target: Fighter,
  amount: number,
  dir: number,
  ctx: CombatCtx,
  opts: DamageOpts = {},
): void {
  if (!target.alive) return;
  // Dash i-frames: the hit whiffs entirely.
  if (target.invulnTimer > 0) {
    const { x, y } = target.root.position;
    pushEffect(ctx, { kind: "text", x, y: y - 70, ttl: 0.5, color: "#9ba69e", text: "MISS" });
    return;
  }
  const knockbackMul = opts.knockbackMul ?? 1;
  const source = opts.source ?? "ability";

  let dmg =
    amount *
    (130 / (130 + target.spec.stats.defense * target.buffs.defenseMul)) *
    DAMAGE_SCALE;
  if (target.shieldTimer > 0) dmg *= 1 - target.shieldCoverage;
  dmg = Math.max(1, Math.round(dmg));

  target.hp = Math.max(0, target.hp - dmg);

  const { x, y } = target.root.position;
  pushEffect(ctx, { kind: "text", x, y: y - 70, ttl: 0.7, color: "#e8b33c", text: `${dmg}` });
  pushEffect(ctx, { kind: "spark", x, y: y - 20, ttl: 0.25, color: target.color, radius: 14 });

  const kb = Math.min(12, (4.5 + dmg * 0.22) * knockbackMul);
  Matter.Body.setVelocity(target.root, {
    x: dir * kb,
    y: Math.min(target.root.velocity.y, -kb * 0.4),
  });

  // Hit reaction: ranged/thrown never launch; abilities launch on their
  // knockback multiplier; melee only on a genuinely heavy hit.
  const launches =
    source === "ability"
      ? knockbackMul > 1.3 || dmg >= LAUNCH_DAMAGE
      : source === "melee" && dmg >= LAUNCH_DAMAGE;

  if (launches) {
    target.launchedTimer = LAUNCH_TIME;
    target.hitstunTimer = 0;
    target.attackAnim = 0;
    target.attackWindow = 0;
  } else if (target.shieldTimer <= 0) {
    target.hitstunTimer = Math.max(target.hitstunTimer, HITSTUN_BY_SOURCE[source]);
    // Only a real stagger (melee-tier) interrupts an attack in progress.
    if (HITSTUN_BY_SOURCE[source] >= HITSTUN_BY_SOURCE.melee) {
      target.attackAnim = 0;
      target.attackWindow = 0;
    }
  }

  ctx.hitstop = Math.max(ctx.hitstop, HITSTOP_BY_SOURCE[source]);

  if (target.hp <= 0) collapse(target, ctx.arena.world);
}

export function spawnProjectile(
  owner: Fighter,
  ctx: CombatCtx,
  opts: {
    damage: number;
    speed: number;
    radius: number;
    arc: boolean;
    source: DamageSource;
    /** Launch angle offset in radians (negative = upward), for fans. */
    angle?: number;
    homing?: boolean;
    glow?: string;
  },
): void {
  // Launch from the weapon hand joint.
  const hand = owner.skeleton.handR;
  const body = Matter.Bodies.circle(
    hand.x + owner.facing * 6 * owner.scale,
    hand.y,
    opts.radius,
    {
      collisionFilter: { group: owner.root.collisionFilter.group }, // never hits its owner
      density: 0.002,
      frictionAir: 0.001,
      restitution: opts.arc ? 0.5 : 0,
      label: `${owner.side}-projectile`,
    },
  );
  const a = opts.angle ?? 0;
  Matter.Body.setVelocity(body, {
    x: owner.facing * opts.speed * Math.cos(a),
    y: opts.speed * Math.sin(a) + (opts.arc ? -5.5 : 0),
  });
  Matter.Composite.add(ctx.arena.world, body);
  ctx.projectiles.push({
    body,
    ownerSide: owner.side,
    damage: opts.damage,
    source: opts.source,
    ttl: opts.arc ? 2.6 : 1.8,
    arc: opts.arc,
    homing: opts.homing ?? false,
    color: owner.color,
    glow: opts.glow ?? owner.style.glow,
    radius: opts.radius,
  });
}

function startAttack(f: Fighter): void {
  f.attackCooldown = isMissile(f) ? MISSILE_ATTACK_COOLDOWN : MELEE_ATTACK_COOLDOWN;
  f.attackAnim = attackTiming(f).total;
  f.attackWindow = 0;
  f.hasHitThisSwing = false;
  f.projectileFired = false;
}

/**
 * The weapon's world-space segment: from the hand joint out along the
 * animated weapon angle. Reach comes from the BALANCED weapon.range (with a
 * small floor), never from the visual form/size — cosmetics don't change
 * hitboxes.
 */
function weaponSegment(f: Fighter): { from: Matter.Vector; to: Matter.Vector } {
  const hand = f.skeleton.handR;
  const reach = Math.max(28 * f.scale, f.spec.weapon.range * 0.6);
  return {
    from: { x: hand.x, y: hand.y },
    to: {
      x: hand.x + Math.cos(f.weaponAngle) * reach,
      y: hand.y + Math.sin(f.weaponAngle) * reach,
    },
  };
}

/** Advance the attack phases: active-frame hit tests and projectile release. */
function progressAttack(f: Fighter, opponent: Fighter, ctx: CombatCtx): void {
  if (f.attackAnim <= 0) {
    f.attackWindow = 0;
    return;
  }
  const timing = attackTiming(f);
  const elapsed = timing.total - f.attackAnim;
  const activeEnd = timing.windup + timing.active;

  f.attackWindow =
    elapsed >= timing.windup && elapsed < activeEnd ? activeEnd - elapsed : 0;

  if (isMissile(f)) {
    if (elapsed >= timing.windup && !f.projectileFired) {
      f.projectileFired = true;
      const { weapon } = f.spec;
      spawnProjectile(f, ctx, {
        damage: rawDamage(f, weapon.damage),
        speed: weapon.type === "ranged" ? 13 : 10,
        radius: weapon.type === "ranged" ? 5 : 7,
        arc: weapon.type === "thrown",
        source: weapon.type === "thrown" ? "thrown" : "ranged",
      });
    }
    return;
  }

  // Melee: raycast the weapon segment against the opponent's hurtbox.
  if (f.attackWindow > 0 && !f.hasHitThisSwing && opponent.alive) {
    const seg = weaponSegment(f);
    const hits = Matter.Query.ray([opponent.root], seg.from, seg.to, 10 * f.scale);
    if (hits.length > 0) {
      f.hasHitThisSwing = true;
      dealDamage(opponent, rawDamage(f, f.spec.weapon.damage), f.facing, ctx, { source: "melee" });
      pushEffect(ctx, {
        kind: "ring",
        x: seg.to.x,
        y: seg.to.y,
        ttl: 0.25,
        color: f.style.glow,
        radius: 16,
      });
    }
  }
}

/**
 * Kinematic one-way platform landing for fighters: the root capsule never
 * physically collides with platforms (edge normals would eject it sideways);
 * instead, a falling capsule whose bottom crossed a platform's top surface
 * this step snaps onto it. Jumping up (vy < 0) and drop-through skip it.
 */
function platformLanding(f: Fighter, ctx: CombatCtx): void {
  const half = 44 * f.scale;
  const x = f.root.position.x;
  const bottom = f.root.position.y + half;
  const prevBottom = f.prevBottom;
  f.prevBottom = bottom;

  if (f.root.velocity.y < -0.5 || f.dropThrough > 0) return;
  for (const p of ctx.arena.platforms) {
    const top = p.bounds.min.y;
    if (
      prevBottom <= top + 1 &&
      bottom >= top - 1 &&
      x > p.bounds.min.x - 4 &&
      x < p.bounds.max.x + 4
    ) {
      Matter.Body.setPosition(f.root, { x, y: top - half });
      Matter.Body.setVelocity(f.root, { x: f.root.velocity.x, y: 0 });
      f.prevBottom = top;
      break;
    }
  }
}

function updateGrounded(f: Fighter, ctx: CombatCtx): void {
  const { x, y } = f.root.position;
  const half = 44 * f.scale;
  const bounds = {
    min: { x: x - 14 * f.scale, y: y + half - 4 },
    max: { x: x + 14 * f.scale, y: y + half + 14 },
  };
  const onGround = Matter.Query.region([ctx.arena.ground], bounds).length > 0;

  // One-way platforms only count as footing when the feet are AT the top
  // surface and the fighter isn't rising through or dropping through it.
  let onPlatform = false;
  if (!onGround && f.root.velocity.y >= -0.5 && f.dropThrough <= 0) {
    const bottom = y + half;
    for (const p of ctx.arena.platforms) {
      if (
        bottom >= p.bounds.min.y - 6 &&
        bottom <= p.bounds.min.y + 14 &&
        x > p.bounds.min.x - 8 &&
        x < p.bounds.max.x + 8
      ) {
        onPlatform = true;
        break;
      }
    }
  }
  f.grounded = onGround || onPlatform;
  f.onPlatform = onPlatform;
}

function tickTimers(f: Fighter, dt: number): void {
  f.attackCooldown = Math.max(0, f.attackCooldown - dt);
  f.attackAnim = Math.max(0, f.attackAnim - dt);
  f.jumpCooldown = Math.max(0, f.jumpCooldown - dt);
  f.abilityCooldown = Math.max(0, f.abilityCooldown - dt);
  f.shieldTimer = Math.max(0, f.shieldTimer - dt);
  f.introTimer = Math.max(0, f.introTimer - dt);
  f.hitstunTimer = Math.max(0, f.hitstunTimer - dt);
  f.launchedTimer = Math.max(0, f.launchedTimer - dt);
  f.castTimer = Math.max(0, f.castTimer - dt);
  f.dropThrough = Math.max(0, f.dropThrough - dt);
  f.invulnTimer = Math.max(0, f.invulnTimer - dt);
  if (f.regenTimer > 0 && f.alive) {
    f.regenTimer = Math.max(0, f.regenTimer - dt);
    f.hp = Math.min(f.maxHp, f.hp + f.regenRate * dt);
    if (f.regenTimer === 0) f.hp = Math.round(f.hp);
  }
  if (f.buffTimer > 0) {
    f.buffTimer = Math.max(0, f.buffTimer - dt);
    if (f.buffTimer === 0) f.buffs = { speedMul: 1, strengthMul: 1, defenseMul: 1 };
  }
}

/**
 * One simulation tick for one fighter: timers, control, attack progression,
 * then the animator poses the skeleton (the render just draws it).
 */
export function updateFighter(
  f: Fighter,
  opponent: Fighter,
  input: InputState,
  ctx: CombatCtx,
  dt: number,
): void {
  tickTimers(f, dt);
  if (!f.alive) return; // the KO ragdoll belongs to the physics engine now

  platformLanding(f, ctx);
  updateGrounded(f, ctx);

  // Fighters always square up to their opponent.
  f.facing = opponent.root.position.x >= f.root.position.x ? 1 : -1;

  const stunned = f.hitstunTimer > 0 || f.launchedTimer > 0;
  const v = f.root.velocity;

  if (f.introTimer <= 0 && !stunned) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir !== 0) {
      Matter.Body.setVelocity(f.root, { x: dir * speedOf(f), y: v.y });
    } else if (f.grounded) {
      Matter.Body.setVelocity(f.root, { x: v.x * 0.8, y: v.y });
    }

    if (input.jump && f.grounded && f.jumpCooldown <= 0) {
      if (input.down && f.onPlatform) {
        // Drop through the one-way platform instead of jumping.
        f.dropThrough = 0.25;
      } else {
        Matter.Body.setVelocity(f.root, { x: v.x, y: -jumpVelOf(f) });
      }
      f.jumpCooldown = 0.3;
    }

    if (input.attack && f.attackCooldown <= 0 && f.attackAnim <= 0) startAttack(f);

    if (input.ability && f.abilityCooldown <= 0) {
      f.abilityCooldown = f.spec.ability.cooldown;
      useAbility(f, opponent, ctx);
    }
  } else if (stunned && f.grounded) {
    // Staggered: skid to a stop, no control.
    Matter.Body.setVelocity(f.root, { x: v.x * 0.85, y: v.y });
  }

  progressAttack(f, opponent, ctx);

  // Pose the skeleton — the single source of truth for how this looks.
  const timing = attackTiming(f);
  const frame = f.animator.update(dt, {
    rootX: f.root.position.x,
    rootY: f.root.position.y,
    vx: f.root.velocity.x,
    vy: f.root.velocity.y,
    grounded: f.grounded,
    facing: f.facing,
    moving: Math.abs(f.root.velocity.x) > 0.6 && f.grounded,
    alive: f.alive,
    attackElapsed: f.attackAnim > 0 ? timing.total - f.attackAnim : -1,
    weaponForm: f.style.weapon.form,
    weaponSize: f.style.weapon.size,
    weaponType: f.spec.weapon.type,
    castTimer: f.castTimer,
    hitstunTimer: f.hitstunTimer,
    launchedTimer: f.launchedTimer,
    // Feet plant on whatever the fighter is standing on (platform or ground).
    groundY: f.grounded ? f.root.position.y + 44 * f.scale : ctx.arena.groundY,
    time: ctx.time,
  });
  f.skeleton = frame.skeleton;
  f.weaponAngle = frame.weaponAngle;
}

export function updateProjectiles(
  fighters: { player: Fighter; bot: Fighter },
  ctx: CombatCtx,
  dt: number,
): void {
  const { arena } = ctx;
  const gravity = arena.engine.gravity;

  for (let i = ctx.projectiles.length - 1; i >= 0; i--) {
    const p = ctx.projectiles[i];
    p.ttl -= dt;

    // Ranged shots fly nearly flat: cancel most of gravity every tick.
    if (!p.arc) {
      Matter.Body.applyForce(p.body, p.body.position, {
        x: 0,
        y: -gravity.y * gravity.scale * p.body.mass * 0.85,
      });
    }

    const target = p.ownerSide === "player" ? fighters.bot : fighters.player;

    // Homing: rotate the velocity toward the target, turn rate capped so it
    // curves rather than snaps.
    if (p.homing && target.alive) {
      const v = p.body.velocity;
      const speed = Math.hypot(v.x, v.y) || 1;
      const current = Math.atan2(v.y, v.x);
      const wanted = Math.atan2(
        target.root.position.y - 20 - p.body.position.y,
        target.root.position.x - p.body.position.x,
      );
      let diff = wanted - current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turn = Math.max(-0.05, Math.min(0.05, diff));
      Matter.Body.setVelocity(p.body, {
        x: Math.cos(current + turn) * speed,
        y: Math.sin(current + turn) * speed,
      });
    }
    const hit =
      target.alive && Matter.Query.collides(p.body, [target.root]).length > 0;
    const hitGround = Matter.Query.collides(p.body, [arena.ground]).length > 0;
    const out =
      p.ttl <= 0 ||
      p.body.position.x < -60 ||
      p.body.position.x > arena.width + 60;

    if (hit) {
      dealDamage(target, p.damage, Math.sign(p.body.velocity.x) || 1, ctx, { source: p.source });
      pushEffect(ctx, {
        kind: "ring",
        x: p.body.position.x,
        y: p.body.position.y,
        ttl: 0.3,
        color: p.glow,
        radius: p.radius * 4,
      });
    }

    if (hit || out || (hitGround && !p.arc)) {
      Matter.Composite.remove(arena.world, p.body);
      ctx.projectiles.splice(i, 1);
    }
  }
}

export function updateEffects(ctx: CombatCtx, dt: number): void {
  for (let i = ctx.effects.length - 1; i >= 0; i--) {
    const e = ctx.effects[i];
    e.ttl -= dt;
    if (e.ttl <= 0) ctx.effects.splice(i, 1);
  }
}

/** Ties (double KO) go to the player — they earned the chaos. */
export function checkWinner(player: Fighter, bot: Fighter): Side | null {
  if (!bot.alive) return "player";
  if (!player.alive) return "bot";
  return null;
}
