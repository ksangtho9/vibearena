// TEMP dev harness (delete after review): renders EVERY weapon form through
// the real skeletal path (createFighter + animator idle + renderFighter) and
// pixel-asserts the weapon actually painted — by diffing against the same
// fighter rendered with an empty weapon draw (weaponless baseline is not
// constructible, so we compare against a body-only render via mount "none",
// accepting pose differences; threshold is generous).
import Matter from "matter-js";
import { parseCharacterSpec } from "./types/character";
import { balanceCharacter } from "./balance/statBudget";
import { enrichCharacter } from "./generation/enrich";
import { createFighter, renderFighter } from "./game/stickman";
import { bonesFor, createAnimator, type AnimInputs } from "./game/animation";

const FORMS: [string, string, string?][] = [
  ["sword", "melee"], ["greatsword", "melee"], ["dagger", "melee"], ["rapier", "melee"],
  ["axe", "melee"], ["hammer", "melee"], ["mace", "melee"], ["flail", "melee"],
  ["spear", "melee"], ["halberd", "melee"], ["scythe", "melee"], ["whip", "melee"],
  ["staff", "melee"], ["shield", "melee"], ["fist", "melee"], ["claw", "melee"],
  ["bow", "ranged"], ["gun", "ranged"], ["orb", "ranged"], ["wand", "ranged"],
  ["sword", "melee", "dual"], ["gun", "ranged", "head"],
  ["orb", "ranged", "floating"], ["cannon", "ranged", "body"],
];

const CELL = 120;
const grid = document.getElementById("grid") as HTMLCanvasElement;
grid.width = CELL * 10;
grid.height = (CELL + 20) * 2;
const gg = grid.getContext("2d")!;
gg.fillStyle = "#efe9d8";
gg.fillRect(0, 0, grid.width, grid.height);

const world = Matter.Composite.create();
const results: Record<string, number> = {};

const renderOne = (form: string, type: string, mount: string | undefined): number => {
  const spec = enrichCharacter(balanceCharacter(parseCharacterSpec({
    name: `T ${form}`,
    appearance: { color: "#8f959e", accessories: [], height: 1 },
    weapon: { type, name: `Test ${form}`, form, size: "medium", range: 6, damage: 7, ...(mount ? { mount } : {}) },
    ability: { name: "A", kind: "aoe", element: "none", motif: "nova", params: {}, cooldown: 6, power: 6 },
    utility: { name: "U", kind: "dash", element: "none", motif: "beam", params: {}, cooldown: 6, power: 5 },
    stats: { hp: 6, speed: 6, strength: 6, defense: 5 },
    flavor: "t",
  })!));
  const f = createFighter(world as unknown as Matter.World, spec, CELL * 0.45, 100, "player");
  const anim = createAnimator(bonesFor(1));
  const base: AnimInputs = {
    rootX: CELL * 0.45, rootY: 56, vx: 0, vy: 0, grounded: true, facing: 1, moving: false,
    alive: true, blocking: false, attackElapsed: -1,
    weaponForm: spec.weapon.form as never, weaponSize: "medium", weaponType: spec.weapon.type as never,
    weaponMount: (spec.weapon.mount ?? "hand") as never,
    castTimer: 0, hitstunTimer: 0, launchedTimer: 0, groundY: 100, time: 0,
  };
  let t = 0;
  let frame = anim.update(1 / 60, { ...base, time: t });
  for (let i = 0; i < 40; i++) { t += 1 / 60; frame = anim.update(1 / 60, { ...base, time: t }); }
  f.skeleton = frame.skeleton;
  f.weaponAngle = frame.weaponAngle;
  f.weaponSmear = frame.smear ?? null;
  const off = document.createElement("canvas");
  off.width = CELL;
  off.height = CELL;
  const og = off.getContext("2d")!;
  renderFighter(og, f, t, 100);
  const data = og.getImageData(0, 0, CELL, CELL).data;
  let painted = 0;
  for (let px = 3; px < data.length; px += 4) if (data[px] > 8) painted++;
  return painted;
};

// Body-only baseline: unarmed (mount none draws no weapon at all).
const baseline = renderOne("sword", "melee", "none");

FORMS.forEach(([form, type, mount], i) => {
  let painted = -1;
  try {
    painted = renderOne(form, type, mount);
  } catch {
    painted = -1; // render threw
  }
  results[mount ? `${form}@${mount}` : form] = painted;
  const col = i % 10;
  const row = Math.floor(i / 10);
  const y0 = row * (CELL + 20);
  // Re-render into the grid for eyeballing.
  gg.fillStyle = painted > baseline + 60 ? "#1e2521" : "#e0483e";
  gg.font = "bold 10px monospace";
  gg.textAlign = "center";
  gg.fillText(`${form}:${painted - baseline}`, col * CELL + CELL / 2, y0 + CELL + 13);
});

const failures = FORMS.filter(([f, , m]) => results[m ? `${f}@${m}` : f] <= baseline + 60).map(
  ([f, , m]) => (m ? `${f}@${m}` : f),
);
document.getElementById("out")!.textContent = JSON.stringify({ baseline, results, failures }, null, 1);
document.title = failures.length ? `WEAPON-FAIL:${failures.join(",")}` : "weapons-all-painted";
