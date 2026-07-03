/**
 * Tiny color toolkit for the renderer. Parses any CSS color via a 1×1 canvas
 * (results memoized), then derives shades, tints, mixes and hue shifts —
 * everything the solid-fill fighter style and weapon VFX need.
 */

export type Rgb = [number, number, number];

let scratch: CanvasRenderingContext2D | null = null;
const parseCache = new Map<string, Rgb>();

export function parseColor(color: string): Rgb {
  const cached = parseCache.get(color);
  if (cached) return cached;

  if (!scratch) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    scratch = canvas.getContext("2d", { willReadFrequently: true });
  }
  let rgb: Rgb = [242, 240, 228]; // chalk fallback
  if (scratch) {
    scratch.clearRect(0, 0, 1, 1);
    scratch.fillStyle = "#f2f0e4";
    scratch.fillStyle = color; // invalid values leave the previous fillStyle
    scratch.fillRect(0, 0, 1, 1);
    const d = scratch.getImageData(0, 0, 1, 1).data;
    rgb = [d[0], d[1], d[2]];
  }
  parseCache.set(color, rgb);
  return rgb;
}

export const rgbCss = ([r, g, b]: Rgb, alpha = 1): string =>
  alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** factor < 1 darkens toward black; factor > 1 lightens toward white. */
export function shade(color: string, factor: number, alpha = 1): string {
  const rgb = parseColor(color);
  const out =
    factor <= 1
      ? (rgb.map((c) => clamp255(c * factor)) as Rgb)
      : (rgb.map((c) => clamp255(c + (255 - c) * (factor - 1))) as Rgb);
  return rgbCss(out, alpha);
}

export function mix(a: string, b: string, t: number, alpha = 1): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return rgbCss(
    [0, 1, 2].map((i) => clamp255(ca[i] + (cb[i] - ca[i]) * t)) as Rgb,
    alpha,
  );
}

export function withAlpha(color: string, alpha: number): string {
  return rgbCss(parseColor(color), alpha);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [clamp255(l * 255), clamp255(l * 255), clamp255(l * 255)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [clamp255(channel(h + 1 / 3) * 255), clamp255(channel(h) * 255), clamp255(channel(h - 1 / 3) * 255)];
}

/** Rotate hue by `deg`, optionally nudging saturation/lightness. */
export function hueShift(color: string, deg: number, satMul = 1, lightMul = 1): string {
  const [h, s, l] = rgbToHsl(parseColor(color));
  return rgbCss(
    hslToRgb([
      (h + deg / 360 + 1) % 1,
      Math.max(0, Math.min(1, s * satMul)),
      Math.max(0.08, Math.min(0.92, l * lightMul)),
    ]),
  );
}

/** Untrusted LLM color → renderable color, or a neutral off-white. */
export function safeCssColor(color: string, fallback = "#f2f0e4"): string {
  const trimmed = (color ?? "").trim();
  if (trimmed && typeof CSS !== "undefined" && CSS.supports("color", trimmed)) return trimmed;
  return fallback;
}
