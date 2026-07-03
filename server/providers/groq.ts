/**
 * Groq chat-completions provider. Returns the model's raw JSON string;
 * parsing and validation happen on the client against the zod schema.
 */
export async function generateWithGroq(system: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 700,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty completion");
  return content;
}
