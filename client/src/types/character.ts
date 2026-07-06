import { z } from "zod";

/** Visual weapon shapes the parametric renderer can draw. */
export const WEAPON_FORMS = [
  "sword", "greatsword", "dagger", "axe", "hammer", "warhammer", "mace",
  "rapier", "spear", "halberd", "scythe", "whip", "flail", "staff", "bow",
  "gun", "cannon", "orb", "shield", "claw", "chakram", "bomb",
  "fist", "gauntlet",
] as const;
export type WeaponForm = (typeof WEAPON_FORMS)[number];

export const WEAPON_SIZES = ["small", "medium", "large"] as const;
export type WeaponSize = (typeof WEAPON_SIZES)[number];

/** Compositional weapon anatomy — drawing only, never mechanics. */
export const BLADE_PROFILES = [
  "straight", "curved", "katana", "scimitar", "rapier", "estoc", "leaf",
  "cleaver", "serrated", "wavy", "kris", "broad", "sickle", "dagger",
] as const;
export type BladeProfile = (typeof BLADE_PROFILES)[number];

export const BLADE_TIPS = ["point", "round", "clipped", "tanto"] as const;
export type BladeTip = (typeof BLADE_TIPS)[number];

export const HEAD_TYPES = [
  "hammer", "spikedBall", "flangedMace", "axeSingle", "axeDouble", "pick",
  "halberd", "warpick",
] as const;
export type HeadType = (typeof HEAD_TYPES)[number];

export const GUARD_TYPES = [
  "none", "crossbar", "circular", "basket", "knuckle", "ornate", "disc",
] as const;
export type GuardType = (typeof GUARD_TYPES)[number];

export const POMMEL_TYPES = ["none", "round", "gem", "spiked", "ring", "skull"] as const;
export type PommelType = (typeof POMMEL_TYPES)[number];

export const ADORNMENTS = [
  "gem", "engraving", "chain", "ribbon", "runes", "feather", "tassel",
] as const;
export type Adornment = (typeof ADORNMENTS)[number];

export const PART_MATERIALS = [
  "steel", "iron", "bronze", "gold", "obsidian", "bone", "wood", "crystal", "energy",
] as const;
export type PartMaterial = (typeof PART_MATERIALS)[number];

/**
 * Mechanical weapon properties — a fixed menu of CODED effects. The LLM only
 * selects kinds and proposes magnitudes; statBudget clamps each magnitude,
 * caps the count, and enforces a total budget that taxes base damage, so a
 * weapon can be wild but never broken.
 */
export const WEAPON_PROPERTY_KINDS = [
  "bleed", // damage-over-time on hit
  "knockback", // extra push
  "lifesteal", // heal a % of damage dealt
  "armorPierce", // ignore some defense
  "reach", // bonus range
  "attackSpeed", // faster swing, less per-hit damage
  "crit", // chance of bonus damage
  "stagger", // longer hitstun on the target
  "cleave", // wider hit arc
  "elementalDot", // element-flavored damage over time
] as const;
export type WeaponPropertyKind = (typeof WEAPON_PROPERTY_KINDS)[number];

export interface WeaponProperty {
  kind: WeaponPropertyKind;
  magnitude: number; // 1–10, budgeted
}

// ---------------------------------------------------------------------------
// Behavior programs — LLM-authored ability logic run by the safe interpreter
// (game/engine). These types are STRUCTURE only; the interpreter is the
// safety guard (verb whitelist, caps, per-action try/catch). NEVER trusted.
// ---------------------------------------------------------------------------

/** One step of a behavior. `do` names an EngineApi verb or a control form
 * (`if` / `repeat` / `wait` / `set`); everything else is that verb's args. */
export interface BehaviorAction {
  do: string;
  [key: string]: unknown;
}

export const BEHAVIOR_HANDLERS = [
  // Ability triggers.
  "onCast", "onTick", "onHit", "onLand",
  // Weapon triggers (weapon.behavior): equip at fight start, active-frame
  // swing moment, and weapon connects. onTick is shared.
  "onEquip", "onAttack", "onHitTarget",
  // Weapon LOOK (weapon.renderProgram): dispatched ~30x/s in the draw pass;
  // draw verbs default to the weapon mount anchor.
  "onRenderWeapon",
  "onRenderHead",
] as const;
export type BehaviorHandler = (typeof BEHAVIOR_HANDLERS)[number];

/** Where the weapon lives — render anchor AND attack origin. */
export const WEAPON_MOUNTS = ["hand", "head", "body", "floating", "dual", "none"] as const;
export type WeaponMount = (typeof WEAPON_MOUNTS)[number];

export interface BehaviorProgram {
  /** Seconds the behavior stays live for onTick/onHit/onLand (capped). */
  duration?: number;
  /** Initial numeric variables, readable/writable via `set` and conds. */
  state?: Record<string, number>;
  handlers: Partial<Record<BehaviorHandler, BehaviorAction[]>>;
}

const MAX_HANDLER_ACTIONS = 40;

/**
 * Pure structural cleanup of an untrusted behavior program: keeps only known
 * handlers holding arrays of `{do: string, ...}` objects (recursively for
 * if/repeat bodies), drops everything else. Returns undefined when there is
 * no usable program. Safety still lives in the interpreter.
 */
export function sanitizeBehaviorShape(raw: unknown): BehaviorProgram | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const src = raw as Record<string, unknown>;
  const handlersSrc =
    typeof src.handlers === "object" && src.handlers !== null
      ? (src.handlers as Record<string, unknown>)
      : src; // tolerate a flat {onCast: [...]} shape

  const cleanActions = (list: unknown, depth: number): BehaviorAction[] => {
    if (!Array.isArray(list) || depth > 6) return [];
    const out: BehaviorAction[] = [];
    for (const item of list.slice(0, MAX_HANDLER_ACTIONS)) {
      if (typeof item !== "object" || item === null) continue;
      const a = { ...(item as Record<string, unknown>) };
      if (typeof a.do !== "string") continue;
      if (Array.isArray(a.then)) a.then = cleanActions(a.then, depth + 1);
      if (Array.isArray(a.else)) a.else = cleanActions(a.else, depth + 1);
      if (Array.isArray(a.each)) a.each = cleanActions(a.each, depth + 1);
      out.push(a as BehaviorAction);
    }
    return out;
  };

  const handlers: BehaviorProgram["handlers"] = {};
  for (const h of BEHAVIOR_HANDLERS) {
    const cleaned = cleanActions(handlersSrc[h], 0);
    if (cleaned.length > 0) handlers[h] = cleaned;
  }
  if (Object.keys(handlers).length === 0) return undefined;

  const program: BehaviorProgram = { handlers };
  if (typeof src.duration === "number" && Number.isFinite(src.duration)) {
    program.duration = src.duration;
  }
  if (typeof src.state === "object" && src.state !== null) {
    const state: Record<string, number> = {};
    for (const [k, v] of Object.entries(src.state as Record<string, unknown>).slice(0, 12)) {
      const n = Number(v);
      if (Number.isFinite(n)) state[k.slice(0, 24)] = n;
    }
    program.state = state;
  }
  return program;
}

/** LLM-designed look for an ability — the default when a behavior doesn't
 * hand-draw its own effects. Colors are snapped in enrich; junk is dropped. */
export interface AbilityVfx {
  /** Main effect color (rings, motifs, projectiles, default particles). */
  primary?: string;
  /** Accent color available to behaviors. */
  secondary?: string;
  particles?: "embers" | "shards" | "orbs" | "feathers" | "sparks";
  shape?: "ring" | "burst" | "wave";
}

export const ABILITY_VFX_PARTICLES = ["embers", "shards", "orbs", "feathers", "sparks"] as const;
export const ABILITY_VFX_SHAPES = ["ring", "burst", "wave"] as const;

/** Shared shape for both ability slots. */
export interface AbilitySpec {
  name: string;
  kind: "dash" | "shield" | "aoe" | "heal" | "projectile" | "buff";
  cooldown: number;
  power: number;
  // LLM-emitted visual/tuning descriptors (snapped/clamped, never raw).
  element?: ElementKind;
  motif?: AbilityMotif;
  vfx?: AbilityVfx;
  params?: AbilityParams;
  /** LLM-authored behavior program (interpreter-guarded); kind is the fallback. */
  behavior?: BehaviorProgram;
  /**
   * Raw-JS escape hatch for mechanics the DSL can't express. Runs once per
   * cast in a shadowed-global sandbox with a watchdog; on any error/timeout
   * the ability falls back to `behavior`, then to the legacy `kind`.
   */
  customScript?: string;
}

/** Which kinds live in which slot (enrich sorts misplaced ones). */
export const ATTACK_ABILITY_KINDS = ["aoe", "projectile"] as const;
export const UTILITY_ABILITY_KINDS = ["dash", "shield", "heal", "buff"] as const;

export interface WeaponParts {
  blade?: {
    profile?: BladeProfile;
    length?: number; // 0–1
    width?: number; // 0–1
    edges?: number; // 1|2
    count?: number; // 1–3
    fuller?: boolean;
    tip?: BladeTip;
  };
  head?: {
    type?: HeadType;
    size?: number; // 0–1
    spikes?: number; // 0–6
  };
  haft?: {
    length?: number; // 0–1
    wrapped?: boolean;
  };
  guard?: GuardType;
  pommel?: PommelType;
  adornments?: Adornment[];
  material?: PartMaterial;
}

export const ELEMENTS = [
  "fire", "ice", "lightning", "poison", "shadow", "holy", "arcane", "none",
] as const;
export type ElementKind = (typeof ELEMENTS)[number];

/** VFX shape an ability takes (visual only — mechanics come from `kind`). */
export const ABILITY_MOTIFS = [
  "nova", "beam", "orbs", "shards", "wave", "aura", "slash", "burst",
] as const;
export type AbilityMotif = (typeof ABILITY_MOTIFS)[number];

export const BUFF_STATS = ["speed", "strength", "defense"] as const;
export type BuffStat = (typeof BUFF_STATS)[number];

/** Functional gear: each kind has BOTH a drawn look and a mechanical effect
 * (armor → +defense, wings → double jump). Opt-in: present only when the
 * concept grants it. Registry lives in game/gear.ts. */
export const GEAR_KINDS = ["armor", "wings"] as const;
export type GearKind = (typeof GEAR_KINDS)[number];
export interface GearItem {
  kind: GearKind;
}

/** Parametric outfit slots — LEGACY (v4.1 dropped the body outfit; the
 * schema still tolerates these fields so old/mock specs validate). */
export const OUTFIT_HEAD = [
  "none", "hat", "tophat", "helmet", "hood", "crown", "cap", "horns", "halo",
] as const;
export const OUTFIT_FACE = ["none", "mask", "visor", "goggles", "warpaint"] as const;
export const OUTFIT_BACK = [
  "none", "cape", "cloak", "wings", "quiver", "pack", "sheath",
] as const;
export const OUTFIT_TORSO = [
  "none", "chestplate", "vest", "robe", "harness", "scarf",
] as const;
export const OUTFIT_SHOULDERS = ["none", "pauldrons", "spikes", "epaulettes"] as const;
export const OUTFIT_ARMS = ["none", "gauntlets", "bracers"] as const;
export const OUTFIT_LEGS = ["none", "boots", "greaves", "skirt"] as const;
export const OUTFIT_MATERIALS = ["cloth", "leather", "metal", "gold", "bone"] as const;

export interface Outfit {
  head?: (typeof OUTFIT_HEAD)[number];
  face?: (typeof OUTFIT_FACE)[number];
  back?: (typeof OUTFIT_BACK)[number];
  torso?: (typeof OUTFIT_TORSO)[number];
  shoulders?: (typeof OUTFIT_SHOULDERS)[number];
  arms?: (typeof OUTFIT_ARMS)[number];
  legs?: (typeof OUTFIT_LEGS)[number];
  material?: (typeof OUTFIT_MATERIALS)[number];
}

/**
 * Per-kind ability tuning, LLM-proposed on loose scales and CLAMPED into
 * fair bands by statBudget — a prompt can flavor an ability, never make it
 * oppressive. After balancing these hold final runtime units.
 */
export interface AbilityParams {
  radius?: number; // aoe
  count?: number; // projectile: 1–5
  spread?: number; // projectile: 0–1 fan width
  homing?: boolean; // projectile
  distance?: number; // dash
  iframes?: number; // dash: seconds of invulnerability
  duration?: number; // shield/buff: seconds
  coverage?: number; // shield: fraction of damage blocked
  amount?: number; // heal
  overTime?: boolean; // heal
  stat?: BuffStat; // buff
  magnitude?: number; // buff
}

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
    /** Legacy free-text trinkets — still validated and used for outfit derivation. */
    accessories: string[];
    height: number; // 0.8–1.2
    /** LEGACY structured outfit — tolerated, no longer rendered (v4.1). */
    outfit?: Outfit;
    accentColor?: string;
    outline?: string;
    /** AI-drawn head accessory (render program, onRenderHead handler);
     * enrich derives a keyword fallback shape when absent. */
    headgear?: BehaviorProgram;
    /** Functional gear — visual + mechanical, opt-in (see game/gear.ts). */
    gear?: GearItem[];
    /** DERIVED by enrich (prompt keywords) — the fallback headgear shape. */
    headgearKind?: string;
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
    /** Compositional anatomy (blade profile, guard, pommel…) — drawing only. */
    parts?: WeaponParts;
    /** Mechanical properties from the fixed menu (clamped + budgeted). */
    properties?: WeaponProperty[];
    /**
     * AI-authored weapon mechanics LAYERED ON the normal swing/hit:
     * onEquip/onTick for passives, onAttack during active frames,
     * onHitTarget on connect. Interpreter-guarded, plain hit is the floor.
     */
    behavior?: BehaviorProgram;
    /** Raw-JS variant, run at the onAttack moment (sandboxed + vetted). */
    customScript?: string;
    /** Where the weapon is anchored (drawn + attacks originate). */
    mount?: WeaponMount;
    /**
     * LLM-DRAWN weapon look: a behavior program whose onRenderWeapon handler
     * paints the weapon each frame with the draw verbs (eye lasers, glowing
     * fists, floating shards…). Vetted like any behavior; on absence/failure
     * the parametric form drawer takes over.
     */
    renderProgram?: BehaviorProgram;
    vfx?: WeaponVfx;
  };
  /** ATTACK ability (kind aoe|projectile after enrich) — its own key + cooldown. */
  ability: AbilitySpec;
  /** UTILITY ability (kind dash|shield|heal|buff after enrich) — second key. */
  utility?: AbilitySpec;
  stats: { hp: number; speed: number; strength: number; defense: number };
  /** Optional block/parry tuning, 0–10 (clamped; defaults derive from stats).
   * MODEST variation only — every fighter shares the same guard system. */
  blockPower?: number;
  parrySkill?: number;
  flavor: string;
}

export const WEAPON_TYPES = ["melee", "ranged", "thrown"] as const;
export const ABILITY_KINDS = ["dash", "shield", "aoe", "heal", "projectile", "buff"] as const;

/** Shared zod shape for both ability slots. */
function abilitySchema() {
  return z.object({
    name: z.string().min(1).max(48),
    kind: z.enum(ABILITY_KINDS),
    cooldown: z.coerce.number().finite(),
    power: z.coerce.number().finite(),
    // Structure was already scrubbed by sanitizeBehaviorShape in normalizeRaw;
    // runtime safety is the interpreter's job, not the schema's.
    behavior: z.unknown().optional(),
    // Sandbox + watchdog guard execution; the schema only bounds size.
    customScript: z.string().min(1).max(4000).optional(),
    element: z.enum(ELEMENTS).optional(),
    motif: z.enum(ABILITY_MOTIFS).optional(),
    vfx: z
      .object({
        primary: z.string().max(32).optional(),
        secondary: z.string().max(32).optional(),
        particles: z.enum(ABILITY_VFX_PARTICLES).optional(),
        shape: z.enum(ABILITY_VFX_SHAPES).optional(),
      })
      .optional(),
    params: z
      .object({
        radius: z.coerce.number().finite().optional(),
        count: z.coerce.number().finite().optional(),
        spread: z.coerce.number().finite().optional(),
        homing: z.boolean().optional(),
        distance: z.coerce.number().finite().optional(),
        iframes: z.coerce.number().finite().optional(),
        duration: z.coerce.number().finite().optional(),
        coverage: z.coerce.number().finite().optional(),
        amount: z.coerce.number().finite().optional(),
        overTime: z.boolean().optional(),
        stat: z.enum(BUFF_STATS).optional(),
        magnitude: z.coerce.number().finite().optional(),
      })
      .optional(),
  });
}

export const characterSpecSchema = z.object({
  name: z.string().min(1).max(48),
  appearance: z.object({
    color: z.string().min(1).max(48),
    accessories: z.array(z.string().max(48)).max(6).default([]),
    height: z.coerce.number().finite(),
    outfit: z
      .object({
        head: z.enum(OUTFIT_HEAD).optional(),
        face: z.enum(OUTFIT_FACE).optional(),
        back: z.enum(OUTFIT_BACK).optional(),
        torso: z.enum(OUTFIT_TORSO).optional(),
        shoulders: z.enum(OUTFIT_SHOULDERS).optional(),
        arms: z.enum(OUTFIT_ARMS).optional(),
        legs: z.enum(OUTFIT_LEGS).optional(),
        material: z.enum(OUTFIT_MATERIALS).optional(),
      })
      .optional(),
    accentColor: z.string().max(48).optional(),
    outline: z.string().max(48).optional(),
    /** AI-drawn head accessory: a render program with onRenderHead. */
    headgear: z.unknown().optional(),
    /** Functional gear (armor/wings) — only when the concept grants it. */
    gear: z.array(z.object({ kind: z.enum(GEAR_KINDS) })).max(3).optional(),
    /** Derived (enrich): keyword-fallback headgear shape. */
    headgearKind: z.string().max(24).optional(),
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
    parts: z
      .object({
        blade: z
          .object({
            profile: z.enum(BLADE_PROFILES).optional(),
            length: z.coerce.number().finite().optional(),
            width: z.coerce.number().finite().optional(),
            edges: z.coerce.number().finite().optional(),
            count: z.coerce.number().finite().optional(),
            fuller: z.boolean().optional(),
            tip: z.enum(BLADE_TIPS).optional(),
          })
          .optional(),
        head: z
          .object({
            type: z.enum(HEAD_TYPES).optional(),
            size: z.coerce.number().finite().optional(),
            spikes: z.coerce.number().finite().optional(),
          })
          .optional(),
        haft: z
          .object({
            length: z.coerce.number().finite().optional(),
            wrapped: z.boolean().optional(),
          })
          .optional(),
        guard: z.enum(GUARD_TYPES).optional(),
        pommel: z.enum(POMMEL_TYPES).optional(),
        adornments: z.array(z.enum(ADORNMENTS)).max(3).optional(),
        material: z.enum(PART_MATERIALS).optional(),
      })
      .optional(),
    properties: z
      .array(
        z.object({
          kind: z.enum(WEAPON_PROPERTY_KINDS),
          magnitude: z.coerce.number().finite(),
        }),
      )
      .max(6)
      .optional(),
    // Weapon behaviors: structure scrubbed in normalizeRaw, guarded at runtime.
    behavior: z.unknown().optional(),
    customScript: z.string().min(1).max(4000).optional(),
    mount: z.enum(WEAPON_MOUNTS).optional(),
    renderProgram: z.unknown().optional(),
    vfx: z
      .object({
        glow: z.string().max(48),
        element: z.enum(ELEMENTS).optional(),
        trail: z.boolean().optional(),
      })
      .optional(),
  }),
  ability: abilitySchema(),
  utility: abilitySchema().optional(),
  stats: z.object({
    hp: z.coerce.number().finite(),
    speed: z.coerce.number().finite(),
    strength: z.coerce.number().finite(),
    defense: z.coerce.number().finite(),
  }),
  blockPower: z.coerce.number().finite().optional(),
  parrySkill: z.coerce.number().finite().optional(),
  flavor: z.string().max(400).default(""),
});

/** Safe fighter used whenever generation or validation fails. */
export const DEFAULT_CHARACTER: CharacterSpec = {
  name: "Chalk Outline",
  appearance: { color: "#f2f0e4", accessories: ["headband"], height: 1 },
  weapon: { type: "melee", name: "Bare Knuckles", range: 5, damage: 6 },
  ability: { name: "Haymaker Burst", kind: "aoe", cooldown: 7, power: 6 },
  utility: { name: "Second Wind", kind: "heal", cooldown: 8, power: 6 },
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
  shield: "shield", block: "shield", barrier: "shield", armor: "shield", reflect: "shield",
  aoe: "aoe", explosion: "aoe", blast: "aoe", slam: "aoe", quake: "aoe", nova: "aoe",
  hazard: "aoe", trap: "aoe", gravity: "aoe",
  heal: "heal", regen: "heal", lifesteal: "heal",
  projectile: "projectile", fireball: "projectile", missile: "projectile",
  bolt: "projectile", ranged: "projectile", shot: "projectile", shoot: "projectile",
  beam: "projectile", laser: "projectile", boomerang: "projectile",
  buff: "buff", rage: "buff", boost: "buff", frenzy: "buff",
  summon: "buff", clone: "buff", transform: "buff",
  spawnentity: "buff", spawn: "buff", minion: "buff", "summon clone": "buff",
};

/**
 * LLMs get close but not exact — map near-miss enum values onto real ones
 * before strict validation so fewer generations fall back to the default.
 */
function normalizeRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  // Overlong strings get truncated rather than sinking the whole spec.
  const trim = (obj: Record<string, unknown> | undefined, field: string, max: number) => {
    if (obj && typeof obj[field] === "string") obj[field] = (obj[field] as string).slice(0, max);
  };
  trim(clone, "name", 48);
  trim(clone, "flavor", 400);
  trim(clone.weapon as Record<string, unknown> | undefined, "name", 48);
  // Unarmed concepts often come back with an empty weapon name — give the
  // fists a name instead of failing the whole spec.
  {
    const w = clone.weapon as Record<string, unknown> | undefined;
    if (w && (typeof w.name !== "string" || w.name.trim().length === 0)) {
      w.name = "Bare Hands";
    }
  }
  trim(clone.ability as Record<string, unknown> | undefined, "name", 48);
  trim(clone.utility as Record<string, unknown> | undefined, "name", 48);
  const app = clone.appearance as Record<string, unknown> | undefined;
  if (app && Array.isArray(app.accessories)) {
    app.accessories = app.accessories
      .filter((a): a is string => typeof a === "string")
      .slice(0, 6)
      .map((a) => a.slice(0, 48));
  }
  trim(app, "color", 48);
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
    // Weapon behavior program + script: same scrubbing as the ability slots.
    if (weapon.behavior !== undefined) {
      const cleaned = sanitizeBehaviorShape(weapon.behavior);
      if (cleaned) weapon.behavior = cleaned;
      else delete weapon.behavior;
    }
    if (weapon.renderProgram !== undefined) {
      const cleaned = sanitizeBehaviorShape(weapon.renderProgram);
      if (cleaned) weapon.renderProgram = cleaned;
      else delete weapon.renderProgram;
    }
    if (typeof weapon.mount === "string") {
      const m = weapon.mount.toLowerCase().trim();
      if ((WEAPON_MOUNTS as readonly string[]).includes(m)) weapon.mount = m;
      else delete weapon.mount;
    } else if (weapon.mount !== undefined) {
      delete weapon.mount;
    }
    if (typeof weapon.customScript === "string") {
      const script = weapon.customScript.trim().slice(0, 4000);
      if (script.length > 0) weapon.customScript = script;
      else delete weapon.customScript;
    } else if (weapon.customScript !== undefined) {
      delete weapon.customScript;
    }
    // Compositional parts: keep only enum-legal / numeric-legal values.
    if (weapon.parts !== undefined && (typeof weapon.parts !== "object" || weapon.parts === null)) {
      delete weapon.parts;
    }
    const parts = weapon.parts as Record<string, unknown> | undefined;
    if (parts) {
      const sanitizeSub = (
        key: string,
        enums: Record<string, readonly string[]>,
        nums: string[],
        bools: string[],
      ) => {
        if (parts[key] !== undefined && (typeof parts[key] !== "object" || parts[key] === null)) {
          delete parts[key];
          return;
        }
        const sub = parts[key] as Record<string, unknown> | undefined;
        if (!sub) return;
        for (const [field, allowed] of Object.entries(enums)) {
          if (typeof sub[field] === "string") {
            const v = (sub[field] as string).trim();
            if (allowed.includes(v)) sub[field] = v;
            else delete sub[field];
          } else if (sub[field] !== undefined) {
            delete sub[field];
          }
        }
        for (const field of nums) {
          if (sub[field] !== undefined && !Number.isFinite(Number(sub[field]))) delete sub[field];
        }
        for (const field of bools) {
          if (sub[field] !== undefined && typeof sub[field] !== "boolean") {
            if (typeof sub[field] === "string") sub[field] = sub[field] === "true";
            else delete sub[field];
          }
        }
      };
      sanitizeSub("blade", { profile: BLADE_PROFILES, tip: BLADE_TIPS }, ["length", "width", "edges", "count"], ["fuller"]);
      sanitizeSub("head", { type: HEAD_TYPES }, ["size", "spikes"], []);
      sanitizeSub("haft", {}, ["length"], ["wrapped"]);
      for (const [field, allowed] of [
        ["guard", GUARD_TYPES],
        ["pommel", POMMEL_TYPES],
        ["material", PART_MATERIALS],
      ] as const) {
        if (typeof parts[field] === "string") {
          const v = (parts[field] as string).trim();
          if ((allowed as readonly string[]).includes(v)) parts[field] = v;
          else delete parts[field];
        } else if (parts[field] !== undefined) {
          delete parts[field];
        }
      }
      if (Array.isArray(parts.adornments)) {
        parts.adornments = parts.adornments
          .filter((a): a is string => typeof a === "string" && (ADORNMENTS as readonly string[]).includes(a))
          .slice(0, 3);
      } else if (parts.adornments !== undefined) {
        delete parts.adornments;
      }
    }
    // Mechanical properties: keep only menu-legal entries with numeric
    // magnitudes; map common aliases; junk never sinks the spec.
    if (Array.isArray(weapon.properties)) {
      const aliases: Record<string, string> = {
        lifedrain: "lifesteal", vampiric: "lifesteal", drain: "lifesteal",
        speed: "attackSpeed", fast: "attackSpeed",
        pierce: "armorPierce", piercing: "armorPierce",
        dot: "elementalDot", burn: "elementalDot",
        critical: "crit",
      };
      weapon.properties = weapon.properties
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => {
          if (typeof p.kind === "string") {
            const key = p.kind.trim();
            p.kind = aliases[key.toLowerCase()] ?? key;
          }
          return p;
        })
        .filter(
          (p) =>
            typeof p.kind === "string" &&
            (WEAPON_PROPERTY_KINDS as readonly string[]).includes(p.kind) &&
            Number.isFinite(Number(p.magnitude)),
        )
        .slice(0, 6);
    } else if (weapon.properties !== undefined) {
      delete weapon.properties;
    }
    // Fully derived fields: recomputed by enrichCharacter, never taken raw.
    delete weapon.archetype;
    delete weapon.vfx;
  }
  const appearance = clone.appearance as Record<string, unknown> | undefined;
  if (appearance) {
    delete appearance.accentColor;
    delete appearance.outline;
    // Outfit slots: keep only enum-legal values (junk must not sink the spec).
    if (appearance.outfit !== undefined && (typeof appearance.outfit !== "object" || appearance.outfit === null)) {
      delete appearance.outfit;
    }
    delete appearance.headgearKind; // derived-only (enrich writes it)
    // headgear: a render program drawn at the head — same sanitizer as
    // weapon renderPrograms; drop it entirely when unusable.
    if (appearance.headgear !== undefined) {
      const hg = sanitizeBehaviorShape(appearance.headgear);
      if (hg && hg.handlers.onRenderHead) appearance.headgear = hg;
      else delete appearance.headgear;
    }
    // gear: whitelist kinds, dedupe, cap.
    if (appearance.gear !== undefined) {
      const rawGear = appearance.gear;
      if (!Array.isArray(rawGear)) delete appearance.gear;
      else {
        const seen = new Set<string>();
        appearance.gear = (rawGear as unknown[])
          .filter((g): g is Record<string, unknown> => typeof g === "object" && g !== null)
          .map((g) => ({ kind: typeof g.kind === "string" ? g.kind.toLowerCase().trim() : "" }))
          .filter((g) => {
            if (!(GEAR_KINDS as readonly string[]).includes(g.kind) || seen.has(g.kind)) return false;
            seen.add(g.kind);
            return true;
          })
          .slice(0, 3);
        if ((appearance.gear as unknown[]).length === 0) delete appearance.gear;
      }
    }
    const outfit = appearance.outfit as Record<string, unknown> | undefined;
    if (outfit) {
      const slots: [string, readonly string[]][] = [
        ["head", OUTFIT_HEAD],
        ["face", OUTFIT_FACE],
        ["back", OUTFIT_BACK],
        ["torso", OUTFIT_TORSO],
        ["shoulders", OUTFIT_SHOULDERS],
        ["arms", OUTFIT_ARMS],
        ["legs", OUTFIT_LEGS],
        ["material", OUTFIT_MATERIALS],
      ];
      for (const [slot, allowed] of slots) {
        if (typeof outfit[slot] === "string") {
          const v = (outfit[slot] as string).toLowerCase().trim();
          if (allowed.includes(v)) outfit[slot] = v;
          else delete outfit[slot];
        } else if (outfit[slot] !== undefined) {
          delete outfit[slot];
        }
      }
    }
  }
  // Both ability slots get the same near-miss mapping + junk stripping.
  const sanitizeAbilitySlot = (slot: "ability" | "utility") => {
    if (clone[slot] !== undefined && (typeof clone[slot] !== "object" || clone[slot] === null)) {
      delete clone[slot];
      return;
    }
    const ability = clone[slot] as Record<string, unknown> | undefined;
    if (!ability) return;
    if (typeof ability.kind === "string") {
      const key = ability.kind.toLowerCase().trim();
      ability.kind = ABILITY_ALIASES[key] ?? key;
    }
    // A behavior program without a kind still needs a legacy fallback kind.
    if (ability.behavior !== undefined) {
      const cleaned = sanitizeBehaviorShape(ability.behavior);
      if (cleaned) ability.behavior = cleaned;
      else delete ability.behavior;
    }
    if (typeof ability.customScript === "string") {
      const script = ability.customScript.trim().slice(0, 4000);
      if (script.length > 0) ability.customScript = script;
      else delete ability.customScript;
    } else if (ability.customScript !== undefined) {
      delete ability.customScript;
    }
    if (ability.behavior !== undefined || ability.customScript !== undefined) {
      if (ability.kind === undefined) ability.kind = slot === "utility" ? "buff" : "aoe";
      if (!Number.isFinite(Number(ability.cooldown))) ability.cooldown = 6;
      if (!Number.isFinite(Number(ability.power))) ability.power = 5;
    }
    const keepAbilityEnum = (field: string, allowed: readonly string[]) => {
      if (typeof ability[field] === "string") {
        const v = (ability[field] as string).toLowerCase().trim();
        if (allowed.includes(v)) ability[field] = v;
        else delete ability[field];
      } else if (ability[field] !== undefined) {
        delete ability[field];
      }
    };
    keepAbilityEnum("element", ELEMENTS);
    keepAbilityEnum("motif", ABILITY_MOTIFS);
    // vfx: keep string colors (snapped later in enrich), snap enums, drop junk.
    if (ability.vfx !== undefined && (typeof ability.vfx !== "object" || ability.vfx === null)) {
      delete ability.vfx;
    }
    const vfx = ability.vfx as Record<string, unknown> | undefined;
    if (vfx) {
      for (const field of ["primary", "secondary"]) {
        if (typeof vfx[field] === "string") vfx[field] = (vfx[field] as string).trim().slice(0, 32);
        else if (vfx[field] !== undefined) delete vfx[field];
      }
      for (const [field, allowed] of [
        ["particles", ABILITY_VFX_PARTICLES],
        ["shape", ABILITY_VFX_SHAPES],
      ] as const) {
        if (typeof vfx[field] === "string" && (allowed as readonly string[]).includes(vfx[field] as string)) {
          continue;
        }
        delete vfx[field];
      }
    }
    if (ability.params !== undefined && (typeof ability.params !== "object" || ability.params === null)) {
      delete ability.params;
    }
    const params = ability.params as Record<string, unknown> | undefined;
    if (params) {
      for (const boolField of ["homing", "overTime"] as const) {
        if (typeof params[boolField] === "string") {
          params[boolField] = params[boolField] === "true";
        } else if (params[boolField] !== undefined && typeof params[boolField] !== "boolean") {
          delete params[boolField];
        }
      }
      if (typeof params.stat === "string") {
        const v = params.stat.toLowerCase().trim();
        if ((BUFF_STATS as readonly string[]).includes(v)) params.stat = v;
        else delete params.stat;
      } else if (params.stat !== undefined) {
        delete params.stat;
      }
      for (const numField of [
        "radius", "count", "spread", "distance", "iframes", "duration",
        "coverage", "amount", "magnitude",
      ] as const) {
        if (params[numField] !== undefined && !Number.isFinite(Number(params[numField]))) {
          delete params[numField];
        }
      }
    }
  };
  sanitizeAbilitySlot("ability");
  sanitizeAbilitySlot("utility");
  return clone;
}

/** Validate an untrusted LLM payload. Returns null instead of throwing. */
export function parseCharacterSpec(raw: unknown): CharacterSpec | null {
  const result = characterSpecSchema.safeParse(normalizeRaw(raw));
  if (!result.success) {
    console.warn(
      "[vibearena] character spec failed validation:",
      JSON.stringify(result.error.flatten().fieldErrors),
      JSON.stringify(result.error.issues.map((i) => i.path.join("."))),
    );
    return null;
  }
  // behavior is z.unknown() in the schema (structure scrubbed in normalizeRaw;
  // the interpreter is the runtime guard), so assert it into the interface.
  return result.data as CharacterSpec;
}
