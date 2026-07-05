/**
 * Keyboard input. The bot feeds the same InputState shape from its FSM, so
 * combat/animation never care whether a fighter is driven by a human or AI.
 *
 * INPUT_BINDINGS is the single place every key lives:
 * - solo: 1-player mode — one human owns the whole keyboard.
 * - p1 / p2: 2-player hotseat — non-overlapping clusters on opposite sides
 *   of one shared keyboard (P1 left hand, P2 right hand).
 */
export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean;
  /** Held with jump while standing on a platform: drop through it. */
  down: boolean;
  attack: boolean;
  /** ATTACK ability (aoe / projectile). */
  ability: boolean;
  /** UTILITY ability (dash / shield / heal / buff). */
  utility: boolean;
  /** Hold to BLOCK; a well-timed tap just before a hit lands = PARRY. */
  block: boolean;
}

export const emptyInput = (): InputState => ({
  left: false,
  right: false,
  jump: false,
  down: false,
  attack: false,
  ability: false,
  utility: false,
  block: false,
});

/** KeyboardEvent.code values per action. */
export interface Bindings {
  left: string[];
  right: string[];
  jump: string[];
  down: string[];
  attack: string[];
  ability: string[];
  utility: string[];
  block: string[];
}

export const INPUT_BINDINGS: { solo: Bindings; p1: Bindings; p2: Bindings } = {
  solo: {
    left: ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
    jump: ["KeyW", "Space", "ArrowUp"],
    down: ["KeyS", "ArrowDown"],
    attack: ["KeyJ"],
    ability: ["KeyK"],
    utility: ["KeyL"],
    block: ["Semicolon"], // completes the J/K/L home row
  },
  p1: {
    left: ["KeyA"],
    right: ["KeyD"],
    jump: ["KeyW"],
    down: ["KeyS"],
    attack: ["KeyF"],
    ability: ["KeyG"],
    utility: ["KeyH"],
    block: ["KeyV"],
  },
  p2: {
    left: ["ArrowLeft"],
    right: ["ArrowRight"],
    jump: ["ArrowUp"],
    down: ["ArrowDown"],
    attack: ["Period"],
    ability: ["Slash"],
    utility: ["Quote"],
    block: ["ShiftRight"],
  },
};

/** Keys the browser would otherwise scroll / quick-find with. */
const PREVENT_DEFAULT = new Set([
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Slash",
  "Quote",
]);

export interface Keyboard {
  state: InputState;
  attach(): void;
  detach(): void;
}

export function createKeyboard(bindings: Bindings): Keyboard {
  const state = emptyInput();

  const keymap = new Map<string, keyof InputState>();
  for (const action of Object.keys(bindings) as (keyof Bindings)[]) {
    for (const code of bindings[action]) keymap.set(code, action);
  }

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const action = keymap.get(e.code);
    if (!action) return;
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    state[action] = down;
  };
  const onDown = onKey(true);
  const onUp = onKey(false);

  return {
    state,
    attach() {
      window.addEventListener("keydown", onDown);
      window.addEventListener("keyup", onUp);
    },
    detach() {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    },
  };
}
