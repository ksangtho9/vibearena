import { create } from "zustand";
import type { CharacterSpec } from "./types/character";
import { generateCharacter } from "./generation/groqAdapter";
import { playSfx } from "./audio/sfx";
import { enrichCharacter } from "./generation/enrich";
import { balanceCharacter } from "./balance/statBudget";
import { pickBotSpec } from "./game/bot";
import type { Side } from "./game/stickman";
import type { HudState } from "./game/loop";

export type Mode = "1p" | "2p";
export type Phase = "mode" | "prompt" | "generating" | "preview" | "fight" | "result";

/** How the current spec was produced — surfaced as a small note on the card. */
export type GenerationNote = "" | "mocked" | "fallback";

interface VibeStore {
  mode: Mode;
  phase: Phase;
  /** Whose prompt/preview is on screen (always 1 in 1P mode). */
  promptFor: 1 | 2;
  prompt: string;
  /** Player 1's fighter. */
  spec: CharacterSpec | null;
  /** Player 2's fighter (2P mode only). */
  spec2: CharacterSpec | null;
  /** The right-side opponent in the ring: P2's fighter in 2P, a bot in 1P. */
  botSpec: CharacterSpec | null;
  result: Side | null;
  hud: HudState | null;
  note: GenerationNote;

  chooseMode(mode: Mode): void;
  toModeSelect(): void;
  setPrompt(prompt: string): void;
  generate(prompt: string): Promise<void>;
  reroll(): Promise<void>;
  /** Preview confirmed: advance to P2's prompt (2P) or into the ring. */
  confirmFighter(): void;
  enterFight(): void;
  setHud(hud: HudState): void;
  endFight(winner: Side): void;
  rematch(): void;
  newPrompt(): void;
}

const clearedFighters = {
  promptFor: 1 as const,
  prompt: "",
  spec: null,
  spec2: null,
  botSpec: null,
  result: null,
  hud: null,
  note: "" as const,
};

export const useVibeStore = create<VibeStore>((set, get) => ({
  mode: "1p",
  phase: "mode",
  ...clearedFighters,

  chooseMode: (mode) => set({ mode, phase: "prompt", ...clearedFighters }),

  toModeSelect: () => set({ phase: "mode", ...clearedFighters }),

  setPrompt: (prompt) => set({ prompt }),

  generate: async (prompt) => {
    set({ phase: "generating", prompt });
    const { spec, fallback, mocked } = await generateCharacter(prompt);
    const note: GenerationNote = fallback ? "fallback" : mocked ? "mocked" : "";
    playSfx("generate");
    if (get().promptFor === 2) set({ spec2: spec, note, phase: "preview" });
    else set({ spec, note, phase: "preview" });
  },

  reroll: async () => {
    const { prompt, generate } = get();
    await generate(prompt);
  },

  confirmFighter: () => {
    const { mode, promptFor, enterFight } = get();
    if (mode === "2p" && promptFor === 1) {
      set({ promptFor: 2, phase: "prompt", prompt: "", note: "" });
    } else {
      enterFight();
    }
  },

  enterFight: () => {
    const { mode, spec2 } = get();
    // 2P: the opponent is Player 2's fighter. 1P: a fresh house bot each
    // match, balanced on the same budget.
    const botSpec =
      mode === "2p" && spec2 ? spec2 : enrichCharacter(balanceCharacter(pickBotSpec()));
    set({ botSpec, result: null, hud: null, phase: "fight" });
  },

  setHud: (hud) => set({ hud }),

  endFight: (winner) => set({ result: winner, phase: "result" }),

  rematch: () => {
    const { enterFight } = get();
    enterFight();
  },

  newPrompt: () => set({ phase: "prompt", ...clearedFighters }),
}));
