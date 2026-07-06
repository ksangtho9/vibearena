import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  createArena,
  destroyArena,
  installOneWayPlatforms,
} from "./arena";
import {
  createFighter,
  drawAfterimage,
  fighterX,
  fighterY,
  renderFighter,
  type Fighter,
  type Side,
} from "./stickman";
import {
  checkWinner,
  pushEffect,
  updateEffects,
  updateFighter,
  updateProjectiles,
  type CombatCtx,
} from "./combat";
import { createKeyboard, emptyInput, INPUT_BINDINGS } from "./input";
import { createBotBrain, type BotBrain } from "./bot";
import { createTheme, type ThemeView } from "./arena/themes";
import { drawEffect, drawProjectile } from "./effectsRender";
import { equipWeaponBehavior, equipWeaponRender, tickBehaviors } from "./engine/interpreter";
import { ALLOW_CUSTOM_SCRIPT } from "./engine/customScript";
import { renderEntities, tickEntities } from "./engine/api";

/**
 * requestAnimationFrame loop with a fixed physics timestep. Rendering is a
 * layered cinematic pass: themed parallax backdrop → world (fighters,
 * projectiles, effects) under a follow camera → foreground parallax →
 * letterbox bars.
 */

export interface HudState {
  playerHp: number;
  playerMaxHp: number;
  botHp: number;
  botMaxHp: number;
  /** Player 1's ATTACK-ability cooldown: 0 = ready, 1 = just used. */
  abilityCdFrac: number;
  /** Player 1's UTILITY-ability cooldown. */
  utilityCdFrac: number;
  /** Right-side fighter's cooldowns (shown for P2 in hotseat). */
  botAbilityCdFrac: number;
  botUtilityCdFrac: number;
  /** Guard meters, 0–1 (block system). */
  playerGuardFrac: number;
  botGuardFrac: number;
}

export interface GameCallbacks {
  onHud(hud: HudState): void;
  onEnd(winner: Side): void;
}

const STEP = 1 / 60;
const INTRO_SECONDS = 1.1;
/** Let the loser flop around before cutting to the result screen. */
const OUTRO_SECONDS = 1.6;

/** Where the camera anchor lands on screen (ground sits low in frame). */
const SCREEN_ANCHOR_Y = 0.74;
const LETTERBOX_FRAC = 0.055;

export function startGame(
  canvas: HTMLCanvasElement,
  playerSpec: CharacterSpec,
  botSpec: CharacterSpec,
  mode: "1p" | "2p",
  cb: GameCallbacks,
): () => void {
  const arena = createArena();
  const ctx2d = ((): CanvasRenderingContext2D => {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    return ctx;
  })();

  const dpr = window.devicePixelRatio || 1;
  canvas.width = ARENA_WIDTH * dpr;
  canvas.height = ARENA_HEIGHT * dpr;
  ctx2d.scale(dpr, dpr);

  const player = createFighter(arena.world, playerSpec, ARENA_WIDTH * 0.28, arena.groundY, "player");
  const bot = createFighter(arena.world, botSpec, ARENA_WIDTH * 0.72, arena.groundY, "bot");
  player.introTimer = INTRO_SECONDS;
  bot.introTimer = INTRO_SECONDS;

  // One-way platforms: ragdolls/projectiles land from above via the pair
  // veto; fighter capsules land kinematically in combat.ts.
  installOneWayPlatforms(arena);

  const combat: CombatCtx = {
    arena,
    fighters: { player, bot },
    projectiles: [],
    effects: [],
    behaviors: [],
    entities: [],
    afterimages: [],
    hitstop: 0,
    time: 0,
    shakeTimer: 0,
    shakeAmp: 0,
    flashTimer: 0,
    flashMax: 0,
    flashColor: "#ffffff",
  };

  // Weapon behaviors are match-long passives: attach + fire onEquip now.
  equipWeaponBehavior(player, combat);
  equipWeaponBehavior(bot, combat);
  // LLM-drawn weapon looks (parametric drawer is the fallback). The kill
  // switch for model-authored content also parks these.
  if (ALLOW_CUSTOM_SCRIPT) {
    equipWeaponRender(player, combat);
    equipWeaponRender(bot, combat);
  }

  // Input routing: in hotseat, the right-side fighter is PLAYER 2's key
  // cluster instead of the bot FSM. Same InputState shape either way.
  const kb1 = createKeyboard(mode === "2p" ? INPUT_BINDINGS.p1 : INPUT_BINDINGS.solo);
  kb1.attach();
  const kb2 = mode === "2p" ? createKeyboard(INPUT_BINDINGS.p2) : null;
  kb2?.attach();
  const brain: BotBrain | null = mode === "1p" ? createBotBrain() : null;

  const theme = createTheme();

  // Follow camera: eases toward the fighters' midpoint (x AND y, so platform
  // fights stay framed), zooms with their separation.
  const cam = { x: ARENA_WIDTH / 2, y: arena.groundY - 40, zoom: 1.05 };

  let time = 0;
  let fightAnnounced = false;
  let winner: Side | null = null;
  let outro = OUTRO_SECONDS;
  let ended = false;
  let frame = 0;
  let rafId = 0;
  let last = performance.now();
  let acc = 0;

  function step(dt: number): void {
    // Hit-stop: the whole fight freezes for a beat when a hit lands.
    if (combat.hitstop > 0) {
      combat.hitstop -= dt;
      return;
    }

    combat.shakeTimer = Math.max(0, combat.shakeTimer - dt);
    combat.flashTimer = Math.max(0, combat.flashTimer - dt);

    time += dt;
    combat.time = time;

    if (!fightAnnounced && time >= INTRO_SECONDS) {
      fightAnnounced = true;
      pushEffect(combat, {
        kind: "text",
        x: ARENA_WIDTH / 2,
        y: ARENA_HEIGHT * 0.32,
        ttl: 0.9,
        color: "#ffe6a3",
        text: "FIGHT!",
      });
    }

    const playerInput = winner ? emptyInput() : kb1.state;
    const botInput = winner
      ? emptyInput()
      : kb2
        ? kb2.state
        : brain
          ? brain.think(bot, player, dt)
          : emptyInput();

    updateFighter(player, bot, playerInput, combat, dt);
    updateFighter(bot, player, botInput, combat, dt);
    updateProjectiles({ player, bot }, combat, dt);
    updateEffects(combat, dt);
    tickBehaviors(combat, dt);
    tickEntities(combat, dt);

    Matter.Engine.update(arena.engine, dt * 1000);

    if (!winner) {
      winner = checkWinner(player, bot);
      if (winner) {
        pushEffect(combat, {
          kind: "text",
          x: ARENA_WIDTH / 2,
          y: ARENA_HEIGHT * 0.3,
          ttl: OUTRO_SECONDS,
          color: "#ffd75e",
          text: winner === "player" ? "K.O." : "FLATTENED",
        });
      }
    } else if (!ended) {
      outro -= dt;
      if (outro <= 0) {
        ended = true;
        cb.onEnd(winner);
      }
    }
  }

  function updateCamera(): void {
    const px = fighterX(player);
    const bx = fighterX(bot);
    const py = fighterY(player);
    const by = fighterY(bot);

    const midX = Math.max(280, Math.min(680, (px + bx) / 2));
    // Rise with the fight; when everyone is grounded this equals the old
    // fixed anchor (roots sit 44px above the ground plane).
    const midY = Math.max(arena.groundY - 190, Math.min(arena.groundY - 40, (py + by) / 2 + 4));

    // Zoom out for horizontal AND vertical separation so a fighter up on a
    // platform never leaves the frame.
    const span = Math.max(Math.abs(px - bx), Math.abs(py - by) * 1.7);
    const targetZoom = Math.max(0.95, Math.min(1.28, ARENA_WIDTH / (span + 560)));

    cam.x += (midX - cam.x) * 0.06;
    cam.y += (midY - cam.y) * 0.06;
    cam.zoom += (targetZoom - cam.zoom) * 0.05;
  }

  /**
   * Camera transform for a given parallax factor. factor 1 = the world plane
   * the fighters live on; smaller factors track the camera less (far away),
   * larger track it more (foreground).
   */
  function applyLayerTransform(factor: number): void {
    const layerCamX = ARENA_WIDTH / 2 + (cam.x - ARENA_WIDTH / 2) * factor;
    const baseY = arena.groundY - 40;
    const layerCamY = baseY + (cam.y - baseY) * factor;
    ctx2d.translate(ARENA_WIDTH / 2, ARENA_HEIGHT * SCREEN_ANCHOR_Y);
    ctx2d.scale(cam.zoom, cam.zoom);
    ctx2d.translate(-layerCamX, -layerCamY);
  }

  /**
   * The surface directly under a fighter — the highest platform top below
   * its feet, else the ground. Contact shadows land on this.
   */
  function supportYFor(f: Fighter): number {
    const x = fighterX(f);
    const bottom = f.ragdoll ? fighterY(f) + 20 : f.root.position.y + 44 * f.scale;
    let support = arena.groundY;
    for (const r of arena.platformRects) {
      if (
        x >= r.cx - r.w / 2 - 6 &&
        x <= r.cx + r.w / 2 + 6 &&
        r.top >= bottom - 12 &&
        r.top < support
      ) {
        support = r.top;
      }
    }
    return support;
  }

  function drawProjectiles(): void {
    // Each projectile draws as its source: arrow, tracer, spinning thrown
    // weapon, or element bolt (visual only — hitbox is the physics body).
    for (const p of combat.projectiles) drawProjectile(ctx2d, p, time);
  }

  function drawEffects(): void {
    for (const e of combat.effects) drawEffect(ctx2d, e, time);
  }

  function render(): void {
    updateCamera();
    const view: ThemeView = {
      w: ARENA_WIDTH,
      h: ARENA_HEIGHT,
      time,
      groundY: arena.groundY,
    };

    // Behavior-engine screenShake: jitter the whole frame while active.
    const shaking = combat.shakeTimer > 0;
    if (shaking) {
      const k = combat.shakeAmp * Math.min(1, combat.shakeTimer * 4);
      ctx2d.save();
      ctx2d.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
    }

    // 1. Sky — pure screen space.
    theme.drawSky(ctx2d, view);

    // 2. Background parallax layers (includes the ground plane at factor 1).
    for (const layer of theme.layers) {
      ctx2d.save();
      applyLayerTransform(layer.parallax);
      layer.draw(ctx2d, view);
      ctx2d.restore();
    }

    // 3. World pass: everything that lives on the fight plane.
    ctx2d.save();
    applyLayerTransform(1);
    for (const rect of arena.platformRects) theme.drawPlatform(ctx2d, rect);
    renderEntities(ctx2d, combat, time);
    for (const a of combat.afterimages) drawAfterimage(ctx2d, a);
    renderFighter(ctx2d, player, time, supportYFor(player));
    renderFighter(ctx2d, bot, time, supportYFor(bot));
    drawProjectiles();
    drawEffects();
    ctx2d.restore();

    // 4. Foreground parallax.
    for (const layer of theme.foreground) {
      ctx2d.save();
      applyLayerTransform(layer.parallax);
      layer.draw(ctx2d, view);
      ctx2d.restore();
    }

    // 5. Cinematic frame: soft vignette + letterbox bars.
    const vignette = ctx2d.createRadialGradient(
      ARENA_WIDTH / 2, ARENA_HEIGHT * 0.45, ARENA_HEIGHT * 0.45,
      ARENA_WIDTH / 2, ARENA_HEIGHT * 0.45, ARENA_HEIGHT * 1.05,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(10, 12, 10, 0.32)");
    ctx2d.fillStyle = vignette;
    ctx2d.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    const bar = Math.round(ARENA_HEIGHT * LETTERBOX_FRAC);
    ctx2d.fillStyle = "#06080a";
    ctx2d.fillRect(0, 0, ARENA_WIDTH, bar);
    ctx2d.fillRect(0, ARENA_HEIGHT - bar, ARENA_WIDTH, bar);

    if (shaking) ctx2d.restore();

    // Behavior-engine flash(): brief full-screen tint, fading out.
    if (combat.flashTimer > 0 && combat.flashMax > 0) {
      ctx2d.save();
      ctx2d.globalAlpha = Math.min(0.55, (combat.flashTimer / combat.flashMax) * 0.55);
      ctx2d.fillStyle = combat.flashColor;
      ctx2d.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
      ctx2d.restore();
    }
  }

  function tick(now: number): void {
    rafId = requestAnimationFrame(tick);
    acc += Math.min((now - last) / 1000, 0.1); // clamp tab-switch jumps
    last = now;

    while (acc >= STEP) {
      step(STEP);
      acc -= STEP;
    }
    render();

    if (frame++ % 5 === 0) {
      const cdFrac = (cd: number, total: number | undefined) =>
        total && total > 0 ? cd / total : 0;
      cb.onHud({
        playerHp: player.hp,
        playerMaxHp: player.maxHp,
        botHp: bot.hp,
        botMaxHp: bot.maxHp,
        abilityCdFrac: cdFrac(player.abilityCooldown, player.spec.ability.cooldown),
        utilityCdFrac: cdFrac(player.utilityCooldown, player.spec.utility?.cooldown),
        botAbilityCdFrac: cdFrac(bot.abilityCooldown, bot.spec.ability.cooldown),
        botUtilityCdFrac: cdFrac(bot.utilityCooldown, bot.spec.utility?.cooldown),
        playerGuardFrac: player.guardMax > 0 ? player.guard / player.guardMax : 1,
        botGuardFrac: bot.guardMax > 0 ? bot.guard / bot.guardMax : 1,
      });
    }
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    kb1.detach();
    kb2?.detach();
    destroyArena(arena);
  };
}
