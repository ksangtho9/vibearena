// TEMP dev harness (delete after review): deterministically renders one
// keyframed slash as a labeled horizontal frame strip — coil, smear,
// contact, follow — without needing live rAF.
import Matter from "matter-js";
import { parseCharacterSpec } from "./types/character";
import { balanceCharacter } from "./balance/statBudget";
import { enrichCharacter } from "./generation/enrich";
import { createFighter, renderFighter } from "./game/stickman";
import { bonesFor, createAnimator, ATTACK_TIMINGS, FINISHER_TIMINGS, type AnimInputs, type AttackStyle } from "./game/animation";

// ?style=<family>&variant=0..3 renders that family's combo swing (3 = its
// finisher, on the family's own finisher timing).
// ?pose=block renders ONE cell per weapon family in its block guard.
const PARAMS = new URLSearchParams(location.search);
const BLOCK_MODE = PARAMS.get("pose") === "block";
const VARIANT = Math.min(3, Math.max(0, Number(PARAMS.get("variant") ?? 0)));

/** Representative form per keyframed family for the review strip. */
const STYLE_FORMS: Record<string, { form: string; type: string }> = {
  slash: { form: "sword", type: "melee" },
  chop: { form: "axe", type: "melee" },
  thrust: { form: "spear", type: "melee" },
  reap: { form: "scythe", type: "melee" },
  crack: { form: "whip", type: "melee" },
  bash: { form: "shield", type: "melee" },
  punch: { form: "fist", type: "melee" },
  cast: { form: "staff", type: "melee" },
};
const STYLE = (PARAMS.get("style") ?? "slash") as AttackStyle;
const FORM = STYLE_FORMS[STYLE] ?? STYLE_FORMS.slash;
const T = VARIANT === 3 ? (FINISHER_TIMINGS[STYLE] ?? ATTACK_TIMINGS[STYLE]) : ATTACK_TIMINGS[STYLE];

const spec = enrichCharacter(
  balanceCharacter(
    parseCharacterSpec({
      name: "Strip Knight",
      appearance: { color: "#8f959e", accessories: [], height: 1 },
      weapon: { type: FORM.type, name: `Strip ${FORM.form}`, form: FORM.form, size: "medium", range: 6, damage: 7 },
      ability: { name: "A", kind: "aoe", element: "none", motif: "nova", params: {}, cooldown: 6, power: 6 },
      utility: { name: "U", kind: "dash", element: "none", motif: "beam", params: {}, cooldown: 6, power: 5 },
      stats: { hp: 6, speed: 6, strength: 6, defense: 5 },
      flavor: "strip",
    })!,
  ),
);


/** One representative form per attack style for the block review strip. */
const BLOCK_FAMILIES: [string, string, string][] = [
  // [label, form, type]
  ["sword", "sword", "melee"], ["axe", "axe", "melee"], ["spear", "spear", "melee"],
  ["scythe", "scythe", "melee"], ["hammer", "hammer", "melee"], ["whip", "whip", "melee"],
  ["staff", "staff", "melee"], ["bow", "bow", "ranged"], ["gun", "gun", "ranged"],
  ["fist", "fist", "melee"], ["shield", "shield", "melee"], ["dagger", "dagger", "melee"],
];
const FRAMES = 12;
const CELL_W = 130;
const CELL_H = 240;
const GROUND = 200;

const canvas = document.getElementById("strip") as HTMLCanvasElement;
canvas.width = CELL_W * FRAMES;
canvas.height = CELL_H;
const g = canvas.getContext("2d")!;
g.fillStyle = "#efe9d8";
g.fillRect(0, 0, canvas.width, canvas.height);

const world = Matter.Composite.create();

if (BLOCK_MODE) {
  for (let i = 0; i < BLOCK_FAMILIES.length; i++) {
    const [label, form, mtype] = BLOCK_FAMILIES[i];
    const cx = i * CELL_W + CELL_W * 0.45;
    const bSpec = enrichCharacter(
      balanceCharacter(
        parseCharacterSpec({
          name: `Guard ${label}`,
          appearance: { color: "#8f959e", accessories: [], height: 1 },
          weapon: { type: mtype, name: `Guard ${form}`, form, size: "medium", range: 6, damage: 7 },
          ability: { name: "A", kind: "aoe", element: "none", motif: "nova", params: {}, cooldown: 6, power: 6 },
          utility: { name: "U", kind: "dash", element: "none", motif: "beam", params: {}, cooldown: 6, power: 5 },
          stats: { hp: 6, speed: 6, strength: 6, defense: 5 },
          flavor: "guard",
        })!,
      ),
    );
    const fighter = createFighter(world as unknown as Matter.World, bSpec, cx, GROUND, "player");
    fighter.blocking = true;
    fighter.blockVis = 1;
    const anim = createAnimator(bonesFor(1));
    const base: AnimInputs = {
      rootX: cx, rootY: GROUND - 44, vx: 0, vy: 0, grounded: true, facing: 1,
      moving: false, alive: true, blocking: true, attackElapsed: -1,
      weaponForm: bSpec.weapon.form as never, weaponSize: "medium", weaponType: bSpec.weapon.type as never,
      castTimer: 0, hitstunTimer: 0, launchedTimer: 0, groundY: GROUND, time: 0,
    };
    let t = 0;
    let frame = anim.update(1 / 60, { ...base, time: t });
    for (let k = 0; k < 50; k++) { t += 1 / 60; frame = anim.update(1 / 60, { ...base, time: t }); }
    fighter.skeleton = frame.skeleton;
    fighter.weaponAngle = frame.weaponAngle;
    renderFighter(g, fighter, t, GROUND);
    g.fillStyle = "#1e2521";
    g.font = "bold 13px monospace";
    g.textAlign = "center";
    g.fillText(label, i * CELL_W + CELL_W / 2, CELL_H - 12);
    g.strokeStyle = "rgba(30,37,33,0.25)";
    g.strokeRect(i * CELL_W + 0.5, 0.5, CELL_W - 1, CELL_H - 1);
  }
  document.title = "strip-ready";
} else {
for (let i = 0; i < FRAMES; i++) {
  const target = (i / (FRAMES - 1)) * T.total;
  const cx = i * CELL_W + CELL_W * 0.42;
  const fighter = createFighter(world as unknown as Matter.World, spec, cx, GROUND, "player");
  const anim = createAnimator(bonesFor(1));
  const base: AnimInputs = {
    rootX: cx, rootY: GROUND - 44, vx: 0, vy: 0, grounded: true, facing: 1,
    moving: false, alive: true, blocking: false, attackElapsed: -1,
    weaponForm: spec.weapon.form as never, weaponSize: "medium", weaponType: spec.weapon.type as never,
    comboVariant: VARIANT,
    castTimer: 0, hitstunTimer: 0, launchedTimer: 0, groundY: GROUND,
    time: 0, aimX: cx + 70, aimY: GROUND - 64, // a level opponent
  };
  let t = 0;
  // Settle idle, then step the attack up to the target elapsed so holds and
  // the state crossfade resolve exactly as in-game.
  for (let k = 0; k < 40; k++) { t += 1 / 60; anim.update(1 / 60, { ...base, time: t }); }
  let frame = anim.update(1 / 60, { ...base, time: (t += 1 / 60), attackElapsed: 0 });
  for (let e = 1 / 60; e < target - 1e-9; e += 1 / 60) {
    frame = anim.update(1 / 60, { ...base, time: (t += 1 / 60), attackElapsed: e });
  }
  if (target > 0) {
    frame = anim.update(1 / 60, { ...base, time: (t += 1 / 60), attackElapsed: target });
  }
  fighter.skeleton = frame.skeleton;
  fighter.weaponAngle = frame.weaponAngle;
  fighter.weaponSmear = frame.smear ?? null;
  renderFighter(g, fighter, t, GROUND);

  // Labels: elapsed ms + phase.
  const ms = Math.round(target * 1000);
  const phase =
    target < T.windup ? (frame.smear ? "SMEAR" : "windup") :
    target < T.windup + T.active ? "ACTIVE" : "recovery";
  g.fillStyle = "#1e2521";
  g.font = "bold 13px monospace";
  g.textAlign = "center";
  g.fillText(`${ms}ms`, i * CELL_W + CELL_W / 2, CELL_H - 22);
  g.fillText(phase, i * CELL_W + CELL_W / 2, CELL_H - 6);
  g.strokeStyle = "rgba(30,37,33,0.25)";
  g.strokeRect(i * CELL_W + 0.5, 0.5, CELL_W - 1, CELL_H - 1);
}
document.title = "strip-ready";
}
