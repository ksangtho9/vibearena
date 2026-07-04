import type { CharacterSpec, ElementKind, WeaponForm } from "../../types/character";

/**
 * Deterministic keyword mapping from the LLM's free-text weapon name (plus
 * the coarse mechanical type) onto a drawable weapon FORM, and element
 * detection for VFX. Used when the LLM didn't supply a valid `form`/`element`
 * itself. Visual only — never affects hitboxes or balance.
 */

const FORM_KEYWORDS: Record<WeaponForm, string[]> = {
  sword: [
    "sword", "katana", "blade", "saber", "sabre", "rapier", "cutlass",
    "machete", "longsword", "falchion", "scimitar", "baguette",
  ],
  greatsword: ["greatsword", "claymore", "zweihander", "buster", "great sword"],
  dagger: ["dagger", "knife", "kunai", "shiv", "stiletto", "dirk", "fang", "needle", "dart"],
  axe: ["axe", "hatchet", "cleaver", "tomahawk", "chopper", "battleaxe"],
  hammer: [
    "hammer", "maul", "mallet", "warhammer", "sledge", "gavel", "club",
    "mace", "bat", "cudgel", "bludgeon", "skillet", "pan", "wrench",
    "rolling pin", "chair", "brick", "anvil",
  ],
  spear: ["spear", "lance", "pike", "trident", "javelin", "harpoon", "skewer", "fork"],
  halberd: ["halberd", "glaive", "polearm", "poleaxe", "naginata", "bardiche"],
  scythe: ["scythe", "sickle", "reaper", "kama"],
  whip: ["whip", "lash", "tendril", "vine", "rope", "ribbon", "tail"],
  flail: ["flail", "morningstar", "chain", "ball and chain", "wrecking"],
  staff: [
    "staff", "stick", "wand", "rod", "cane", "scepter", "sceptre", "broom",
    "pole", "baton", "mop", "umbrella", "oar", "paddle",
  ],
  bow: ["bow", "crossbow", "slingshot", "sling", "arrow", "longbow"],
  gun: [
    "gun", "cannon", "rifle", "pistol", "launcher", "blaster", "railgun",
    "musket", "revolver", "shotgun", "laser", "turret",
  ],
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

/** Which forms plausibly suit each mechanical type. */
const TYPE_COMPAT: Record<CharacterSpec["weapon"]["type"], WeaponForm[]> = {
  melee: [
    "sword", "greatsword", "dagger", "axe", "hammer", "spear", "halberd",
    "scythe", "whip", "flail", "staff", "shield", "claw",
  ],
  ranged: ["bow", "gun", "orb", "staff"],
  thrown: ["chakram", "bomb", "dagger", "axe", "spear", "hammer", "orb"],
};

/** Where an incompatible form lands, per mechanical type. */
const TYPE_SNAP: Record<CharacterSpec["weapon"]["type"], Partial<Record<WeaponForm, WeaponForm>>> = {
  melee: { gun: "hammer", bow: "staff", orb: "staff", chakram: "sword", bomb: "flail" },
  ranged: { orb: "orb", whip: "staff", sword: "gun" },
  thrown: {
    sword: "dagger", greatsword: "axe", scythe: "chakram", whip: "chakram",
    flail: "bomb", halberd: "spear", shield: "chakram", claw: "dagger",
    staff: "spear",
  },
};

const TYPE_FALLBACK: Record<CharacterSpec["weapon"]["type"], WeaponForm> = {
  melee: "sword",
  ranged: "gun",
  thrown: "bomb",
};

/** Force a form to be compatible with the mechanical weapon type. */
export function snapFormToType(
  form: WeaponForm,
  type: CharacterSpec["weapon"]["type"],
): WeaponForm {
  if (TYPE_COMPAT[type].includes(form)) return form;
  return TYPE_SNAP[type][form] ?? TYPE_FALLBACK[type];
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
