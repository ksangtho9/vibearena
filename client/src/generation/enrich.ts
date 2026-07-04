import type {
  CharacterSpec,
  ElementKind,
  WeaponForm,
  WeaponSize,
} from "../types/character";
import { detectElement, mapWeaponForm, snapFormToType } from "../game/weapons/mapWeapon";
import { hueShift, safeCssColor, shade } from "../render/color";

/**
 * Post-generation normalization: snaps the LLM's visual weapon descriptors
 * into range (or derives them from the weapon name when missing) and fills
 * the fully-derived fields (VFX colors, accent/outline). Visual only — the
 * mechanical type/range/damage were already balanced by statBudget.
 */

const ELEMENT_GLOW: Record<Exclude<ElementKind, "none">, string> = {
  fire: "#ff9a3c",
  ice: "#7cd7ff",
  lightning: "#ffe95e",
  poison: "#9dff57",
  shadow: "#9257e8",
  holy: "#ffe6a3",
  arcane: "#ff6bd6",
};

/** Forms whose attacks read as a swing — these get the ribbon trail. */
const TRAIL_FORMS: WeaponForm[] = [
  "sword", "greatsword", "dagger", "axe", "hammer", "spear", "halberd",
  "scythe", "whip", "flail", "staff", "claw",
];

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

export interface WeaponVisual {
  form: WeaponForm;
  size: WeaponSize;
  curve: number;
  spikes: number;
  doubleEnded: boolean;
}

export interface ResolvedStyle {
  fill: string;
  outline: string;
  accent: string;
  glow: string;
  element: ElementKind;
  weapon: WeaponVisual;
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

  const w = spec.weapon;
  const form = snapFormToType(w.form ?? mapWeaponForm(w.name, w.type), w.type);
  const weapon: WeaponVisual = {
    form,
    size: w.size ?? "medium",
    curve: clamp(w.curve ?? (form === "scythe" ? 0.6 : 0), 0, 1),
    spikes: Math.round(clamp(w.spikes ?? 0, 0, 4)),
    doubleEnded: w.doubleEnded ?? false,
  };

  const element =
    (w.element && w.element !== "none" ? w.element : undefined) ??
    w.vfx?.element ??
    detectElement(`${w.name} ${spec.ability.name}`);
  const glow =
    w.vfx?.glow ?? (element !== "none" ? ELEMENT_GLOW[element] : shade(accent, 1.35));
  const trail = w.vfx?.trail ?? TRAIL_FORMS.includes(form);

  return { fill, outline, accent, glow, element, weapon, trail };
}

/** Write the resolved style back into the spec's optional derived fields. */
export function enrichCharacter(spec: CharacterSpec): CharacterSpec {
  // Resolve from a copy with fully-derived fields cleared, so enriching an
  // already enriched spec recomputes rather than echoes.
  const bare: CharacterSpec = {
    ...spec,
    appearance: { ...spec.appearance, accentColor: undefined, outline: undefined },
    weapon: { ...spec.weapon, vfx: undefined },
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
      form: style.weapon.form,
      size: style.weapon.size,
      curve: style.weapon.curve,
      spikes: style.weapon.spikes,
      doubleEnded: style.weapon.doubleEnded,
      element: style.element,
      vfx: { glow: style.glow, element: style.element, trail: style.trail },
    },
  };
}
