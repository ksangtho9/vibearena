import type {
  AbilityMotif,
  BehaviorAction,
  BehaviorHandler,
  BehaviorProgram,
  ElementKind,
} from "../../types/character";
import { BEHAVIOR_HANDLERS } from "../../types/character";
import type { Fighter } from "../stickman";
import type { CombatCtx } from "../combat";
import { createEngineApi } from "./api";

/**
 * Behavior interpreter — runs LLM-authored ability programs against the
 * EngineApi verb whitelist. There is intentionally NO power budget here;
 * the only rules are anti-crash caps (loop/spawn/action counts, finite
 * numbers, per-action try/catch). A broken program degrades to "does less",
 * never to a crashed game.
 */

export const BEHAVIOR_CAPS = {
  actionsPerInvocation: 300,
  repeat: 25,
  depth: 6,
  wait: 5, // seconds
  duration: 10, // seconds a runtime stays live
  projectilesPerInvocation: 14,
  entitiesPerInvocation: 8,
  entitiesGlobal: 24,
} as const;

export interface BehaviorRuntime {
  program: BehaviorProgram;
  state: Record<string, number>;
  caster: Fighter;
  /** Visual defaults for spawn/draw verbs, from the owning ability. */
  element: ElementKind;
  motif: AbilityMotif;
  glow: string;
  age: number;
  duration: number;
  wasGrounded: boolean;
  tickAccum: number;
  /** Continuations parked by `wait`. */
  pending: { delay: number; actions: BehaviorAction[] }[];
  // Per-invocation budgets (reset by beginInvocation).
  actionBudget: number;
  projectileBudget: number;
  entityBudget: number;
  /** Weapon runtimes live for the whole match (no duration expiry). */
  persistent: boolean;
  done: boolean;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/**
 * Resolve a behavior value: numbers pass through, booleans become 0/1, and
 * strings read the sense whitelist ("self.hp", "opponent.x", "distance",
 * "age", "rng", "state.<var>"). Anything else yields the fallback.
 */
export function resolveValue(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  v: unknown,
  fallback = 0,
): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "boolean") return v ? 1 : 0;
  // Tiny arithmetic form: {op:"+"|"-"|"*", a: VALUE, b: VALUE} (for counters).
  if (typeof v === "object" && v !== null) {
    const e = v as { op?: unknown; a?: unknown; b?: unknown };
    const a = resolveValue(rt, ctx, e.a, 0);
    const b = resolveValue(rt, ctx, e.b, 0);
    const out = e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : fallback;
    return Number.isFinite(out) ? out : fallback;
  }
  if (typeof v !== "string") return fallback;
  const caster = rt.caster;
  const foe = caster.side === "player" ? ctx.fighters.bot : ctx.fighters.player;
  switch (v) {
    case "self.x": return caster.root.position.x;
    case "self.y": return caster.root.position.y;
    case "self.hp": return caster.hp;
    case "self.maxHp": return caster.maxHp;
    case "self.facing": return caster.facing;
    case "self.grounded": return caster.grounded ? 1 : 0;
    case "self.airborne": return caster.grounded ? 0 : 1;
    case "self.scale": return caster.displayScale;
    case "opponent.x": return foe.root.position.x;
    case "opponent.y": return foe.root.position.y;
    case "opponent.vx": return foe.root.velocity.x;
    case "opponent.vy": return foe.root.velocity.y;
    case "opponent.hp": return foe.hp;
    case "opponent.maxHp": return foe.maxHp;
    case "opponent.grounded": return foe.grounded ? 1 : 0;
    case "opponent.airborne": return foe.grounded ? 0 : 1;
    case "opponent.attacking": return foe.attackAnim > 0 ? 1 : 0;
    case "distance":
      return Math.abs(foe.root.position.x - caster.root.position.x);
    case "age": return rt.age;
    case "now":
    case "match.time": return ctx.time;
    case "myEntities":
      return ctx.entities.filter((e) => e.side === caster.side && !e.dead).length;
    case "rng": return Math.random();
    default: {
      if (v.startsWith("state.")) {
        const n = rt.state[v.slice(6)];
        return Number.isFinite(n) ? n : fallback;
      }
      return fallback;
    }
  }
}

interface BehaviorCond {
  lhs?: unknown;
  op?: unknown;
  rhs?: unknown;
}

function evalCond(rt: BehaviorRuntime, ctx: CombatCtx, cond: unknown): boolean {
  if (typeof cond === "string" || typeof cond === "number" || typeof cond === "boolean") {
    return resolveValue(rt, ctx, cond) > 0;
  }
  if (typeof cond !== "object" || cond === null) return false;
  const c = cond as BehaviorCond;
  const lhs = resolveValue(rt, ctx, c.lhs);
  const rhs = resolveValue(rt, ctx, c.rhs);
  switch (c.op) {
    case "<": return lhs < rhs;
    case ">": return lhs > rhs;
    case "<=": return lhs <= rhs;
    case ">=": return lhs >= rhs;
    case "==": return lhs === rhs;
    case "!=": return lhs !== rhs;
    default: return false;
  }
}

function beginInvocation(rt: BehaviorRuntime): void {
  rt.actionBudget = BEHAVIOR_CAPS.actionsPerInvocation;
  rt.projectileBudget = BEHAVIOR_CAPS.projectilesPerInvocation;
  rt.entityBudget = BEHAVIOR_CAPS.entitiesPerInvocation;
}

/**
 * Run a list of actions. `wait` parks the REST of the current list as a
 * pending continuation (nested if/repeat callers do not resume — documented
 * simplification). Every action is individually try/caught.
 */
function runActions(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  actions: BehaviorAction[],
  depth: number,
): void {
  if (depth > BEHAVIOR_CAPS.depth || rt.done) return;
  const api = createEngineApi(rt, ctx);
  for (let i = 0; i < actions.length; i++) {
    if (rt.done || --rt.actionBudget <= 0) return;
    const a = actions[i];
    try {
      switch (a.do) {
        case "wait": {
          const t = clamp(resolveValue(rt, ctx, a.t ?? a.seconds, 0.3), 0.02, BEHAVIOR_CAPS.wait);
          rt.pending.push({ delay: t, actions: actions.slice(i + 1) });
          return;
        }
        case "if": {
          const branch = evalCond(rt, ctx, a.cond)
            ? (a.then as BehaviorAction[] | undefined)
            : (a.else as BehaviorAction[] | undefined);
          if (Array.isArray(branch)) runActions(rt, ctx, branch, depth + 1);
          break;
        }
        case "repeat": {
          const times = Math.round(clamp(resolveValue(rt, ctx, a.times, 1), 1, BEHAVIOR_CAPS.repeat));
          const each = a.each as BehaviorAction[] | undefined;
          if (Array.isArray(each)) {
            for (let n = 0; n < times && !rt.done && rt.actionBudget > 0; n++) {
              rt.state.i = n; // loop index, readable as "state.i"
              runActions(rt, ctx, each, depth + 1);
            }
          }
          break;
        }
        case "set": {
          if (typeof a.var === "string") {
            rt.state[a.var.slice(0, 24)] = resolveValue(rt, ctx, a.to);
          }
          break;
        }
        default: {
          const verb = api[a.do];
          if (typeof verb === "function") verb(a as Record<string, unknown>);
          // Unknown verbs are silently ignored.
        }
      }
    } catch (err) {
      console.warn("[vibearena] behavior action failed (skipped):", a.do, err);
    }
  }
}

/** Fire one handler on a live runtime (weapon triggers use this directly). */
export function dispatchHandler(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  handler: BehaviorHandler,
): void {
  const actions = rt.program.handlers[handler];
  if (!actions || rt.done) return;
  beginInvocation(rt);
  runActions(rt, ctx, actions, 0);
}

function makeRuntime(
  caster: Fighter,
  program: BehaviorProgram,
  visuals: { element: ElementKind; motif: AbilityMotif; glow: string },
  persistent: boolean,
): BehaviorRuntime {
  const h = program.handlers;
  const needsLife = Boolean(h.onTick || h.onHit || h.onLand);
  return {
    program,
    state: { ...(program.state ?? {}) },
    caster,
    element: visuals.element,
    motif: visuals.motif,
    glow: visuals.glow,
    age: 0,
    duration: clamp(program.duration ?? (needsLife ? 6 : 0.05), 0.05, BEHAVIOR_CAPS.duration),
    wasGrounded: caster.grounded,
    tickAccum: 0,
    pending: [],
    actionBudget: 0,
    projectileBudget: 0,
    entityBudget: 0,
    persistent,
    done: false,
  };
}

/** Start an ability behavior: registers the runtime and fires onCast. */
export function castBehavior(
  caster: Fighter,
  ctx: CombatCtx,
  program: BehaviorProgram,
  visuals: { element: ElementKind; motif: AbilityMotif; glow: string },
): void {
  const rt = makeRuntime(caster, program, visuals, false);
  ctx.behaviors.push(rt);
  dispatchHandler(rt, ctx, "onCast");
}

/**
 * Attach the fighter's weapon behavior for the whole match: a persistent
 * runtime (onTick keeps firing, no duration expiry) whose onEquip runs now.
 * combat.ts dispatches onAttack/onHitTarget on it during swings.
 */
export function equipWeaponBehavior(caster: Fighter, ctx: CombatCtx): void {
  const program = caster.spec.weapon.behavior;
  if (!program) return;
  const element = caster.style.element;
  const rt = makeRuntime(
    caster,
    program,
    { element, motif: "burst", glow: caster.style.glow },
    true,
  );
  caster.weaponRuntime = rt;
  ctx.behaviors.push(rt);
  dispatchHandler(rt, ctx, "onEquip");
}

/** Called from the fixed-step loop: waits, onTick (10 Hz), onLand, expiry. */
export function tickBehaviors(ctx: CombatCtx, dt: number): void {
  for (const rt of ctx.behaviors) {
    if (rt.done) continue;
    rt.age += dt;

    // Wake parked continuations.
    if (rt.pending.length > 0) {
      const ready: BehaviorAction[][] = [];
      for (const p of rt.pending) p.delay -= dt;
      rt.pending = rt.pending.filter((p) => {
        if (p.delay <= 0) {
          ready.push(p.actions);
          return false;
        }
        return true;
      });
      for (const actions of ready) {
        beginInvocation(rt);
        runActions(rt, ctx, actions, 0);
      }
    }

    // onTick, throttled to 10 Hz so a busy program can't melt the frame.
    rt.tickAccum += dt;
    if (rt.tickAccum >= 0.1) {
      rt.tickAccum = 0;
      dispatchHandler(rt, ctx, "onTick");
    }

    // onLand: airborne → grounded edge.
    const grounded = rt.caster.grounded;
    if (!rt.wasGrounded && grounded) dispatchHandler(rt, ctx, "onLand");
    rt.wasGrounded = grounded;

    if (
      (!rt.persistent && rt.age >= rt.duration && rt.pending.length === 0) ||
      !rt.caster.alive
    ) {
      rt.done = true;
    }
  }
  // Drop finished runtimes in place (ctx.behaviors is shared).
  for (let i = ctx.behaviors.length - 1; i >= 0; i--) {
    if (ctx.behaviors[i].done) ctx.behaviors.splice(i, 1);
  }
}

/** Fired when something this behavior spawned connects with the opponent. */
export function dispatchBehaviorHit(rt: BehaviorRuntime, ctx: CombatCtx): void {
  dispatchHandler(rt, ctx, "onHit");
}

// ---------------------------------------------------------------------------
// Smoke test — the "anything works" guarantee at generation time.
// ---------------------------------------------------------------------------

/**
 * Run every handler once against a stub arena with all verbs no-oped. Caps
 * still apply, per-action try/catch is bypassed at the top level so genuine
 * interpreter-breaking shapes surface as a throw → caller drops the behavior.
 */
export function smokeTestBehavior(program: BehaviorProgram): boolean {
  const fakeFighter = {
    root: { position: { x: 200, y: 300 } },
    hp: 100,
    maxHp: 100,
    facing: 1,
    grounded: true,
    alive: true,
    side: "player",
  } as unknown as Fighter;
  const fakeCtx = {
    fighters: { player: fakeFighter, bot: { ...fakeFighter, side: "bot" } },
    behaviors: [],
    entities: [],
    projectiles: [],
    effects: [],
    time: 0,
    hitstop: 0,
    // Missing arena is fine: verbs are no-oped below and never touch it.
  } as unknown as CombatCtx;

  const rt: BehaviorRuntime = {
    program,
    state: { ...(program.state ?? {}) },
    caster: fakeFighter,
    element: "none",
    motif: "burst",
    glow: "#fff",
    age: 0,
    duration: 1,
    wasGrounded: true,
    tickAccum: 0,
    pending: [],
    actionBudget: 0,
    projectileBudget: 0,
    entityBudget: 0,
    persistent: false,
    done: false,
  };

  try {
    for (const handler of BEHAVIOR_HANDLERS) {
      const actions = program.handlers[handler];
      if (!actions) continue;
      beginInvocation(rt);
      runSmoke(rt, fakeCtx, actions, 0);
    }
    // Drain a few rounds of parked continuations.
    for (let round = 0; round < 8 && rt.pending.length > 0; round++) {
      const batch = rt.pending.splice(0, rt.pending.length);
      for (const p of batch) {
        beginInvocation(rt);
        runSmoke(rt, fakeCtx, p.actions, 0);
      }
    }
    return true;
  } catch (err) {
    console.warn("[vibearena] behavior failed smoke test:", err);
    return false;
  }
}

/** Smoke variant of runActions: same control flow, verbs are no-ops. */
function runSmoke(
  rt: BehaviorRuntime,
  ctx: CombatCtx,
  actions: BehaviorAction[],
  depth: number,
): void {
  if (depth > BEHAVIOR_CAPS.depth) return;
  for (let i = 0; i < actions.length; i++) {
    if (--rt.actionBudget <= 0) return;
    const a = actions[i];
    switch (a.do) {
      case "wait": {
        rt.pending.push({ delay: 0, actions: actions.slice(i + 1) });
        return;
      }
      case "if": {
        const branch = evalCond(rt, ctx, a.cond)
          ? (a.then as BehaviorAction[] | undefined)
          : (a.else as BehaviorAction[] | undefined);
        if (Array.isArray(branch)) runSmoke(rt, ctx, branch, depth + 1);
        break;
      }
      case "repeat": {
        const times = Math.round(clamp(resolveValue(rt, ctx, a.times, 1), 1, BEHAVIOR_CAPS.repeat));
        const each = a.each as BehaviorAction[] | undefined;
        if (Array.isArray(each)) {
          for (let n = 0; n < times && rt.actionBudget > 0; n++) runSmoke(rt, ctx, each, depth + 1);
        }
        break;
      }
      case "set": {
        if (typeof a.var === "string") rt.state[a.var.slice(0, 24)] = resolveValue(rt, ctx, a.to);
        break;
      }
      default:
        // Verb args must at least resolve without throwing.
        for (const val of Object.values(a)) resolveValue(rt, ctx, val);
        break;
    }
  }
}
