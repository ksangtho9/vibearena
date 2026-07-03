import Matter from "matter-js";
import type { Arena } from "./arena";
import { collapse, type Fighter, type Side } from "./stickman";
import type { InputState } from "./input";
import { useAbility } from "./abilities";

/**
 * Damage, knockback, HP and projectiles. All tuning constants live here so
 * the feel of the game is adjustable in one place.
 */

export interface Projectile {
  body: Matter.Body;
  ownerSide: Side;
  damage: number; // pre-mitigation damage (attacker strength already applied)
  ttl: number;
  /** Thrown weapons arc under gravity and bounce; ranged shots fly flat. */
  arc: boolean;
  color: string;
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
}

const DAMAGE_SCALE = 2.2;
const MELEE_ATTACK_COOLDOWN = 0.55;
const MISSILE_ATTACK_COOLDOWN = 0.8;
const ATTACK_WINDOW = 0.2;

const speedOf = (f: Fighter) => (3 + f.spec.stats.speed * 0.035) * f.buffs.speedMul;
const jumpVelOf = (f: Fighter) => 11 + f.spec.stats.speed * 0.015;

/** Attacker-side damage before the defender's mitigation. */
export function rawDamage(attacker: Fighter, base: number): number {
  return base * (0.7 + attacker.spec.stats.strength / 250) * attacker.buffs.strengthMul;
}

export function pushEffect(ctx: CombatCtx, effect: Omit<Effect, "maxTtl">): void {
  ctx.effects.push({ ...effect, maxTtl: effect.ttl });
}

/** Apply mitigated damage + knockback. Handles death (ragdoll collapse). */
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

  if (target.hp <= 0) collapse(target);
}

export function spawnProjectile(
  owner: Fighter,
  ctx: CombatCtx,
  opts: { damage: number; speed: number; radius: number; arc: boolean },
): void {
  const { x, y } = owner.root.position;
  const body = Matter.Bodies.circle(
    x + owner.facing * 26 * owner.scale,
    y - 24 * owner.scale,
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
    radius: opts.radius,
  });
}

function startAttack(f: Fighter, ctx: CombatCtx): void {
  const { weapon } = f.spec;
  f.attackWindow = ATTACK_WINDOW;
  f.hasHitThisSwing = false;

  if (weapon.type === "melee") {
    f.attackCooldown = MELEE_ATTACK_COOLDOWN;
    // Fling the weapon arm forward for the visual swing.
    Matter.Body.setVelocity(f.arms[1].body, {
      x: f.facing * 14,
      y: -6,
    });
  } else {
    f.attackCooldown = MISSILE_ATTACK_COOLDOWN;
    spawnProjectile(f, ctx, {
      damage: rawDamage(f, weapon.damage),
      speed: weapon.type === "ranged" ? 13 : 10,
      radius: weapon.type === "ranged" ? 5 : 7,
      arc: weapon.type === "thrown",
    });
  }
}

/** Melee hitbox in front of the fighter, sized by weapon range. */
function resolveMelee(f: Fighter, opponent: Fighter, ctx: CombatCtx): void {
  if (f.spec.weapon.type !== "melee" || f.attackWindow <= 0 || f.hasHitThisSwing) return;

  const { x, y } = f.root.position;
  const reach = f.spec.weapon.range;
  const x1 = x + f.facing * 6;
  const x2 = x + f.facing * (6 + reach);
  const bounds = {
    min: { x: Math.min(x1, x2), y: y - 55 * f.scale },
    max: { x: Math.max(x1, x2), y: y + 45 * f.scale },
  };
  const hits = Matter.Query.region(opponent.hittable, bounds);
  if (hits.length > 0) {
    f.hasHitThisSwing = true;
    dealDamage(opponent, rawDamage(f, f.spec.weapon.damage), f.facing, ctx);
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
  f.attackWindow = Math.max(0, f.attackWindow - dt);
  f.jumpCooldown = Math.max(0, f.jumpCooldown - dt);
  f.abilityCooldown = Math.max(0, f.abilityCooldown - dt);
  f.shieldTimer = Math.max(0, f.shieldTimer - dt);
  f.introTimer = Math.max(0, f.introTimer - dt);
  if (f.buffTimer > 0) {
    f.buffTimer = Math.max(0, f.buffTimer - dt);
    if (f.buffTimer === 0) f.buffs = { speedMul: 1, strengthMul: 1 };
  }
}

/** One simulation tick for one fighter: timers, facing, movement, attacks. */
export function updateFighter(
  f: Fighter,
  opponent: Fighter,
  input: InputState,
  ctx: CombatCtx,
  dt: number,
): void {
  tickTimers(f, dt);
  if (!f.alive) return;

  updateGrounded(f, ctx);

  // Fighters always square up to their opponent.
  f.facing = opponent.root.position.x >= f.root.position.x ? 1 : -1;

  if (f.introTimer > 0) return; // round intro: no inputs yet

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const v = f.root.velocity;
  if (dir !== 0) {
    Matter.Body.setVelocity(f.root, { x: dir * speedOf(f), y: v.y });
  } else if (f.grounded) {
    Matter.Body.setVelocity(f.root, { x: v.x * 0.8, y: v.y });
  }

  if (input.jump && f.grounded && f.jumpCooldown <= 0) {
    Matter.Body.setVelocity(f.root, { x: v.x, y: -jumpVelOf(f) });
    f.jumpCooldown = 0.3;
  }

  if (input.attack && f.attackCooldown <= 0) startAttack(f, ctx);
  resolveMelee(f, opponent, ctx);

  if (input.ability && f.abilityCooldown <= 0) {
    f.abilityCooldown = f.spec.ability.cooldown;
    useAbility(f, opponent, ctx);
  }
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
    const hit = Matter.Query.collides(p.body, target.hittable).length > 0;
    const hitGround = Matter.Query.collides(p.body, [arena.ground]).length > 0;
    const out =
      p.ttl <= 0 ||
      p.body.position.x < -60 ||
      p.body.position.x > arena.width + 60;

    if (hit && target.alive) {
      dealDamage(target, p.damage, Math.sign(p.body.velocity.x) || 1, ctx);
      pushEffect(ctx, {
        kind: "ring",
        x: p.body.position.x,
        y: p.body.position.y,
        ttl: 0.3,
        color: p.color,
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
