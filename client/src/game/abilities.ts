import Matter from "matter-js";
import { castBehavior } from "./engine/interpreter";
import { runCustomScript } from "./engine/customScript";
import { playSfx } from "../audio/sfx";
import { dashJuice } from "./movementFx";
import {
  aoeDetonation,
  auraGlow,
  fieldTint,
  impactSparks,
  risingMotes,
  shockwaveRing,
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
  };
}

function motifEffect(
  ctx: CombatCtx,
  rt: AbilityRuntime,
  x: number,
  y: number,
  opts: { radius?: number; dir?: number; ttl?: number } = {},
): void {
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
  const p = rt.params;
  user.castTimer = CAST_TIME; // cast pose for the animator
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
      const burst = Math.max(16, p.distance ?? 18); // snappy — a real reposition
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
      // Bubble rise-in; the dome itself is drawn live by renderFighter.
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
      // A real detonation: shockwave + debris + scorch + shake + boom.
      aoeDetonation(ctx, pos.x, pos.y - 10 * user.scale, radius, rt.glow, ctx.arena.groundY, rt.element);
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
      motifEffect(ctx, rt, pos.x, pos.y - 24 * user.scale, { radius: 46, ttl: 0.9 });
      risingMotes(ctx, pos.x, pos.y - 24 * user.scale, { count: 10, color: "#8fd18a", ttl: 0.9 });
      auraGlow(ctx, user, { color: "#8fd18a", ttl: 0.5 });
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
      auraGlow(ctx, user, { color: rt.glow, ttl: 0.5 });
      risingMotes(ctx, pos.x, pos.y - 26 * user.scale, { count: 9, color: rt.glow, ttl: 0.8 });
      fieldTint(ctx, rt.glow, 0.22);
      playSfx("generate", { pitch: 1.3, volume: 0.5, element: rt.element });
      motifEffect(ctx, rt, pos.x, pos.y - 24 * user.scale, { radius: 50, ttl: 0.8 });
      break;
    }
  }
}
