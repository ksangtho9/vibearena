import type { CharacterSpec, ElementKind, WeaponArchetypeId } from "../types/character";
import { detectElement, mapWeaponArchetype } from "../game/weapons/mapWeapon";
import { hueShift, safeCssColor, shade } from "../render/color";

/**
 * Post-generation normalization: fills the DERIVED visual fields (weapon
 * archetype, VFX, accent/outline colors). Runs after zod validation and the
 * stat budget; the raw values from the model are never trusted (they're
 * stripped in normalizeRaw before validation anyway).
 */

const ELEMENT_GLOW: Record<Exclude<ElementKind, "none">, string> = {
  fire: "#ff9a3c",
  ice: "#7cd7ff",
  lightning: "#ffe95e",
  poison: "#9dff57",
};

/** Archetypes whose attacks read as a swing — these get the ribbon trail. */
const TRAIL_ARCHETYPES: WeaponArchetypeId[] = ["sword", "spear", "staff", "gauntlet"];

export interface ResolvedStyle {
  fill: string;
  outline: string;
  accent: string;
  glow: string;
  element: ElementKind;
  archetype: WeaponArchetypeId;
  trail: boolean;
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
  const archetype = spec.weapon.archetype ?? mapWeaponArchetype(spec.weapon.name, spec.weapon.type);
  const element =
    spec.weapon.vfx?.element ??
    detectElement(`${spec.weapon.name} ${spec.ability.name}`);
  const glow =
    spec.weapon.vfx?.glow ??
    (element !== "none" ? ELEMENT_GLOW[element] : shade(accent, 1.35));
  const trail = spec.weapon.vfx?.trail ?? TRAIL_ARCHETYPES.includes(archetype);
  return { fill, outline, accent, glow, element, archetype, trail };
}

/** Write the resolved style back into the spec's optional derived fields. */
export function enrichCharacter(spec: CharacterSpec): CharacterSpec {
  // Resolve from a copy with derived fields cleared, so enriching an already
  // enriched spec recomputes rather than echoes.
  const bare: CharacterSpec = {
    ...spec,
    appearance: { ...spec.appearance, accentColor: undefined, outline: undefined },
    weapon: { ...spec.weapon, archetype: undefined, vfx: undefined },
  };
  const style = resolveStyle(bare);
  return {
    ...spec,
    appearance: {
      ...spec.appearance,
      accentColor: style.accent,
      outline: style.outline,
    },
    weapon: {
      ...spec.weapon,
      archetype: style.archetype,
      vfx: { glow: style.glow, element: style.element, trail: style.trail },
    },
  };
}
