import Matter from "matter-js";
import type { ElementKind } from "../../types/character";
import { ABILITY_MOTIFS, ELEMENTS } from "../../types/character";
import type { Fighter } from "../stickman";
import { createFighter, renderFighter } from "../stickman";
import { createBotBrain, type BotBrain } from "../bot";
import type { CombatCtx } from "../combat";
import { dealDamage, pushEffect, rawDamage, spawnProjectile } from "../combat";
import { attackTimingOf } from "../animation";
import { blinkJuice, dashJuice, leapJuice } from "../movementFx";
import {
  aoeDetonation,
  beamCore,
  chargeUp,
  fieldTint,
  groundDecal,
  impactSparks,
  materialize,
  particleBurst,
  shake,
  shockwaveRing,
  vortex,
} from "../effectsJuice";
import { playSfx, SFX_KINDS, type SfxKind } from "../../audio/sfx";
import { ARENA_HEIGHT, ARENA_WIDTH } from "../arena";
import { mix, withAlpha } from "../../render/color";
import {
  dispatchBehaviorHit,
  equipWeaponRender,
  resolveValue,
  type BehaviorRuntime,
} from "./interpreter";

/**
 * EngineApi — the frozen whitelist of verbs a behavior program may call.
 * Every verb is coded, clamps its arguments to finite anti-crash ranges,
 * and is bound to the casting fighter + combat context. No power budgets
 * by design: a wild ability is welcome, a crashing one is not.
 */

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

// Anti-crash argument ceilings (deliberately generous — NOT balance).
const MAX_DAMAGE_PER_ACTION = 300;
const MAX_HEAL_PER_ACTION = 200;
const MAX_SPEED = 44;
const MAX_ENTITY_TTL = 15;

export type EntityKind =
  | "clone" | "minion" | "trap" | "turret" | "wall" | "orbital"
  | "hazard" | "beam";
const ENTITY_KINDS: EntityKind[] = ["clone", "minion", "trap", "turret", "wall", "orbital"];

export type HazardKind = "fire" | "ice" | "spikes" | "void";

/** Clone-specific caps (Kal's ask): helper bots, never an army. */
const CLONE_MAX_ALIVE = 2;
const CLONE_MAX_TTL = 6;
const CLONE_HP_FRACTION = 0.22;
const CLONE_DAMAGE_FRACTION = 0.35;

export interface EngineEntity {
  kind: EntityKind;
  side: Fighter["side"];
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  ttl: number;
  maxTtl: number;
  radius: number;
  color: string;
  glow: string;
  facing: 1 | -1;
  groundY: number;
  /** turret fire / contact-damage debounce. */
  fireTimer: number;
  /** incoming-damage debounce (melee swings hit entities). */
  hurtCd: number;
  /** orbital phase. */
  angle: number;
  /** wall: the static Matter body blocking movement. */
  wallBody?: Matter.Body;
  /** hazard: which ground zone effect. */
  hazardKind?: HazardKind;
  /** beam: sustained laser — direction (rad), length, damage/s. */
  beam?: { dir: number; length: number; dps: number; tickAcc: number };
  /** clone: bot brain + a REAL ghost Fighter rendered through the unified
   * fighter pipeline (animated, mount- and renderProgram-aware). */
  clone?: {
    brain: BotBrain;
    attackCd: number;
    /** Remaining attack animation (counts down from attackTotal). */
    attackAnim: number;
    attackTotal: number;
    fighter: Fighter;
  };
  /** Owning behavior — entity hits dispatch its onHit handler. */
  rt: BehaviorRuntime;
  dead: boolean;
}

const foeOf = (side: Fighter["side"], ctx: CombatCtx): Fighter =>
  side === "player" ? ctx.fighters.bot : ctx.fighters.player;

/** playSound verb: per-fighter retrigger throttle (anti audio spam). */
const lastVerbSound = new WeakMap<Fighter, number>();

/** Verbs may return a value (dealAoe/dealMelee report whether they hit). */
export type EngineApi = Record<string, (a: Record<string, unknown>) => unknown>;

export function createEngineApi(rt: BehaviorRuntime, ctx: CombatCtx): EngineApi {
  const caster = rt.caster;
  const foe = () => foeOf(caster.side, ctx);
  /** Resolve + clamp a numeric arg. */
  const N = (v: unknown, dflt: number, min: number, max: number) =>
    clamp(resolveValue(rt, ctx, v, dflt), min, max);
  // Render runtimes anchor draw-verb defaults to the weapon mount.
  const pos = () => rt.anchor?.() ?? caster.root.position;
  const setVel = (f: Fighter, vx: number, vy: number) =>
    Matter.Body.setVelocity(f.root, {
      x: clamp(vx, -MAX_SPEED, MAX_SPEED),
      y: clamp(vy, -MAX_SPEED, MAX_SPEED),
    });
  const element = (v: unknown): ElementKind =>
    typeof v === "string" && (ELEMENTS as readonly string[]).includes(v)
      ? (v as ElementKind)
      : rt.element;

  /** LLM-supplied CSS color (length-capped) or the fallback. */
  const colorOf = (v: unknown, dflt: string) =>
    typeof v === "string" && v.length > 0 && v.length <= 32 ? v : dflt;
  /** Anti-softlock duration clamp — nothing the engine sets is permanent. */
  const dur = (v: unknown, dflt: number, max = 4) => N(v, dflt, 0.05, max);
  /** target: "self" (default) | "opponent" | "all". */
  const targetsOf = (v: unknown): Fighter[] =>
    v === "opponent" ? [foe()] : v === "all" ? [caster, foe()] : [caster];

  const api: EngineApi = {
    // ----- movement -------------------------------------------------------
    /** leap {up?, forward?} — vertical spring with optional forward carry.
     * Strong forward carry makes it a LUNGE: gap-closer poke on the way. */
    leap(a) {
      const forward = N(a.forward, 4, -30, 30);
      setVel(caster, caster.facing * forward, -N(a.up, 15, 0, 34));
      leapJuice(caster, ctx, rt.glow, Math.abs(forward) >= 8);
    },
    /** dash {speed?, up?, iframes?} — snappy horizontal burst along facing.
     * Dodges by default (brief i-frames) and pokes what it passes through. */
    dash(a) {
      setVel(caster, caster.facing * N(a.speed, 21, -34, 34), -N(a.up, 2, -10, 20));
      caster.invulnTimer = Math.max(caster.invulnTimer, N(a.iframes, 0.15, 0, 0.5));
      dashJuice(caster, ctx, rt.glow);
    },
    /** blink / teleport {x?, y?, dx?, dy?, behindOpponent?} — with no
     * positional args it repositions USEFULLY: just behind the opponent. */
    teleport(a) {
      const p = pos();
      const f = foe();
      const from = { x: caster.root.position.x, y: caster.root.position.y };
      let x = p.x;
      let y = p.y;
      if (a.x !== undefined || a.y !== undefined) {
        x = N(a.x, p.x, 30, ARENA_WIDTH - 30);
        y = N(a.y, p.y, 40, ARENA_HEIGHT - 60);
      } else if (!a.behindOpponent && (a.dx !== undefined || a.dy !== undefined)) {
        x = p.x + N(a.dx, 0, -300, 300);
        y = p.y + N(a.dy, 0, -300, 300);
      } else {
        // behindOpponent, or the bare default: land just behind the foe.
        x = f.root.position.x - f.facing * 46;
        y = f.root.position.y;
      }
      Matter.Body.setPosition(caster.root, {
        x: clamp(x, 30, ARENA_WIDTH - 30),
        y: clamp(y, 40, ARENA_HEIGHT - 60),
      });
      Matter.Body.setVelocity(caster.root, { x: 0, y: 0 });
      blinkJuice(caster, ctx, from, caster.root.position, rt.glow);
    },
    applyForce(a) {
      const v = caster.root.velocity;
      setVel(caster, v.x + N(a.fx, 0, -30, 30), v.y + N(a.fy, 0, -30, 30));
    },
    setVelocity(a) {
      setVel(caster, N(a.vx, 0, -MAX_SPEED, MAX_SPEED), N(a.vy, 0, -MAX_SPEED, MAX_SPEED));
    },

    // ----- spawn ----------------------------------------------------------
    /**
     * spawnProjectile {damage?, speed?, angle?, count?, spread?, homing?,
     * element?, radius?, arc?, fromAbove?} — fromAbove rains from the sky
     * over the opponent (meteors); otherwise fires from the caster's hand.
     */
    spawnProjectile(a) {
      const count = Math.round(N(a.count, 1, 1, 8));
      const spread = N(a.spread, 0, 0, 1);
      for (let i = 0; i < count; i++) {
        if (--rt.projectileBudget <= 0) return;
        const fan = count > 1 ? (i / (count - 1) - 0.5) * spread : 0;
        const fromAbove = Boolean(a.fromAbove);
        const fx = foe().root.position.x;
        spawnProjectile(caster, ctx, {
          damage: N(a.damage, 10, 0, MAX_DAMAGE_PER_ACTION),
          speed: N(a.speed, 12, 2, 30),
          radius: N(a.radius, 5, 2, 14),
          arc: Boolean(a.arc),
          source: "ability",
          angle: N(a.angle, 0, -Math.PI, Math.PI) + fan,
          homing: Boolean(a.homing),
          element: element(a.element),
          visual: "bolt",
          glow: rt.glow,
          origin: fromAbove
            ? { x: fx + (Math.random() - 0.5) * 140, y: 30 + Math.random() * 30, straightDown: true }
            : undefined,
          onHit: rt.program.handlers.onHit ? () => dispatchBehaviorHit(rt, ctx) : undefined,
        });
      }
    },
    /** spawnEntity {kind, hp?, ttl?, x?, y?, damage?, count?} */
    spawnEntity(a) {
      const kind =
        typeof a.kind === "string" && (ENTITY_KINDS as string[]).includes(a.kind)
          ? (a.kind as EntityKind)
          : "clone";
      const count = Math.round(N(a.count, 1, 1, 4));
      for (let i = 0; i < count; i++) {
        if (--rt.entityBudget <= 0) return;
        spawnEntityImpl(rt, ctx, kind, a, i);
      }
    },
    /** spawnEffect {motif?, element?, radius?, x?, y?} — legacy ability VFX. */
    spawnEffect(a) {
      const motif =
        typeof a.motif === "string" && (ABILITY_MOTIFS as readonly string[]).includes(a.motif)
          ? (a.motif as (typeof ABILITY_MOTIFS)[number])
          : rt.motif;
      pushEffect(ctx, {
        kind: "motif",
        x: N(a.x, pos().x, 0, ARENA_WIDTH),
        y: N(a.y, pos().y - 20, 0, ARENA_HEIGHT),
        ttl: N(a.ttl, 0.55, 0.1, 2),
        color: rt.glow,
        motif,
        element: element(a.element),
        radius: N(a.radius, 60, 12, 240),
        dir: caster.facing,
      });
    },

    // ----- combat ---------------------------------------------------------
    /** dealAoe {damage?, radius?, x?, y?, knockback?, color?, particles?} */
    dealAoe(a) {
      const x = N(a.x, pos().x, 0, ARENA_WIDTH);
      const y = N(a.y, pos().y, 0, ARENA_HEIGHT);
      const radius = N(a.radius, 60, 12, 260);
      const damage = N(a.damage, 14, 0, MAX_DAMAGE_PER_ACTION);
      const col = colorOf(a.color, rt.glow);
      aoeDetonation(ctx, x, y, radius, col, ctx.arena.groundY, rt.element);
      pushEffect(ctx, {
        kind: "motif", x, y, ttl: 0.5, color: col,
        motif: rt.motif, element: rt.element, radius, dir: caster.facing,
      });
      if (a.particles !== undefined) {
        api.spawnParticles({ x, y: y - 6, count: a.particles, color: col, speed: radius * 1.6, gravity: 160 });
      }
      const f = foe();
      const d = Math.hypot(f.root.position.x - x, f.root.position.y - y);
      if (d < radius + 16 && f.alive) {
        dealDamage(f, damage, Math.sign(f.root.position.x - x) || caster.facing, ctx, {
          source: "ability",
          knockbackMul: N(a.knockback, 1, 0, 3),
          attacker: caster,
        });
        if (rt.program.handlers.onHit) dispatchBehaviorHit(rt, ctx);
        return true;
      }
      return false;
    },
    /** dealMelee {damage?, range?} — a coded strike in front of the caster. */
    dealMelee(a) {
      const f = foe();
      const dx = (f.root.position.x - pos().x) * caster.facing / caster.displayScale;
      const dy = Math.abs(f.root.position.y - pos().y);
      pushEffect(ctx, {
        kind: "spark",
        x: pos().x + caster.facing * 34,
        y: pos().y - 16,
        ttl: 0.2,
        color: rt.glow,
        radius: 12,
      });
      if (dx > -10 && dx < N(a.range, 55, 10, 150) && dy < 70 && f.alive) {
        dealDamage(f, N(a.damage, 12, 0, MAX_DAMAGE_PER_ACTION), caster.facing, ctx, { source: "ability", attacker: caster });
        if (rt.program.handlers.onHit) dispatchBehaviorHit(rt, ctx);
        return true;
      }
      return false;
    },
    heal(a) {
      const amount = Math.round(N(a.amount, 12, 0, MAX_HEAL_PER_ACTION));
      caster.hp = Math.min(caster.maxHp, caster.hp + amount);
      pushEffect(ctx, { kind: "text", x: pos().x, y: pos().y - 76, ttl: 0.6, color: "#8fd18a", text: `+${amount}` });
    },
    shield(a) {
      caster.shieldTimer = Math.max(caster.shieldTimer, N(a.duration, 2, 0.2, 8));
      caster.shieldCoverage = N(a.coverage, 0.6, 0, 0.95);
    },
    /** applyStatus {type: "burn"|"stun"|"slow"|"weaken", ...} on the opponent. */
    applyStatus(a) {
      const f = foe();
      switch (a.type) {
        case "burn":
          f.dotTimer = Math.max(f.dotTimer, N(a.duration, 2.5, 0.2, 8));
          f.dotPerSec = N(a.dps, 4, 0, 40);
          f.dotColor = rt.glow;
          break;
        case "stun":
          f.hitstunTimer = Math.max(f.hitstunTimer, N(a.duration, 0.4, 0, 1.2));
          break;
        case "slow":
          f.buffs.speedMul = N(a.factor, 0.6, 0.2, 1);
          f.buffTimer = Math.max(f.buffTimer, N(a.duration, 2.5, 0.2, 8));
          break;
        case "weaken":
          f.buffs.strengthMul = N(a.factor, 0.7, 0.2, 1);
          f.buffTimer = Math.max(f.buffTimer, N(a.duration, 2.5, 0.2, 8));
          break;
        default:
          break;
      }
    },
    knockback(a) {
      const f = foe();
      const dir = Math.sign(f.root.position.x - pos().x) || caster.facing;
      setVel(f, dir * N(a.strength, 12, 0, 36), -N(a.up, 5, 0, 22));
    },
    pull(a) {
      const f = foe();
      const dir = Math.sign(pos().x - f.root.position.x) || -caster.facing;
      setVel(f, dir * N(a.strength, 12, 0, 36), -N(a.up, 3, 0, 16));
      vortex(ctx, f.root.position.x, f.root.position.y - 20, { color: rt.glow, dir: 1 });
    },
    /** lifesteal {damage?, percent?} — drain: hurt the foe, drink a share. */
    lifesteal(a) {
      const f = foe();
      const damage = N(a.damage, 8, 0, 120);
      if (!f.alive) return;
      dealDamage(f, damage, caster.facing, ctx, { source: "ability", attacker: caster });
      const healed = Math.max(1, Math.round(damage * N(a.percent, 0.5, 0, 1)));
      caster.hp = Math.min(caster.maxHp, caster.hp + healed);
      pushEffect(ctx, { kind: "text", x: pos().x, y: pos().y - 76, ttl: 0.6, color: "#8fd18a", text: `+${healed}` });
    },

    // ----- draw -----------------------------------------------------------
    /** draw {shape: "circle"|"line", x?, y?, x2?, y2?, radius?, ttl?} */
    draw(a) {
      pushEffect(ctx, {
        kind: "shape",
        shape: a.shape === "line" ? "line" : "circle",
        x: N(a.x, pos().x, -100, ARENA_WIDTH + 100),
        y: N(a.y, pos().y, -100, ARENA_HEIGHT + 100),
        x2: N(a.x2, pos().x + caster.facing * 60, -100, ARENA_WIDTH + 100),
        y2: N(a.y2, pos().y, -100, ARENA_HEIGHT + 100),
        radius: N(a.radius, 20, 1, 240),
        ttl: N(a.ttl, 0.4, 0.05, 3),
        color: rt.glow,
      });
    },
    // ----- movement & space (expansion) ------------------------------------
    /** setGravity {target?, scale?(-2..3, negative floats), duration?} */
    setGravity(a) {
      for (const t of targetsOf(a.target)) {
        t.gravityScale = N(a.scale, 0.4, -2, 3);
        t.gravityTimer = dur(a.duration, 2);
        const up = t.gravityScale < 1;
        particleBurst(ctx, t.root.position.x, t.root.position.y - 20, {
          count: 8, color: rt.glow, speed: 150, spread: 0.8,
          baseAngle: up ? -Math.PI / 2 : Math.PI / 2, gravity: 0, shape: "spark", ttl: 0.4,
        });
      }
      fieldTint(ctx, rt.glow, 0.25);
    },
    /** launch {target?, power?} — pop airborne (combo starter). */
    launch(a) {
      for (const t of targetsOf(a.target ?? "opponent")) {
        Matter.Body.setVelocity(t.root, {
          x: t.root.velocity.x,
          y: -N(a.power, 14, 4, 30),
        });
        if (t !== caster) t.launchedTimer = Math.max(t.launchedTimer, 0.35);
        const tx = t.root.position.x;
        const ty = t.root.position.y;
        shockwaveRing(ctx, tx, ty + 26, { color: rt.glow, radius: 14, expand: 120, thickness: 3, ttl: 0.3 });
        particleBurst(ctx, tx, ty + 20, { count: 8, color: rt.glow, speed: 210, spread: 1.1, baseAngle: -Math.PI / 2, gravity: 140, ttl: 0.4 });
        for (let sl = -1; sl <= 1; sl++) {
          pushEffect(ctx, { kind: "shape", shape: "line", x: tx + sl * 12, y: ty + 30, x2: tx + sl * 12, y2: ty - 20, color: rt.glow, width: 1.5, ttl: 0.2 });
        }
      }
    },
    /** teleportBehind {} — blink directly behind the opponent. */
    teleportBehind() {
      api.teleport({ behindOpponent: true });
    },
    /** pushRadial {x?, y?, radius?, force?} — shockwave push outward. */
    pushRadial(a) {
      const x = N(a.x, pos().x, 0, ARENA_WIDTH);
      const y = N(a.y, pos().y, 0, ARENA_HEIGHT);
      const radius = N(a.radius, 120, 20, 320);
      const force = N(a.force, 14, 0, 34);
      shockwaveRing(ctx, x, y, { color: colorOf(a.color, rt.glow), radius: 12, expand: radius * 1.8, thickness: 4.5, ttl: 0.35 });
      particleBurst(ctx, x, y, { count: 10, color: colorOf(a.color, rt.glow), speed: radius * 1.8, gravity: 120, ttl: 0.4 });
      shake(ctx, 3.5, 0.15);
      const f = foe();
      const dx = f.root.position.x - x;
      const dy = f.root.position.y - y;
      const d = Math.hypot(dx, dy);
      if (d < radius && f.alive) {
        Matter.Body.setVelocity(f.root, {
          x: (dx / (d || 1)) * force,
          y: Math.min(-3, (dy / (d || 1)) * force),
        });
      }
    },

    // ----- time & rewind ---------------------------------------------------
    /** setTimeScale {target?, scale?(0.2..3), duration?} — slow-mo / haste. */
    setTimeScale(a) {
      for (const t of targetsOf(a.target)) {
        t.timeFactor = N(a.scale, 0.5, 0.2, 3);
        t.timeFactorTimer = dur(a.duration, 1.5);
        shockwaveRing(ctx, t.root.position.x, t.root.position.y - 20, { color: "#cfd8dc", radius: 20, expand: 90, thickness: 2, ttl: 0.5 });
      }
      fieldTint(ctx, "#aebcc4", 0.3);
    },
    /** recall {seconds?} — mark this spot now, snap back after `seconds`. */
    recall(a) {
      caster.recallPoint = { x: pos().x, y: pos().y };
      caster.recallTimer = dur(a.seconds ?? a.t, 1.5);
      pushEffect(ctx, { kind: "ring", x: pos().x, y: pos().y - 20, ttl: caster.recallTimer, color: withAlpha(rt.glow, 0.5), radius: 24, expand: 0, width: 2 });
    },

    // ----- transform ---------------------------------------------------------
    /** setScale {target?, factor?(0.4..2.5), duration?} — grow/shrink. */
    setScale(a) {
      for (const t of targetsOf(a.target)) {
        t.displayScale = N(a.factor, 1.6, 0.4, 2.5);
        t.displayScaleTimer = dur(a.duration, 3);
        const grow = t.displayScale > 1;
        shockwaveRing(ctx, t.root.position.x, t.root.position.y, { color: rt.glow, radius: grow ? 12 : 46, expand: grow ? 200 : -80, thickness: 3.5, ttl: 0.35 });
        particleBurst(ctx, t.root.position.x, t.root.position.y - 16, { count: 10, color: rt.glow, speed: grow ? 200 : 90, gravity: grow ? 120 : -60, ttl: 0.4 });
      }
    },
    /** phase {target?, duration?} — intangible ghost (dodge). */
    phase(a) {
      for (const t of targetsOf(a.target)) {
        t.phaseTimer = Math.max(t.phaseTimer, dur(a.duration, 0.8, 1.5));
        materialize(ctx, t.root.position.x, t.root.position.y - 20, { color: "#cfd6ff" });
      }
    },
    /** reflect {duration?} — parry window: projectiles + damage bounce back. */
    reflect(a) {
      caster.reflectTimer = Math.max(caster.reflectTimer, dur(a.duration, 1, 2));
      shockwaveRing(ctx, pos().x, pos().y - 20, { color: "#ffffff", radius: 30, expand: 24, thickness: 2, ttl: 0.4 });
      shockwaveRing(ctx, pos().x, pos().y - 20, { color: "#ffd75e", radius: 24, expand: 30, thickness: 2.5, ttl: 0.4 });
      impactSparks(ctx, pos().x, pos().y - 40, { color: "#ffd75e", count: 4 });
    },
    /** tint {target?, color?, duration?} — recolor a fighter. */
    tint(a) {
      for (const t of targetsOf(a.target)) {
        t.tintColor = colorOf(a.color, rt.glow);
        t.tintTimer = dur(a.duration, 2);
        shockwaveRing(ctx, t.root.position.x, t.root.position.y - 20, { color: t.tintColor, radius: 16, expand: 110, thickness: 3, ttl: 0.3 });
      }
    },

    // ----- offense (expansion) ----------------------------------------------
    /** beam {dir?(-0.6..0.6 rad), length?, damage?(per second), duration?, color?} */
    beam(a) {
      if (--rt.entityBudget <= 0) return;
      chargeUp(ctx, pos().x, pos().y - 14, { color: colorOf(a.color, rt.glow), count: 10, radius: 42, ttl: 0.18 });
      playSfx("zap", { pitch: 0.9, volume: 0.6, element: rt.element });
      pushEntity(ctx, {
        ...baseEntity(rt, ctx, "beam"),
        x: pos().x,
        y: pos().y - 14,
        ttl: dur(a.duration, 1.2, 2.5),
        maxTtl: dur(a.duration, 1.2, 2.5),
        glow: colorOf(a.color, rt.glow),
        beam: {
          dir: N(a.dir, 0, -0.6, 0.6),
          length: N(a.length, 260, 60, 420),
          dps: N(a.damage, 24, 0, 120),
          tickAcc: 0,
        },
      });
    },
    /** spawnHazard {kind:"fire"|"ice"|"spikes"|"void", x?, radius?, ttl?, color?} */
    spawnHazard(a) {
      if (--rt.entityBudget <= 0) return;
      const kind: HazardKind =
        a.kind === "ice" || a.kind === "spikes" || a.kind === "void" ? a.kind : "fire";
      const hazardGlow: Record<HazardKind, string> = {
        fire: "#ff9a3c", ice: "#7cd7ff", spikes: "#c9ced9", void: "#9257e8",
      };
      const hx = N(a.x, pos().x + caster.facing * 90, 30, ARENA_WIDTH - 30);
      const hr = N(a.radius, 44, 20, 90);
      const hglow = colorOf(a.color, hazardGlow[kind]);
      pushEntity(ctx, {
        ...baseEntity(rt, ctx, "hazard"),
        x: hx,
        y: ctx.arena.groundY - 2,
        radius: hr,
        ttl: dur(a.ttl, 4, 8),
        maxTtl: dur(a.ttl, 4, 8),
        glow: hglow,
        hazardKind: kind,
      });
      // Kind-distinct arrival: decal + burst + sound.
      const gy = ctx.arena.groundY;
      if (kind === "fire") {
        groundDecal(ctx, hx, gy, { kind: "scorch", radius: hr * 0.9, ttl: 3 });
        particleBurst(ctx, hx, gy - 6, { count: 10, color: hglow, speed: 130, spread: 1.6, gravity: -60, ttl: 0.6 });
        playSfx("explosion", { pitch: 1.2, volume: 0.45, element: "fire" });
      } else if (kind === "ice") {
        groundDecal(ctx, hx, gy, { kind: "frost", radius: hr * 0.9, ttl: 3 });
        particleBurst(ctx, hx, gy - 8, { count: 8, color: hglow, speed: 90, gravity: 60, shape: "star", ttl: 0.7 });
        playSfx("cast", { pitch: 1.4, volume: 0.5, element: "ice" });
      } else if (kind === "spikes") {
        groundDecal(ctx, hx, gy, { kind: "crack", radius: hr * 0.8, ttl: 3 });
        particleBurst(ctx, hx, gy - 4, { count: 9, color: hglow, speed: 180, spread: 1.2, gravity: 380, shape: "square", ttl: 0.4 });
        playSfx("hitHeavy", { pitch: 1.1, volume: 0.4 });
        shake(ctx, 3, 0.15);
      } else {
        vortex(ctx, hx, gy - 16, { color: hglow, radius: hr, dir: 1, count: 10 });
        fieldTint(ctx, "#2a1840", 0.3);
        playSfx("zap", { pitch: 0.6, volume: 0.45, element: "shadow" });
      }
    },
    /** boomerang {damage?, range?, color?} — flies out, then comes back. */
    boomerang(a) {
      if (--rt.projectileBudget <= 0) return;
      const range = N(a.range, 240, 80, 420);
      spawnProjectile(caster, ctx, {
        damage: N(a.damage, 12, 0, MAX_DAMAGE_PER_ACTION),
        speed: 13,
        radius: 7,
        arc: false,
        source: "ability",
        visual: "thrown",
        form: caster.style.weapon.form,
        element: element(a.element),
        glow: colorOf(a.color, rt.glow),
        boomerang: true,
        onHit: rt.program.handlers.onHit ? () => dispatchBehaviorHit(rt, ctx) : undefined,
      });
      // Range → how long the outbound leg lasts (turnaround at 40% of ttl).
      const p = ctx.projectiles[ctx.projectiles.length - 1];
      if (p?.boomerang) {
        p.ttl = Math.min(4, (range / 13 / 60) * 2.6 + 1);
        p.maxTtl = p.ttl;
      }
    },

    // ----- juice -------------------------------------------------------------
    /** screenShake {intensity?, duration?} */
    screenShake(a) {
      ctx.shakeAmp = N(a.intensity, 7, 1, 14);
      ctx.shakeTimer = Math.max(ctx.shakeTimer, dur(a.duration, 0.25, 0.6));
    },
    /** flash {color?, duration?} — brief screen tint. */
    flash(a) {
      ctx.flashColor = colorOf(a.color, "#ffffff");
      ctx.flashMax = dur(a.duration, 0.15, 0.4);
      ctx.flashTimer = ctx.flashMax;
    },
    /** playSound {kind, pitch?, volume?, element?} — procedural SFX. Per-
     * fighter throttled so behaviors can't machine-gun the mixer (the sfx
     * engine adds its own voice cap + per-kind throttle on top). */
    playSound(a) {
      const now = performance.now();
      if (now - (lastVerbSound.get(caster) ?? -1e9) < 90) return;
      lastVerbSound.set(caster, now);
      const kind =
        typeof a.kind === "string" && (SFX_KINDS as string[]).includes(a.kind)
          ? (a.kind as SfxKind)
          : "cast";
      playSfx(kind, {
        pitch: N(a.pitch, 1, 0.5, 2),
        volume: N(a.volume, 1, 0, 1),
        element: element(a.element),
      });
    },
    /** spawnText {text, x?, y?, color?} — floating words ("BONK!"). */
    spawnText(a) {
      pushEffect(ctx, {
        kind: "text",
        x: N(a.x, pos().x, 0, ARENA_WIDTH),
        y: N(a.y, pos().y - 80, 0, ARENA_HEIGHT),
        ttl: 0.9,
        color: colorOf(a.color, rt.glow),
        text: String(a.text ?? "!").slice(0, 24).toUpperCase(),
      });
    },

    // ----- expressive drawing (design your own look) -------------------------
    /** spawnParticles {x?,y?,count?,color?,size?,spread?,speed?,gravity?,lifetime?,shape?} */
    spawnParticles(a) {
      const count = Math.round(N(a.count, 8, 1, 24));
      const spread = N(a.spread, Math.PI * 2, 0.1, Math.PI * 2);
      const speed = N(a.speed, 80, 0, 400);
      const baseAngle = N(a.angle, -Math.PI / 2, -Math.PI, Math.PI);
      const shape =
        a.shape === "square" || a.shape === "spark" || a.shape === "star" ? a.shape : "circle";
      for (let i = 0; i < count; i++) {
        const ang = baseAngle + (Math.random() - 0.5) * spread;
        const v = speed * (0.5 + Math.random() * 0.5);
        pushEffect(ctx, {
          kind: "particle",
          x: N(a.x, pos().x, -100, ARENA_WIDTH + 100),
          y: N(a.y, pos().y - 20, -100, ARENA_HEIGHT + 100),
          ttl: dur(a.lifetime, 0.7, 2.5),
          color: colorOf(a.color, rt.glow),
          vx: Math.cos(ang) * v,
          vy: Math.sin(ang) * v,
          gravity: N(a.gravity, 0, -400, 600),
          size: N(a.size, 4, 1, 14),
          particleShape: shape,
        });
      }
    },
    /** drawRing {x?,y?,radius?,expand?(px/s),color?,thickness?,ttl?} */
    drawRing(a) {
      pushEffect(ctx, {
        kind: "ring",
        x: N(a.x, pos().x, -100, ARENA_WIDTH + 100),
        y: N(a.y, pos().y - 20, -100, ARENA_HEIGHT + 100),
        ttl: dur(a.ttl, 0.5, 2),
        color: colorOf(a.color, rt.glow),
        radius: N(a.radius, 30, 2, 300),
        expand: N(a.expand, 120, -300, 600),
        width: N(a.thickness, 3, 1, 12),
      });
    },
    /** drawLine {x,y,x2,y2,color?,width?,ttl?} */
    drawLine(a) {
      pushEffect(ctx, {
        kind: "shape",
        shape: "line",
        x: N(a.x, pos().x, -100, ARENA_WIDTH + 100),
        y: N(a.y, pos().y - 20, -100, ARENA_HEIGHT + 100),
        x2: N(a.x2, pos().x + caster.facing * 80, -100, ARENA_WIDTH + 100),
        y2: N(a.y2, pos().y - 20, -100, ARENA_HEIGHT + 100),
        ttl: dur(a.ttl, 0.4, 2),
        color: colorOf(a.color, rt.glow),
        width: N(a.width, 2.5, 1, 12),
      });
    },
    /** drawArc {x?,y?,radius?,a0?,a1?,color?,width?,ttl?} */
    drawArc(a) {
      pushEffect(ctx, {
        kind: "shape",
        shape: "arc",
        x: N(a.x, pos().x, -100, ARENA_WIDTH + 100),
        y: N(a.y, pos().y - 20, -100, ARENA_HEIGHT + 100),
        radius: N(a.radius, 30, 2, 300),
        a0: N(a.a0, 0, -Math.PI * 2, Math.PI * 2),
        a1: N(a.a1, Math.PI, -Math.PI * 2, Math.PI * 2),
        ttl: dur(a.ttl, 0.4, 2),
        color: colorOf(a.color, rt.glow),
        width: N(a.width, 2.5, 1, 12),
      });
    },

    /** particles {count?, x?, y?} — a burst of sparks. */
    particles(a) {
      const count = Math.round(N(a.count, 4, 1, 10));
      for (let i = 0; i < count; i++) {
        pushEffect(ctx, {
          kind: "spark",
          x: N(a.x, pos().x, 0, ARENA_WIDTH) + (Math.random() - 0.5) * 30,
          y: N(a.y, pos().y - 20, 0, ARENA_HEIGHT) + (Math.random() - 0.5) * 30,
          ttl: 0.3 + Math.random() * 0.3,
          color: rt.glow,
          radius: 6 + Math.random() * 8,
        });
      }
    },
  };
  api.blink = api.teleport; // aliases
  api.drawShape = api.draw;

  return Object.freeze(api);
}

/** Common entity fields; spawners override what they need. */
function baseEntity(rt: BehaviorRuntime, ctx: CombatCtx, kind: EntityKind): EngineEntity {
  const caster = rt.caster;
  return {
    kind,
    side: caster.side,
    x: caster.root.position.x,
    y: caster.root.position.y,
    vx: 0,
    vy: 0,
    hp: 30,
    ttl: 4,
    maxTtl: 4,
    radius: 14,
    color: caster.color,
    glow: rt.glow,
    facing: caster.facing,
    groundY: ctx.arena.groundY - 2,
    fireTimer: 0.4,
    hurtCd: 0,
    angle: 0,
    rt,
    dead: false,
  };
}

/** Add an entity under the global cap (oldest culled, walls cleaned up). */
function pushEntity(ctx: CombatCtx, entity: EngineEntity): void {
  if (ctx.entities.length >= 24) {
    const oldest = ctx.entities.shift();
    if (oldest?.wallBody) Matter.World.remove(ctx.arena.world, oldest.wallBody);
    if (oldest?.clone) {
      if (oldest.clone.fighter.weaponRenderRuntime) oldest.clone.fighter.weaponRenderRuntime.done = true;
      Matter.Composite.remove(CLONE_WORLD, oldest.clone.fighter.root);
    }
  }
  ctx.entities.push(entity);
  pushEffect(ctx, { kind: "spark", x: entity.x, y: entity.y - 14, ttl: 0.3, color: entity.glow, radius: 14 });
}

// ---------------------------------------------------------------------------
// Entities — lightweight kinematic actors (no Matter bodies except walls).
// ---------------------------------------------------------------------------

function spawnEntityImpl(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  kind: EntityKind,
  a: Record<string, unknown>,
  index: number,
): void {
  const caster = rt.caster;
  const p = caster.root.position;
  const f = foeOf(caster.side, ctx);
  const groundY = ctx.arena.groundY - 2;
  const N = (v: unknown, dflt: number, min: number, max: number) =>
    clamp(resolveValue(rt, ctx, v, dflt), min, max);

  // Sensible default placement per kind.
  let x = p.x + caster.facing * (30 + index * 26);
  let y = p.y;
  if (kind === "trap") x = p.x + caster.facing * (70 + index * 40);
  if (kind === "wall") x = p.x + caster.facing * 90;
  if (a.x !== undefined) x = N(a.x, x, 30, ARENA_WIDTH - 30);
  if (a.y !== undefined) y = N(a.y, y, 40, groundY);
  if (a.atOpponent) x = f.root.position.x + (Math.random() - 0.5) * 40;

  const entity: EngineEntity = {
    ...baseEntity(rt, ctx, kind),
    x: clamp(x, 30, ARENA_WIDTH - 30),
    y: kind === "trap" || kind === "wall" ? groundY : Math.min(y, groundY),
    hp: N(a.hp, 30, 1, 500),
    ttl: N(a.ttl, kind === "clone" ? 5 : 8, 0.5, MAX_ENTITY_TTL),
    radius: kind === "minion" ? 10 : kind === "orbital" ? 7 : 14,
    angle: (index / 3) * Math.PI * 2,
  };
  entity.maxTtl = entity.ttl;

  if (kind === "clone") {
    // Clones are resembling BOT copies with hard caps: weak HP, short life,
    // limited headcount, no ability casting (and so no recursion). The clone
    // body is a REAL Fighter in a dummy world — same renderer, same animator,
    // same mount/renderProgram weapon path as everyone else, ghost-tinted.
    entity.hp = Math.min(entity.hp, Math.max(8, caster.maxHp * CLONE_HP_FRACTION));
    entity.ttl = entity.maxTtl = Math.min(entity.ttl, CLONE_MAX_TTL);
    entity.radius = 12;
    const ghost = createFighter(
      CLONE_WORLD as unknown as Matter.World,
      caster.spec,
      entity.x,
      groundY,
      caster.side,
    );
    ghost.tintColor = rt.glow;
    ghost.tintTimer = Number.MAX_SAFE_INTEGER; // clones aren't combat-ticked
    ghost.phaseTimer = Number.MAX_SAFE_INTEGER; // → renderFighter ghosts them
    ghost.displayScale = 0.92;
    // Same already-vetted renderProgram as the caster (no re-vetting) —
    // anchored to the CLONE's own mount so eye-lasers glow on the clone's head.
    if (caster.weaponRenderRuntime && !caster.weaponRenderRuntime.done) {
      equipWeaponRender(ghost, ctx);
    }
    entity.clone = {
      brain: createBotBrain(),
      attackCd: 0.6,
      attackAnim: 0,
      attackTotal: attackTimingOf(caster.style.weapon.form, caster.spec.weapon.type).total,
      fighter: ghost,
    };
    const alive = ctx.entities.filter((o) => o.kind === "clone" && o.side === entity.side && !o.dead);
    while (alive.length >= CLONE_MAX_ALIVE) {
      const oldest = alive.shift()!;
      oldest.dead = true;
    }
  }

  if (kind === "wall") {
    const body = Matter.Bodies.rectangle(entity.x, groundY - 34, 16, 68, {
      isStatic: true,
      label: "engine-wall",
    });
    entity.wallBody = body;
    Matter.World.add(ctx.arena.world, body);
  }

  materialize(ctx, entity.x, entity.y - 20, { color: entity.glow });
  playSfx("cast", { pitch: 1.2, volume: 0.35, element: rt.element });
  pushEntity(ctx, entity);
}

/**
 * Dummy composite for clone Fighter bodies — never stepped by the engine,
 * never added to the arena, so clone capsules exert zero real physics.
 */
const CLONE_WORLD = Matter.Composite.create();

/** Fixed-step entity update: motion, simple AI, contact damage, expiry. */
export function tickEntities(ctx: CombatCtx, dt: number): void {
  for (const e of ctx.entities) {
    if (e.dead) continue;
    e.ttl -= dt;
    e.fireTimer -= dt;
    e.hurtCd = Math.max(0, e.hurtCd - dt);
    const foe = foeOf(e.side, ctx);
    const fp = foe.root.position;
    const dx = fp.x - e.x;
    const dist = Math.abs(dx);

    switch (e.kind) {
      case "clone": {
        // A resembling bot copy: the caster's spec drives the same FSM the
        // real bot uses, and attacks swing the caster's WEAPON — at clone
        // strength (damage fraction, weak hp, short ttl, no abilities).
        const caster = e.rt.caster;
        const c = e.clone!;
        c.attackCd = Math.max(0, c.attackCd - dt);
        c.attackAnim = Math.max(0, c.attackAnim - dt);
        const ghost = c.fighter;
        ghost.hp = e.hp; // brain retreats when the clone is hurt
        const input = c.brain.think(ghost, foe, dt);
        const pxPerSec = (3 + caster.spec.stats.speed * 0.035) * 42;
        const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        e.vx = dir * pxPerSec;
        e.x += e.vx * dt;
        e.facing = (dir || Math.sign(dx) || e.facing) as 1 | -1;
        e.y = e.groundY;

        if (input.attack && c.attackCd <= 0 && foe.alive) {
          c.attackCd = 1.0;
          c.attackAnim = c.attackTotal; // real swing timing -> real animation
          const w = caster.spec.weapon;
          const damage = rawDamage(caster, w.damage) * CLONE_DAMAGE_FRACTION;
          if (w.type === "melee") {
            const reach = Math.max(28, w.range * 0.6) + 14;
            if (Math.abs(fp.x - e.x) < reach && Math.abs(fp.y - (e.y - 30)) < 70) {
              dealDamage(foe, damage, e.facing, ctx, { source: "ability", attacker: e.rt.caster });
              if (e.rt.program.handlers.onHit) dispatchBehaviorHit(e.rt, ctx);
            }
          } else {
            spawnProjectile(caster, ctx, {
              damage,
              speed: 11,
              radius: 4,
              arc: w.type === "thrown",
              source: "ability",
              visual: w.type === "thrown" ? "thrown" : "bolt",
              form: caster.style.weapon.form,
              element: e.rt.element,
              glow: e.glow,
              origin: { x: e.x + e.facing * 12, y: e.y - 34 },
            });
          }
        }

        // Drive the ghost Fighter through THE animator (same as bots and
        // players) so clones idle/run/swing; renderEntities just calls
        // renderFighter on it.
        Matter.Body.setPosition(ghost.root, { x: e.x, y: e.y - 44 * ghost.scale });
        ghost.facing = e.facing;
        const elapsed = c.attackAnim > 0 ? c.attackTotal - c.attackAnim : -1;
        const timing = attackTimingOf(caster.style.weapon.form, caster.spec.weapon.type);
        ghost.attackWindow =
          elapsed >= timing.windup && elapsed < timing.windup + timing.active ? 0.05 : 0;
        const frame = ghost.animator.update(dt, {
          rootX: e.x,
          rootY: e.y - 44 * ghost.scale,
          vx: e.vx / 60,
          vy: 0,
          grounded: true,
          facing: e.facing,
          moving: Math.abs(e.vx) > 20,
          alive: true,
          blocking: false,
          attackElapsed: elapsed,
          weaponForm: caster.style.weapon.form,
          weaponSize: caster.style.weapon.size,
          weaponType: caster.spec.weapon.type,
          castTimer: 0,
          hitstunTimer: 0,
          launchedTimer: 0,
          groundY: e.groundY,
          time: ctx.time,
        });
        ghost.skeleton = frame.skeleton;
        ghost.weaponAngle = frame.weaponAngle;
        break;
      }
      case "minion": {
        // Chase with gravity, stop at melee distance.
        if (dist > 34) e.vx = Math.sign(dx) * 2.8;
        else e.vx = 0;
        e.facing = (Math.sign(dx) || e.facing) as 1 | -1;
        e.vy = Math.min(12, e.vy + 26 * dt);
        e.x += e.vx * 60 * dt * 0.5;
        e.y = Math.min(e.groundY, e.y + e.vy);
        if (e.y >= e.groundY) e.vy = 0;
        // Contact damage on a debounce.
        if (dist < 34 && Math.abs(fp.y - e.y) < 60 && e.fireTimer <= 0 && foe.alive) {
          e.fireTimer = 0.8;
          dealDamage(foe, 6, e.facing, ctx, { source: "ability" });
          if (e.rt.program.handlers.onHit) dispatchBehaviorHit(e.rt, ctx);
        }
        break;
      }
      case "hazard": {
        // Ambient per-kind emissions (cadence via the unused angle field).
        e.angle += dt;
        if (e.angle >= 0.2) {
          e.angle = 0;
          const ex = e.x + (Math.random() - 0.5) * e.radius * 1.6;
          switch (e.hazardKind) {
            case "fire":
              pushEffect(ctx, { kind: "particle", x: ex, y: e.groundY - 4, vx: (Math.random() - 0.5) * 20, vy: -60 - Math.random() * 50, gravity: -40, size: 3, particleShape: "spark", color: e.glow, ttl: 0.5 });
              break;
            case "ice":
              pushEffect(ctx, { kind: "particle", x: ex, y: e.groundY - 10 - Math.random() * 16, vx: (Math.random() - 0.5) * 24, vy: 10, gravity: 20, size: 2.5, particleShape: "star", color: e.glow, ttl: 0.8 });
              break;
            case "spikes":
              pushEffect(ctx, { kind: "particle", x: ex, y: e.groundY - 4, vx: 0, vy: -30, gravity: 160, size: 2.5, particleShape: "square", color: e.glow, ttl: 0.35 });
              break;
            case "void":
              vortex(ctx, e.x, e.groundY - 14, { color: e.glow, radius: e.radius, dir: 1, count: 3 });
              break;
          }
        }
        // Ground zone: applies its effect while the opponent stands in it.
        const inside =
          dist < e.radius && fp.y > e.groundY - 80 && foe.alive;
        if (inside && e.fireTimer <= 0) {
          e.fireTimer = 0.45;
          switch (e.hazardKind) {
            case "fire":
              foe.dotTimer = Math.max(foe.dotTimer, 1.2);
              foe.dotPerSec = Math.max(foe.dotPerSec, 6);
              foe.dotColor = e.glow;
              break;
            case "ice":
              foe.buffs.speedMul = 0.55;
              foe.buffTimer = Math.max(foe.buffTimer, 0.8);
              // Slip: keep them sliding in whatever direction they move.
              Matter.Body.setVelocity(foe.root, {
                x: foe.root.velocity.x * 1.6,
                y: foe.root.velocity.y,
              });
              break;
            case "spikes":
              dealDamage(foe, 7, (Math.sign(dx) || 1) as number, ctx, { source: "ability" });
              break;
            case "void": {
              const pull = Math.sign(e.x - fp.x) * 7;
              Matter.Body.setVelocity(foe.root, { x: pull, y: foe.root.velocity.y - 1 });
              break;
            }
          }
          if (e.rt.program.handlers.onHit && e.hazardKind !== "ice") dispatchBehaviorHit(e.rt, ctx);
        }
        break;
      }
      case "beam": {
        // Sustained laser anchored to the caster's hand; damage on a cadence.
        const caster = e.rt.caster;
        const hand = caster.skeleton.handR;
        e.x = hand.x;
        e.y = hand.y;
        e.facing = caster.facing;
        const b = e.beam!;
        b.tickAcc += dt;
        if (!caster.alive) e.dead = true;
        const endX = e.x + Math.cos(b.dir) * b.length * e.facing;
        const endY = e.y + Math.sin(b.dir) * b.length;
        // Sustained juice: flickering bright core over the base render, a
        // low rumble, and sparks boiling off the far end (cadence via angle).
        beamCore(ctx, { x: e.x, y: e.y }, { x: endX, y: endY }, { color: e.glow, width: 7, ttl: 0.07 });
        shake(ctx, 1.6, 0.06);
        e.angle += dt;
        if (e.angle >= 0.12) {
          e.angle = 0;
          impactSparks(ctx, endX, endY, { color: e.glow, count: 4 });
        }
        if (b.tickAcc >= 0.15 && foe.alive) {
          b.tickAcc = 0;
          // Point-to-segment distance for the opponent's chest.
          const px = fp.x, py = fp.y - 10;
          const t = Math.max(0, Math.min(1,
            ((px - e.x) * (endX - e.x) + (py - e.y) * (endY - e.y)) /
            (Math.hypot(endX - e.x, endY - e.y) ** 2 || 1)));
          const cx = e.x + (endX - e.x) * t;
          const cy = e.y + (endY - e.y) * t;
          if (Math.hypot(px - cx, py - cy) < 22) {
            dealDamage(foe, b.dps * 0.15, e.facing, ctx, { source: "ability", attacker: e.rt.caster });
            if (e.rt.program.handlers.onHit) dispatchBehaviorHit(e.rt, ctx);
          }
        }
        break;
      }
      case "trap": {
        if (dist < 32 && fp.y > e.groundY - 60 && foe.alive) {
          dealDamage(foe, 18, (Math.sign(dx) || 1) as number, ctx, { source: "ability" });
          foe.hitstunTimer = Math.max(foe.hitstunTimer, 0.45);
          pushEffect(ctx, { kind: "ring", x: e.x, y: e.groundY - 10, ttl: 0.3, color: e.glow, radius: 26 });
          if (e.rt.program.handlers.onHit) dispatchBehaviorHit(e.rt, ctx);
          e.dead = true; // sprung
        }
        break;
      }
      case "turret": {
        if (e.fireTimer <= 0 && foe.alive) {
          e.fireTimer = 1.1;
          e.facing = (Math.sign(dx) || e.facing) as 1 | -1;
          spawnProjectile(e.rt.caster, ctx, {
            damage: 6,
            speed: 11,
            radius: 4,
            arc: false,
            source: "ability",
            visual: "bolt",
            element: e.rt.element,
            glow: e.glow,
            origin: { x: e.x + e.facing * 12, y: e.y - 22 },
            onHit: e.rt.program.handlers.onHit
              ? () => dispatchBehaviorHit(e.rt, ctx)
              : undefined,
          });
        }
        break;
      }
      case "orbital": {
        e.angle += 3.2 * dt;
        const c = e.rt.caster.root.position;
        e.x = c.x + Math.cos(e.angle) * 46;
        e.y = c.y - 18 + Math.sin(e.angle) * 30;
        if (dist < 20 && Math.abs(fp.y - e.y) < 40 && e.fireTimer <= 0 && foe.alive) {
          e.fireTimer = 0.55;
          dealDamage(foe, 5, (Math.sign(dx) || 1) as number, ctx, { source: "ability" });
          if (e.rt.program.handlers.onHit) dispatchBehaviorHit(e.rt, ctx);
        }
        break;
      }
      case "wall":
        break; // static; Matter does the blocking
    }

    if (e.ttl <= 0 || !e.rt.caster.alive) {
      e.dead = true;
    }
    if (e.dead && e.wallBody) {
      Matter.World.remove(ctx.arena.world, e.wallBody);
      e.wallBody = undefined;
    }
  }
  for (let i = ctx.entities.length - 1; i >= 0; i--) {
    if (ctx.entities[i].dead) {
      const c = ctx.entities[i].clone;
      if (c) {
        if (c.fighter.weaponRenderRuntime) c.fighter.weaponRenderRuntime.done = true;
        Matter.Composite.remove(CLONE_WORLD, c.fighter.root);
      }
      pushEffect(ctx, {
        kind: "spark",
        x: ctx.entities[i].x,
        y: ctx.entities[i].y - 14,
        ttl: 0.25,
        color: ctx.entities[i].glow,
        radius: 10,
      });
      ctx.entities.splice(i, 1);
    }
  }
}

/** Flat-style entity rendering, layered with the world pass. */
export function renderEntities(g: CanvasRenderingContext2D, ctx: CombatCtx, time: number): void {
  for (const e of ctx.entities) {
    const fade = Math.min(1, e.ttl / 0.4); // pop out at end of life
    g.save();
    g.globalAlpha = fade;
    switch (e.kind) {
      case "clone": {
        // THE fighter renderer — the ghost look comes from the clone
        // fighter's phase/tint fields, the weapon from the same
        // mount/renderProgram-aware path as everyone else.
        if (e.clone) renderFighter(g, e.clone.fighter, time, e.groundY);
        break;
      }
      case "hazard": {
        renderHazard(g, e, time, fade);
        break;
      }
      case "beam": {
        const b = e.beam!;
        const endX = e.x + Math.cos(b.dir) * b.length * e.facing;
        const endY = e.y + Math.sin(b.dir) * b.length;
        const pulse = 0.7 + 0.3 * Math.sin(time * 30);
        g.lineCap = "round";
        g.shadowColor = e.glow;
        g.shadowBlur = 16;
        g.strokeStyle = withAlpha(e.glow, 0.5 * fade);
        g.lineWidth = 13 * pulse;
        g.beginPath();
        g.moveTo(e.x, e.y);
        g.lineTo(endX, endY);
        g.stroke();
        g.strokeStyle = withAlpha("#ffffff", 0.9 * fade);
        g.lineWidth = 4.5 * pulse;
        g.beginPath();
        g.moveTo(e.x, e.y);
        g.lineTo(endX, endY);
        g.stroke();
        g.fillStyle = e.glow;
        g.beginPath();
        g.arc(endX, endY, 7 * pulse, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case "minion": {
        g.fillStyle = mix(e.color, "#20242a", 0.2);
        g.strokeStyle = e.glow;
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(e.x, e.y - 10, e.radius, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(e.x + e.facing * 4, e.y - 12, 2, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case "trap": {
        g.fillStyle = mix(e.color, "#20242a", 0.35);
        g.strokeStyle = e.glow;
        g.lineWidth = 1.2;
        for (const dir of [-1, 1]) {
          g.beginPath();
          g.moveTo(e.x + dir * 14, e.y);
          g.lineTo(e.x + dir * 4, e.y);
          g.lineTo(e.x + dir * 9, e.y - 13);
          g.closePath();
          g.fill();
          g.stroke();
        }
        break;
      }
      case "turret": {
        g.fillStyle = mix(e.color, "#20242a", 0.25);
        g.strokeStyle = e.glow;
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(e.x - 12, e.y);
        g.lineTo(e.x + 12, e.y);
        g.lineTo(e.x, e.y - 18);
        g.closePath();
        g.fill();
        g.stroke();
        g.strokeStyle = e.color;
        g.lineWidth = 4;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(e.x, e.y - 20);
        g.lineTo(e.x + e.facing * 14, e.y - 24);
        g.stroke();
        break;
      }
      case "wall": {
        g.fillStyle = withAlpha(mix(e.color, "#20242a", 0.15), 0.85);
        g.strokeStyle = e.glow;
        g.lineWidth = 1.6;
        g.beginPath();
        g.roundRect(e.x - 8, e.groundY - 68, 16, 68, 4);
        g.fill();
        g.stroke();
        break;
      }
      case "orbital": {
        g.shadowColor = e.glow;
        g.shadowBlur = 12;
        g.fillStyle = e.glow;
        g.beginPath();
        g.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
        g.fill();
        break;
      }
    }
    g.restore();
  }
}

/** Ground hazard zones — each kind gets its own look. */
function renderHazard(
  g: CanvasRenderingContext2D,
  e: EngineEntity,
  time: number,
  fade: number,
): void {
  const y = e.groundY;
  g.save();
  g.globalAlpha = 0.85 * fade;
  switch (e.hazardKind) {
    case "fire": {
      g.fillStyle = withAlpha(e.glow, 0.25);
      g.beginPath();
      g.ellipse(e.x, y, e.radius, 8, 0, 0, Math.PI * 2);
      g.fill();
      g.shadowColor = e.glow;
      g.shadowBlur = 12;
      g.fillStyle = e.glow;
      for (let i = 0; i < 5; i++) {
        const fx = e.x + Math.sin(i * 2.1 + time * 3) * e.radius * 0.7;
        const h = 10 + Math.sin(time * 9 + i * 1.7) * 6;
        g.beginPath();
        g.moveTo(fx - 4, y);
        g.lineTo(fx + 4, y);
        g.lineTo(fx, y - h);
        g.closePath();
        g.fill();
      }
      break;
    }
    case "ice": {
      g.fillStyle = withAlpha(e.glow, 0.35);
      g.beginPath();
      g.ellipse(e.x, y, e.radius, 6, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = withAlpha("#ffffff", 0.7);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(e.x - e.radius * 0.6, y - 2);
      g.lineTo(e.x + e.radius * 0.5, y - 3);
      g.stroke();
      break;
    }
    case "spikes": {
      g.fillStyle = mix(e.color, "#20242a", 0.3);
      g.strokeStyle = e.glow;
      g.lineWidth = 1;
      const n = Math.max(3, Math.round(e.radius / 12));
      for (let i = 0; i < n; i++) {
        const sx = e.x - e.radius + (i + 0.5) * ((e.radius * 2) / n);
        g.beginPath();
        g.moveTo(sx - 6, y);
        g.lineTo(sx + 6, y);
        g.lineTo(sx, y - 14 - (i % 2) * 4);
        g.closePath();
        g.fill();
        g.stroke();
      }
      break;
    }
    case "void": {
      const pulse = 0.8 + 0.2 * Math.sin(time * 5);
      g.shadowColor = e.glow;
      g.shadowBlur = 14;
      g.fillStyle = withAlpha("#120a1e", 0.8);
      g.beginPath();
      g.ellipse(e.x, y - 4, e.radius * 0.8 * pulse, 12 * pulse, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = e.glow;
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(e.x, y - 4, e.radius * pulse, 14 * pulse, 0, 0, Math.PI * 2);
      g.stroke();
      // Inward-falling particles.
      g.fillStyle = e.glow;
      for (let i = 0; i < 4; i++) {
        const a = time * 2 + (i / 4) * Math.PI * 2;
        const r = e.radius * (1 - ((time * 0.7 + i * 0.25) % 1));
        g.beginPath();
        g.arc(e.x + Math.cos(a) * r, y - 4 + Math.sin(a) * r * 0.25, 2, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
  }
  g.restore();
}
