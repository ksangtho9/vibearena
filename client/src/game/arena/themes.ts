import { withAlpha } from "../../render/color";
import type { PlatformRect } from "../arena";

/**
 * Themed parallax backdrops, drawn procedurally (flat-color canvas polygons,
 * soft edges, atmospheric fade with distance) — no external art assets.
 *
 * A theme is an ordered layer manifest, back → front. Each layer only knows
 * how to paint world-space geometry; the renderer in loop.ts applies the
 * camera transform for the layer's parallax factor before calling draw().
 * That keeps the door open for painted PNG/SVG layers later: an image layer
 * implements the same ThemeLayer interface with a drawImage call — no other
 * code changes.
 *
 * Arena theming is a client/render concern only — it is deliberately NOT part
 * of CharacterSpec.
 */

export interface ThemeView {
  w: number;
  h: number;
  time: number;
  groundY: number;
}

export interface ThemeLayer {
  /** 0 = pinned to camera (infinitely far) … 1 = world plane … >1 foreground. */
  parallax: number;
  draw(ctx: CanvasRenderingContext2D, view: ThemeView): void;
}

export interface ArenaTheme {
  name: string;
  /** Screen-space backdrop, drawn before any world transform. */
  drawSky(ctx: CanvasRenderingContext2D, view: ThemeView): void;
  /** World-space layers behind the fighters, back → front (includes ground). */
  layers: ThemeLayer[];
  /** World-space layers in front of the fighters (parallax > 1). */
  foreground: ThemeLayer[];
  /**
   * A one-way platform on the FIGHT PLANE (gameplay object, not parallaxed) —
   * themed to match the flat painterly look.
   */
  drawPlatform(ctx: CanvasRenderingContext2D, rect: PlatformRect): void;
}

export const THEME_NAMES = ["meadow", "canyon"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** Horizontal extent the layers cover (world coords; arena is 0..960). */
const SPAN_MIN = -900;
const SPAN_MAX = 1860;

/** Deterministic RNG so a theme's geometry is stable for the whole match. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polygon(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A stylized pine: stacked soft triangles on a short trunk. */
function drawPine(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  height: number,
  foliage: string,
  trunk?: string,
): void {
  const w = height * 0.42;
  if (trunk) {
    ctx.fillStyle = trunk;
    ctx.fillRect(x - height * 0.035, baseY - height * 0.16, height * 0.07, height * 0.18);
  }
  for (let tier = 0; tier < 3; tier++) {
    const ty = baseY - height * (0.1 + tier * 0.26);
    const tw = w * (1 - tier * 0.24);
    const th = height * 0.38;
    polygon(ctx, [[x - tw / 2, ty], [x + tw / 2, ty], [x, ty - th]], foliage);
  }
}

/** A soft-edged boulder: irregular rounded polygon with a lit top. */
function drawBoulder(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  x: number,
  baseY: number,
  r: number,
  fill: string,
  lit: string,
): void {
  const pts: [number, number][] = [];
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - (i / n) * Math.PI; // half-dome, left → right
    const rr = r * (0.85 + rand() * 0.3);
    pts.push([x + Math.cos(a) * rr, baseY - Math.max(0, Math.sin(a)) * rr * 0.78]);
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], baseY + 2);
  for (const [px, py] of pts) ctx.lineTo(px, py);
  ctx.lineTo(pts[pts.length - 1][0], baseY + 2);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  // Lit crown.
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, baseY - r * 0.72, r * 0.75, r * 0.4, -0.25, 0, Math.PI * 2);
  ctx.fillStyle = lit;
  ctx.fill();
  ctx.restore();
}

/** Clump of tapered grass blades — used dark and large in the foreground. */
function drawGrassClump(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  x: number,
  baseY: number,
  size: number,
  fill: string,
  blades = 7,
): void {
  for (let i = 0; i < blades; i++) {
    const bx = x + (rand() - 0.5) * size * 1.6;
    const lean = (rand() - 0.5) * size * 0.7;
    const hgt = size * (0.6 + rand() * 0.8);
    polygon(
      ctx,
      [[bx - size * 0.07, baseY], [bx + size * 0.07, baseY], [bx + lean, baseY - hgt]],
      fill,
    );
  }
}

// ---------------------------------------------------------------------------
// Meadow — green field, tan boulders, pine treeline, misty depth.
// ---------------------------------------------------------------------------

function createMeadow(seed: number): ArenaTheme {
  const rand = mulberry32(seed);

  // Precompute stable geometry.
  const farHills: { x: number; w: number; h: number }[] = [];
  for (let x = SPAN_MIN; x < SPAN_MAX; x += 420) {
    farHills.push({ x: x + rand() * 200, w: 520 + rand() * 320, h: 120 + rand() * 90 });
  }
  const treeline: { x: number; h: number }[] = [];
  for (let x = SPAN_MIN; x < SPAN_MAX; x += 46) {
    treeline.push({ x: x + rand() * 26, h: 90 + rand() * 70 });
  }
  const midPines = Array.from({ length: 7 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    h: 130 + rand() * 80,
  }));
  const boulders = Array.from({ length: 5 }, () => ({
    x: SPAN_MIN + 200 + rand() * (SPAN_MAX - SPAN_MIN - 400),
    r: 34 + rand() * 40,
    seed: Math.floor(rand() * 1e9),
  }));
  const patches = Array.from({ length: 14 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    y: 18 + rand() * 120,
    rx: 50 + rand() * 90,
    ry: 8 + rand() * 14,
  }));
  const tufts = Array.from({ length: 26 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    y: rand() * 90,
    size: 7 + rand() * 9,
    seed: Math.floor(rand() * 1e9),
  }));
  const fgClumps = Array.from({ length: 4 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    size: 34 + rand() * 26,
    seed: Math.floor(rand() * 1e9),
  }));

  return {
    name: "Meadow",
    drawSky(ctx, v) {
      const sky = ctx.createLinearGradient(0, 0, 0, v.h);
      sky.addColorStop(0, "#b9d4de");
      sky.addColorStop(0.55, "#dde8d9");
      sky.addColorStop(1, "#eef0da");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, v.w, v.h);
      // Soft sun glow, upper right.
      const sun = ctx.createRadialGradient(v.w * 0.74, v.h * 0.2, 0, v.w * 0.74, v.h * 0.2, v.h * 0.42);
      sun.addColorStop(0, "rgba(255, 249, 224, 0.85)");
      sun.addColorStop(0.35, "rgba(255, 246, 214, 0.28)");
      sun.addColorStop(1, "rgba(255, 246, 214, 0)");
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, v.w, v.h);
    },
    layers: [
      {
        // Distant hills, heavily atmospheric.
        parallax: 0.1,
        draw(ctx, v) {
          for (const hill of farHills) {
            ctx.beginPath();
            ctx.ellipse(hill.x, v.groundY - 150, hill.w, hill.h, 0, Math.PI, 0);
            ctx.closePath();
            ctx.fillStyle = "rgba(168, 189, 180, 0.55)";
            ctx.fill();
          }
        },
      },
      {
        // Pine treeline silhouette with mist at its feet.
        parallax: 0.28,
        draw(ctx, v) {
          ctx.fillStyle = "#8ba692";
          ctx.fillRect(SPAN_MIN, v.groundY - 118, SPAN_MAX - SPAN_MIN, 24);
          for (const tree of treeline) {
            drawPine(ctx, tree.x, v.groundY - 96, tree.h, "#8ba692");
          }
          // Drifting mist band.
          const drift = Math.sin(v.time * 0.12) * 30;
          const mist = ctx.createLinearGradient(0, v.groundY - 170, 0, v.groundY - 40);
          mist.addColorStop(0, "rgba(228, 236, 226, 0)");
          mist.addColorStop(0.55, "rgba(228, 236, 226, 0.5)");
          mist.addColorStop(1, "rgba(228, 236, 226, 0.08)");
          ctx.fillStyle = mist;
          ctx.fillRect(SPAN_MIN + drift, v.groundY - 170, SPAN_MAX - SPAN_MIN, 130);
        },
      },
      {
        // Mid-ground pines and tan boulders.
        parallax: 0.55,
        draw(ctx, v) {
          for (const pine of midPines) {
            drawPine(ctx, pine.x, v.groundY - 8, pine.h, "#5c7f58", "#6d5738");
          }
          for (const b of boulders) {
            drawBoulder(ctx, mulberry32(b.seed), b.x, v.groundY + 2, b.r, "#c0a67c", "#d8c49a");
          }
        },
      },
      {
        // The meadow ground plane itself.
        parallax: 1,
        draw(ctx, v) {
          ctx.fillStyle = "#7ca157";
          ctx.fillRect(SPAN_MIN, v.groundY, SPAN_MAX - SPAN_MIN, 460);
          // Horizon edge highlight.
          ctx.fillStyle = "rgba(235, 240, 205, 0.5)";
          ctx.fillRect(SPAN_MIN, v.groundY, SPAN_MAX - SPAN_MIN, 2.5);
          // Darker grass patches for depth.
          ctx.fillStyle = "rgba(84, 116, 58, 0.4)";
          for (const p of patches) {
            ctx.beginPath();
            ctx.ellipse(p.x, v.groundY + p.y, p.rx, p.ry, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          for (const t of tufts) {
            drawGrassClump(ctx, mulberry32(t.seed), t.x, v.groundY + t.y + 4, t.size, "#5b8342", 5);
          }
        },
      },
    ],
    foreground: [
      {
        parallax: 1.18,
        draw(ctx, v) {
          for (const c of fgClumps) {
            drawGrassClump(ctx, mulberry32(c.seed), c.x, v.groundY + 120, c.size, "rgba(45, 66, 38, 0.9)", 9);
          }
        },
      },
    ],
    drawPlatform(ctx, rect) {
      const x = rect.cx - rect.w / 2;
      // Wooden ledge: plank slab with seams and a grassy lip.
      ctx.beginPath();
      ctx.roundRect(x, rect.top, rect.w, rect.h, 4);
      ctx.fillStyle = "#8a6844";
      ctx.fill();
      ctx.strokeStyle = "rgba(74, 52, 30, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Plank seams + end caps.
      ctx.strokeStyle = "rgba(74, 52, 30, 0.5)";
      ctx.lineWidth = 1.2;
      for (let px = x + 26; px < x + rect.w - 12; px += 30) {
        ctx.beginPath();
        ctx.moveTo(px, rect.top + 3);
        ctx.lineTo(px, rect.top + rect.h - 3);
        ctx.stroke();
      }
      // Grass lip on the walkable top.
      ctx.fillStyle = "#7ca157";
      ctx.beginPath();
      ctx.roundRect(x - 2, rect.top - 3, rect.w + 4, 6, 3);
      ctx.fill();
      const rr = mulberry32(Math.floor(rect.cx * 7919));
      for (let i = 0; i < 5; i++) {
        const gx = x + 8 + rr() * (rect.w - 16);
        polygon(ctx, [[gx - 2, rect.top - 2], [gx + 2, rect.top - 2], [gx + (rr() - 0.5) * 5, rect.top - 8 - rr() * 4]], "#5b8342");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Desert Canyon — warm haze, layered mesas, red rock, sandy floor.
// ---------------------------------------------------------------------------

function createCanyon(seed: number): ArenaTheme {
  const rand = mulberry32(seed);

  const farMesas: { x: number; w: number; h: number; cap: number }[] = [];
  for (let x = SPAN_MIN; x < SPAN_MAX; x += 380) {
    farMesas.push({
      x: x + rand() * 160,
      w: 260 + rand() * 220,
      h: 150 + rand() * 110,
      cap: 30 + rand() * 40,
    });
  }
  const midRocks = Array.from({ length: 5 }, () => ({
    x: SPAN_MIN + 150 + rand() * (SPAN_MAX - SPAN_MIN - 300),
    w: 120 + rand() * 140,
    h: 140 + rand() * 120,
    lean: (rand() - 0.5) * 40,
  }));
  const cacti = Array.from({ length: 4 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    h: 46 + rand() * 30,
  }));
  const cracks = Array.from({ length: 12 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    y: 16 + rand() * 110,
    len: 40 + rand() * 90,
    bend: (rand() - 0.5) * 40,
  }));
  const pebbles = Array.from({ length: 22 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    y: 10 + rand() * 120,
    r: 2 + rand() * 5,
  }));
  const fgRocks = Array.from({ length: 3 }, () => ({
    x: SPAN_MIN + rand() * (SPAN_MAX - SPAN_MIN),
    r: 60 + rand() * 60,
    seed: Math.floor(rand() * 1e9),
  }));

  return {
    name: "Desert Canyon",
    drawSky(ctx, v) {
      const sky = ctx.createLinearGradient(0, 0, 0, v.h);
      sky.addColorStop(0, "#f0bf85");
      sky.addColorStop(0.6, "#eed9b0");
      sky.addColorStop(1, "#e8dcc0");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, v.w, v.h);
      const sun = ctx.createRadialGradient(v.w * 0.3, v.h * 0.24, 0, v.w * 0.3, v.h * 0.24, v.h * 0.3);
      sun.addColorStop(0, "rgba(255, 244, 214, 0.95)");
      sun.addColorStop(0.3, "rgba(255, 238, 200, 0.3)");
      sun.addColorStop(1, "rgba(255, 238, 200, 0)");
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, v.w, v.h);
    },
    layers: [
      {
        // Hazy distant mesas.
        parallax: 0.12,
        draw(ctx, v) {
          for (const m of farMesas) {
            polygon(
              ctx,
              [
                [m.x - m.w / 2, v.groundY - 130],
                [m.x - m.w / 2 + 30, v.groundY - 130 - m.h],
                [m.x - m.w / 2 + 30 + m.cap, v.groundY - 130 - m.h],
                [m.x + m.w / 2, v.groundY - 130 - m.h * 0.4],
                [m.x + m.w / 2 + 20, v.groundY - 130],
              ],
              "rgba(203, 141, 110, 0.5)",
            );
          }
          // Heat haze band at the horizon.
          const haze = ctx.createLinearGradient(0, v.groundY - 190, 0, v.groundY - 90);
          haze.addColorStop(0, "rgba(240, 219, 180, 0)");
          haze.addColorStop(1, "rgba(240, 219, 180, 0.55)");
          ctx.fillStyle = haze;
          ctx.fillRect(SPAN_MIN, v.groundY - 190, SPAN_MAX - SPAN_MIN, 100);
        },
      },
      {
        // Mid canyon walls with strata lines, plus cactus silhouettes.
        parallax: 0.5,
        draw(ctx, v) {
          for (const r of midRocks) {
            const baseL = r.x - r.w / 2;
            const baseR = r.x + r.w / 2;
            polygon(
              ctx,
              [
                [baseL, v.groundY + 4],
                [baseL + 14 + r.lean, v.groundY - r.h * 0.72],
                [r.x - r.w * 0.12 + r.lean, v.groundY - r.h],
                [r.x + r.w * 0.2 + r.lean, v.groundY - r.h * 0.92],
                [baseR - 10 + r.lean * 0.5, v.groundY - r.h * 0.5],
                [baseR, v.groundY + 4],
              ],
              "#b06a4a",
            );
            // Strata.
            ctx.strokeStyle = "rgba(122, 62, 42, 0.55)";
            ctx.lineWidth = 3;
            for (let i = 1; i <= 3; i++) {
              const y = v.groundY - (r.h * i) / 4.4;
              ctx.beginPath();
              ctx.moveTo(baseL + 10 + r.lean * (i / 4), y + 6);
              ctx.lineTo(baseR - 12 + r.lean * (i / 5), y - 4);
              ctx.stroke();
            }
          }
          ctx.fillStyle = "#7e8a4e";
          for (const c of cacti) {
            ctx.beginPath();
            ctx.roundRect(c.x - 4, v.groundY - c.h, 8, c.h, 4);
            ctx.roundRect(c.x - 16, v.groundY - c.h * 0.72, 6, c.h * 0.3, 3);
            ctx.roundRect(c.x - 16, v.groundY - c.h * 0.46, 18, 6, 3);
            ctx.roundRect(c.x + 10, v.groundY - c.h * 0.62, 6, c.h * 0.24, 3);
            ctx.roundRect(c.x - 2, v.groundY - c.h * 0.42, 18, 6, 3);
            ctx.fill();
          }
        },
      },
      {
        // Sandy canyon floor.
        parallax: 1,
        draw(ctx, v) {
          ctx.fillStyle = "#d8b57f";
          ctx.fillRect(SPAN_MIN, v.groundY, SPAN_MAX - SPAN_MIN, 460);
          ctx.fillStyle = "rgba(255, 238, 200, 0.6)";
          ctx.fillRect(SPAN_MIN, v.groundY, SPAN_MAX - SPAN_MIN, 2.5);
          // Cracked earth.
          ctx.strokeStyle = "rgba(150, 111, 71, 0.6)";
          ctx.lineWidth = 1.6;
          for (const c of cracks) {
            ctx.beginPath();
            ctx.moveTo(c.x, v.groundY + c.y);
            ctx.quadraticCurveTo(
              c.x + c.len / 2 + c.bend,
              v.groundY + c.y + 6,
              c.x + c.len,
              v.groundY + c.y - 3,
            );
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(150, 111, 71, 0.5)";
          for (const p of pebbles) {
            ctx.beginPath();
            ctx.ellipse(p.x, v.groundY + p.y, p.r, p.r * 0.6, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        },
      },
    ],
    foreground: [
      {
        parallax: 1.16,
        draw(ctx, v) {
          for (const rock of fgRocks) {
            drawBoulder(
              ctx,
              mulberry32(rock.seed),
              rock.x,
              v.groundY + 150,
              rock.r,
              "rgba(84, 52, 38, 0.92)",
              withAlpha("#7a4a34", 0.9),
            );
          }
        },
      },
    ],
    drawPlatform(ctx, rect) {
      const x = rect.cx - rect.w / 2;
      // Rock shelf: uneven slab with a strata line and a sunlit top edge.
      polygon(
        ctx,
        [
          [x + 3, rect.top],
          [x + rect.w - 5, rect.top],
          [x + rect.w, rect.top + rect.h * 0.55],
          [x + rect.w - 10, rect.top + rect.h],
          [x + 8, rect.top + rect.h],
          [x - 3, rect.top + rect.h * 0.5],
        ],
        "#b06a4a",
      );
      ctx.strokeStyle = "rgba(122, 62, 42, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 6, rect.top + rect.h * 0.62);
      ctx.lineTo(x + rect.w - 8, rect.top + rect.h * 0.55);
      ctx.stroke();
      // Sunlit walkable top.
      ctx.fillStyle = "rgba(240, 205, 160, 0.85)";
      ctx.beginPath();
      ctx.roundRect(x + 3, rect.top - 2, rect.w - 8, 4.5, 2);
      ctx.fill();
    },
  };
}

// ---------------------------------------------------------------------------

const FACTORIES: Record<ThemeName, (seed: number) => ArenaTheme> = {
  meadow: createMeadow,
  canyon: createCanyon,
};

/** Build a theme (random unless named). One per match — geometry is stable. */
export function createTheme(name?: ThemeName): ArenaTheme {
  const pick = name ?? THEME_NAMES[Math.floor(Math.random() * THEME_NAMES.length)];
  return FACTORIES[pick](Math.floor(Math.random() * 2 ** 31));
}
