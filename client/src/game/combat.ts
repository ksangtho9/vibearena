import Matter from "matter-js";
import type { Arena } from "./arena";
import { collapse, type Fighter, type Side } from "./stickman";
import type { InputState } from "./input";
import { useAbility } from "./abilities";
import { ATTACK_TIMING } from "./animation";
import { ARCHETYPES } from "./weapons/archetypes";

/**
 * Damage, knockback, HP and projectiles. Weapons have NO physics bodies:
 * during an attack's ACTIVE frames the weapon's world-space segment is
 * computed from the hand joint + archetype geometry and raycast against the
 * opponent's hurtbox (their root capsule). Hits apply damage, knockback,
 * hitstun/launched reactions, VFX and a brief hit-stop.
 */

export interface Projectile {
  body: Matter.Body;
  ownerSide: Side;
  damage: number; // pre-mitigation damage (attacker strength already applied)
  ttl: number;
  /** Thrown weapons arc under gravity and bounce; ranged shots fly flat. */
  arc: boolean;
  color: string;
  /** VFX glow color derived from the owner's weapon (render-only). */
  glow: string;
  radius: number;
}

export interface Effect {
  kind: "ring" | "spark" | "text";
  x: number;
  y: number;
  ttl: number;
  maxTtl: number;
  color: string;
  text?: string;
  radius?: number;
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

const HITSTUN_TIME = 0.26;
const LAUNCH_TIME = 0.5;
/** Mitigated damage at or above this sends the target flying. */
const LAUNCH_DAMAGE = 15;
const HITSTOP_TIME = 0.07;

const speedOf = (f: Fighter) => (3 + f.spec.stats.speed * 0.035) * f.buffs.speedMul;
const jumpVelOf = (f: Fighter) => 11 + f.spec.stats.speed * 0.015;

const isMissile = (f: Fighter) => f.spec.weapon.type !== "melee";
const attackTiming = (f: Fighter) => (isMissile(f) ? ATTACK_TIMING.missile : ATTACK_TIMING.melee);

/** Attacker-side damage before the defender's mitigation. */
export function rawDamage(attacker: Fighter, base: number): number {
  return base * (0.7 + attacker.spec.stats.strength / 250) * attacker.buffs.strengthMul;
}

export function pushEffect(ctx: CombatCtx, effect: Omit<Effect, "maxTtl">): void {
  ctx.effects.push({ ...effect, maxTtl: effect.ttl });
}

/**
 * Apply mitigated damage + knockback + hit reaction. Normal hits cause
 * hitstun; heavy hits launch; lethal hits hand the body to the ragdoll.
 */
export function dealDamage(
  target: Fighter,
  amount: number,
  dir: number,
  ctx: CombatCtx,
  knockbackMul = 1,
): void {
  if (!target.alive) return;

  let dmg = amount * (130 / (130 + target.spec.stats.defense)) * DAMAGE_SCALE;
  if (target.shieldTimer > 0) dmg *= 0.3;
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

  // Hit reaction: interrupted, staggered, or sent flying.
  if (dmg >= LAUNCH_DAMAGE || knockbackMul > 1.3) {
    target.launchedTimer = LAUNCH_TIME;
    target.hitstunTimer = 0;
  } else if (target.shieldTimer <= 0) {
    target.hitstunTimer = HITSTUN_TIME;
  }
  target.attackAnim = 0;
  target.attackWindow = 0;

  ctx.hitstop = Math.max(ctx.hitstop, HITSTOP_TIME);

  if (target.hp <= 0) collapse(target, ctx.arena.world);
}

export function spawnProjectile(
  owner: Fighter,
  ctx: CombatCtx,
  opts: { damage: number; speed: number; radius: number; arc: boolean },
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
  Matter.Body.setVelocity(body, {
    x: owner.facing * opts.speed,
    y: opts.arc ? -5.5 : 0,
  });
  Matter.Composite.add(ctx.arena.world, body);
  ctx.projectiles.push({
    body,
    ownerSide: owner.side,
    damage: opts.damage,
    ttl: opts.arc ? 2.6 : 1.8,
    arc: opts.arc,
    color: owner.color,
    glow: owner.style.glow,
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
 * animated weapon angle, as far as the archetype's drawn length or the
 * balanced gameplay range, whichever is longer.
 */
function weaponSegment(f: Fighter): { from: Matter.Vector; to: Matter.Vector } {
  const hand = f.skeleton.handR;
  const tip = ARCHETYPES[f.style.archetype].tip * f.scale * 0.95;
  const reach = Math.max(tip, f.spec.weapon.range * 0.6);
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
      dealDamage(opponent, rawDamage(f, f.spec.weapon.damage), f.facing, ctx);
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

function updateGrounded(f: Fighter, ctx: CombatCtx): void {
  const { x, y } = f.root.position;
  const half = 44 * f.scale;
  const bounds = {
    min: { x: x - 14 * f.scale, y: y + half - 4 },
    max: { x: x + 14 * f.scale, y: y + half + 14 },
  };
  f.grounded = Matter.Query.region([ctx.arena.ground], bounds).length > 0;
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
  if (f.buffTimer > 0) {
    f.buffTimer = Math.max(0, f.buffTimer - dt);
    if (f.buffTimer === 0) f.buffs = { speedMul: 1, strengthMul: 1 };
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
      Matter.Body.setVelocity(f.root, { x: v.x, y: -jumpVelOf(f) });
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
    missileWeapon: isMissile(f),
    castTimer: f.castTimer,
    hitstunTimer: f.hitstunTimer,
    launchedTimer: f.launchedTimer,
    groundY: ctx.arena.groundY,
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
    const hit =
      target.alive && Matter.Query.collides(p.body, [target.root]).length > 0;
    const hitGround = Matter.Query.collides(p.body, [arena.ground]).length > 0;
    const out =
      p.ttl <= 0 ||
      p.body.position.x < -60 ||
      p.body.position.x > arena.width + 60;

    if (hit) {
      dealDamage(target, p.damage, Math.sign(p.body.velocity.x) || 1, ctx);
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
