import type { CharacterSpec, ElementKind, WeaponArchetypeId } from "../../types/character";

/**
 * Deterministic keyword mapping from the LLM's free-text weapon name (plus
 * the coarse weapon type) onto one of the drawn archetypes. The archetype is
 * always DERIVED here — a raw LLM `archetype` value is never trusted.
 */

const KEYWORDS: Record<WeaponArchetypeId, string[]> = {
  sword: [
    "sword", "katana", "blade", "saber", "sabre", "dagger", "knife", "cleaver",
    "machete", "axe", "hatchet", "scythe", "sickle", "rapier", "cutlass", "claymore",
  ],
  spear: [
    "spear", "lance", "pike", "trident", "halberd", "javelin", "polearm",
    "naginata", "glaive", "harpoon", "fork", "skewer",
  ],
  staff: [
    "staff", "stick", "wand", "rod", "cane", "scepter", "sceptre", "broom",
    "pole", "baton", "mop", "umbrella", "pin",
  ],
  bow: [
    "bow", "crossbow", "slingshot", "sling", "gun", "cannon", "rifle", "pistol",
    "launcher", "blaster", "railgun", "musket", "arrow",
  ],
  thrown: [
    "bottle", "bomb", "grenade", "shuriken", "kunai", "rock", "stone", "sand",
    "dart", "horseshoe", "baguette", "chakram", "ball", "brick", "flask", "vial",
    "card", "coin", "egg", "tomato", "snowball", "boomerang",
  ],
  shield: ["shield", "buckler", "aegis", "wall", "door", "lid", "manhole"],
  gauntlet: [
    "fist", "gauntlet", "glove", "knuckle", "claw", "punch", "paw", "hand",
    "slap", "mitt", "boxing",
  ],
  orb: [
    "orb", "sphere", "crystal", "moonstone", "star", "soul", "spirit", "energy",
    "plasma", "void", "rune", "pearl", "eye", "lantern",
  ],
};

/** Which archetypes plausibly match each coarse weapon type. */
const TYPE_COMPAT: Record<CharacterSpec["weapon"]["type"], WeaponArchetypeId[]> = {
  melee: ["sword", "spear", "staff", "shield", "gauntlet"],
  ranged: ["bow", "staff", "orb"],
  thrown: ["thrown", "orb"],
};

const TYPE_FALLBACK: Record<CharacterSpec["weapon"]["type"], WeaponArchetypeId> = {
  melee: "sword",
  ranged: "bow",
  thrown: "thrown",
};

export function mapWeaponArchetype(
  name: string,
  type: CharacterSpec["weapon"]["type"],
): WeaponArchetypeId {
  const text = name.toLowerCase();
  let best: WeaponArchetypeId | null = null;
  let bestScore = 0;

  for (const archetype of Object.keys(KEYWORDS) as WeaponArchetypeId[]) {
    // Score = summed length of matched keywords ("staff" beats "moon"),
    // plus a bonus when the archetype suits the coarse weapon type.
    let score = 0;
    for (const kw of KEYWORDS[archetype]) {
      if (text.includes(kw)) score += kw.length;
    }
    if (score > 0 && TYPE_COMPAT[type].includes(archetype)) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = archetype;
    }
  }
  return best ?? TYPE_FALLBACK[type];
}

const ELEMENT_KEYWORDS: Record<Exclude<ElementKind, "none">, string[]> = {
  fire: ["fire", "flame", "burn", "magma", "lava", "ember", "inferno", "explod", "blaze", "scorch", "solar"],
  ice: ["ice", "frost", "snow", "freez", "glacier", "chill", "winter", "arctic", "cryo"],
  lightning: ["lightning", "thunder", "volt", "storm", "shock", "electric", "spark", "zap", "plasma", "rail"],
  poison: ["poison", "venom", "toxic", "acid", "plague", "rot", "sludge", "bio"],
};

export function detectElement(text: string): ElementKind {
  const lower = text.toLowerCase();
  for (const element of Object.keys(ELEMENT_KEYWORDS) as Exclude<ElementKind, "none">[]) {
    if (ELEMENT_KEYWORDS[element].some((kw) => lower.includes(kw))) return element;
  }
  return "none";
}
