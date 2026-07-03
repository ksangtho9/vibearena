import type { CharacterSpec } from "../types/character";
import type { Fighter } from "./stickman";
import { emptyInput, type InputState } from "./input";

/**
 * Simple FSM opponent: approach → strike → dodge/retreat → approach.
 * It emits the same InputState the keyboard does, so it obeys exactly the
 * same movement/attack/ability rules (and the same stat budget) as the player.
 */

type BotState = "approach" | "strike" | "dodge" | "retreat";

export interface BotBrain {
  think(bot: Fighter, player: Fighter, dt: number): InputState;
}

export function createBotBrain(): BotBrain {
  let state: BotState = "approach";
  let timer = 0;
  let dodgeDir: 1 | -1 = 1;

  const enter = (next: BotState, duration: number) => {
    state = next;
    timer = duration;
  };

  return {
    think(bot, player, dt) {
      const input = emptyInput();
      if (!bot.alive || !player.alive) return input;

      timer -= dt;
      const dx = player.root.position.x - bot.root.position.x;
      const dist = Math.abs(dx);
      const toward = dx > 0 ? "right" : "left";
      const away = dx > 0 ? "left" : "right";

      const { weapon, ability } = bot.spec;
      const melee = weapon.type === "melee";
      const engageDist = melee ? weapon.range * 0.85 : weapon.range * 0.75;

      // React to an incoming swing.
      if (state !== "dodge" && player.attackWindow > 0 && dist < 170 && Math.random() < 0.04) {
        dodgeDir = Math.random() < 0.5 ? 1 : -1;
        enter("dodge", 0.35);
      }

      switch (state) {
        case "approach": {
          input[toward] = true;
          if (dist < 60 && Math.random() < 0.02) input.jump = true; // hop over tangles
          if (dist <= engageDist) enter("strike", 0.9 + Math.random() * 0.7);
          break;
        }
        case "strike": {
          input.attack = true;
          if (melee && dist > engageDist * 0.7) input[toward] = true;
          if (!melee && dist < engageDist * 0.45) input[away] = true; // keep spacing
          if (timer <= 0) {
            const roll = Math.random();
            if (roll < 0.35) enter("retreat", 0.4 + Math.random() * 0.4);
            else if (roll < 0.55) enter("dodge", 0.3);
            else enter("approach", 0);
          }
          break;
        }
        case "dodge": {
          input[dodgeDir > 0 ? "right" : "left"] = true;
          input.jump = true;
          if (timer <= 0) enter("approach", 0);
          break;
        }
        case "retreat": {
          input[away] = true;
          if (!melee) input.attack = true; // shoot while falling back
          if (timer <= 0) enter("approach", 0);
          break;
        }
      }

      // Ability usage, matched to what the ability actually does.
      if (bot.abilityCooldown <= 0) {
        const hurt = bot.hp < bot.maxHp * 0.45;
        input.ability =
          (ability.kind === "heal" && hurt) ||
          (ability.kind === "shield" && dist < 200 && player.attackWindow > 0) ||
          (ability.kind === "aoe" && dist < 80 + ability.power * 3) ||
          (ability.kind === "projectile" && dist > 180) ||
          (ability.kind === "dash" && dist > 240) ||
          (ability.kind === "buff" && state === "approach" && Math.random() < 0.05);
      }

      return input;
    },
  };
}

/**
 * House fighters the bot draws from — raw 0–10 scale specs, run through the
 * same balanceCharacter() as the player's, so the bot is never privileged.
 */
export const BOT_ROSTER: CharacterSpec[] = [
  {
    name: "The Janitor",
    appearance: { color: "#9bd0e0", accessories: ["bucket hat"], height: 1.1 },
    weapon: { type: "melee", name: "Wet Mop", range: 7, damage: 5 },
    ability: { name: "Caution: Wet Floor", kind: "aoe", cooldown: 7, power: 6 },
    stats: { hp: 7, speed: 4, strength: 6, defense: 6 },
    flavor: "He didn't sign up for this. He signed up for Tuesdays.",
  },
  {
    name: "Pigeon Baron",
    appearance: { color: "#c8a2e8", accessories: ["monocle", "cape"], height: 0.85 },
    weapon: { type: "thrown", name: "Stale Baguette", range: 6, damage: 6 },
    ability: { name: "Flock Off", kind: "projectile", cooldown: 6, power: 7 },
    stats: { hp: 4, speed: 8, strength: 4, defense: 3 },
    flavor: "Feeds the birds. The birds feed on you.",
  },
  {
    name: "Gym Teacher Rex",
    appearance: { color: "#e58a5a", accessories: ["whistle"], height: 1.15 },
    weapon: { type: "ranged", name: "Dodgeball Cannon", range: 7, damage: 5 },
    ability: { name: "No Excuses", kind: "buff", cooldown: 8, power: 7 },
    stats: { hp: 6, speed: 5, strength: 7, defense: 5 },
    flavor: "If you can dodge a wrench, you can dodge Rex.",
  },
  {
    name: "Nonna Fortissima",
    appearance: { color: "#8fd18a", accessories: ["shawl", "rolling pin belt"], height: 0.8 },
    weapon: { type: "melee", name: "Rolling Pin", range: 4, damage: 8 },
    ability: { name: "Mangia!", kind: "heal", cooldown: 9, power: 8 },
    stats: { hp: 8, speed: 3, strength: 6, defense: 8 },
    flavor: "You will finish your plate. And this fight.",
  },
];

export function pickBotSpec(): CharacterSpec {
  return BOT_ROSTER[Math.floor(Math.random() * BOT_ROSTER.length)];
}
