import Matter from "matter-js";
import { castBehavior } from "./engine/interpreter";
import { runCustomScript } from "./engine/customScript";
import { playSfx } from "../audio/sfx";
import { dashJuice } from "./movementFx";
import { injuryDashMul } from "./injury";
import {
  aoeDetonation,
  fieldTint,
  glowColumn,
  groundDecal,
  impactFlash,
  impactSparks,
  lightningArc,
  orbitMotes,
  particleBurst,
  risingMotes,
  shake,
  shardBurst,
  shockwave,
  shockwaveRing,
  slashArc,
  vortex,
} from "./effectsJuice";
import type { AbilityMotif, AbilityParams, AbilitySpec, ElementKind } from "../types/character";
import type { Fighter } from "./stickman";
import { CAST_TIME } from "./animation";
import { elementGlow } from "../generation/enrich";
import {
  dealDamage,
  pushEffect,
  rawDamage,
  spawnProjectile,
  type CombatCtx,
} from "./combat";

/**
 * Ability effects. The LLM picks the KIND (fixed mechanics), the ELEMENT +
 * MOTIF (visuals), and proposes params that statBudget clamped into fair
 * bands — so a "Lightning Nova" and a "Toxic Wave" are both AOEs, but they
 * read and play differently without either being oppressive.
 */

interface AbilityRuntime {
  element: ElementKind;
  motif: AbilityMotif;
  glow: string;
  params: AbilityParams;
  /** Name-derived visual identity (deterministic; null = generic motif). */
  theme: AbilityTheme | null;
  /** Opponent chest position — bolt-style themes strike AT the target. */
  aimX?: number;
  aimY?: number;
  groundY?: number;
}

// ---------------------------------------------------------------------------
// THEME → VISUAL IDENTITY (deterministic; model-independent)
//
// An ability's NAME is mined for theme keywords and mapped to a distinct
// visual recipe built on the effect primitives. This is the safety net for
// small models that never author behaviors: two same-kind abilities with
// different names stop looking identical. Authored behaviors still win.
// ---------------------------------------------------------------------------

export type AbilityTheme =
  | "meteor" | "wall" | "cry" | "slam" | "bolt" | "blade"
  | "void" | "holy" | "giant" | "beam";

const THEME_TABLE: [RegExp, AbilityTheme][] = [
  [/giant|coloss|titan(?!ium)|gargantuan|grow|enlarg|ascend|towering|huge/i, "giant"],
  [/meteor|rain|hail|barrage|storm.?of|fall(?:ing)?.?star|comet|shower/i, "meteor"],
  [/wall|barrier|bulwark|palisade|rampart|fortress/i, "wall"],
  [/\bcry\b|shout|roar|howl|scream|wail|bellow|sonic|thunderclap|song|chord/i, "cry"],
  [/slam|smash|crash|quake|stomp|tremor|shatter(?:ing)?.?earth|ground.?pound/i, "slam"],
  [/bolt|lightning|thunder|shock|zap|storm|spark|volt/i, "bolt"],
  [/blade|slash|cut|sever|cleave|razor|scissor|crescent|moon.?cut/i, "blade"],
  [/void|shadow|dark|abyss|gloom|umbra|devour|drain/i, "void"],
  [/holy|light\b|radiant|divine|sacred|bless|aegis|dawn|sun/i, "holy"],
  [/beam|laser|\bray\b/i, "beam"],
];

export function themeOf(text: string): AbilityTheme | null {
  for (const [re, theme] of THEME_TABLE) if (re.test(text)) return theme;
  return null;
}

/**
 * The themed on-cast look. Returns false for themes with no cast recipe
 * (caller falls back to the generic motif).
 */
function themeCastFx(
  ctx: CombatCtx,
  rt: AbilityRuntime,
  x: number,
  y: number,
  opts: { radius?: number; dir?: number },
): boolean {
  const r = opts.radius ?? 60;
  const dir = opts.dir ?? 1;
  const c = rt.glow;
  switch (rt.theme) {
    case "meteor": {
      // Rocks rain from above onto the zone; impact marks on the ground.
      const gy = rt.groundY ?? y + 40;
      for (let i = 0; i < 7; i++) {
        const px = x + (Math.random() - 0.5) * r * 1.6;
        pushEffect(ctx, {
          kind: "particle", x: px, y: gy - 150 - Math.random() * 60,
          vx: (Math.random() - 0.5) * 30, vy: 240 + Math.random() * 120,
          gravity: 320, size: 3.5 + Math.random() * 2.5, particleShape: "shard",
          color: c, ttl: 0.45 + Math.random() * 0.2, seed: Math.floor(Math.random() * 97),
        });
      }
      groundDecal(ctx, x, gy, { kind: rt.element === "ice" ? "frost" : "scorch", radius: r * 0.7 });
      impactFlash(ctx, x, gy - 8, { color: c, radius: r * 0.35, ttl: 0.2 });
      return true;
    }
    case "wall": {
      // A standing lattice of bars rising in front — NOT a ring.
      const wx = x + dir * 34;
      const gy = rt.groundY ?? y + 40;
      for (let i = 0; i < 4; i++) {
        const bx = wx + dir * i * 7;
        const h = 52 - Math.abs(i - 1.5) * 8;
        pushEffect(ctx, { kind: "shape", shape: "line", x: bx, y: gy, x2: bx, y2: gy - h, color: c, width: 4, ttl: 0.9 });
      }
      pushEffect(ctx, { kind: "shape", shape: "line", x: wx - dir * 4, y: gy - 30, x2: wx + dir * 25, y2: gy - 30, color: c, width: 2.5, ttl: 0.9 });
      risingMotes(ctx, wx + dir * 10, gy - 20, { count: 5, color: c, ttl: 0.8 });
      return true;
    }
    case "cry": {
      // Concentric voice-waves + shake. No particle fireworks.
      shockwave(ctx, x, y, { color: c, radius: 10, expand: r * 2.6, thickness: 4, ttl: 0.4 });
      shockwave(ctx, x, y, { color: c, radius: 4, expand: r * 1.8, thickness: 2.5, ttl: 0.5 });
      shockwave(ctx, x, y, { color: "#ffffff", radius: 2, expand: r * 1.1, thickness: 1.5, ttl: 0.6 });
      shake(ctx, 5, 0.3);
      return true;
    }
    case "slam": {
      const gy = rt.groundY ?? y + 40;
      shockwave(ctx, x, gy - 6, { color: c, radius: 10, expand: r * 2.4, thickness: 6, ttl: 0.35 });
      shardBurst(ctx, x, gy - 4, { count: 10, color: c, speed: r * 1.6 });
      groundDecal(ctx, x, gy, { kind: "crack", radius: r * 0.8 });
      shake(ctx, 6, 0.3);
      return true;
    }
    case "bolt": {
      const ax = rt.aimX ?? x + dir * 120;
      const ay = rt.aimY ?? y;
      lightningArc(ctx, { x, y: y - 8 }, { x: ax, y: ay }, { color: c, width: 3 });
      lightningArc(ctx, { x, y: y - 8 }, { x: ax + (Math.random() - 0.5) * 30, y: ay - 20 }, { color: c, width: 1.8 });
      impactFlash(ctx, ax, ay, { color: c, radius: 22 });
      return true;
    }
    case "blade": {
      // Twin crossing crescents sweeping toward the foe.
      slashArc(ctx, x + dir * 18, y, { radius: r * 0.7, angle: dir > 0 ? -0.3 : Math.PI + 0.3, spread: 1.8, color: c, width: 11, ttl: 0.28 });
      slashArc(ctx, x + dir * 24, y + 4, { radius: r * 0.5, angle: dir > 0 ? 0.4 : Math.PI - 0.4, spread: 1.5, color: "#ffffff", width: 7, ttl: 0.22 });
      return true;
    }
    case "void": {
      vortex(ctx, x, y, { color: c, radius: r, dir: 1, count: 12 });
      particleBurst(ctx, x, y, { count: 6, color: "#241a33", speed: -r * 0.9, gravity: 0, ttl: 0.5 });
      pushEffect(ctx, { kind: "ring", x, y, ttl: 0.4, color: c, radius: r, expand: -r * 1.6, width: 2 });
      return true;
    }
    case "holy": {
      impactFlash(ctx, x, y, { color: "#fff3c4", radius: r * 0.6, ttl: 0.3 });
      glowColumn(ctx, x, (rt.groundY ?? y + 40), { color: c, height: 90, ttl: 0.6 });
      risingMotes(ctx, x, y, { count: 8, color: c, ttl: 0.9 });
      return true;
    }
    default:
      return false; // giant (mechanics hook) / beam (kind already IS the look)
  }
}

/** Safe accessors with enrich-equivalent fallbacks (handles bare specs). */
function runtimeOf(user: Fighter, ability: AbilitySpec): AbilityRuntime {
  const element = ability.element ?? "none";
  return {
    element,
    motif: ability.motif ?? "burst",
    // LLM-designed vfx color wins — two same-motif abilities stop looking
    // identical the moment the model picks its palette.
    glow: ability.vfx?.primary || elementGlow(element, user.style.glow),
    params: ability.params ?? {},
    theme: themeOf(ability.name),
  };
}

function motifEffect(
  ctx: CombatCtx,
  rt: AbilityRuntime,
  x: number,
  y: number,
  opts: { radius?: number; dir?: number; ttl?: number } = {},
): void {
  // Theme layer first: a name-matched recipe replaces the generic motif.
  if (rt.theme && themeCastFx(ctx, rt, x, y, opts)) return;
  pushEffect(ctx, {
    kind: "motif",
    x,
    y,
    ttl: opts.ttl ?? 0.55,
    color: rt.glow,
    motif: rt.motif,
    element: rt.element,
    radius: opts.radius ?? 60,
    dir: opts.dir ?? 1,
  });
}

/** Fire one ability slot (attack or utility — same coded handlers). */
export function useAbility(
  user: Fighter,
  opponent: Fighter,
  ctx: CombatCtx,
  ability: AbilitySpec,
): void {
  const pos = user.root.position;
  const rt = runtimeOf(user, ability);
  rt.aimX = opponent.root.position.x;
  rt.aimY = opponent.root.position.y - 20 * opponent.scale;
  rt.groundY = ctx.arena.groundY;
  const p = rt.params;
  user.castTimer = CAST_TIME; // cast pose for the animator

  // GIANT: a growth-themed ability (or a giant-themed FIGHTER casting
  // anything) visibly enlarges the caster — deterministic, no authored
  // behavior needed. Uses the same displayScale channel as the setScale
  // verb (render + reach + mitigation already handle it).
  const giantFighter = themeOf(`${user.spec.name} ${user.spec.flavor ?? ""}`) === "giant";
  if ((rt.theme === "giant" || giantFighter) && user.displayScale <= 1.05) {
    user.displayScale = rt.theme === "giant" ? 1.8 : 1.5;
    user.displayScaleTimer = Math.max(5, p.duration ?? 0);
    shockwaveRing(ctx, pos.x, pos.y, { color: rt.glow, radius: 12, expand: 210, thickness: 4, ttl: 0.35 });
    particleBurst(ctx, pos.x, pos.y - 16 * user.scale, { count: 10, color: rt.glow, speed: 200, gravity: 120, ttl: 0.4 });
    shake(ctx, 4, 0.25);
  }
  user.lastAbility = { name: ability.name, kind: ability.kind }; // scripts sense this

  // Default cast audio from element + kind; behaviors can layer their own
  // via the playSound verb.
  playSfx(ability.kind === "heal" ? "heal" : "cast", { element: rt.element });

  // Dispatch order: customScript (raw-JS escape hatch) → interpreted
  // behavior → legacy kind. Each tier falls through on failure/absence.
  if (ability.customScript || ability.behavior) {
    pushEffect(ctx, {
      kind: "text",
      x: pos.x,
      y: pos.y - 95 * user.scale,
      ttl: 0.9,
      color: rt.glow,
      text: ability.name.toUpperCase(),
    });
    const visuals = { element: rt.element, motif: rt.motif, glow: rt.glow };
    if (ability.customScript && runCustomScript(user, ctx, ability, visuals)) return;
    if (ability.behavior) {
      castBehavior(user, ctx, ability.behavior, visuals);
      return;
    }
    // customScript failed with no behavior fallback → legacy kind below.
  }

  // Announce the move with its LLM-given name, tinted by its element.
  pushEffect(ctx, {
    kind: "text",
    x: pos.x,
    y: pos.y - 95 * user.scale,
    ttl: 0.9,
    color: rt.glow,
    text: ability.name.toUpperCase(),
  });

  switch (ability.kind) {
    case "dash": {
      // Maimed legs halve the dash burst (injury system).
      const burst = Math.max(16, p.distance ?? 18) * injuryDashMul(user);
      Matter.Body.setVelocity(user.root, { x: user.facing * burst, y: -2 });
      user.invulnTimer = p.iframes ?? 0.25;
      dashJuice(user, ctx, rt.glow);
      motifEffect(ctx, rt, pos.x, pos.y - 20 * user.scale, {
        radius: 55,
        dir: -user.facing, // trail behind the dash
        ttl: 0.45,
      });
      break;
    }

    case "shield": {
      user.shieldTimer = p.duration ?? 3;
      user.shieldCoverage = p.coverage ?? 0.7;
      user.shieldStyle = { color: rt.glow, element: rt.element, theme: rt.theme };
      // Bubble rise-in; the dome itself is drawn live by renderFighter.
      // A themed name (wall/aegis/…) casts its own identity on top.
      if (rt.theme) motifEffect(ctx, rt, pos.x, pos.y - 20 * user.scale, { radius: 60, dir: user.facing });
      shockwaveRing(ctx, pos.x, pos.y - 24 * user.scale, { color: rt.glow, radius: 14, expand: 170, thickness: 3, ttl: 0.35 });
      risingMotes(ctx, pos.x, pos.y - 20 * user.scale, { count: 6, color: rt.glow, ttl: 0.6 });
      break;
    }

    case "aoe": {
      const radius = p.radius ?? 120;
      motifEffect(ctx, rt, pos.x, pos.y - 10 * user.scale, {
        radius,
        dir: user.facing,
        ttl: 0.65,
      });
      // A real detonation — unless the THEME drew its own look above
      // (a war cry is waves+shake, not debris; meteor rains its own rocks).
      if (!rt.theme) {
        aoeDetonation(ctx, pos.x, pos.y - 10 * user.scale, radius, rt.glow, ctx.arena.groundY, rt.element);
      }
      const d = Matter.Vector.magnitude(Matter.Vector.sub(opponent.root.position, pos));
      if (d <= radius) {
        dealDamage(opponent, rawDamage(user, ability.power * 0.9), user.facing, ctx, {
          knockbackMul: 1.6,
          source: "ability",
        });
      }
      break;
    }

    case "heal": {
      const amount = p.amount ?? Math.round(ability.power * 1.3);
      if (p.overTime) {
        user.regenTimer = 3;
        user.regenRate = amount / 3;
      } else {
        user.hp = Math.min(user.maxHp, user.hp + amount);
      }
      pushEffect(ctx, {
        kind: "text",
        x: pos.x,
        y: pos.y - 70,
        ttl: 0.8,
        color: "#8fd18a",
        text: p.overTime ? `+${amount} over time` : `+${amount}`,
      });
      // Heal: rising motes inside a soft light column (no ring pulse).
      glowColumn(ctx, pos.x, pos.y + 30 * user.scale, { color: "#8fd18a", height: 86 * user.scale, ttl: 0.6 });
      risingMotes(ctx, pos.x, pos.y - 24 * user.scale, { count: 12, color: "#8fd18a", ttl: 1 });
      break;
    }

    case "projectile": {
      const count = Math.max(1, Math.min(5, Math.round(p.count ?? 1)));
      // Total potential damage grows sub-linearly with count — a fan trades
      // per-hit punch for coverage.
      const per = rawDamage(user, ability.power * 1.1) / Math.sqrt(count);
      const halfArc = (p.spread ?? 0) * 0.45;
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1) - 0.5;
        spawnProjectile(user, ctx, {
          damage: per,
          speed: p.homing ? 10 : 12,
          radius: count > 2 ? 6.5 : 9,
          arc: false,
          source: "ability",
          angle: t * 2 * halfArc,
          homing: p.homing ?? false,
          glow: rt.glow,
          visual: "bolt",
          element: rt.element,
        });
      }
      motifEffect(ctx, rt, pos.x + user.facing * 24 * user.scale, pos.y - 24 * user.scale, {
        radius: 30,
        dir: user.facing,
        ttl: 0.4,
      });
      impactSparks(ctx, pos.x + user.facing * 26 * user.scale, pos.y - 24 * user.scale, { color: rt.glow, count: 4 });
      break;
    }

    case "buff": {
      user.buffTimer = p.duration ?? 4;
      const magnitude = p.magnitude ?? 1.35;
      const stat = p.stat ?? "strength";
      user.buffs = {
        speedMul: stat === "speed" ? magnitude : 1,
        strengthMul: stat === "strength" ? magnitude : 1,
        defenseMul: stat === "defense" ? magnitude : 1,
      };
      pushEffect(ctx, {
        kind: "text",
        x: pos.x,
        y: pos.y - 70,
        ttl: 0.8,
        color: rt.glow,
        text: `${stat.toUpperCase()} UP`,
      });
      // Buff: orbiting aura particles + rising motes around the body.
      orbitMotes(ctx, pos.x, pos.y - 22 * user.scale, { count: 8, color: rt.glow, radius: 30 * user.scale });
      risingMotes(ctx, pos.x, pos.y - 26 * user.scale, { count: 7, color: rt.glow, ttl: 0.8 });
      fieldTint(ctx, rt.glow, 0.22);
      playSfx("generate", { pitch: 1.3, volume: 0.5, element: rt.element });
      motifEffect(ctx, rt, pos.x, pos.y - 24 * user.scale, { radius: 50, ttl: 0.8 });
      break;
    }
  }
}
