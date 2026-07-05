import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import type { CombatCtx } from "./combat";
import { updateEffects } from "./combat";
import { createFighter, renderFighter } from "./stickman";
import { equipWeaponRender, tickBehaviors } from "./engine/interpreter";
import { ALLOW_CUSTOM_SCRIPT } from "./engine/customScript";
import { drawEffect } from "./effectsRender";
import type { Arena } from "./arena";

/**
 * Fighter preview = THE game render pipeline pointed at a pedestal.
 *
 * There is exactly ONE fighter renderer (renderFighter) and ONE weapon
 * renderer (its mount/renderProgram-aware drawWeapon) in this codebase; the
 * preview builds a real Fighter in a dummy Matter world, ticks its animator
 * and behavior runtimes (so LLM-drawn weapon looks run at their real ~30Hz),
 * and draws through those same functions. Any future render surface should
 * do the same and will inherit mounts, render programs, outfits and
 * animation automatically.
 */
export function startFighterPreview(
  g: CanvasRenderingContext2D,
  spec: CharacterSpec,
  w: number,
  h: number,
): () => void {
  const world = Matter.Composite.create();
  const groundY = h - 26;
  const fighter = createFighter(
    world as unknown as Matter.World,
    spec,
    w * 0.5,
    groundY,
    "player",
  );

  // Minimal combat ctx: enough for behavior draw verbs (effects) and the
  // interpreter's senses. Physics-touching verbs fail per-action-safely.
  const mini: CombatCtx = {
    arena: { world, groundY, width: w, height: h, platformRects: [] } as unknown as Arena,
    fighters: { player: fighter, bot: fighter },
    projectiles: [],
    effects: [],
    behaviors: [],
    entities: [],
    hitstop: 0,
    time: 0,
    shakeTimer: 0,
    shakeAmp: 0,
    flashTimer: 0,
    flashMax: 0,
    flashColor: "#ffffff",
  };
  if (ALLOW_CUSTOM_SCRIPT) equipWeaponRender(fighter, mini);

  let raf = 0;
  let time = 0;
  let last = performance.now();

  const advance = (dt: number) => {
    time += dt;
    mini.time = time;

    // Idle pose from the real animator (sway, guard stance, weapon carry).
    const frame = fighter.animator.update(dt, {
      rootX: fighter.root.position.x,
      rootY: groundY - 44 * fighter.scale,
      vx: 0,
      vy: 0,
      grounded: true,
      facing: 1,
      moving: false,
      alive: true,
      blocking: false,
      attackElapsed: -1,
      weaponForm: fighter.style.weapon.form,
      weaponSize: fighter.style.weapon.size,
      weaponType: spec.weapon.type,
      castTimer: 0,
      hitstunTimer: 0,
      launchedTimer: 0,
      groundY,
      time,
    });
    fighter.skeleton = frame.skeleton;
    fighter.weaponAngle = frame.weaponAngle;

    // Behavior runtimes (the weapon renderProgram) + their drawn effects.
    tickBehaviors(mini, dt);
    updateEffects(mini, dt);
  };

  const paint = () => {
    g.clearRect(0, 0, w, h);
    renderFighter(g, fighter, time, groundY);
    for (const e of mini.effects) drawEffect(g, e, time);
  };

  // Synchronous warm-up: a valid first frame (incl. render-program output)
  // even before the first rAF fires — no blank flash, and background tabs
  // still show a drawn portrait.
  for (let i = 0; i < 4; i++) advance(1 / 30);
  paint();

  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    advance(dt);
    paint();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => cancelAnimationFrame(raf);
}
