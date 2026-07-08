import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { AllModelsBusyError, generateWithGroq, suggestWithGroq } from "./providers/groq";
import { generateWithOpenRouter } from "./providers/openrouter";
// Single source of truth for the system prompt, shared with the client build.
import { SYSTEM_PROMPT } from "../client/src/generation/prompt";

/**
 * Thin proxy that holds the LLM API key. The browser only ever talks to
 * /api/generate here; the key never ships to the client.
 */

const app = express();
const port = Number(process.env.PORT) || 8787;

app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));
app.use(express.json({ limit: "16kb" }));

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Easy, champ. Too many fighters — try again in a minute." },
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: activeProvider().name });
});

/** Local suggestion pool — served when no key / rotation exhausted, so the
 * prompt screen always has chips. Mirrors the client's own fallback. */
const SUGGEST_FALLBACK: [string, string, string][] = [
  [
    "a mailman whose letters explode on delivery",
    "a sushi chef who flash-freezes the floor and flings knife fans",
    "a karaoke banshee whose high note flips gravity, spawns two backup-singer clones, and lasers the crowd on the chorus",
  ],
  [
    "a crossing guard whose stop sign hits like a truck",
    "a beekeeper who lobs hive grenades and hides behind a living swarm",
    "an origami warlord who folds paper clones, rains razor cranes from above, and grows into a giant crane when cornered",
  ],
  [
    "a barista who steams foes with a portafilter flamethrower",
    "a gravedigger who trips you into open graves and heals under moonlight",
    "a weather anchor who slows time for the forecast, drops localized blizzards, and rides a tornado that hurls boomerang lightning",
  ],
];

const suggestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "suggestion limit reached" },
});

app.post("/api/suggest", suggestLimiter, async (req, res) => {
  const avoidRaw = Array.isArray(req.body?.avoid) ? (req.body.avoid as unknown[]) : [];
  const avoid = avoidRaw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.slice(0, 220))
    .slice(-40);

  const fallback = () => {
    const trio = SUGGEST_FALLBACK[Math.floor(Math.random() * SUGGEST_FALLBACK.length)];
    res.json({ suggestions: { simple: trio[0], medium: trio[1], wild: trio[2] }, source: "fallback" });
  };

  if (activeProvider().name !== "groq") {
    fallback();
    return;
  }
  try {
    const content = await suggestWithGroq(avoid);
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    const clean = (v: unknown) => {
      if (typeof v !== "string" || v.trim().length < 8) return null;
      let s = v.trim();
      if (s.length > 220) {
        s = s.slice(0, 220);
        const cut = s.lastIndexOf(" ");
        if (cut > 80) s = s.slice(0, cut); // never end mid-word
      }
      return s;
    };
    const simple = clean(parsed.simple);
    const medium = clean(parsed.medium);
    const wild = clean(parsed.wild);
    if (!simple || !medium || !wild) throw new Error("suggestion trio failed validation");
    res.json({ suggestions: { simple, medium, wild }, source: "llm" });
  } catch (err) {
    // Suggestions are decoration — never surface an error to the screen.
    console.error("[vibearena] suggest failed:", String(err).slice(0, 200));
    fallback();
  }
});

app.post("/api/generate", limiter, async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 300) {
    res.status(400).json({ error: "prompt must be a string of 3-300 characters" });
    return;
  }

  const provider = activeProvider();
  try {
    const content = await provider.generate(SYSTEM_PROMPT, prompt);
    res.json({
      content,
      provider: provider.name,
      mocked: provider.name === "mock",
      // The only way to land on the mock with a healthy key is asking for it.
      ...(provider.name === "mock" ? { mockReason: "nokey" as const } : {}),
    });
  } catch (err) {
    // Provider trouble should never kill the game — fall back to the mock.
    // mockReason lets the client tell "come back in a minute" apart from
    // "no key configured" (it may ignore the field; that's fine).
    console.error(`[vibearena] ${provider.name} failed:`, err);
    const mockReason =
      err instanceof AllModelsBusyError && err.rateLimited ? "busy" : "error";
    res.json({ content: mockCharacter(prompt), provider: "mock", mocked: true, mockReason });
  }
});

interface Provider {
  name: string;
  generate(system: string, prompt: string): Promise<string>;
}

function activeProvider(): Provider {
  const choice = (process.env.PROVIDER || "groq").toLowerCase();
  if (choice === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return { name: "openrouter", generate: generateWithOpenRouter };
  }
  if (choice === "groq" && process.env.GROQ_API_KEY) {
    return { name: "groq", generate: generateWithGroq };
  }
  return { name: "mock", generate: async (_system, prompt) => mockCharacter(prompt) };
}

// ---------------------------------------------------------------------------
// Mock provider: no API key needed. Derives a valid, prompt-flavored
// character deterministically so the whole game loop works offline.
// ---------------------------------------------------------------------------

const MOCK_ARCHETYPES = [
  {
    color: "#e8b33c",
    weapon: { type: "melee", name: "Borrowed Broadsword", range: 6, damage: 7 },
    ability: { name: "Chalk Dust Cloud", kind: "dash", cooldown: 5, power: 7 },
    stats: { hp: 6, speed: 7, strength: 6, defense: 3 },
  },
  {
    color: "#9bd0e0",
    weapon: { type: "ranged", name: "Slingshot Deluxe", range: 8, damage: 5 },
    ability: { name: "Pocket Sand", kind: "projectile", cooldown: 6, power: 6 },
    stats: { hp: 4, speed: 8, strength: 4, defense: 4 },
  },
  {
    color: "#c8a2e8",
    weapon: { type: "thrown", name: "Lucky Horseshoes", range: 7, damage: 6 },
    ability: { name: "Stubborn Streak", kind: "buff", cooldown: 8, power: 7 },
    stats: { hp: 7, speed: 4, strength: 7, defense: 5 },
  },
  {
    color: "#8fd18a",
    weapon: { type: "melee", name: "Folding Chair", range: 5, damage: 8 },
    ability: { name: "Deep Breath", kind: "heal", cooldown: 9, power: 7 },
    stats: { hp: 8, speed: 3, strength: 6, defense: 7 },
  },
] as const;

function mockCharacter(prompt: string): string {
  let hash = 0;
  for (const ch of prompt) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const arch = MOCK_ARCHETYPES[Math.abs(hash) % MOCK_ARCHETYPES.length];

  const words = prompt
    .replace(/[^a-zA-Z ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const name = words.length > 0 ? `${words.join(" ")} the Understudy` : "The Understudy";

  return JSON.stringify({
    name: name.slice(0, 40),
    appearance: {
      color: arch.color,
      accessories: ["name tag"],
      height: 0.9 + (Math.abs(hash >> 4) % 30) / 100,
    },
    weapon: arch.weapon,
    ability: arch.ability,
    stats: arch.stats,
    flavor: "Stand-in fighter from the house roster — add an API key for the real deal.",
  });
}

app.listen(port, () => {
  console.log(`[vibearena] server on http://localhost:${port} (provider: ${activeProvider().name})`);
});
