import { z } from "zod";

/** Visual weapon shapes the parametric renderer can draw. */
export const WEAPON_FORMS = [
  "sword", "greatsword", "dagger", "axe", "hammer", "spear", "halberd",
  "scythe", "whip", "flail", "staff", "bow", "gun", "orb", "shield", "claw",
  "chakram", "bomb",
] as const;
export type WeaponForm = (typeof WEAPON_FORMS)[number];

export const WEAPON_SIZES = ["small", "medium", "large"] as const;
export type WeaponSize = (typeof WEAPON_SIZES)[number];

export const ELEMENTS = [
  "fire", "ice", "lightning", "poison", "shadow", "holy", "arcane", "none",
] as const;
export type ElementKind = (typeof ELEMENTS)[number];

export interface WeaponVfx {
  glow: string;
  element?: ElementKind;
  trail?: boolean;
}

/**
 * The contract between the LLM and the game. The LLM proposes a character on
 * loose 1–10 scales; balance/statBudget.ts then rebalances everything onto a
 * fixed budget so a prompt defines identity, never dominance.
 *
 * The weapon's VISUAL descriptors (form/size/curve/spikes/doubleEnded/
 * element) may come straight from the LLM — enrich.ts snaps them into range
 * and derives anything missing. They never affect mechanics: hitboxes come
 * from the mechanical `type` + balanced `range` only. `vfx`, `accentColor`
 * and `outline` stay fully derived (stripped from raw output).
 */
export interface CharacterSpec {
  name: string;
  appearance: {
    color: string;
    accessories: string[];
    height: number; // 0.8–1.2
    accentColor?: string;
    outline?: string;
  };
  weapon: {
    type: "melee" | "ranged" | "thrown";
    name: string;
    range: number;
    damage: number;
    // LLM-emitted visual descriptors (snapped/derived in enrich).
    form?: WeaponForm;
    size?: WeaponSize;
    curve?: number; // 0 straight → 1 curved
    spikes?: number; // 0–4
    doubleEnded?: boolean;
    element?: ElementKind;
    vfx?: WeaponVfx;
  };
  ability: {
    name: string;
    kind: "dash" | "shield" | "aoe" | "heal" | "projectile" | "buff";
    cooldown: number;
    power: number;
  };
  stats: { hp: number; speed: number; strength: number; defense: number };
  flavor: string;
}

export const WEAPON_TYPES = ["melee", "ranged", "thrown"] as const;
export const ABILITY_KINDS = ["dash", "shield", "aoe", "heal", "projectile", "buff"] as const;

export const characterSpecSchema = z.object({
  name: z.string().min(1).max(48),
  appearance: z.object({
    color: z.string().min(1).max(48),
    accessories: z.array(z.string().max(48)).max(6).default([]),
    height: z.coerce.number().finite(),
    accentColor: z.string().max(48).optional(),
    outline: z.string().max(48).optional(),
  }),
  weapon: z.object({
    type: z.enum(WEAPON_TYPES),
    name: z.string().min(1).max(48),
    range: z.coerce.number().finite(),
    damage: z.coerce.number().finite(),
    form: z.enum(WEAPON_FORMS).optional(),
    size: z.enum(WEAPON_SIZES).optional(),
    curve: z.coerce.number().finite().optional(),
    spikes: z.coerce.number().finite().optional(),
    doubleEnded: z.boolean().optional(),
    element: z.enum(ELEMENTS).optional(),
    vfx: z
      .object({
        glow: z.string().max(48),
        element: z.enum(ELEMENTS).optional(),
        trail: z.boolean().optional(),
      })
      .optional(),
  }),
  ability: z.object({
    name: z.string().min(1).max(48),
    kind: z.enum(ABILITY_KINDS),
    cooldown: z.coerce.number().finite(),
    power: z.coerce.number().finite(),
  }),
  stats: z.object({
    hp: z.coerce.number().finite(),
    speed: z.coerce.number().finite(),
    strength: z.coerce.number().finite(),
    defense: z.coerce.number().finite(),
  }),
  flavor: z.string().max(400).default(""),
});

/** Safe fighter used whenever generation or validation fails. */
export const DEFAULT_CHARACTER: CharacterSpec = {
  name: "Chalk Outline",
  appearance: { color: "#f2f0e4", accessories: ["headband"], height: 1 },
  weapon: { type: "melee", name: "Bare Knuckles", range: 5, damage: 6 },
  ability: { name: "Second Wind", kind: "heal", cooldown: 7, power: 6 },
  stats: { hp: 6, speed: 5, strength: 5, defense: 4 },
  flavor: "Drawn on the board when nobody showed up to fight.",
};

const WEAPON_ALIASES: Record<string, CharacterSpec["weapon"]["type"]> = {
  melee: "melee", sword: "melee", fist: "melee", blade: "melee", blunt: "melee",
  ranged: "ranged", gun: "ranged", bow: "ranged", beam: "ranged", magic: "ranged",
  thrown: "thrown", throw: "thrown", throwable: "thrown", grenade: "thrown", bomb: "thrown",
};

const ABILITY_ALIASES: Record<string, CharacterSpec["ability"]["kind"]> = {
  dash: "dash", teleport: "dash", blink: "dash", charge: "dash",
  shield: "shield", block: "shield", barrier: "shield", armor: "shield",
  aoe: "aoe", explosion: "aoe", blast: "aoe", slam: "aoe", quake: "aoe",
  heal: "heal", regen: "heal", lifesteal: "heal",
  projectile: "projectile", fireball: "projectile", missile: "projectile", bolt: "projectile",
  buff: "buff", rage: "buff", boost: "buff", frenzy: "buff",
};

/**
 * LLMs get close but not exact — map near-miss enum values onto real ones
 * before strict validation so fewer generations fall back to the default.
 */
function normalizeRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const weapon = clone.weapon as Record<string, unknown> | undefined;
  if (weapon) {
    if (typeof weapon.type === "string") {
      const key = weapon.type.toLowerCase().trim();
      weapon.type = WEAPON_ALIASES[key] ?? key;
    }
    // Visual descriptors: keep only values that will pass the enums — a junk
    // form/size/element must not fail an otherwise good spec (enrich derives
    // whatever is missing).
    const keepEnum = (field: string, allowed: readonly string[]) => {
      if (typeof weapon[field] === "string") {
        const v = (weapon[field] as string).toLowerCase().trim();
        if (allowed.includes(v)) weapon[field] = v;
        else delete weapon[field];
      } else if (weapon[field] !== undefined) {
        delete weapon[field];
      }
    };
    keepEnum("form", WEAPON_FORMS);
    keepEnum("size", WEAPON_SIZES);
    keepEnum("element", ELEMENTS);
    if (typeof weapon.doubleEnded === "string") {
      weapon.doubleEnded = weapon.doubleEnded === "true";
    } else if (weapon.doubleEnded !== undefined && typeof weapon.doubleEnded !== "boolean") {
      delete weapon.doubleEnded;
    }
    for (const numField of ["curve", "spikes"] as const) {
      if (weapon[numField] !== undefined && !Number.isFinite(Number(weapon[numField]))) {
        delete weapon[numField];
      }
    }
    // Fully derived fields: recomputed by enrichCharacter, never taken raw.
    delete weapon.archetype;
    delete weapon.vfx;
  }
  const appearance = clone.appearance as Record<string, unknown> | undefined;
  if (appearance) {
    delete appearance.accentColor;
    delete appearance.outline;
  }
  const ability = clone.ability as Record<string, unknown> | undefined;
  if (ability && typeof ability.kind === "string") {
    const key = ability.kind.toLowerCase().trim();
    ability.kind = ABILITY_ALIASES[key] ?? key;
  }
  return clone;
}

/** Validate an untrusted LLM payload. Returns null instead of throwing. */
export function parseCharacterSpec(raw: unknown): CharacterSpec | null {
  const result = characterSpecSchema.safeParse(normalizeRaw(raw));
  if (!result.success) {
    console.warn("[vibearena] character spec failed validation:", result.error.flatten());
    return null;
  }
  return result.data;
}
