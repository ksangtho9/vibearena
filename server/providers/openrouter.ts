/**
 * OpenRouter chat-completions provider — same interface as the Groq one, so
 * PROVIDER=openrouter in .env is the only switch needed.
 */
export async function generateWithOpenRouter(system: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-Title": "Vibe Arena",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 700,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned an empty completion");
  return content;
}
