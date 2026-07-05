/**
 * Groq chat-completions provider with MODEL ROTATION. Groq free-tier rate
 * limits are per-model (each model has its own tokens/min bucket), so on a
 * 429 we simply try the next model in the pool instead of giving up —
 * multiplying effective throughput. Returns the model's raw JSON string;
 * parsing and validation happen on the client against the zod schema.
 */

// NOTE: llama-3.1-8b-instant is deliberately absent — its 6k-token/min
// window is smaller than one behavior-era request (~7k tokens), so it 413s
// every call. llama-4-scout has a 30k window and makes a real last resort.
const DEFAULT_MODELS =
  "llama-3.3-70b-versatile,openai/gpt-oss-120b,openai/gpt-oss-20b,meta-llama/llama-4-scout-17b-16e-instruct";

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

export async function generateWithGroq(system: string, userPrompt: string): Promise<string> {
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
      console.log(`[vibearena] groq answered via ${model}`);
      return content;
    } catch (err) {
      // Network-level failure: transient, no cooldown, next model.
      lastError = err;
      console.warn(`[vibearena] groq ${model} network error, rotating:`, err);
    }
  }

  throw new AllModelsBusyError(sawRateLimit, lastError);
}
