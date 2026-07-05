import type { AbilityParams, AbilitySpec, CharacterSpec, WeaponForm, WeaponProperty } from "../types/character";
import { detectElement, deriveWeaponProperties, resolveWeaponIdentity } from "../game/weapons/mapWeapon";

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
  // Ability params: LLM 0–10 scales (or native units) → fair runtime bands.
  aoeRadius: { min: 70, max: 170 }, // px
  dashDistance: { min: 10, max: 22 }, // burst velocity
  healAmount: { min: 10, max: 34 }, // hp
  buffMagnitude: { min: 1.15, max: 1.6 }, // stat multiplier
  shieldCoverage: { min: 0.4, max: 0.85 }, // fraction of damage blocked
} as const;

/** Hard limits for params the LLM supplies in native units. */
const PARAM_LIMITS = {
  count: { min: 1, max: 5 },
  spread: { min: 0, max: 1 },
  iframes: { min: 0, max: 0.5 }, // seconds
  duration: { min: 1.5, max: 6 }, // seconds (shield/buff)
} as const;

/** Weapon-property fairness: at most 3 properties, magnitudes 1–10 each,
 * summed magnitude scaled down to this budget, and base damage taxed by up
 * to DAMAGE_TAX in proportion to the load — power is a trade, never free. */
export const WEAPON_PROPERTY_BUDGET = 14;
export const MAX_WEAPON_PROPERTIES = 3;
const PROPERTY_DAMAGE_TAX = 0.25;

/**
 * Clamp + budget the weapon's mechanical properties, deriving concept-fitting
 * defaults when none were given, and tax base damage for the load carried.
 * Returns the final properties and the damage multiplier to apply.
 */
function balanceWeaponProperties(
  spec: CharacterSpec,
  form: WeaponForm,
): { properties: WeaponProperty[]; damageMul: number } {
  const w = spec.weapon;
  let props: WeaponProperty[] = (w.properties ?? []).map((p) => ({
    kind: p.kind,
    magnitude: clamp(p.magnitude, 1, 10),
  }));

  // Dedupe by kind (first mention wins) and cap the count.
  const seen = new Set<string>();
  props = props.filter((p) => !seen.has(p.kind) && seen.add(p.kind));
  props = props.slice(0, MAX_WEAPON_PROPERTIES);

  if (props.length === 0) {
    const element = w.element ?? detectElement(w.name);
    props = deriveWeaponProperties(w.name, form, element);
  }

  // Enforce the total budget proportionally.
  const total = props.reduce((sum, p) => sum + p.magnitude, 0);
  if (total > WEAPON_PROPERTY_BUDGET) {
    const k = WEAPON_PROPERTY_BUDGET / total;
    props = props.map((p) => ({ ...p, magnitude: Math.max(1, Math.round(p.magnitude * k * 10) / 10) }));
  }

  const load = Math.min(WEAPON_PROPERTY_BUDGET, props.reduce((sum, p) => sum + p.magnitude, 0));
  return { properties: props, damageMul: 1 - PROPERTY_DAMAGE_TAX * (load / WEAPON_PROPERTY_BUDGET) };
}

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

/**
 * Clamp whatever ability params the LLM supplied into their fair bands.
 * (Missing params get in-band defaults later, in enrich.) 0–10 scales map
 * onto bands; native-unit params (seconds, fractions, counts) hard-clamp.
 */
function balanceAbilityParams(params: AbilityParams | undefined): AbilityParams | undefined {
  if (!params) return undefined;
  const out: AbilityParams = { ...params };
  if (out.radius !== undefined) out.radius = Math.round(scaleToBand(out.radius, BANDS.aoeRadius));
  if (out.distance !== undefined) out.distance = Math.round(scaleToBand(out.distance, BANDS.dashDistance) * 10) / 10;
  if (out.amount !== undefined) out.amount = Math.round(scaleToBand(out.amount, BANDS.healAmount));
  if (out.magnitude !== undefined) out.magnitude = Math.round(scaleToBand(out.magnitude, BANDS.buffMagnitude) * 100) / 100;
  if (out.coverage !== undefined) out.coverage = Math.round(scaleToBand(out.coverage * 10, BANDS.shieldCoverage) * 100) / 100;
  if (out.count !== undefined) out.count = Math.round(clamp(out.count, PARAM_LIMITS.count.min, PARAM_LIMITS.count.max));
  if (out.spread !== undefined) out.spread = Math.round(clamp(out.spread, PARAM_LIMITS.spread.min, PARAM_LIMITS.spread.max) * 100) / 100;
  if (out.iframes !== undefined) out.iframes = Math.round(clamp(out.iframes, PARAM_LIMITS.iframes.min, PARAM_LIMITS.iframes.max) * 100) / 100;
  if (out.duration !== undefined) out.duration = Math.round(clamp(out.duration, PARAM_LIMITS.duration.min, PARAM_LIMITS.duration.max) * 10) / 10;
  return out;
}

/** Clamp one ability slot's numbers into the fair bands. */
function balanceAbility(ability: AbilitySpec): AbilitySpec {
  return {
    ...ability,
    power: Math.round(scaleToBand(ability.power, BANDS.abilityPower)),
    cooldown: Math.round(clampCooldown(ability.cooldown) * 10) / 10,
    params: balanceAbilityParams(ability.params),
  };
}

/** Produce the tournament-legal version of a proposed character. */
export function balanceCharacter(spec: CharacterSpec): CharacterSpec {
  // FORM is the weapon's identity: the mechanical type follows from it (an
  // explicit hammer stays melee even if tagged "ranged"), and the range band
  // is chosen by the CORRECTED type so the numbers match how it plays.
  const identity = resolveWeaponIdentity(spec.weapon);
  const { properties, damageMul } = balanceWeaponProperties(spec, identity.form);
  return {
    ...spec,
    appearance: {
      ...spec.appearance,
      accessories: spec.appearance.accessories.slice(0, 4),
      height: clamp(spec.appearance.height, BANDS.height.min, BANDS.height.max),
    },
    weapon: {
      ...spec.weapon,
      form: identity.form,
      type: identity.type,
      damage: Math.max(
        BANDS.weaponDamage.min - 2,
        Math.round(scaleToBand(spec.weapon.damage, BANDS.weaponDamage) * damageMul),
      ),
      range: Math.round(scaleToBand(spec.weapon.range, BANDS.weaponRange[identity.type])),
      properties,
    },
    ability: balanceAbility(spec.ability),
    utility: spec.utility ? balanceAbility(spec.utility) : undefined,
    stats: normalizeStats(spec.stats),
    // Block/parry tuning stays a MODEST 0–10 band (defaults derive in-game).
    blockPower:
      spec.blockPower !== undefined ? clamp(spec.blockPower, 0, 10) : undefined,
    parrySkill:
      spec.parrySkill !== undefined ? clamp(spec.parrySkill, 0, 10) : undefined,
  };
}
