import Matter from "matter-js";
import type { Fighter } from "./stickman";
import { CAST_TIME } from "./animation";
import {
  dealDamage,
  pushEffect,
  rawDamage,
  spawnProjectile,
  type CombatCtx,
} from "./combat";

/**
 * Deterministic ability effects. The LLM picks the *kind* and the flavor
 * name; what each kind actually does is fixed game logic, scaled only by the
 * budget-clamped `power`.
 */
export function useAbility(user: Fighter, opponent: Fighter, ctx: CombatCtx): void {
  const { ability } = user.spec;
  const pos = user.root.position;
  user.castTimer = CAST_TIME; // cast pose for the animator

  // Announce the move with its LLM-given name.
  pushEffect(ctx, {
    kind: "text",
    x: pos.x,
    y: pos.y - 95 * user.scale,
    ttl: 0.9,
    color: user.color,
    text: ability.name.toUpperCase(),
  });

  switch (ability.kind) {
    case "dash": {
      Matter.Body.setVelocity(user.root, {
        x: user.facing * (14 + ability.power * 0.35),
        y: -2,
      });
      for (let i = 0; i < 4; i++) {
        pushEffect(ctx, {
          kind: "ring",
          x: pos.x - user.facing * i * 14,
          y: pos.y,
          ttl: 0.25 + i * 0.05,
          color: user.color,
          radius: 18 - i * 3,
        });
      }
      break;
    }
    case "shield": {
      user.shieldTimer = 2.2 + ability.power * 0.06;
      pushEffect(ctx, { kind: "ring", x: pos.x, y: pos.y, ttl: 0.4, color: user.color, radius: 60 });
      break;
    }
    case "aoe": {
      const radius = 80 + ability.power * 3.5;
      pushEffect(ctx, { kind: "ring", x: pos.x, y: pos.y, ttl: 0.5, color: user.color, radius });
      const d = Matter.Vector.magnitude(
        Matter.Vector.sub(opponent.root.position, pos),
      );
      if (d <= radius) {
        dealDamage(opponent, rawDamage(user, ability.power * 0.9), user.facing, ctx, {
          knockbackMul: 1.6,
          source: "ability",
        });
      }
      break;
    }
    case "heal": {
      const healed = Math.round(ability.power * 1.3);
      user.hp = Math.min(user.maxHp, user.hp + healed);
      pushEffect(ctx, {
        kind: "text",
        x: pos.x,
        y: pos.y - 70,
        ttl: 0.8,
        color: "#8fd18a",
        text: `+${healed}`,
      });
      break;
    }
    case "projectile": {
      spawnProjectile(user, ctx, {
        damage: rawDamage(user, ability.power * 1.1),
        speed: 12,
        radius: 9,
        arc: false,
        source: "ability",
      });
      break;
    }
    case "buff": {
      user.buffTimer = 4;
      user.buffs = { speedMul: 1.35, strengthMul: 1 + ability.power * 0.03 };
      break;
    }
  }
}
