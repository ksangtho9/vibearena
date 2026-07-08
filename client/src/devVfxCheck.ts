// TEMP dev harness (delete after review): renders EVERY effect kind through
// the real drawEffect and asserts the pixel output is non-blank. A kind that
// pushes but paints nothing FAILS here — the exact bug class that shipped
// invisibly in v3.19.
import { drawEffect } from "./game/effectsRender";
import type { Effect } from "./game/combat";

const CASES: [string, Effect][] = [
  ["shockwave", { kind: "shockwave", x: 60, y: 60, ttl: 0.25, maxTtl: 0.4, color: "#ff8c1a", radius: 14, expand: 120, width: 5, seed: 7 }],
  ["lightning", { kind: "lightning", x: 15, y: 60, x2: 105, y2: 60, ttl: 0.15, maxTtl: 0.22, color: "#9be8ff", width: 2.5, seed: 11 }],
  ["slasharc", { kind: "slasharc", x: 60, y: 60, ttl: 0.15, maxTtl: 0.22, color: "#f2f0e4", radius: 40, a0: -0.9, a1: 0.9, width: 10 }],
  ["flash", { kind: "flash", x: 60, y: 60, ttl: 0.1, maxTtl: 0.18, color: "#ffe6a3", radius: 24, seed: 5 }],
  ["ring", { kind: "ring", x: 60, y: 60, ttl: 0.2, maxTtl: 0.35, color: "#9be8ff", radius: 24 }],
  ["spark", { kind: "spark", x: 60, y: 60, ttl: 0.15, maxTtl: 0.3, color: "#ffe6a3", radius: 14 }],
  ["particle-shard", { kind: "particle", x: 60, y: 60, ttl: 0.3, maxTtl: 0.5, color: "#bfe8f2", size: 6, particleShape: "shard", seed: 3 }],
  ["shape-line", { kind: "shape", shape: "line", x: 20, y: 60, x2: 100, y2: 60, ttl: 0.1, maxTtl: 0.2, color: "#ffffff", width: 3 }],
];

const CELL = 120;
const grid = document.getElementById("grid") as HTMLCanvasElement;
grid.width = CELL * CASES.length;
grid.height = CELL + 24;
const gg = grid.getContext("2d")!;
gg.fillStyle = "#efe9d8";
gg.fillRect(0, 0, grid.width, grid.height);

const results: Record<string, number> = {};
for (let i = 0; i < CASES.length; i++) {
  const [name, effect] = CASES[i];
  // Offscreen render + pixel assertion.
  const off = document.createElement("canvas");
  off.width = CELL;
  off.height = CELL;
  const og = off.getContext("2d")!;
  drawEffect(og, effect, 1.23);
  const data = og.getImageData(0, 0, CELL, CELL).data;
  let painted = 0;
  for (let px = 3; px < data.length; px += 4) if (data[px] > 8) painted++;
  results[name] = painted;
  // Blit into the visible grid + label.
  gg.drawImage(off, i * CELL, 0);
  gg.fillStyle = painted > 0 ? "#1e2521" : "#e0483e";
  gg.font = "bold 11px monospace";
  gg.textAlign = "center";
  gg.fillText(`${name}:${painted}`, i * CELL + CELL / 2, CELL + 15);
  gg.strokeStyle = "rgba(30,37,33,0.3)";
  gg.strokeRect(i * CELL + 0.5, 0.5, CELL - 1, CELL - 1);
}

const failures = Object.entries(results).filter(([, n]) => n === 0).map(([k]) => k);
document.getElementById("out")!.textContent = JSON.stringify({ results, failures }, null, 1);
document.title = failures.length ? `VFX-FAIL:${failures.join(",")}` : "vfx-all-painted";
