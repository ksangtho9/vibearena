import type {
  CharacterSpec,
  ElementKind,
  WeaponForm,
  WeaponParts,
  WeaponProperty,
} from "../../types/character";

/**
 * Deterministic keyword mapping from the LLM's free-text weapon name (plus
 * the coarse mechanical type) onto a drawable weapon FORM, and element
 * detection for VFX. Used when the LLM didn't supply a valid `form`/`element`
 * itself. Visual only — never affects hitboxes or balance.
 */

const FORM_KEYWORDS: Record<WeaponForm, string[]> = {
  sword: [
    "sword", "katana", "blade", "saber", "sabre", "cutlass",
    "machete", "longsword", "falchion", "scimitar", "baguette",
  ],
  greatsword: ["greatsword", "claymore", "zweihander", "buster", "great sword"],
  dagger: ["dagger", "knife", "kunai", "shiv", "stiletto", "dirk", "fang", "dart"],
  axe: ["axe", "hatchet", "cleaver", "tomahawk", "chopper", "battleaxe"],
  hammer: [
    "hammer", "mallet", "gavel", "club", "bat", "cudgel", "bludgeon",
    "skillet", "pan", "wrench", "rolling pin", "chair", "brick", "anvil",
  ],
  warhammer: ["warhammer", "maul", "sledge", "war hammer"],
  mace: ["mace", "morningstar", "morning star", "scepter of war"],
  rapier: ["rapier", "estoc", "needle", "fencing", "epee", "foil"],
  spear: ["spear", "lance", "pike", "trident", "javelin", "harpoon", "skewer", "fork"],
  halberd: ["halberd", "glaive", "polearm", "poleaxe", "naginata", "bardiche"],
  scythe: ["scythe", "sickle", "reaper", "kama"],
  whip: ["whip", "lash", "tendril", "vine", "rope", "ribbon", "tail"],
  flail: ["flail", "chain", "ball and chain", "wrecking"],
  staff: [
    "staff", "stick", "wand", "rod", "cane", "scepter", "sceptre", "broom",
    "pole", "baton", "mop", "umbrella", "oar", "paddle",
  ],
  bow: ["bow", "crossbow", "slingshot", "sling", "arrow", "longbow"],
  gun: [
    "gun", "rifle", "pistol", "blaster", "railgun",
    "musket", "revolver", "shotgun", "laser", "turret",
  ],
  cannon: ["cannon", "mortar", "bazooka", "artillery", "launcher", "howitzer"],
  orb: [
    "orb", "sphere", "crystal", "moonstone", "soul", "spirit", "energy",
    "plasma", "rune", "pearl", "eye", "lantern", "tome",
  ],
  shield: ["shield", "buckler", "aegis", "wall", "door", "lid", "manhole"],
  claw: [
    "claw", "fist", "gauntlet", "glove", "knuckle", "punch", "paw", "talon",
    "nail", "mitt", "boxing", "slap", "hand",
  ],
  chakram: [
    "chakram", "ring", "disc", "disk", "discus", "frisbee", "boomerang",
    "shuriken", "saw", "horseshoe", "record", "card", "coin",
  ],
  bomb: [
    "bomb", "bottle", "grenade", "flask", "vial", "rock", "stone", "egg",
    "tomato", "snowball", "sand", "potion", "mine", "orb of", "ball",
  ],
};

type MechType = CharacterSpec["weapon"]["type"];

/**
 * The FORM is the weapon's identity; its natural mechanical TYPE follows.
 * A hammer form is a melee weapon no matter what `type` tag came with it.
 */
export const FORM_TYPE: Record<WeaponForm, MechType> = {
  sword: "melee", greatsword: "melee", dagger: "melee", axe: "melee",
  hammer: "melee", warhammer: "melee", mace: "melee", rapier: "melee",
  spear: "melee", halberd: "melee", scythe: "melee", whip: "melee",
  flail: "melee", shield: "melee", claw: "melee",
  staff: "ranged", bow: "ranged", gun: "ranged", cannon: "ranged", orb: "ranged",
  chakram: "thrown", bomb: "thrown",
};

/** Genuinely type-ambiguous forms: the LLM's type is honored inside this set. */
const FORM_TYPE_ALLOWED: Partial<Record<WeaponForm, MechType[]>> = {
  staff: ["melee", "ranged"],
  orb: ["ranged", "thrown"],
  dagger: ["melee", "thrown"],
  spear: ["melee", "thrown"],
  axe: ["melee", "thrown"],
  hammer: ["melee", "thrown"],
  chakram: ["thrown", "ranged"],
};

/** Which forms plausibly suit each mechanical type (gap-filling only). */
const TYPE_COMPAT: Record<MechType, WeaponForm[]> = {
  melee: [
    "sword", "greatsword", "dagger", "axe", "hammer", "warhammer", "mace",
    "rapier", "spear", "halberd", "scythe", "whip", "flail", "staff",
    "shield", "claw",
  ],
  ranged: ["bow", "gun", "cannon", "orb", "staff"],
  thrown: ["chakram", "bomb", "dagger", "axe", "spear", "hammer", "orb"],
};

/** Where an incompatible form lands, per mechanical type. */
const TYPE_SNAP: Record<MechType, Partial<Record<WeaponForm, WeaponForm>>> = {
  melee: { gun: "hammer", cannon: "hammer", bow: "staff", orb: "staff", chakram: "sword", bomb: "flail" },
  ranged: { orb: "orb", whip: "staff", sword: "gun" },
  thrown: {
    sword: "dagger", greatsword: "axe", scythe: "chakram", whip: "chakram",
    flail: "bomb", halberd: "spear", shield: "chakram", claw: "dagger",
    staff: "spear", warhammer: "hammer", mace: "hammer", rapier: "dagger",
  },
};

const TYPE_FALLBACK: Record<MechType, WeaponForm> = {
  melee: "sword",
  ranged: "gun",
  thrown: "bomb",
};

/**
 * LAST-RESORT gap filler: force a form to suit a type. Only used when the
 * LLM gave no valid form and we derived one from the name — never to
 * override an explicit form (see resolveWeaponIdentity).
 */
export function snapFormToType(form: WeaponForm, type: MechType): WeaponForm {
  if (TYPE_COMPAT[type].includes(form)) return form;
  return TYPE_SNAP[type][form] ?? TYPE_FALLBACK[type];
}

/**
 * Resolve the weapon's identity with FORM as the source of truth:
 * - explicit valid form → keep it; type = the LLM's type if this form allows
 *   it (throwable axes, melee-or-caster staves), else the form's natural type.
 * - no form → derive one from the name, snapped to the LLM's type (old path).
 */
export function resolveWeaponIdentity(weapon: {
  form?: WeaponForm;
  name: string;
  type: MechType;
}): { form: WeaponForm; type: MechType } {
  if (weapon.form) {
    const allowed = FORM_TYPE_ALLOWED[weapon.form] ?? [FORM_TYPE[weapon.form]];
    const type = allowed.includes(weapon.type) ? weapon.type : FORM_TYPE[weapon.form];
    return { form: weapon.form, type };
  }
  return { form: mapWeaponForm(weapon.name, weapon.type), type: weapon.type };
}

/** Derive the visual form from the weapon's name + mechanical type. */
export function mapWeaponForm(
  name: string,
  type: CharacterSpec["weapon"]["type"],
): WeaponForm {
  const text = name.toLowerCase();
  let best: WeaponForm | null = null;
  let bestScore = 0;

  for (const form of Object.keys(FORM_KEYWORDS) as WeaponForm[]) {
    // Score = summed length of matched keywords ("scythe" beats "eye"),
    // plus a bonus when the form suits the mechanical type.
    let score = 0;
    for (const kw of FORM_KEYWORDS[form]) {
      if (text.includes(kw)) score += kw.length;
    }
    if (score > 0 && TYPE_COMPAT[type].includes(form)) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = form;
    }
  }
  return best ? snapFormToType(best, type) : TYPE_FALLBACK[type];
}

/**
 * Weapon-name keywords → compositional part overrides, so a "katana" looks
 * like a katana even when the LLM didn't emit structured parts. Later
 * entries never overwrite earlier ones (first match per field wins via the
 * merge in enrich). Visual only.
 */
export function derivePartsFromName(name: string): WeaponParts {
  const t = name.toLowerCase();
  const out: WeaponParts = {};
  const blade = (v: NonNullable<WeaponParts["blade"]>) => {
    out.blade = { ...v, ...out.blade };
  };
  const head = (v: NonNullable<WeaponParts["head"]>) => {
    out.head = { ...v, ...out.head };
  };

  // Blade profiles.
  if (t.includes("katana") || t.includes("ronin")) {
    blade({ profile: "katana", edges: 1, tip: "tanto", length: 0.75, width: 0.28 });
    out.guard = out.guard ?? "disc";
    out.haft = { length: 0.35, wrapped: true };
  } else if (t.includes("rapier") || t.includes("needle") || t.includes("fencing")) {
    blade({ profile: "rapier", length: 0.8, width: 0.12, edges: 2, tip: "point" });
    out.guard = out.guard ?? "basket";
  } else if (t.includes("estoc")) {
    blade({ profile: "estoc", length: 0.85, width: 0.15 });
  } else if (t.includes("scimitar") || t.includes("saber") || t.includes("cutlass")) {
    blade({ profile: "scimitar", edges: 1, length: 0.65 });
    out.guard = out.guard ?? "knuckle";
  } else if (t.includes("cleaver") || t.includes("butcher")) {
    blade({ profile: "cleaver", length: 0.4, width: 0.85, edges: 1, tip: "clipped" });
    out.guard = out.guard ?? "none";
  } else if (t.includes("kris") || t.includes("wavy")) {
    blade({ profile: "kris", length: 0.5 });
  } else if (t.includes("serrat") || t.includes("saw") || t.includes("jagged")) {
    blade({ profile: "serrated" });
  } else if (t.includes("sickle") || t.includes("reaper") || t.includes("scythe")) {
    blade({ profile: "sickle", edges: 1 });
  } else if (t.includes("glaive") || t.includes("naginata")) {
    blade({ profile: "curved", edges: 1, length: 0.55 });
  } else if (t.includes("broadsword") || t.includes("broad")) {
    blade({ profile: "broad", width: 0.7 });
  }

  // Heads.
  if (t.includes("warhammer") || t.includes("maul") || t.includes("sledge")) {
    head({ type: "hammer", size: 0.85 });
    out.haft = out.haft ?? { length: 0.7, wrapped: false };
  } else if (t.includes("morningstar") || t.includes("morning star")) {
    head({ type: "spikedBall", spikes: 5 });
  } else if (t.includes("mace")) {
    head({ type: "flangedMace" });
  } else if (t.includes("warpick") || t.includes("war pick")) {
    head({ type: "warpick" });
  } else if (t.includes("pick")) {
    head({ type: "pick" });
  } else if (t.includes("double axe") || t.includes("battleaxe") || t.includes("great axe")) {
    head({ type: "axeDouble", size: 0.8 });
  }

  // Twin / triple blades.
  if (t.includes("twin") || t.includes("double-blade") || t.includes("dual") || t.includes("double blade")) {
    blade({ count: 2 });
  } else if (t.includes("trident") || t.includes("triple")) {
    blade({ count: 3 });
  }

  // Materials.
  if (t.includes("gold") || t.includes("gilded") || t.includes("royal")) out.material = "gold";
  else if (t.includes("obsidian") || t.includes("volcanic")) out.material = "obsidian";
  else if (t.includes("bone") || t.includes("skeletal")) out.material = "bone";
  else if (t.includes("crystal") || t.includes("glass") || t.includes("diamond")) out.material = "crystal";
  else if (t.includes("energy") || t.includes("plasma") || t.includes("laser") || t.includes("light saber") || t.includes("beam")) out.material = "energy";
  else if (t.includes("bronze") || t.includes("ancient") || t.includes("brass")) out.material = "bronze";
  else if (t.includes("rusty") || t.includes("iron") || t.includes("crude")) out.material = "iron";
  else if (t.includes("wooden") || t.includes("oak") || t.includes("training")) out.material = "wood";

  // Details.
  if (t.includes("skull")) out.pommel = "skull";
  const adorn: WeaponParts["adornments"] = [];
  if (t.includes("gem") || t.includes("jewel")) adorn.push("gem");
  if (t.includes("rune") || t.includes("inscrib")) adorn.push("runes");
  if (t.includes("ribbon") || t.includes("silk")) adorn.push("ribbon");
  if (t.includes("tassel")) adorn.push("tassel");
  if (t.includes("feather")) adorn.push("feather");
  if (t.includes("chain")) adorn.push("chain");
  if (t.includes("engrav") || t.includes("ornate")) adorn.push("engraving");
  if (adorn.length) out.adornments = adorn.slice(0, 3);
  if (t.includes("ornate") || t.includes("ceremonial")) out.guard = out.guard ?? "ornate";

  return out;
}

/**
 * Default mechanical properties for weapons whose spec doesn't carry any —
 * derived from the name + form so a katana bleeds and swings fast even when
 * the LLM (or the mock) never emitted properties. Modest magnitudes: the
 * budget tax stays low, keeping "no properties, full damage" a real trade.
 */
export function deriveWeaponProperties(
  name: string,
  form: WeaponForm,
  element: ElementKind,
): WeaponProperty[] {
  const t = name.toLowerCase();

  // Name-driven identities first.
  if (t.includes("katana")) return [{ kind: "bleed", magnitude: 5 }, { kind: "attackSpeed", magnitude: 5 }];
  if (t.includes("rapier") || t.includes("needle")) return [{ kind: "crit", magnitude: 5 }, { kind: "reach", magnitude: 4 }];
  if (t.includes("warhammer") || t.includes("maul") || t.includes("sledge")) return [{ kind: "knockback", magnitude: 6 }, { kind: "stagger", magnitude: 5 }];
  if (t.includes("serrated") || t.includes("jagged") || t.includes("saw")) return [{ kind: "bleed", magnitude: 6 }];
  if (t.includes("vampir") || t.includes("blood") || t.includes("leech")) return [{ kind: "lifesteal", magnitude: 6 }];
  if (t.includes("venom") || t.includes("poison") || t.includes("toxic")) return [{ kind: "elementalDot", magnitude: 5 }];
  if (t.includes("lance") || t.includes("pike")) return [{ kind: "reach", magnitude: 6 }];

  // Form baselines.
  switch (form) {
    case "dagger":
    case "claw":
      return [{ kind: "attackSpeed", magnitude: 5 }, { kind: "crit", magnitude: 3 }];
    case "rapier":
      return [{ kind: "crit", magnitude: 5 }, { kind: "reach", magnitude: 4 }];
    case "warhammer":
      return [{ kind: "knockback", magnitude: 6 }, { kind: "stagger", magnitude: 5 }];
    case "mace":
      return [{ kind: "stagger", magnitude: 4 }, { kind: "knockback", magnitude: 3 }];
    case "cannon":
      return [{ kind: "knockback", magnitude: 4 }];
    case "hammer":
    case "flail":
      return [{ kind: "knockback", magnitude: 5 }, { kind: "stagger", magnitude: 3 }];
    case "greatsword":
    case "axe":
      return [{ kind: "cleave", magnitude: 4 }, { kind: "knockback", magnitude: 3 }];
    case "scythe":
    case "halberd":
      return [{ kind: "cleave", magnitude: 5 }];
    case "spear":
    case "whip":
      return [{ kind: "reach", magnitude: 5 }];
    default:
      // Elemental weapons smolder; plain ones keep their untaxed damage.
      return element !== "none" ? [{ kind: "elementalDot", magnitude: 4 }] : [];
  }
}

const ELEMENT_KEYWORDS: Record<Exclude<ElementKind, "none">, string[]> = {
  fire: ["fire", "flame", "burn", "magma", "lava", "ember", "inferno", "explod", "blaze", "scorch", "solar"],
  ice: ["ice", "frost", "snow", "freez", "glacier", "chill", "winter", "arctic", "cryo"],
  lightning: ["lightning", "thunder", "volt", "storm", "shock", "electric", "spark", "zap", "plasma", "rail"],
  poison: ["poison", "venom", "toxic", "acid", "plague", "rot", "sludge", "bio"],
  shadow: ["shadow", "dark", "night", "void", "umbral", "nether", "doom", "grave", "wraith", "soul", "ghost", "phantom"],
  holy: ["holy", "divine", "sacred", "celestial", "angel", "radiant", "blessed", "sun", "dawn"],
  arcane: ["arcane", "magic", "mystic", "rune", "astral", "eldritch", "mana", "cosmic", "moon", "star", "hex", "witch"],
};

export function detectElement(text: string): ElementKind {
  const lower = text.toLowerCase();
  for (const element of Object.keys(ELEMENT_KEYWORDS) as Exclude<ElementKind, "none">[]) {
    if (ELEMENT_KEYWORDS[element].some((kw) => lower.includes(kw))) return element;
  }
  return "none";
}
