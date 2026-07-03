# VIBE ✕ ARENA

A prompt-to-fighter game. Type a fighter in plain English — *"a drunk samurai who
throws exploding sake bottles and dashes on a hangover"* — and an LLM turns it into
a playable chalk stickman: name, look, weapon, ability, stats. Then you fight a
house bot in a real-time ragdoll-physics ring.

**Prompt → preview → fight → win/lose → rematch.** The whole loop is playable.

## Run it

```bash
npm install
cp .env.example .env   # optional — the game runs without a key (see below)
npm run dev
```

`npm run dev` starts the Vite client on <http://localhost:5173> and the Express
proxy on port 8787 concurrently. Open the client URL and type a fighter.

**No API key?** The server falls back to a built-in mock generator, so the full
game loop works offline — your fighter is just drawn from a house roster instead
of dreamed up by an LLM.

### Getting a free key

- **Groq** (default): create a key at <https://console.groq.com/keys>, put it in
  `.env` as `GROQ_API_KEY=...`.
- **OpenRouter**: create a key at <https://openrouter.ai/keys>, set
  `OPENROUTER_API_KEY=...` and `PROVIDER=openrouter`.

### Controls

`A`/`D` move · `W`/`Space` jump · `J` attack · `K` ability

## Architecture

The client never sees the LLM key: a thin Express proxy (`server/`) holds it and
forwards generation requests to Groq or OpenRouter behind a swappable provider
interface — the client's own `ModelAdapter` (`client/src/generation/`) only knows
about `/api/generate`, and every response is validated against a zod schema with
a safe default fighter on any failure. Stats are deterministically rebalanced in
`client/src/balance/statBudget.ts`: the LLM's numbers are treated as weights and
normalized onto a fixed budget with clamped damage/range/cooldown bands, so a
prompt buys identity, never dominance. Fighters are Matter.js ragdolls (head,
torso, arms, legs joined by constraints) rendered as chalk drawings on a canvas;
the torso keeps infinite inertia while alive so you can actually steer it, and
collapses into a full ragdoll at 0 HP. The bot runs a small approach → strike →
dodge/retreat FSM and feeds the same input shape and stat budget as the player.

## Scripts

| Script          | What it does                              |
| --------------- | ----------------------------------------- |
| `npm run dev`   | Client (Vite, :5173) + server (:8787)     |
| `npm run build` | Typecheck + production client build       |
| `npm run lint`  | TypeScript project check (`tsc --noEmit`) |
