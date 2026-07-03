import type { CharacterSpec } from "../types/character";

/**
 * Deterministic balancing — no LLM involved. The LLM's numbers are treated as
 * *weights and intents*, then forced onto a fixed budget and fixed bands.
 * Every fighter that leaves this function is on equal footing: a prompt
 * defines identity, never dominance.
 */

export const TOTAL_STAT_BUDGET = 400;

/** Minimum share of the budget any single stat can hold (prevents 0-speed bricks). */
const STAT_FLOOR_SHARE = 0.08;

/** Bands the LLM's 0–10 scales are mapped into. */
export const BANDS = {
  weaponDamage: { min: 6, max: 16 },
  /** Pixels; per weapon type so "range" means something different per archetype. */
  weaponRange: {
    melee: { min: 55, max: 110 },
    thrown: { min: 180, max: 320 },
    ranged: { min: 260, max: 460 },
  },
  abilityPower: { min: 8, max: 26 },
  abilityCooldown: { min: 3, max: 10 },
  height: { min: 0.8, max: 1.2 },
} as const;

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/** Map a loose 0–10 LLM scale into a [min, max] band. */
function scaleToBand(value: number, band: { min: number; max: number }): number {
  const t = clamp(value, 0, 10) / 10;
  return band.min + t * (band.max - band.min);
}

/** Cooldown arrives in seconds already — clamp, don't rescale. */
function clampCooldown(value: number): number {
  return clamp(value, BANDS.abilityCooldown.min, BANDS.abilityCooldown.max);
}

/**
 * Normalize the four stats so they always sum to TOTAL_STAT_BUDGET, with a
 * floor so no stat is useless. Input magnitudes don't matter, only ratios.
 */
export function normalizeStats(stats: CharacterSpec["stats"]): CharacterSpec["stats"] {
  const keys = ["hp", "speed", "strength", "defense"] as const;
  let weights = keys.map((k) => {
    const v = stats[k];
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) weights = [1, 1, 1, 1];
  const sum = weights.reduce((a, b) => a + b, 0);

  const usable = 1 - STAT_FLOOR_SHARE * keys.length;
  const shares = weights.map((w) => STAT_FLOOR_SHARE + usable * (w / sum));
  const values = shares.map((s) => Math.round(s * TOTAL_STAT_BUDGET));

  // Rounding drift goes into hp so the sum is exactly the budget.
  const drift = TOTAL_STAT_BUDGET - values.reduce((a, b) => a + b, 0);
  values[0] += drift;

  return { hp: values[0], speed: values[1], strength: values[2], defense: values[3] };
}

/** Produce the tournament-legal version of a proposed character. */
export function balanceCharacter(spec: CharacterSpec): CharacterSpec {
  return {
    ...spec,
    appearance: {
      ...spec.appearance,
      accessories: spec.appearance.accessories.slice(0, 4),
      height: clamp(spec.appearance.height, BANDS.height.min, BANDS.height.max),
    },
    weapon: {
      ...spec.weapon,
      damage: Math.round(scaleToBand(spec.weapon.damage, BANDS.weaponDamage)),
      range: Math.round(scaleToBand(spec.weapon.range, BANDS.weaponRange[spec.weapon.type])),
    },
    ability: {
      ...spec.ability,
      power: Math.round(scaleToBand(spec.ability.power, BANDS.abilityPower)),
      cooldown: Math.round(clampCooldown(spec.ability.cooldown) * 10) / 10,
    },
    stats: normalizeStats(spec.stats),
  };
}
