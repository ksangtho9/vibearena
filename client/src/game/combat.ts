import Matter from "matter-js";
import type {
  AbilityMotif,
  ElementKind,
  WeaponForm,
  WeaponPropertyKind,
} from "../types/character";
import type { BehaviorRuntime } from "./engine/interpreter";
import { dispatchHandler } from "./engine/interpreter";
import { runWeaponScript } from "./engine/customScript";
import type { EngineEntity } from "./engine/api";
import { elementGlow } from "../generation/enrich";
import type { Arena } from "./arena";
import { collapse, weaponMountAnchor, type Fighter, type Side } from "./stickman";
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

/** How a projectile DRAWS — purely cosmetic, hitbox is the physics body. */
export type ProjectileVisual = "arrow" | "bullet" | "thrown" | "bolt";

export interface Projectile {
  body: Matter.Body;
  ownerSide: Side;
  damage: number; // pre-mitigation damage (attacker strength already applied)
  source: DamageSource;
  ttl: number;
  /** Initial ttl — lets the renderer compute age for spin/trails. */
  maxTtl: number;
  /** Thrown weapons arc under gravity and bounce; ranged shots fly flat. */
  arc: boolean;
  /** Gently steers toward the target (ability param, turn-rate capped). */
  homing: boolean;
  color: string;
  /** VFX glow color derived from the owner's weapon (render-only). */
  glow: string;
  radius: number;
  visual: ProjectileVisual;
  /** For "thrown": which object spins through the air. */
  form?: WeaponForm;
  /** For "bolt": element styling (jagged, flaming, shard…). */
  element?: ElementKind;
  /** Behavior-engine callback fired when this projectile connects. */
  onHit?: () => void;
  /** Boomerang flight: flies out then homes back to the thrower. */
  boomerang?: boolean;
  returning?: boolean;
  /** Re-hit debounce for piercing/reflected projectiles. */
  rehit?: number;
}

export interface Effect {
  kind: "ring" | "spark" | "text" | "motif" | "shape" | "particle";
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
  /** Behavior-engine draw verbs (kind "shape"). */
  shape?: "circle" | "line" | "arc";
  x2?: number;
  y2?: number;
  /** Arc angles (kind "shape", shape "arc"). */
  a0?: number;
  a1?: number;
  /** Stroke width / ring thickness override. */
  width?: number;
  /** Ring expansion rate px/s (kind "ring"; default keeps legacy grow). */
  expand?: number;
  // Free-flying particle (kind "particle") — moved by updateEffects.
  vx?: number;
  vy?: number;
  gravity?: number;
  size?: number;
  particleShape?: "circle" | "square" | "spark" | "star";
}

export interface CombatCtx {
  arena: Arena;
  fighters: { player: Fighter; bot: Fighter };
  projectiles: Projectile[];
  effects: Effect[];
  /** Live behavior-program runtimes (LLM-authored abilities). */
  behaviors: BehaviorRuntime[];
  /** Behavior-spawned entities (clones, traps, turrets…). */
  entities: EngineEntity[];
  /** Global freeze remaining (seconds) — set on weapon hits for punch. */
  hitstop: number;
  /** Game clock, fed by the loop; the animators sway/bob off it. */
  time: number;
  // Behavior-engine screen juice (rendered by the loop).
  shakeTimer: number;
  shakeAmp: number;
  flashTimer: number;
  flashMax: number;
  flashColor: string;
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

/** Balanced magnitude (0 when absent) of a weapon property on this fighter. */
export function weaponPropMag(f: Fighter, kind: WeaponPropertyKind): number {
  return f.spec.weapon.properties?.find((p) => p.kind === kind)?.magnitude ?? 0;
}

/** attackSpeed property: faster phases (and cooldown), traded in dealDamage
 * against per-hit output. */
const attackSpeedScale = (f: Fighter) => 1 / (1 + weaponPropMag(f, "attackSpeed") * 0.04);

/** Phase timing follows the weapon's form, scaled by the attackSpeed property. */
function attackTiming(f: Fighter): { windup: number; active: number; recovery: number; total: number } {
  const base = attackTimingOf(f.style.weapon.form, f.spec.weapon.type);
  const ts = attackSpeedScale(f);
  return {
    windup: base.windup * ts,
    active: base.active * ts,
    recovery: base.recovery * ts,
    total: base.total * ts,
  };
}

/** Per-hit weapon damage after the attackSpeed trade-off. */
function weaponHitDamage(f: Fighter): number {
  return rawDamage(f, f.spec.weapon.damage) * (1 - weaponPropMag(f, "attackSpeed") * 0.025);
}

/** Roll the crit property: returns the (possibly boosted) damage + crit flag. */
function rollCrit(f: Fighter, damage: number): { damage: number; crit: boolean } {
  const chance = weaponPropMag(f, "crit") * 0.03;
  if (chance > 0 && Math.random() < chance) return { damage: damage * 1.6, crit: true };
  return { damage, crit: false };
}

/** Attacker-side damage before the defender's mitigation. */
export function rawDamage(attacker: Fighter, base: number): number {
  return base * (0.7 + attacker.spec.stats.strength / 250) * attacker.buffs.strengthMul;
}

export function pushEffect(ctx: CombatCtx, effect: Omit<Effect, "maxTtl">): void {
  // Anti-crash cap: render programs push every frame — drop the oldest
  // rather than let the effects array grow without bound.
  if (ctx.effects.length >= 450) ctx.effects.shift();
  ctx.effects.push({ ...effect, maxTtl: effect.ttl });
}

export interface DamageOpts {
  knockbackMul?: number;
  source?: DamageSource;
  /** Set on weapon-sourced hits so the attacker's properties apply. */
  attacker?: Fighter;
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
  // Dash i-frames / phase(): the hit whiffs entirely.
  if (target.invulnTimer > 0 || target.phaseTimer > 0) {
    const { x, y } = target.root.position;
    pushEffect(ctx, { kind: "text", x, y: y - 70, ttl: 0.5, color: "#9ba69e", text: "MISS" });
    return;
  }
  // --- Block + parry: the ONE central hook, so guarding works against
  // melee, projectiles AND AI-authored engine damage alike. Frontal only —
  // `dir` is the push direction, so the attack comes from the -dir side and
  // is frontal when the target faces that way.
  const frontal = target.facing === -(Math.sign(dir) || 1);

  // PARRY: block tapped within the window just before the hit lands.
  // Free (no guard cost), no damage, and the attacker is staggered open.
  if (frontal && target.parryTimer > 0 && target.introTimer <= 0) {
    target.parryTimer = 0; // consumed
    const { x, y } = target.root.position;
    pushEffect(ctx, { kind: "text", x, y: y - 84, ttl: 0.8, color: "#ffe95e", text: "PARRY!" });
    pushEffect(ctx, { kind: "spark", x: x + target.facing * 18, y: y - 22, ttl: 0.3, color: "#ffe95e", radius: 18 });
    pushEffect(ctx, { kind: "ring", x: x + target.facing * 18, y: y - 22, ttl: 0.25, color: "#ffffff", radius: 22 });
    if (opts.attacker?.alive) {
      // Riposte opening: stagger + interrupt whatever they were doing.
      opts.attacker.hitstunTimer = Math.max(opts.attacker.hitstunTimer, 0.5);
      opts.attacker.attackAnim = 0;
      opts.attacker.attackWindow = 0;
    }
    ctx.hitstop = Math.max(ctx.hitstop, 0.09);
    return;
  }

  // BLOCK: guard stance negates the frontal hit at the cost of guard meter.
  if (frontal && target.blocking) {
    const preMitigation = amount * DAMAGE_SCALE * 0.45; // drain ~ hit weight
    target.guard -= preMitigation * target.guardDrainMul;
    target.guardRegenDelay = 0.8;
    const { x, y } = target.root.position;
    if (target.guard > 0) {
      // Held: spark + a nudge of pushback, zero damage (no chip).
      pushEffect(ctx, { kind: "spark", x: x + target.facing * 16, y: y - 20, ttl: 0.2, color: "#c9ced9", radius: 12 });
      Matter.Body.setVelocity(target.root, {
        x: dir * 3,
        y: target.root.velocity.y,
      });
      ctx.hitstop = Math.max(ctx.hitstop, 0.03);
      return;
    }
    // GUARD BREAK: block shatters, long stun, guard refills from zero.
    target.guard = 0;
    target.blocking = false;
    target.hitstunTimer = Math.max(target.hitstunTimer, 0.6);
    target.attackAnim = 0;
    target.attackWindow = 0;
    target.guardRegenDelay = 0.35; // then ~2s to refill
    pushEffect(ctx, { kind: "text", x, y: y - 92, ttl: 1, color: "#e0483e", text: "GUARD BREAK" });
    pushEffect(ctx, { kind: "ring", x, y: y - 20, ttl: 0.4, color: "#e0483e", radius: 34 });
    for (let i = 0; i < 5; i++) {
      pushEffect(ctx, {
        kind: "particle", x, y: y - 40, ttl: 0.7, color: "#ffe95e",
        vx: (Math.random() - 0.5) * 160, vy: -80 - Math.random() * 80,
        gravity: 300, size: 4, particleShape: "star",
      });
    }
    ctx.hitstop = Math.max(ctx.hitstop, 0.1);
    // The breaking hit itself is spent shattering the guard.
    return;
  }

  // reflect(): the parry window turns the damage back on the attacker.
  // (The reflected call carries no attacker, so mirrors can't ping-pong.)
  if (target.reflectTimer > 0) {
    const { x, y } = target.root.position;
    pushEffect(ctx, { kind: "text", x, y: y - 76, ttl: 0.6, color: "#ffd75e", text: "REFLECT" });
    pushEffect(ctx, { kind: "ring", x, y: y - 20, ttl: 0.25, color: "#ffd75e", radius: 26 });
    if (opts.attacker?.alive) {
      dealDamage(opts.attacker, amount, -dir, ctx, { source: opts.source });
    }
    return;
  }
  const source = opts.source ?? "ability";
  // Weapon properties apply only to weapon-sourced hits from a live attacker.
  const weaponHit = source === "melee" || source === "ranged" || source === "thrown";
  const prop = (kind: WeaponPropertyKind) =>
    weaponHit && opts.attacker ? weaponPropMag(opts.attacker, kind) : 0;

  const knockbackMul = (opts.knockbackMul ?? 1) + prop("knockback") * 0.06;

  // armorPierce ignores part of the defense (capped at 60%).
  const pierce = Math.min(0.6, prop("armorPierce") * 0.06);
  const effectiveDefense = target.spec.stats.defense * target.buffs.defenseMul * (1 - pierce);

  let dmg = amount * (130 / (130 + effectiveDefense)) * DAMAGE_SCALE;
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
    // stagger property lengthens the lockout (hard-capped for 2P fairness).
    const stun = Math.min(0.45, HITSTUN_BY_SOURCE[source] + prop("stagger") * 0.03);
    target.hitstunTimer = Math.max(target.hitstunTimer, stun);
    // Only a real stagger (melee-tier) interrupts an attack in progress.
    if (stun >= HITSTUN_BY_SOURCE.melee) {
      target.attackAnim = 0;
      target.attackWindow = 0;
    }
  }

  // lifesteal: the attacker drinks a capped share of the damage dealt.
  const lifesteal = Math.min(0.35, prop("lifesteal") * 0.032);
  if (lifesteal > 0 && opts.attacker && opts.attacker.alive) {
    const healed = Math.max(1, Math.round(dmg * lifesteal));
    opts.attacker.hp = Math.min(opts.attacker.maxHp, opts.attacker.hp + healed);
    pushEffect(ctx, {
      kind: "text",
      x: opts.attacker.root.position.x,
      y: opts.attacker.root.position.y - 76,
      ttl: 0.6,
      color: "#8fd18a",
      text: `+${healed}`,
    });
  }

  // bleed / elementalDot: refresh a damage-over-time on the target.
  const bleed = prop("bleed");
  const eDot = prop("elementalDot");
  if ((bleed > 0 || eDot > 0) && target.alive) {
    target.dotTimer = 3;
    target.dotPerSec = (bleed + eDot) * 0.4; // total ≈ 1.2 × magnitude over 3s
    target.dotColor =
      eDot >= bleed && opts.attacker
        ? elementGlow(opts.attacker.style.element, "#e05555")
        : "#e05555";
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
    visual?: ProjectileVisual;
    form?: WeaponForm;
    element?: ElementKind;
    /** Behavior-engine spawn point override (default: the weapon hand). */
    origin?: { x: number; y: number; straightDown?: boolean };
    /** Behavior-engine callback on connect. */
    onHit?: () => void;
    /** Boomerang flight path (returns to the thrower). */
    boomerang?: boolean;
  },
): void {
  // Launch from the weapon hand joint unless the engine placed it elsewhere.
  const hand = owner.skeleton.handR;
  const startX = opts.origin?.x ?? hand.x + owner.facing * 6 * owner.scale;
  const startY = opts.origin?.y ?? hand.y;
  const body = Matter.Bodies.circle(startX, startY, opts.radius, {
    collisionFilter: { group: owner.root.collisionFilter.group }, // never hits its owner
    density: 0.002,
    frictionAir: 0.001,
    restitution: opts.arc ? 0.5 : 0,
    label: `${owner.side}-projectile`,
  });
  const a = opts.angle ?? 0;
  Matter.Body.setVelocity(
    body,
    opts.origin?.straightDown
      ? { x: (Math.random() - 0.5) * 2, y: opts.speed }
      : {
          x: owner.facing * opts.speed * Math.cos(a),
          y: opts.speed * Math.sin(a) + (opts.arc ? -5.5 : 0),
        },
  );
  Matter.Composite.add(ctx.arena.world, body);
  const ttl = opts.arc ? 2.6 : 1.8;
  ctx.projectiles.push({
    body,
    ownerSide: owner.side,
    damage: opts.damage,
    source: opts.source,
    ttl,
    maxTtl: ttl,
    arc: opts.arc,
    homing: opts.homing ?? false,
    color: owner.color,
    glow: opts.glow ?? owner.style.glow,
    radius: opts.radius,
    visual: opts.visual ?? "bolt",
    form: opts.form,
    element: opts.element,
    onHit: opts.onHit,
    boomerang: opts.boomerang,
  });
}

function startAttack(f: Fighter): void {
  const ts = attackSpeedScale(f);
  f.attackCooldown = (isMissile(f) ? MISSILE_ATTACK_COOLDOWN : MELEE_ATTACK_COOLDOWN) * ts;
  f.attackAnim = attackTiming(f).total;
  f.attackWindow = 0;
  f.hasHitThisSwing = false;
  f.projectileFired = false;
  f.weaponAttackFired = false;
}

/**
 * The weapon's world-space segment: from the hand joint out along the
 * animated weapon angle. Reach comes from the BALANCED weapon.range (with a
 * small floor), never from the visual form/size — cosmetics don't change
 * hitboxes.
 */
function weaponSegment(f: Fighter, time = 0): { from: Matter.Vector; to: Matter.Vector } {
  // Attacks originate at the weapon MOUNT (head lasers strike from the head,
  // unarmed strikes from the hand); reach itself is unchanged.
  const hand =
    (f.spec.weapon.mount ?? "hand") === "hand" || f.spec.weapon.mount === "dual"
      ? f.skeleton.handR
      : weaponMountAnchor(f, time);
  // setScale() grows/shrinks reach with the fighter (visual + mechanical).
  const reach =
    (Math.max(28 * f.scale, f.spec.weapon.range * 0.6) + weaponPropMag(f, "reach") * 3) *
    f.displayScale;
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

  // Weapon behavior, LAYERED on the normal swing: fire once as the active
  // frames open. Script first, else the program's onAttack; failures just
  // mean no extra — the plain hit below is untouched.
  if (elapsed >= timing.windup && !f.weaponAttackFired) {
    f.weaponAttackFired = true;
    if (f.spec.weapon.customScript) runWeaponScript(f, ctx);
    if (f.weaponRuntime) dispatchHandler(f.weaponRuntime, ctx, "onAttack");
  }

  if (isMissile(f)) {
    if (elapsed >= timing.windup && !f.projectileFired) {
      f.projectileFired = true;
      const { weapon } = f.spec;
      const form = f.style.weapon.form;
      // Ammo looks like what fired it: arrows from bows, tracers from guns,
      // the spinning weapon itself when thrown, element bolts from casters.
      const visual: ProjectileVisual =
        weapon.type === "thrown"
          ? "thrown"
          : form === "bow"
            ? "arrow"
            : form === "gun" || form === "cannon"
              ? "bullet"
              : "bolt";
      spawnProjectile(f, ctx, {
        damage: weaponHitDamage(f),
        speed: weapon.type === "ranged" ? 13 : 10,
        radius: weapon.type === "ranged" ? 5 : 7,
        arc: weapon.type === "thrown",
        source: weapon.type === "thrown" ? "thrown" : "ranged",
        visual,
        form,
        element: f.style.element,
        origin:
          (f.spec.weapon.mount ?? "hand") !== "hand" && f.spec.weapon.mount !== "dual"
            ? weaponMountAnchor(f, ctx.time)
            : undefined,
        onHit:
          f.weaponRuntime?.program.handlers.onHitTarget && f.weaponRuntime
            ? () => dispatchHandler(f.weaponRuntime!, ctx, "onHitTarget")
            : undefined,
      });
    }
    return;
  }

  // Melee swings also connect with enemy ENTITIES (clones body-block).
  if (f.attackWindow > 0) {
    const seg = weaponSegment(f, ctx.time);
    for (const e of ctx.entities) {
      if (e.side === f.side || e.dead || e.hurtCd > 0) continue;
      if (e.kind !== "clone" && e.kind !== "minion" && e.kind !== "turret") continue;
      const dx = e.x - f.root.position.x;
      const reach = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) + 20;
      if (Math.sign(dx) === f.facing && Math.abs(dx) < reach && Math.abs(e.y - 30 - f.root.position.y) < 70) {
        e.hurtCd = 0.5;
        e.hp -= weaponHitDamage(f);
        pushEffect(ctx, { kind: "spark", x: e.x, y: e.y - 20, ttl: 0.2, color: e.glow, radius: 10 });
        if (e.hp <= 0) e.dead = true;
      }
    }
  }

  // Melee: raycast the weapon segment against the opponent's hurtbox.
  // The cleave property widens the swept arc.
  if (f.attackWindow > 0 && !f.hasHitThisSwing && opponent.alive) {
    const seg = weaponSegment(f, ctx.time);
    const rayWidth = (10 * f.scale + weaponPropMag(f, "cleave") * 2.2) * f.displayScale;
    const hits = Matter.Query.ray([opponent.root], seg.from, seg.to, rayWidth);
    if (hits.length > 0) {
      f.hasHitThisSwing = true;
      const { damage, crit } = rollCrit(f, weaponHitDamage(f));
      dealDamage(opponent, damage, f.facing, ctx, { source: "melee", attacker: f });
      if (f.weaponRuntime) dispatchHandler(f.weaponRuntime, ctx, "onHitTarget");
      if (crit) {
        pushEffect(ctx, {
          kind: "text",
          x: opponent.root.position.x,
          y: opponent.root.position.y - 88,
          ttl: 0.7,
          color: "#ffd75e",
          text: "CRIT!",
        });
      }
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
  f.utilityCooldown = Math.max(0, f.utilityCooldown - dt);
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
 * Behavior-engine transform upkeep: tick the revert timers, apply personal
 * gravity, resolve recall() snap-backs. EVERYTHING auto-reverts on expiry
 * and on death — a behavior can bend the rules, never brick the match.
 */
function tickEngineTransforms(f: Fighter, ctx: CombatCtx, dt: number): void {
  if (!f.alive) {
    // Death clears every transform so the ragdoll behaves normally.
    f.gravityScale = 1;
    f.timeFactor = 1;
    f.displayScale = 1;
    f.phaseTimer = 0;
    f.reflectTimer = 0;
    f.tintTimer = 0;
    f.recallPoint = null;
    if (f.root.timeScale !== 1) f.root.timeScale = 1;
    return;
  }

  const expire = (timer: "gravityTimer" | "timeFactorTimer" | "displayScaleTimer" | "tintTimer") => {
    f[timer] = Math.max(0, f[timer] - dt);
    return f[timer] <= 0;
  };
  if (expire("gravityTimer") && f.gravityScale !== 1) f.gravityScale = 1;
  if (expire("timeFactorTimer") && f.timeFactor !== 1) f.timeFactor = 1;
  if (expire("displayScaleTimer") && f.displayScale !== 1) f.displayScale = 1;
  if (expire("tintTimer")) f.tintColor = null;
  f.phaseTimer = Math.max(0, f.phaseTimer - dt);
  f.reflectTimer = Math.max(0, f.reflectTimer - dt);

  // Matter integrates this body's motion on its own clock.
  if (f.root.timeScale !== f.timeFactor) f.root.timeScale = f.timeFactor;

  // Personal gravity: additive acceleration relative to world gravity.
  if (f.gravityScale !== 1 && !f.ragdoll) {
    const v = f.root.velocity;
    Matter.Body.setVelocity(f.root, {
      x: v.x,
      y: v.y + (f.gravityScale - 1) * 33 * dt,
    });
  }

  // recall(): snap back to the marked point when the timer lands.
  if (f.recallPoint) {
    f.recallTimer -= dt;
    if (f.recallTimer <= 0) {
      pushEffect(ctx, { kind: "spark", x: f.root.position.x, y: f.root.position.y - 20, ttl: 0.3, color: f.style.glow, radius: 16 });
      Matter.Body.setPosition(f.root, { x: f.recallPoint.x, y: f.recallPoint.y });
      Matter.Body.setVelocity(f.root, { x: 0, y: 0 });
      pushEffect(ctx, { kind: "ring", x: f.recallPoint.x, y: f.recallPoint.y - 20, ttl: 0.35, color: f.style.glow, radius: 30 });
      f.recallPoint = null;
    }
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
  // Personal time scale (behavior engine): slows/hastens this fighter's
  // timers, attacks and motion — the opponent ticks at full speed.
  const fdt = dt * f.timeFactor;
  tickTimers(f, fdt);
  tickEngineTransforms(f, ctx, dt);
  if (!f.alive) return; // the KO ragdoll belongs to the physics engine now

  // Damage-over-time (bleed / elemental) — small, steady, can finish a KO.
  if (f.dotTimer > 0) {
    f.dotTimer = Math.max(0, f.dotTimer - dt);
    f.hp -= f.dotPerSec * dt;
    f.dotTickAcc += dt;
    if (f.dotTickAcc >= 0.55) {
      f.dotTickAcc = 0;
      pushEffect(ctx, {
        kind: "spark",
        x: f.root.position.x,
        y: f.root.position.y - 14 * f.scale,
        ttl: 0.25,
        color: f.dotColor,
        radius: 8,
      });
    }
    if (f.hp <= 0) {
      f.hp = 0;
      collapse(f, ctx.arena.world);
      return;
    }
  }

  platformLanding(f, ctx);
  updateGrounded(f, ctx);

  // Fighters always square up to their opponent.
  f.facing = opponent.root.position.x >= f.root.position.x ? 1 : -1;

  const stunned = f.hitstunTimer > 0 || f.launchedTimer > 0;
  const v = f.root.velocity;

  // --- Block + parry input. A press EDGE arms the parry window; holding
  // (past the window) is the guard stance. Guard at 0 = can't block.
  f.parryTimer = Math.max(0, f.parryTimer - dt);
  if (input.block && !f.blockHeld && !stunned && f.introTimer <= 0) {
    f.parryTimer = f.parryWindow;
  }
  f.blockHeld = input.block;
  f.blocking =
    input.block && !stunned && f.introTimer <= 0 && f.attackAnim <= 0 && f.guard > 0;

  // Guard regen: pauses while blocking / shortly after guard activity.
  if (f.blocking) {
    f.guardRegenDelay = Math.max(f.guardRegenDelay, 0.6);
  } else {
    f.guardRegenDelay = Math.max(0, f.guardRegenDelay - dt);
    if (f.guardRegenDelay <= 0 && f.guard < f.guardMax) {
      f.guard = Math.min(f.guardMax, f.guard + (f.guardMax / 2) * dt); // ~2s refill
    }
  }

  if (f.introTimer <= 0 && !stunned) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    // Guard stance: rooted to a slow shuffle, no attacks or casts.
    const speedScale = f.blocking ? 0.25 : 1;
    if (dir !== 0) {
      Matter.Body.setVelocity(f.root, { x: dir * speedOf(f) * f.timeFactor * speedScale, y: v.y });
    } else if (f.grounded) {
      Matter.Body.setVelocity(f.root, { x: v.x * 0.8, y: v.y });
    }

    if (input.jump && f.grounded && f.jumpCooldown <= 0 && !f.blocking) {
      if (input.down && f.onPlatform) {
        // Drop through the one-way platform instead of jumping.
        f.dropThrough = 0.25;
      } else {
        Matter.Body.setVelocity(f.root, { x: v.x, y: -jumpVelOf(f) });
      }
      f.jumpCooldown = 0.3;
    }

    if (input.attack && f.attackCooldown <= 0 && f.attackAnim <= 0 && !f.blocking) startAttack(f);

    if (input.ability && f.abilityCooldown <= 0 && !f.blocking) {
      f.abilityCooldown = f.spec.ability.cooldown;
      useAbility(f, opponent, ctx, f.spec.ability);
    }

    if (input.utility && f.utilityCooldown <= 0 && f.spec.utility && !f.blocking) {
      f.utilityCooldown = f.spec.utility.cooldown;
      useAbility(f, opponent, ctx, f.spec.utility);
    }
  } else {
    f.blocking = false;
    if (stunned && f.grounded) {
      // Staggered: skid to a stop, no control.
      Matter.Body.setVelocity(f.root, { x: v.x * 0.85, y: v.y });
    }
  }

  progressAttack(f, opponent, ctx);

  // Pose the skeleton — the single source of truth for how this looks.
  // attackSpeed scales real time; the animator gets NORMALIZED elapsed so
  // its (unscaled) phase table plays the same swing, just faster.
  const timing = attackTiming(f);
  const ts = attackSpeedScale(f);
  const frame = f.animator.update(dt, {
    rootX: f.root.position.x,
    rootY: f.root.position.y,
    vx: f.root.velocity.x,
    vy: f.root.velocity.y,
    grounded: f.grounded,
    facing: f.facing,
    moving: Math.abs(f.root.velocity.x) > 0.6 && f.grounded,
    blocking: f.blocking,
    alive: f.alive,
    attackElapsed: f.attackAnim > 0 ? (timing.total - f.attackAnim) / ts : -1,
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
    p.rehit = Math.max(0, (p.rehit ?? 0) - dt);

    // Boomerang: fly out, then arc back toward the thrower; despawn on
    // return. Can clip the target on both passes (rehit debounce).
    if (p.boomerang) {
      const owner = p.ownerSide === "player" ? fighters.player : fighters.bot;
      const age = p.maxTtl - p.ttl;
      if (!p.returning && age > p.maxTtl * 0.4) p.returning = true;
      if (p.returning) {
        const dx = owner.root.position.x - p.body.position.x;
        const dy = owner.root.position.y - 20 - p.body.position.y;
        const d = Math.hypot(dx, dy) || 1;
        Matter.Body.setVelocity(p.body, { x: (dx / d) * 15, y: (dy / d) * 15 });
        if (d < 26) {
          Matter.Composite.remove(arena.world, p.body);
          ctx.projectiles.splice(i, 1);
          continue;
        }
      }
    }

    // Enemy entities body-block projectiles (clones/minions/turrets).
    let blocked = false;
    for (const e of ctx.entities) {
      if (e.side === p.ownerSide || e.dead) continue;
      if (e.kind !== "clone" && e.kind !== "minion" && e.kind !== "turret") continue;
      if (Math.hypot(e.x - p.body.position.x, e.y - 26 - p.body.position.y) < p.radius + 20) {
        e.hp -= p.damage;
        if (e.hp <= 0) e.dead = true;
        pushEffect(ctx, { kind: "spark", x: e.x, y: e.y - 24, ttl: 0.25, color: e.glow, radius: 12 });
        blocked = true;
        break;
      }
    }
    if (blocked && !p.boomerang) {
      Matter.Composite.remove(arena.world, p.body);
      ctx.projectiles.splice(i, 1);
      continue;
    }

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
      target.alive &&
      (p.rehit ?? 0) <= 0 &&
      Matter.Query.collides(p.body, [target.root]).length > 0;
    const hitGround = Matter.Query.collides(p.body, [arena.ground]).length > 0;
    const out =
      p.ttl <= 0 ||
      p.body.position.x < -60 ||
      p.body.position.x > arena.width + 60;

    // reflect(): the parry window flips the projectile back at its owner.
    if (hit && target.reflectTimer > 0) {
      const v = p.body.velocity;
      p.ownerSide = p.ownerSide === "player" ? "bot" : "player";
      Matter.Body.setVelocity(p.body, { x: -v.x * 1.15, y: -v.y * 0.6 });
      p.ttl = Math.max(p.ttl, 1.2);
      p.rehit = 0.3;
      pushEffect(ctx, { kind: "ring", x: p.body.position.x, y: p.body.position.y, ttl: 0.25, color: "#ffd75e", radius: 18 });
      continue;
    }

    if (hit) {
      const attacker = p.ownerSide === "player" ? fighters.player : fighters.bot;
      const weaponShot = p.source === "ranged" || p.source === "thrown";
      const { damage, crit } = weaponShot
        ? rollCrit(attacker, p.damage)
        : { damage: p.damage, crit: false };
      dealDamage(target, damage, Math.sign(p.body.velocity.x) || 1, ctx, {
        source: p.source,
        attacker: weaponShot ? attacker : undefined,
      });
      if (crit) {
        pushEffect(ctx, {
          kind: "text",
          x: target.root.position.x,
          y: target.root.position.y - 88,
          ttl: 0.7,
          color: "#ffd75e",
          text: "CRIT!",
        });
      }
      pushEffect(ctx, {
        kind: "ring",
        x: p.body.position.x,
        y: p.body.position.y,
        ttl: 0.3,
        color: p.glow,
        radius: p.radius * 4,
      });
      // Behavior-engine hook: this projectile came from a program.
      try {
        p.onHit?.();
      } catch (err) {
        console.warn("[vibearena] projectile onHit behavior failed:", err);
      }
      // Boomerangs pierce: damage, keep flying, debounce re-hits.
      if (p.boomerang) {
        p.rehit = 0.45;
        continue;
      }
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
    // Behavior-drawn particles fly on their own physics.
    if (e.kind === "particle") {
      e.vy = (e.vy ?? 0) + (e.gravity ?? 0) * dt;
      e.x += (e.vx ?? 0) * dt;
      e.y += (e.vy ?? 0) * dt;
    }
    if (e.ttl <= 0) ctx.effects.splice(i, 1);
  }
}

/** Ties (double KO) go to the player — they earned the chaos. */
export function checkWinner(player: Fighter, bot: Fighter): Side | null {
  if (!bot.alive) return "player";
  if (!player.alive) return "bot";
  return null;
}
