import { DEFAULT_CHARACTER, parseCharacterSpec, type CharacterSpec } from "../types/character";
import { balanceCharacter } from "../balance/statBudget";
import { enrichCharacter } from "./enrich";
import type { ModelAdapter } from "./modelAdapter";

/**
 * Adapter that talks to the backend proxy (which holds the Groq/OpenRouter
 * key — the client never sees it). Parses and validates the LLM's JSON, then
 * runs it through the deterministic stat budget.
 */

export interface GenerationResult {
  spec: CharacterSpec;
  /** True when validation/network failed and the default character was used. */
  fallback: boolean;
  /** True when the server had no API key and answered with its mock provider. */
  mocked: boolean;
}

/** LLMs love fences and preambles; dig the JSON object out of whatever came back. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

export async function generateCharacter(prompt: string): Promise<GenerationResult> {
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`generate failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { content: string; mocked?: boolean };

    const spec = parseCharacterSpec(extractJson(body.content));
    if (!spec) throw new Error("LLM response failed CharacterSpec validation");

    return {
      spec: enrichCharacter(balanceCharacter(spec)),
      fallback: false,
      mocked: Boolean(body.mocked),
    };
  } catch (err) {
    console.warn("[vibearena] generation failed, using default character:", err);
    return { spec: enrichCharacter(balanceCharacter(DEFAULT_CHARACTER)), fallback: true, mocked: false };
  }
}

/** ModelAdapter-conformant wrapper around generateCharacter. */
export const groqAdapter: ModelAdapter = {
  async generate(prompt: string): Promise<CharacterSpec> {
    return (await generateCharacter(prompt)).spec;
  },
};
