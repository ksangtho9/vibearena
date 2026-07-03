import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import { ARENA_HEIGHT, ARENA_WIDTH, createArena, destroyArena } from "./arena";
import { createFighter, renderFighter, type Side } from "./stickman";
import {
  checkWinner,
  pushEffect,
  updateEffects,
  updateFighter,
  updateProjectiles,
  type CombatCtx,
} from "./combat";
import { createKeyboard, emptyInput } from "./input";
import { createBotBrain } from "./bot";

/**
 * requestAnimationFrame loop with a fixed physics timestep. Rendering is
 * custom canvas chalk drawing over the Matter bodies.
 */

export interface HudState {
  playerHp: number;
  playerMaxHp: number;
  botHp: number;
  botMaxHp: number;
  /** 0 = ready, 1 = just used. */
  abilityCdFrac: number;
}

export interface GameCallbacks {
  onHud(hud: HudState): void;
  onEnd(winner: Side): void;
}

const STEP = 1 / 60;
const INTRO_SECONDS = 1.1;
/** Let the loser flop around before cutting to the result screen. */
const OUTRO_SECONDS = 1.6;

export function startGame(
  canvas: HTMLCanvasElement,
  playerSpec: CharacterSpec,
  botSpec: CharacterSpec,
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

  const combat: CombatCtx = { arena, projectiles: [], effects: [] };
  const keyboard = createKeyboard();
  keyboard.attach();
  const brain = createBotBrain();

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
    time += dt;

    if (!fightAnnounced && time >= INTRO_SECONDS) {
      fightAnnounced = true;
      pushEffect(combat, {
        kind: "text",
        x: ARENA_WIDTH / 2,
        y: ARENA_HEIGHT * 0.32,
        ttl: 0.9,
        color: "#e0483e",
        text: "FIGHT!",
      });
    }

    const playerInput = winner ? emptyInput() : keyboard.state;
    const botInput = winner ? emptyInput() : brain.think(bot, player, dt);

    updateFighter(player, bot, playerInput, combat, dt);
    updateFighter(bot, player, botInput, combat, dt);
    updateProjectiles({ player, bot }, combat, dt);
    updateEffects(combat, dt);

    Matter.Engine.update(arena.engine, dt * 1000);

    if (!winner) {
      winner = checkWinner(player, bot);
      if (winner) {
        pushEffect(combat, {
          kind: "text",
          x: ARENA_WIDTH / 2,
          y: ARENA_HEIGHT * 0.3,
          ttl: OUTRO_SECONDS,
          color: "#e8b33c",
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

  function drawBoard(): void {
    ctx2d.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    ctx2d.save();
    ctx2d.strokeStyle = "rgba(242, 240, 228, 0.5)";
    ctx2d.lineWidth = 3;
    ctx2d.lineCap = "round";
    // Ground chalk line, slightly scuffed.
    ctx2d.beginPath();
    ctx2d.moveTo(14, arena.groundY + 2);
    ctx2d.lineTo(ARENA_WIDTH - 14, arena.groundY + 2);
    ctx2d.stroke();
    // Center mark.
    ctx2d.globalAlpha = 0.25;
    ctx2d.setLineDash([4, 10]);
    ctx2d.beginPath();
    ctx2d.moveTo(ARENA_WIDTH / 2, arena.groundY - 6);
    ctx2d.lineTo(ARENA_WIDTH / 2, arena.groundY - 40);
    ctx2d.stroke();
    ctx2d.restore();
  }

  function drawProjectiles(): void {
    for (const p of combat.projectiles) {
      ctx2d.save();
      ctx2d.strokeStyle = p.color;
      ctx2d.lineWidth = 3;
      ctx2d.beginPath();
      ctx2d.arc(p.body.position.x, p.body.position.y, p.radius, 0, Math.PI * 2);
      ctx2d.stroke();
      // Motion streak.
      ctx2d.globalAlpha = 0.35;
      ctx2d.beginPath();
      ctx2d.moveTo(p.body.position.x, p.body.position.y);
      ctx2d.lineTo(
        p.body.position.x - p.body.velocity.x * 2.2,
        p.body.position.y - p.body.velocity.y * 2.2,
      );
      ctx2d.stroke();
      ctx2d.restore();
    }
  }

  function drawEffects(): void {
    for (const e of combat.effects) {
      const life = e.ttl / e.maxTtl; // 1 → 0
      ctx2d.save();
      ctx2d.globalAlpha = Math.max(0, life) * 0.9;
      ctx2d.strokeStyle = e.color;
      ctx2d.fillStyle = e.color;
      if (e.kind === "ring") {
        const r = (e.radius ?? 20) * (1.6 - life * 0.6);
        ctx2d.lineWidth = 3;
        ctx2d.beginPath();
        ctx2d.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx2d.stroke();
      } else if (e.kind === "spark") {
        ctx2d.lineWidth = 2.5;
        const r = e.radius ?? 12;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + e.maxTtl;
          ctx2d.beginPath();
          ctx2d.moveTo(e.x + Math.cos(a) * r * 0.4, e.y + Math.sin(a) * r * 0.4);
          ctx2d.lineTo(
            e.x + Math.cos(a) * r * (1.5 - life),
            e.y + Math.sin(a) * r * (1.5 - life),
          );
          ctx2d.stroke();
        }
      } else {
        const big = e.text === "FIGHT!" || e.text === "K.O." || e.text === "FLATTENED";
        ctx2d.font = big
          ? "48px Anton, Impact, sans-serif"
          : "20px Anton, Impact, sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.fillText(e.text ?? "", e.x, e.y - (1 - life) * 26);
      }
      ctx2d.restore();
    }
  }

  function render(): void {
    drawBoard();
    renderFighter(ctx2d, player, time);
    renderFighter(ctx2d, bot, time);
    drawProjectiles();
    drawEffects();
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
      cb.onHud({
        playerHp: player.hp,
        playerMaxHp: player.maxHp,
        botHp: bot.hp,
        botMaxHp: bot.maxHp,
        abilityCdFrac:
          player.spec.ability.cooldown > 0
            ? player.abilityCooldown / player.spec.ability.cooldown
            : 0,
      });
    }
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    keyboard.detach();
    destroyArena(arena);
  };
}
