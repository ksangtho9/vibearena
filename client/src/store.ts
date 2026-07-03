import { create } from "zustand";
import type { CharacterSpec } from "./types/character";
import { generateCharacter } from "./generation/groqAdapter";
import { balanceCharacter } from "./balance/statBudget";
import { pickBotSpec } from "./game/bot";
import type { Side } from "./game/stickman";
import type { HudState } from "./game/loop";

export type Phase = "prompt" | "generating" | "preview" | "fight" | "result";

/** How the current spec was produced — surfaced as a small note on the card. */
export type GenerationNote = "" | "mocked" | "fallback";

interface VibeStore {
  phase: Phase;
  prompt: string;
  spec: CharacterSpec | null;
  botSpec: CharacterSpec | null;
  result: Side | null;
  hud: HudState | null;
  note: GenerationNote;

  setPrompt(prompt: string): void;
  generate(prompt: string): Promise<void>;
  reroll(): Promise<void>;
  enterFight(): void;
  setHud(hud: HudState): void;
  endFight(winner: Side): void;
  rematch(): void;
  newPrompt(): void;
}

export const useVibeStore = create<VibeStore>((set, get) => ({
  phase: "prompt",
  prompt: "",
  spec: null,
  botSpec: null,
  result: null,
  hud: null,
  note: "",

  setPrompt: (prompt) => set({ prompt }),

  generate: async (prompt) => {
    set({ phase: "generating", prompt });
    const { spec, fallback, mocked } = await generateCharacter(prompt);
    set({
      spec,
      note: fallback ? "fallback" : mocked ? "mocked" : "",
      phase: "preview",
    });
  },

  reroll: async () => {
    const { prompt, generate } = get();
    await generate(prompt);
  },

  enterFight: () => {
    // A fresh house fighter each match, balanced on the same budget.
    set({ botSpec: balanceCharacter(pickBotSpec()), result: null, hud: null, phase: "fight" });
  },

  setHud: (hud) => set({ hud }),

  endFight: (winner) => set({ result: winner, phase: "result" }),

  rematch: () => {
    const { enterFight } = get();
    enterFight();
  },

  newPrompt: () => set({ phase: "prompt", spec: null, botSpec: null, result: null, hud: null, note: "" }),
}));
