import type { CharacterSpec } from "../types/character";

/**
 * Swappable LLM adapter. Implementations must never reject — on any failure
 * they resolve with a valid fallback character so the game never crashes.
 */
export interface ModelAdapter {
  generate(prompt: string): Promise<CharacterSpec>;
}
