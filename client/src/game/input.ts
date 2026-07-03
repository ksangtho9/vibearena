/**
 * Keyboard mapping: A/D (or arrows) move, W/Space/Up jump, J attack, K ability.
 * The bot feeds the same InputState shape from its FSM, so player and bot go
 * through identical control code.
 */
export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean;
  attack: boolean;
  ability: boolean;
}

export const emptyInput = (): InputState => ({
  left: false,
  right: false,
  jump: false,
  attack: false,
  ability: false,
});

const KEYMAP: Record<string, keyof InputState> = {
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  KeyW: "jump",
  ArrowUp: "jump",
  Space: "jump",
  KeyJ: "attack",
  KeyK: "ability",
};

export interface Keyboard {
  state: InputState;
  attach(): void;
  detach(): void;
}

export function createKeyboard(): Keyboard {
  const state = emptyInput();

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const action = KEYMAP[e.code];
    if (!action) return;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
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
