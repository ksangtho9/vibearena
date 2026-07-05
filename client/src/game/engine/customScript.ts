import type { AbilityMotif, AbilitySpec, CharacterSpec, ElementKind } from "../../types/character";
import type { Fighter } from "../stickman";
import type { CombatCtx } from "../combat";
import { pushEffect } from "../combat";
import { createEngineApi, type EngineApi } from "./api";
import type { BehaviorRuntime } from "./interpreter";

/**
 * customScript — the raw-JS escape hatch for mechanics the behavior DSL
 * can't express. A script runs ONCE per cast inside `new Function` with:
 *  - every reachable browser global SHADOWED to undefined (no window /
 *    document / fetch / timers / Function / eval …),
 *  - a frozen `api` argument (EngineApi verbs + sensing + persistent state),
 *  - a WATCHDOG: every api call checks a per-cast time budget and a total
 *    call cap and throws past either.
 * Halting overall is enforced at GENERATION time: scripts must survive a
 * Web Worker halt-test (hard terminate on timeout, randomized senses ×3)
 * before they ever ship on a spec — see vetCustomScript below.
 *
 * SECURITY: good enough for locally generated fighters; NOT hardened against
 * malicious authors (e.g. constructor-chain escapes). Before any public
 * deploy with shared fighters, review or disable via ALLOW_CUSTOM_SCRIPT.
 */

/** Kill switch (VITE_ALLOW_CUSTOM_SCRIPT=false disables; default ON locally). */
export const ALLOW_CUSTOM_SCRIPT =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ALLOW_CUSTOM_SCRIPT !==
  "false";

/** Per-cast watchdog budgets (anti-hitch, not balance). */
const TIME_BUDGET_MS = 12;
const CALL_CAP = 400;

/** Globals shadowed to undefined inside the sandbox function scope. */
const SHADOWED_GLOBALS = [
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker",
  "importScripts", "postMessage", "localStorage", "sessionStorage",
  "indexedDB", "caches", "cookieStore", "navigator", "location", "history",
  "open", "close", "alert", "confirm", "prompt",
  "setTimeout", "setInterval", "setImmediate", "requestAnimationFrame",
  "queueMicrotask", "Function", "eval", "import",
] as const;

/**
 * Tokens that have no business in an ability script. `eval` cannot be
 * shadowed in strict mode and `constructor`/`prototype` chains are the
 * classic new Function escapes — so scripts containing these tokens are
 * refused outright (dropped → fallback). Legit ability logic never needs
 * them; a false positive just costs the script, not the game.
 */
const FORBIDDEN_TOKENS =
  /\b(eval|Function|constructor|prototype|__proto__|import|require|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|Worker|process|localStorage|sessionStorage|indexedDB)\b/;

const compileCache = new Map<string, ((...args: unknown[]) => unknown) | null>();

function compileScript(script: string): ((...args: unknown[]) => unknown) | null {
  const cached = compileCache.get(script);
  if (cached !== undefined) return cached;
  let fn: ((...args: unknown[]) => unknown) | null = null;
  const banned = FORBIDDEN_TOKENS.exec(script);
  if (banned) {
    console.warn(`[vibearena] customScript refused (forbidden token "${banned[1]}")`);
  } else {
    try {
      // "import"/"eval" can't be parameter names in strict mode; they are
      // covered by the token blocklist above instead.
      const shadows = SHADOWED_GLOBALS.filter((g) => g !== "import" && g !== "eval");
      fn = new Function("api", "state", ...shadows, `"use strict"; ${script}`) as (
        ...args: unknown[]
      ) => unknown;
    } catch (err) {
      console.warn("[vibearena] customScript failed to compile:", err);
    }
  }
  compileCache.set(script, fn);
  return fn;
}

interface ScriptSense {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  facing: number;
  grounded: boolean;
  airborne: boolean;
  attacking: boolean;
  scale: number;
}

/** Build the frozen script-facing api: guarded verbs + senses + state. */
function buildScriptApi(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  engine: EngineApi,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const caster = rt.caster;
  const foe = () => (caster.side === "player" ? ctx.fighters.bot : ctx.fighters.player);
  const started = performance.now();
  let calls = 0;
  const guard = () => {
    if (++calls > CALL_CAP) throw new Error("customScript call cap exceeded");
    if (performance.now() - started > TIME_BUDGET_MS) {
      throw new Error("customScript time budget exceeded");
    }
  };

  const sense = (f: Fighter): ScriptSense => ({
    x: f.root.position.x,
    y: f.root.position.y,
    vx: f.root.velocity.x,
    vy: f.root.velocity.y,
    hp: f.hp,
    maxHp: f.maxHp,
    facing: f.facing,
    grounded: f.grounded,
    airborne: !f.grounded,
    attacking: f.attackAnim > 0,
    scale: f.displayScale,
  });

  const api: Record<string, unknown> = {
    state,
    self: () => {
      guard();
      return sense(caster);
    },
    opponent: () => {
      guard();
      const f = foe();
      return {
        ...sense(f),
        distance: Math.abs(f.root.position.x - caster.root.position.x),
        lastAbility: f.lastAbility ? { ...f.lastAbility } : null,
      };
    },
    rng: () => {
      guard();
      return Math.random();
    },
    now: () => {
      guard();
      return ctx.time;
    },
    myEntities: () => {
      guard();
      return ctx.entities.filter((e) => e.side === caster.side && !e.dead).length;
    },
    /** text {text} — a floating callout above the caster. */
    text: (a: Record<string, unknown> = {}) => {
      guard();
      pushEffect(ctx, {
        kind: "text",
        x: caster.root.position.x,
        y: caster.root.position.y - 84,
        ttl: 0.8,
        color: rt.glow,
        text: String(a.text ?? "").slice(0, 24).toUpperCase(),
      });
    },
  };

  // Every EngineApi verb, wrapped with the watchdog. dealAoe/dealMelee
  // return whether they connected, so scripts can react to hits/misses.
  for (const [name, verb] of Object.entries(engine)) {
    api[name] = (a: Record<string, unknown> = {}) => {
      guard();
      return verb(typeof a === "object" && a !== null ? a : {});
    };
  }

  return Object.freeze(api);
}

/**
 * Run one cast's script. Returns true on clean completion; false means the
 * caller should fall back (interpreted behavior, else legacy kind).
 */
export function runCustomScript(
  caster: Fighter,
  ctx: CombatCtx,
  ability: AbilitySpec,
  visuals: { element: ElementKind; motif: AbilityMotif; glow: string },
): boolean {
  const slot = ability === caster.spec.utility ? "utility" : "ability";
  return runScript(caster, ctx, ability.customScript, ability.name, slot, visuals);
}

/** Weapon variant: runs at the swing's onAttack moment, state key "weapon". */
export function runWeaponScript(caster: Fighter, ctx: CombatCtx): boolean {
  return runScript(
    caster,
    ctx,
    caster.spec.weapon.customScript,
    caster.spec.weapon.name,
    "weapon",
    { element: caster.style.element, motif: "burst", glow: caster.style.glow },
  );
}

function runScript(
  caster: Fighter,
  ctx: CombatCtx,
  script: string | undefined,
  name: string,
  stateKey: string,
  visuals: { element: ElementKind; motif: AbilityMotif; glow: string },
): boolean {
  if (!ALLOW_CUSTOM_SCRIPT || !script) return false;
  const fn = compileScript(script);
  if (!fn) return false;

  // Ephemeral runtime so EngineApi verbs (spawn budgets, entity ownership)
  // work exactly as they do for interpreted behaviors.
  const rt: BehaviorRuntime = {
    program: { handlers: {} },
    state: {},
    caster,
    element: visuals.element,
    motif: visuals.motif,
    glow: visuals.glow,
    age: 0,
    duration: 0.05,
    wasGrounded: caster.grounded,
    tickAccum: 0,
    pending: [],
    actionBudget: 300,
    projectileBudget: 14,
    entityBudget: 8,
    persistent: false,
    renderAcc: 0,
    done: false,
  };

  // Persistent per-slot state across casts.
  const state = (caster.scriptState[stateKey] ??= {});

  try {
    const engine = createEngineApi(rt, ctx);
    const api = buildScriptApi(rt, ctx, engine, state);
    fn(api, state, ...new Array(SHADOWED_GLOBALS.length - 2).fill(undefined));
    return true;
  } catch (err) {
    console.warn(`[vibearena] customScript for "${name}" failed (falling back):`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generation-time vetting: the Web Worker halt-test.
// ---------------------------------------------------------------------------

/**
 * Run the script in a throwaway Web Worker with all verbs stubbed and senses
 * randomized, three times. The worker is hard-terminated on timeout, so even
 * `while(true){}` (or state-conditional hangs) get caught here and the script
 * never ships. Throws inside the worker fail the test too (retried once by
 * the caller). Environments without Worker (node tests) fall back to a
 * single guarded sync run.
 */
export function testScriptHalts(script: string, timeoutMs = 400): Promise<boolean> {
  // Same token gate as the runtime compiler — fail fast at vet time so specs
  // never ship scripts the runtime would refuse anyway.
  if (FORBIDDEN_TOKENS.test(script)) {
    console.warn("[vibearena] script halt-test refused (forbidden token)");
    return Promise.resolve(false);
  }
  if (typeof Worker === "undefined") {
    return Promise.resolve(syncSmokeRun(script));
  }
  const shadows = SHADOWED_GLOBALS.filter((g) => g !== "import" && g !== "eval");
  const workerSrc = `
    "use strict";
    const randomSense = () => ({
      x: 100 + Math.random() * 700, y: 100 + Math.random() * 300,
      vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 12,
      hp: Math.random() * 200, maxHp: 200,
      facing: Math.random() < 0.5 ? 1 : -1, grounded: Math.random() < 0.5,
      airborne: Math.random() < 0.5, attacking: Math.random() < 0.5,
      scale: 0.4 + Math.random() * 2,
    });
    const VERBS = ${JSON.stringify(SCRIPT_VERBS)};
    function makeApi(state) {
      let calls = 0;
      const guard = () => { if (++calls > 5000) throw new Error("call cap"); };
      const api = { state };
      api.self = () => { guard(); return randomSense(); };
      api.opponent = () => {
        guard();
        return { ...randomSense(), distance: Math.random() * 600,
          lastAbility: Math.random() < 0.5 ? { name: "Test Move", kind: "projectile" } : null };
      };
      api.rng = () => { guard(); return Math.random(); };
      api.now = () => { guard(); return 1; };
      for (const v of VERBS) api[v] = () => { guard(); return Math.random() < 0.5; };
      return Object.freeze(api);
    }
    try {
      const fn = new Function("api", "state", ...${JSON.stringify(shadows)},
        '"use strict"; const eval_ = undefined; ' + ${JSON.stringify(script)});
      for (let run = 0; run < 3; run++) {
        const state = {};
        fn(makeApi(state), state, ...new Array(${shadows.length}).fill(undefined));
      }
      postMessage({ ok: true });
    } catch (err) {
      postMessage({ ok: false, error: String(err) });
    }
  `;
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let url = "";
    const finish = (ok: boolean) => {
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(ok);
    };
    try {
      url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (err) {
      console.warn("[vibearena] script halt-test worker unavailable:", err);
      resolve(syncSmokeRun(script));
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; error?: string }>) => {
      clearTimeout(timer);
      if (!e.data.ok) console.warn("[vibearena] script halt-test threw:", e.data.error);
      finish(e.data.ok);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      finish(false);
    };
  });
}

/** Verb names exposed to scripts (kept in sync with EngineApi + extras). */
const SCRIPT_VERBS = [
  "leap", "dash", "teleport", "blink", "teleportBehind", "applyForce", "setVelocity",
  "setGravity", "launch", "pushRadial", "setTimeScale", "recall",
  "setScale", "phase", "reflect", "tint",
  "spawnProjectile", "spawnEntity", "spawnEffect", "spawnHazard", "beam", "boomerang",
  "dealAoe", "dealMelee", "heal", "shield", "applyStatus", "knockback",
  "pull", "lifesteal",
  "draw", "drawShape", "drawLine", "drawArc", "drawRing", "spawnParticles",
  "particles", "text", "spawnText", "screenShake", "flash", "playSound", "myEntities",
];

/** Worker-less fallback (node tests): one guarded run, no hang protection. */
function syncSmokeRun(script: string): boolean {
  const fn = compileScript(script);
  if (!fn) return false;
  const state: Record<string, unknown> = {};
  let calls = 0;
  const guard = () => {
    if (++calls > 5000) throw new Error("call cap");
  };
  const sense = () => ({
    x: 200, y: 300, vx: 0, vy: 0, hp: 100, maxHp: 200, facing: 1,
    grounded: true, airborne: false, attacking: false, scale: 1,
  });
  const api: Record<string, unknown> = {
    state,
    self: () => (guard(), sense()),
    opponent: () => (guard(), { ...sense(), distance: 300, lastAbility: null }),
    rng: () => (guard(), Math.random()),
    now: () => (guard(), 1),
  };
  for (const v of SCRIPT_VERBS) api[v] = () => (guard(), Math.random() < 0.5);
  try {
    fn(Object.freeze(api), state, ...new Array(SHADOWED_GLOBALS.length - 2).fill(undefined));
    return true;
  } catch (err) {
    console.warn("[vibearena] script sync smoke failed:", err);
    return false;
  }
}

/**
 * Vet every customScript on a freshly generated spec (halt-test, retried
 * once, drop on fail). Async because the halt-test rides a Worker; called
 * from the generation adapter after enrich.
 */
export async function vetCustomScripts(spec: CharacterSpec): Promise<CharacterSpec> {
  const carriers: { name: string; obj: { customScript?: string } }[] = [
    ...(["ability", "utility"] as const).flatMap((slot) => {
      const a = spec[slot];
      return a ? [{ name: a.name, obj: a }] : [];
    }),
    { name: spec.weapon.name, obj: spec.weapon },
  ];
  for (const { name, obj } of carriers) {
    if (!obj.customScript) continue;
    if (!ALLOW_CUSTOM_SCRIPT) {
      delete obj.customScript;
      continue;
    }
    const ok =
      (await testScriptHalts(obj.customScript)) || (await testScriptHalts(obj.customScript));
    if (!ok) {
      console.warn(
        `[vibearena] "${name}" customScript dropped after failing its halt-test — falling back.`,
      );
      delete obj.customScript;
    }
  }
  return spec;
}
