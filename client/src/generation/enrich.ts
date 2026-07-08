import type {
  Adornment,
  AbilityMotif,
  AbilityParams,
  AbilitySpec,
  BladeProfile,
  BladeTip,
  CharacterSpec,
  ElementKind,
  GuardType,
  HeadType,
  Outfit,
  PartMaterial,
  PommelType,
  WeaponForm,
  WeaponParts,
  WeaponSize,
} from "../types/character";
import { ATTACK_ABILITY_KINDS, sanitizeBehaviorShape } from "../types/character";
import { smokeTestBehavior } from "../game/engine/interpreter";
import {
  detectElement,
  derivePartsFromName,
  resolveWeaponIdentity,
} from "../game/weapons/mapWeapon";
import { hueShift, safeCssColor, shade } from "../render/color";
import { headgearFromText, type HeadgearKind } from "../game/gear";
import type { GearItem } from "../types/character";

/**
 * Post-generation normalization: snaps the LLM's visual weapon descriptors
 * into range (or derives them from the weapon name when missing) and fills
 * the fully-derived fields (VFX colors, accent/outline). Visual only — the
 * mechanical type/range/damage were already balanced by statBudget.
 */

export const ELEMENT_GLOW: Record<Exclude<ElementKind, "none">, string> = {
  fire: "#ff9a3c",
  ice: "#7cd7ff",
  lightning: "#ffe95e",
  poison: "#9dff57",
  shadow: "#9257e8",
  holy: "#ffe6a3",
  arcane: "#ff6bd6",
};

/** Glow color for an element, with a fallback for "none". */
export function elementGlow(element: ElementKind, fallback: string): string {
  return element === "none" ? fallback : ELEMENT_GLOW[element];
}

/** Forms whose attacks read as a swing — these get the ribbon trail. */
const TRAIL_FORMS: WeaponForm[] = [
  "sword", "greatsword", "dagger", "axe", "hammer", "warhammer", "mace",
  "rapier", "spear", "halberd", "scythe", "whip", "flail", "staff", "claw",
];

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

export interface ResolvedBlade {
  profile: BladeProfile;
  length: number; // 0–1
  width: number; // 0–1
  edges: 1 | 2;
  count: 1 | 2 | 3;
  fuller: boolean;
  tip: BladeTip;
}

export interface ResolvedHead {
  type: HeadType;
  size: number; // 0–1
  spikes: number; // 0–6
}

/** Fully resolved weapon anatomy — every field concrete, drawing only. */
export interface ResolvedParts {
  blade: ResolvedBlade | null;
  head: ResolvedHead | null;
  haft: { length: number; wrapped: boolean };
  guard: GuardType;
  pommel: PommelType;
  adornments: Adornment[];
  material: PartMaterial;
}

export interface WeaponVisual {
  form: WeaponForm;
  size: WeaponSize;
  curve: number;
  spikes: number;
  doubleEnded: boolean;
  parts: ResolvedParts;
}

/** Baseline anatomy per form — what a bare `form:"sword"` looks like. */
function defaultParts(form: WeaponForm): ResolvedParts {
  const base: ResolvedParts = {
    blade: null,
    head: null,
    haft: { length: 0.2, wrapped: false },
    guard: "none",
    pommel: "none",
    adornments: [],
    material: "steel",
  };
  const bladed = (profile: BladeProfile, length: number, width: number): ResolvedBlade => ({
    profile,
    length,
    width,
    edges: 2,
    count: 1,
    fuller: false,
    tip: "point",
  });
  switch (form) {
    case "sword":
      return { ...base, blade: bladed("straight", 0.6, 0.35), guard: "crossbar", pommel: "round" };
    case "greatsword":
      return { ...base, blade: { ...bladed("broad", 0.85, 0.5), fuller: true }, guard: "crossbar", pommel: "round", haft: { length: 0.3, wrapped: true } };
    case "dagger":
      return { ...base, blade: bladed("dagger", 0.3, 0.3), guard: "crossbar", haft: { length: 0.15, wrapped: false } };
    case "axe":
      return { ...base, head: { type: "axeSingle", size: 0.6, spikes: 0 }, haft: { length: 0.55, wrapped: false }, material: "steel" };
    case "hammer":
      return { ...base, head: { type: "hammer", size: 0.6, spikes: 0 }, haft: { length: 0.55, wrapped: false } };
    case "warhammer":
      return { ...base, head: { type: "hammer", size: 0.9, spikes: 0 }, haft: { length: 0.75, wrapped: true } };
    case "mace":
      return { ...base, head: { type: "flangedMace", size: 0.6, spikes: 0 }, haft: { length: 0.5, wrapped: false } };
    case "rapier":
      return { ...base, blade: bladed("rapier", 0.8, 0.12), guard: "basket", pommel: "round" };
    case "cannon":
      return { ...base, haft: { length: 0.2, wrapped: false }, material: "iron" };
    case "flail":
      return { ...base, head: { type: "spikedBall", size: 0.5, spikes: 4 }, haft: { length: 0.3, wrapped: true } };
    case "spear":
      return { ...base, blade: bladed("leaf", 0.25, 0.3), haft: { length: 0.85, wrapped: false } };
    case "halberd":
      return { ...base, head: { type: "halberd", size: 0.6, spikes: 1 }, haft: { length: 0.9, wrapped: false } };
    case "scythe":
      return { ...base, blade: { ...bladed("sickle", 0.55, 0.35), edges: 1 }, haft: { length: 0.85, wrapped: false }, material: "steel" };
    case "claw":
      return { ...base, blade: { ...bladed("dagger", 0.3, 0.2), count: 3, edges: 1 }, material: "steel" };
    case "fist":
      return { ...base, material: "steel" };
    case "gauntlet":
      return { ...base, material: "steel" };
    case "whip":
      return { ...base, haft: { length: 0.15, wrapped: true }, material: "wood" };
    case "staff":
      return { ...base, haft: { length: 1, wrapped: false }, pommel: "gem", material: "wood" };
    case "bow":
      return { ...base, haft: { length: 0.2, wrapped: true }, material: "wood" };
    case "gun":
      return { ...base, haft: { length: 0.1, wrapped: false }, material: "iron" };
    case "orb":
      return { ...base, material: "crystal" };
    case "shield":
      return { ...base, material: "steel", adornments: [] };
    case "chakram":
      return { ...base, material: "steel" };
    case "bomb":
      return { ...base, material: "iron" };
  }
}

const clamp01 = (v: number | undefined, dflt: number) =>
  v === undefined || !Number.isFinite(v) ? dflt : Math.max(0, Math.min(1, v));

/** LLM parts (validated) > name-derived parts > form defaults, all clamped. */
function resolveParts(spec: CharacterSpec, form: WeaponForm): ResolvedParts {
  const given: WeaponParts = spec.weapon.parts ?? {};
  const named = derivePartsFromName(spec.weapon.name);
  const dflt = defaultParts(form);

  const blade =
    given.blade || named.blade || dflt.blade
      ? {
          profile: given.blade?.profile ?? named.blade?.profile ?? dflt.blade?.profile ?? "straight",
          length: clamp01(given.blade?.length ?? named.blade?.length, dflt.blade?.length ?? 0.6),
          width: clamp01(given.blade?.width ?? named.blade?.width, dflt.blade?.width ?? 0.35),
          edges: ((given.blade?.edges ?? named.blade?.edges ?? dflt.blade?.edges ?? 2) >= 2 ? 2 : 1) as 1 | 2,
          count: (Math.max(1, Math.min(3, Math.round(given.blade?.count ?? named.blade?.count ?? dflt.blade?.count ?? 1)))) as 1 | 2 | 3,
          fuller: given.blade?.fuller ?? named.blade?.fuller ?? dflt.blade?.fuller ?? false,
          tip: given.blade?.tip ?? named.blade?.tip ?? dflt.blade?.tip ?? "point",
        }
      : null;

  const head =
    given.head || named.head || dflt.head
      ? {
          type: given.head?.type ?? named.head?.type ?? dflt.head?.type ?? "hammer",
          size: clamp01(given.head?.size ?? named.head?.size, dflt.head?.size ?? 0.6),
          spikes: Math.max(0, Math.min(6, Math.round(given.head?.spikes ?? named.head?.spikes ?? dflt.head?.spikes ?? 0))),
        }
      : null;

  return {
    // A weapon is blade- OR head-led; if the LLM supplied both, the form decides.
    blade: head && dflt.head && !dflt.blade ? null : blade,
    head: blade && dflt.blade && !dflt.head ? null : head,
    haft: {
      length: clamp01(given.haft?.length ?? named.haft?.length, dflt.haft.length),
      wrapped: given.haft?.wrapped ?? named.haft?.wrapped ?? dflt.haft.wrapped,
    },
    guard: given.guard ?? named.guard ?? dflt.guard,
    pommel: given.pommel ?? named.pommel ?? dflt.pommel,
    adornments: (given.adornments ?? named.adornments ?? dflt.adornments).slice(0, 3),
    material: given.material ?? named.material ?? dflt.material,
  };
}

/** Every slot resolved — "none" where nothing is worn. Cosmetic only. */
export type ResolvedOutfit = Required<Outfit>;

/**
 * Concept → outfit derivation for specs that don't carry structured outfit
 * data (mocks, the bot roster, old specs, or LLM omissions). First matching
 * keyword wins per slot; unmatched slots stay "none".
 */
const OUTFIT_KEYWORDS: { [S in keyof Required<Outfit>]: [string, Required<Outfit>[S]][] } = {
  head: [
    ["knight", "helmet"], ["paladin", "helmet"], ["viking", "helmet"], ["helmet", "helmet"],
    ["hard hat", "helmet"], ["samurai", "helmet"], ["soldier", "helmet"],
    ["tophat", "tophat"], ["top hat", "tophat"], ["gentleman", "tophat"], ["baron", "tophat"],
    ["wizard", "hood"], ["reaper", "hood"], ["necromancer", "hood"], ["hood", "hood"], ["monk", "hood"],
    ["king", "crown"], ["queen", "crown"], ["royal", "crown"], ["crown", "crown"], ["prince", "crown"],
    ["demon", "horns"], ["devil", "horns"], ["imp", "horns"], ["horns", "horns"], ["minotaur", "horns"],
    ["angel", "halo"], ["saint", "halo"], ["halo", "halo"], ["seraph", "halo"],
    ["pilot", "cap"], ["courier", "cap"], ["scout", "cap"], ["cap", "cap"], ["chef", "cap"],
    ["witch", "hat"], ["cowboy", "hat"], ["sheriff", "hat"], ["outlaw", "hat"], ["hat", "hat"],
    ["pirate", "hat"], ["gunslinger", "hat"],
  ],
  face: [
    ["ninja", "mask"], ["assassin", "mask"], ["bandit", "mask"], ["mask", "mask"], ["thief", "mask"],
    ["robot", "visor"], ["cyborg", "visor"], ["android", "visor"], ["visor", "visor"], ["mech", "visor"],
    ["goggles", "goggles"], ["engineer", "goggles"], ["scientist", "goggles"], ["tinker", "goggles"], ["aviator", "goggles"],
    ["warpaint", "warpaint"], ["tribal", "warpaint"], ["barbarian", "warpaint"], ["berserk", "warpaint"],
  ],
  back: [
    ["demon", "wings"], ["devil", "wings"], ["dragon", "wings"], ["wings", "wings"],
    ["angel", "wings"], ["fairy", "wings"], ["moth", "wings"], ["winged", "wings"],
    ["archer", "quiver"], ["ranger", "quiver"], ["bow", "quiver"], ["quiver", "quiver"],
    ["samurai", "sheath"], ["katana", "sheath"],
    ["cloak", "cloak"], ["shawl", "cloak"], ["reaper", "cloak"], ["necromancer", "cloak"],
    ["vampire", "cape"], ["count", "cape"], ["king", "cape"], ["hero", "cape"], ["cape", "cape"],
    ["traveler", "pack"], ["courier", "pack"], ["hiker", "pack"], ["pack", "pack"], ["merchant", "pack"],
  ],
  torso: [
    ["knight", "chestplate"], ["paladin", "chestplate"], ["soldier", "chestplate"],
    ["armor", "chestplate"], ["plate", "chestplate"], ["guard", "chestplate"],
    ["wizard", "robe"], ["witch", "robe"], ["mage", "robe"], ["monk", "robe"],
    ["priest", "robe"], ["robe", "robe"], ["sorcer", "robe"], ["shaman", "robe"],
    ["hunter", "vest"], ["rogue", "vest"], ["vest", "vest"], ["cowboy", "vest"], ["bartender", "vest"],
    ["harness", "harness"], ["worker", "harness"], ["climber", "harness"], ["contractor", "harness"],
    ["scarf", "scarf"], ["aviator", "scarf"], ["courier", "scarf"],
  ],
  shoulders: [
    ["knight", "pauldrons"], ["paladin", "pauldrons"], ["pauldron", "pauldrons"],
    ["barbarian", "spikes"], ["orc", "spikes"], ["punk", "spikes"], ["raider", "spikes"],
    ["general", "epaulettes"], ["captain", "epaulettes"], ["admiral", "epaulettes"], ["marshal", "epaulettes"],
  ],
  arms: [
    ["knight", "gauntlets"], ["boxer", "gauntlets"], ["gauntlet", "gauntlets"], ["brawler", "gauntlets"],
    ["archer", "bracers"], ["rogue", "bracers"], ["bracer", "bracers"], ["ranger", "bracers"],
  ],
  legs: [
    ["knight", "greaves"], ["greave", "greaves"], ["paladin", "greaves"],
    ["samurai", "skirt"], ["roman", "skirt"], ["gladiator", "skirt"], ["skirt", "skirt"],
    ["cowboy", "boots"], ["pirate", "boots"], ["hiker", "boots"], ["boots", "boots"], ["ranger", "boots"],
  ],
  material: [
    ["skeleton", "bone"], ["bone", "bone"], ["necromancer", "bone"], ["lich", "bone"],
    ["gold", "gold"], ["royal", "gold"], ["king", "gold"], ["midas", "gold"], ["rich", "gold"],
    ["knight", "metal"], ["robot", "metal"], ["mech", "metal"], ["paladin", "metal"], ["soldier", "metal"],
    ["rogue", "leather"], ["hunter", "leather"], ["cowboy", "leather"], ["bandit", "leather"],
  ],
};

function deriveOutfit(spec: CharacterSpec): Partial<ResolvedOutfit> {
  const text =
    `${spec.name} ${spec.appearance.accessories.join(" ")} ${spec.flavor} ${spec.weapon.name}`.toLowerCase();
  const out: Partial<ResolvedOutfit> = {};
  for (const slot of Object.keys(OUTFIT_KEYWORDS) as (keyof ResolvedOutfit)[]) {
    for (const [kw, value] of OUTFIT_KEYWORDS[slot]) {
      if (text.includes(kw)) {
        (out as Record<string, string>)[slot] = value;
        break;
      }
    }
  }
  return out;
}

function resolveOutfit(spec: CharacterSpec): ResolvedOutfit {
  const given = spec.appearance.outfit ?? {};
  const derived = deriveOutfit(spec);
  return {
    head: given.head ?? derived.head ?? "none",
    face: given.face ?? derived.face ?? "none",
    back: given.back ?? derived.back ?? "none",
    torso: given.torso ?? derived.torso ?? "none",
    shoulders: given.shoulders ?? derived.shoulders ?? "none",
    arms: given.arms ?? derived.arms ?? "none",
    legs: given.legs ?? derived.legs ?? "none",
    material: given.material ?? derived.material ?? "cloth",
  };
}

export interface ResolvedStyle {
  fill: string;
  /** Keyword-derived parametric head accessory (LLM headgear wins). */
  headgear: HeadgearKind | null;
  outline: string;
  accent: string;
  glow: string;
  element: ElementKind;
  weapon: WeaponVisual;
  trail: boolean;
  outfit: ResolvedOutfit;
  /** 0–1 armor heft DERIVED from the balanced defense stat — visual only. */
  bulk: number;
}

/**
 * Compute the full visual style for a spec. Uses already-enriched fields when
 * present so renderers can call this on any spec (old, mock or enriched).
 */
export function resolveStyle(spec: CharacterSpec): ResolvedStyle {
  const fill = safeCssColor(spec.appearance.color);
  const outline = spec.appearance.outline ?? shade(fill, 0.45);
  const accent = spec.appearance.accentColor
    ? safeCssColor(spec.appearance.accentColor, hueShift(fill, 32, 1.1, 1.25))
    : hueShift(fill, 32, 1.1, 1.25);

  const w = spec.weapon;
  const { form } = resolveWeaponIdentity(w);
  const weapon: WeaponVisual = {
    form,
    size: w.size ?? "medium",
    curve: clamp(w.curve ?? (form === "scythe" ? 0.6 : 0), 0, 1),
    spikes: Math.round(clamp(w.spikes ?? 0, 0, 4)),
    doubleEnded: w.doubleEnded ?? false,
    parts: resolveParts(spec, form),
  };

  const element =
    (w.element && w.element !== "none" ? w.element : undefined) ??
    w.vfx?.element ??
    detectElement(`${w.name} ${spec.ability.name}`);
  const glow =
    w.vfx?.glow ?? (element !== "none" ? ELEMENT_GLOW[element] : shade(accent, 1.35));
  const trail = w.vfx?.trail ?? TRAIL_FORMS.includes(form);

  const outfit = resolveOutfit(spec);
  // Heavier defenders wear visibly chunkier armor (stats 32–208 → 0–1).
  const bulk = Math.max(0, Math.min(1, (spec.stats.defense - 32) / 176));

  // Keyword head accessory: reliable fallback beneath any LLM headgear
  // program ("viking" always gets the horned helm).
  const headgear =
    (spec.appearance.headgearKind as HeadgearKind | undefined) ??
    headgearFromText(
      `${spec.name} ${spec.flavor ?? ""} ${(spec.appearance.accessories ?? []).join(" ")} ${spec.appearance.outfit?.head ?? ""}`,
    );

  return { fill, outline, accent, glow, element, weapon, trail, outfit, bulk, headgear };
}

/** Keyword backstop for FUNCTIONAL gear — only when the concept clearly
 * grants it (armor → tanky, wings → double jump). */
function detectGear(spec: CharacterSpec, sourcePrompt = ""): GearItem[] | undefined {
  const have = new Set((spec.appearance.gear ?? []).map((g) => g.kind));
  const text = `${sourcePrompt} ${spec.name} ${spec.flavor ?? ""} ${(spec.appearance.accessories ?? []).join(" ")}`;
  if (!have.has("armor") && /armou?r|plated|iron-?clad|plate ?mail|juggernaut|steel-?clad/i.test(text)) {
    have.add("armor");
  }
  if (!have.has("wings") && /wing(s|ed)?\b|valkyrie|seraph/i.test(text)) {
    have.add("wings");
  }
  if (have.size === 0) return undefined;
  return [...have].map((kind) => ({ kind }));
}

const DEFAULT_MOTIF: Record<AbilitySpec["kind"], AbilityMotif> = {
  aoe: "nova",
  projectile: "orbs",
  dash: "beam",
  shield: "aura",
  heal: "aura",
  buff: "burst",
};

// ---------------------------------------------------------------------------
// Two ability slots: ATTACK (aoe|projectile) and UTILITY (dash|shield|heal|
// buff). The LLM may emit them in either slot or only one — sort what's
// valid, derive what's missing.
// ---------------------------------------------------------------------------

const isAttackKind = (k: AbilitySpec["kind"]) =>
  (ATTACK_ABILITY_KINDS as readonly string[]).includes(k);

/** A composed behavior/script IS a real attack, whatever its kind tag. */
const hasAction = (a?: AbilitySpec) => Boolean(a && (a.behavior || a.customScript));

const ELEMENT_TITLES: Record<Exclude<ElementKind, "none">, string> = {
  fire: "Flame", ice: "Frost", lightning: "Storm", poison: "Venom",
  shadow: "Shadow", holy: "Radiant", arcane: "Arcane",
};

/** In-band attack ability derived from the weapon's identity. */
function deriveAttackAbility(spec: CharacterSpec): AbilitySpec {
  const { type } = resolveWeaponIdentity(spec.weapon);
  const element = spec.weapon.element ?? detectElement(`${spec.weapon.name} ${spec.name}`);
  const kind = type === "melee" ? "aoe" : "projectile";
  const title = element !== "none" ? ELEMENT_TITLES[element] : "Power";
  return {
    name: kind === "aoe" ? `${title} Slam` : `${title} Shot`,
    kind,
    element,
    cooldown: 6,
    power: 14, // mid-band; skips balance, so hand-picked in-band
  };
}

/** In-band utility derived from the fighter's balanced stat shape. */
function deriveUtilityAbility(spec: CharacterSpec): AbilitySpec {
  const s = spec.stats;
  const top = (["speed", "defense", "hp", "strength"] as const).reduce((a, b) =>
    s[a] >= s[b] ? a : b,
  );
  const pick = {
    speed: { name: "Quickstep", kind: "dash" as const },
    defense: { name: "Brace", kind: "shield" as const },
    hp: { name: "Second Wind", kind: "heal" as const },
    strength: { name: "War Cry", kind: "buff" as const }, // armed by ensureActionAbility
  }[top];
  return { ...pick, cooldown: 7, power: 13 };
}

/**
 * NO PURE STAT BOOSTS: a bare `buff` (stat mul, nothing happens on screen)
 * may not be an ability's primary effect. Any buff arriving WITHOUT an
 * authored behavior/script gets a deterministic ACTION attached — themed by
 * its stat — with the stat change demoted to a brief side-rider. Buffs that
 * carry their own behavior already have a real action and pass untouched.
 */
function ensureActionAbility(a: AbilitySpec): AbilitySpec {
  if (a.kind !== "buff" || a.behavior || a.customScript) return a;
  const stat = a.params?.stat ?? "strength";
  const dur = Math.min(6, Math.max(2, a.params?.duration ?? 3));
  const behavior =
    stat === "speed"
      ? {
          // Blitz THROUGH the foe; the speed boost rides along briefly.
          handlers: {
            onCast: [
              { do: "dash", speed: 26, iframes: 0.2 },
              { do: "setTimeScale", target: "self", scale: 1.3, duration: dur },
              { do: "drawBurst", radius: 26 },
              { do: "spawnText", text: "SURGE" },
            ],
          },
        }
      : stat === "defense"
        ? {
            // Ground-shove that clears space; a short ward rides along.
            handlers: {
              onCast: [
                { do: "pushRadial", radius: 110, force: 16 },
                { do: "shield", duration: dur * 0.8, coverage: 0.45 },
                { do: "drawShockwave", radius: 16, expand: 240 },
              ],
            },
          }
        : {
            // Strength: a war-stomp that weakens the foe (relative might).
            handlers: {
              onCast: [
                { do: "dealAoe", damage: 12, radius: 95, knockback: 1.4 },
                { do: "applyStatus", type: "weaken", duration: dur, factor: 0.8 },
                { do: "drawShockwave", radius: 14, expand: 220 },
                { do: "screenShake", intensity: 6, duration: 0.25 },
              ],
            },
          };
  return { ...a, behavior: behavior as never };
}

/**
 * Sort whatever the LLM gave into the two slots, deriving the missing one.
 * Cooldown floors keep dual-casting from being oppressive in 2P.
 */
function resolveAbilitySlots(spec: CharacterSpec): { attack: AbilitySpec; utility: AbilitySpec } {
  let attack: AbilitySpec;
  let utility: AbilitySpec;

  // POSITIONAL classification: the primary slot IS the attack. A composed
  // behavior/customScript qualifies it regardless of its kind tag (a summon
  // attack tagged "buff" stays the attack); kind-based sorting only applies
  // to BARE legacy specs, where kind is all we have to go on.
  if (hasAction(spec.ability) || isAttackKind(spec.ability.kind)) {
    attack = spec.ability;
    // A BARE attack-kind in the utility slot is dropped, not stacked;
    // a composed one is a legitimate second action and stays.
    utility =
      spec.utility && !(isAttackKind(spec.utility.kind) && !hasAction(spec.utility))
        ? spec.utility
        : deriveUtilityAbility(spec);
  } else {
    // The primary slot held a bare utility kind (old single-ability specs).
    utility = spec.ability;
    attack =
      spec.utility && (hasAction(spec.utility) || isAttackKind(spec.utility.kind))
        ? spec.utility
        : deriveAttackAbility(spec);
  }

  return {
    attack: { ...ensureActionAbility(attack), cooldown: Math.max(4, attack.cooldown) },
    utility: { ...ensureActionAbility(utility), cooldown: Math.max(5, utility.cooldown) },
  };
}

/**
 * Fill any ability params the LLM omitted with in-band defaults derived from
 * the already-balanced `power` — same feel as the old single-power scaling.
 */
function defaultAbilityParams(ability: AbilitySpec): AbilityParams {
  const p = ability.power; // balanced: 8–26
  const given = ability.params ?? {};
  const base: AbilityParams = {};
  switch (ability.kind) {
    case "aoe":
      base.radius = Math.round(80 + p * 3.5);
      break;
    case "projectile":
      base.count = 1;
      base.spread = 0;
      base.homing = false;
      break;
    case "dash":
      base.distance = Math.round(Math.min(22, 14 + p * 0.35) * 10) / 10;
      base.iframes = 0.25;
      break;
    case "shield":
      base.duration = Math.round(Math.min(4, 2.2 + p * 0.06) * 10) / 10;
      base.coverage = 0.7;
      break;
    case "heal":
      base.amount = Math.round(Math.min(34, p * 1.3));
      base.overTime = false;
      break;
    case "buff":
      base.stat = "strength";
      base.magnitude = Math.round(Math.min(1.6, 1 + p * 0.03) * 100) / 100;
      base.duration = 4;
      break;
  }
  // Projectiles with an explicit count > 1 default to a visible fan.
  const merged = { ...base, ...given };
  if (ability.kind === "projectile" && (merged.count ?? 1) > 1 && given.spread === undefined) {
    merged.spread = 0.4;
  }
  return merged;
}

/** Write the resolved style back into the spec's optional derived fields. */
export function enrichCharacter(spec: CharacterSpec, sourcePrompt = ""): CharacterSpec {
  // Resolve from a copy with fully-derived fields cleared, so enriching an
  // already enriched spec recomputes rather than echoes.
  const bare: CharacterSpec = {
    ...spec,
    appearance: { ...spec.appearance, accentColor: undefined, outline: undefined },
    weapon: { ...spec.weapon, vfx: undefined },
  };
  const style = resolveStyle(bare);
  const slots = resolveAbilitySlots(spec);
  return {
    ...spec,
    appearance: {
      ...spec.appearance,
      outfit: style.outfit,
      accentColor: style.accent,
      outline: style.outline,
      // AI-drawn head accessory: vetted exactly like weapon renderPrograms;
      // when it's dropped, the keyword shape takes over. The USER PROMPT is
      // part of the keyword text, so "viking berserker" reliably gets the
      // horned helm even when the LLM names him something else.
      headgear: vetProgram(spec.appearance.headgear, `${spec.name} (headgear)`),
      headgearKind:
        headgearFromText(
          `${sourcePrompt} ${spec.name} ${spec.flavor ?? ""} ${(spec.appearance.accessories ?? []).join(" ")} ${spec.appearance.outfit?.head ?? ""}`,
        ) ?? undefined,
      // Functional gear: LLM-emitted, plus a keyword backstop (prompt
      // included) so "armored"/"winged" prompts reliably grant the effect.
      gear: detectGear(spec, sourcePrompt),
    },
    weapon: {
      ...spec.weapon,
      form: style.weapon.form,
      size: style.weapon.size,
      curve: style.weapon.curve,
      spikes: style.weapon.spikes,
      doubleEnded: style.weapon.doubleEnded,
      parts: {
        blade: style.weapon.parts.blade ?? undefined,
        head: style.weapon.parts.head ?? undefined,
        haft: style.weapon.parts.haft,
        guard: style.weapon.parts.guard,
        pommel: style.weapon.parts.pommel,
        adornments: style.weapon.parts.adornments,
        material: style.weapon.parts.material,
      },
      element: style.element,
      behavior: vetProgram(spec.weapon.behavior, spec.weapon.name),
      renderProgram: vetProgram(spec.weapon.renderProgram, `${spec.weapon.name} (render)`),
      vfx: { glow: style.glow, element: style.element, trail: style.trail },
    },
    ability: enrichAbility(slots.attack),
    utility: enrichAbility(slots.utility),
  };
}

/** Fill one slot's derived visual fields + params. */
function enrichAbility(ability: AbilitySpec): AbilitySpec {
  return {
    ...ability,
    element:
      (ability.element && ability.element !== "none" ? ability.element : undefined) ??
      detectElement(ability.name),
    motif: ability.motif ?? DEFAULT_MOTIF[ability.kind],
    params: defaultAbilityParams(ability),
    behavior: vetBehavior(ability),
  };
}

/**
 * The "anything works" guarantee: an LLM-authored behavior only ships if its
 * structure survives sanitizing AND every handler runs headless under the
 * interpreter caps (retried once — rng-dependent paths get a second look).
 * Otherwise the behavior is dropped and the fallback takes over (legacy
 * `kind` for abilities; the plain hit for weapons).
 */
function vetProgram(raw: unknown, owner: string): AbilitySpec["behavior"] {
  if (!raw) return undefined;
  const program = sanitizeBehaviorShape(raw);
  if (!program) return undefined;
  if (smokeTestBehavior(program) || smokeTestBehavior(program)) return program;
  console.warn(`[vibearena] "${owner}" behavior dropped after failing its smoke test.`);
  return undefined;
}

function vetBehavior(ability: AbilitySpec): AbilitySpec["behavior"] {
  return vetProgram(ability.behavior, ability.name);
}
