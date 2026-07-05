import { buildSystemPrompt, type PromptTier } from "../../client/src/generation/prompt";

/**
 * Groq chat-completions provider with MODEL ROTATION and MODEL-AWARE
 * PROMPTS. Groq free-tier rate limits are per-model (each model has its own
 * tokens/min bucket), so on a 429 we simply try the next model in the pool
 * instead of giving up — multiplying effective throughput. Each model gets
 * the system-prompt tier its token window can afford (see promptTierFor).
 * Returns the model's raw JSON string; parsing and validation happen on the
 * client against the zod schema.
 */

// llama-3.1-8b-instant (6k window) is back as the final fallback: the LEAN
// prompt (~2.8k + 2.2k completion ≈ 5k) fits where the old prompt 413'd.
const DEFAULT_MODELS =
  "llama-3.3-70b-versatile,openai/gpt-oss-120b,openai/gpt-oss-20b,meta-llama/llama-4-scout-17b-16e-instruct,llama-3.1-8b-instant";

/**
 * Which models can afford the FULL prompt (~6k tokens + 2.2k completion).
 * The binding limit on the free tier is the per-minute token window, checked
 * live (v3.5): llama-3.3-70b ≈ 12k, llama-4-scout ≈ 30k — both fit `full`;
 * gpt-oss models ≈ 8k — they get `lean` (~2.8k + completion ≈ 5k, real
 * headroom). Unknown models default to `lean`: never 413 a stranger.
 */
const FULL_PROMPT_MODELS = ["llama-3.3-70b", "llama-4-scout"];

export function promptTierFor(model: string): PromptTier {
  return FULL_PROMPT_MODELS.some((m) => model.includes(m)) ? "full" : "lean";
}

/** How long a rate-limited/5xx model sits out before we re-try its bucket. */
const COOLDOWN_MS = 60_000;

/** model → epoch ms until which we skip it (module state, per process). */
const coolingUntil = new Map<string, number>();

/**
 * Ordered pool: GROQ_MODEL (single-model override, back-compat) wins;
 * otherwise GROQ_MODELS (comma-separated, strongest first); otherwise the
 * default chain. Read per-call so tsx watch restarts pick up .env edits.
 */
function modelPool(): string[] {
  const single = process.env.GROQ_MODEL?.trim();
  if (single) return [single];
  return (process.env.GROQ_MODELS || DEFAULT_MODELS)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Thrown when every model in the pool is cooling or failed this call. */
export class AllModelsBusyError extends Error {
  constructor(
    /** True when rate limits (429/cooldown) were the dominant cause. */
    public readonly rateLimited: boolean,
    lastError: unknown,
  ) {
    super(
      `all Groq models exhausted (${rateLimited ? "rate-limited" : "failing"}); last: ${String(lastError).slice(0, 200)}`,
    );
    this.name = "AllModelsBusyError";
  }
}

export async function generateWithGroq(_system: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  let lastError: unknown = null;
  let sawRateLimit = false;

  for (const model of modelPool()) {
    // Skip buckets we know are exhausted — don't waste the round-trip.
    if ((coolingUntil.get(model) ?? 0) > Date.now()) {
      sawRateLimit = true;
      continue;
    }

    // Model-aware prompt: rich reference for big windows, trimmed core for
    // small ones (keeps gpt-oss in the rotation instead of 413ing).
    const tier = promptTierFor(model);
    const system = buildSystemPrompt(tier);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.9,
          // Behavior programs made specs much longer — leave generous headroom.
          max_tokens: 2200,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        lastError = new Error(`Groq ${res.status} on ${model}: ${body}`);
        if (res.status === 429 || res.status === 413 || res.status >= 500) {
          // Rate-limited / request-too-large-for-TPM / server trouble:
          // bench this model, try the next.
          coolingUntil.set(model, Date.now() + COOLDOWN_MS);
          if (res.status === 429 || res.status === 413) sawRateLimit = true;
          console.warn(`[vibearena] groq ${model} → ${res.status}, cooling 60s, rotating`);
        } else {
          // 4xx (bad request, decommissioned model…): don't cool — the
          // bucket is fine, the model isn't. Move on.
          console.warn(`[vibearena] groq ${model} → ${res.status}, skipping: ${body}`);
        }
        continue;
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        lastError = new Error(`Groq returned an empty completion on ${model}`);
        continue;
      }
      console.log(`[vibearena] groq answered via ${model} (${tier} prompt)`);
      return content;
    } catch (err) {
      // Network-level failure: transient, no cooldown, next model.
      lastError = err;
      console.warn(`[vibearena] groq ${model} network error, rotating:`, err);
    }
  }

  throw new AllModelsBusyError(sawRateLimit, lastError);
}
