import { useState } from "react";
import { useVibeStore } from "../store";

/**
 * Curated pool of example fighters. Three are drawn at random per mount, so
 * every visit to this screen suggests something new — intentionally NOT
 * LLM-generated (no API cost just for loading the page).
 */
const EXAMPLE_POOL = [
  "a drunk samurai who throws exploding sake bottles and dashes on a hangover",
  "a librarian who silences the arena and hurls overdue encyclopedias",
  "a tiny wizard grandpa with a walking-stick railgun and a nap-powered shield",
  "a grandma knight with a cast-iron skillet and an impenetrable shawl",
  "a ballet assassin whose pirouettes whip up razor wind",
  "a sentient traffic cone that lobs molten asphalt",
  "a mime who punches through the walls of his invisible box",
  "a barista berserker flinging scalding espresso shots",
  "a haunted scarecrow guarded by a tornado of crows",
  "a disco knight whose shield is a spinning mirrorball",
  "a sleepy panda monk who fights better while dreaming",
  "a glitchy arcade hologram with a flickering pixel sword",
  "a beekeeper general who calls in hive artillery strikes",
  "a lava-lamp golem lobbing blobs of hypnotic goo",
  "an origami dragon that folds itself into paper blades",
  "a plumber sage with a pipe staff and a geyser slam",
  "a vampire accountant who drains HP like unpaid taxes",
  "a rooftop pigeon king armed with a baguette lance",
] as const;

function pickExamples(): string[] {
  const pool = [...EXAMPLE_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

/**
 * The fight poster. Type a fighter, get chalked onto the board.
 */
export function PromptScreen() {
  const phase = useVibeStore((s) => s.phase);
  const mode = useVibeStore((s) => s.mode);
  const promptFor = useVibeStore((s) => s.promptFor);
  const generate = useVibeStore((s) => s.generate);
  const toModeSelect = useVibeStore((s) => s.toModeSelect);
  const storedPrompt = useVibeStore((s) => s.prompt);
  const [text, setText] = useState(storedPrompt);
  // Fresh random trio per mount (page load / each player's turn in 2P).
  const [examples] = useState(pickExamples);
  const generating = phase === "generating";
  const canSubmit = text.trim().length > 2 && !generating;
  const hotseat = mode === "2p";

  const submit = () => {
    if (canSubmit) void generate(text.trim());
  };

  return (
    <main className="screen prompt-screen">
      <p className="eyebrow">
        {hotseat ? `PLAYER ${promptFor} — CHALK UP YOUR CHALLENGER` : "TONIGHT, ON THE BOARD"}
      </p>
      <h1 className="poster-title">
        {hotseat ? (
          <>
            PLAYER<span className="title-mark">{promptFor}</span>
          </>
        ) : (
          <>
            VIBE<span className="title-mark">✕</span>ARENA
          </>
        )}
      </h1>
      <p className="tagline">
        {hotseat
          ? promptFor === 1
            ? "Player 1: type your fighter. Player 2 goes next."
            : "Player 2: your turn. Type the fighter who'll settle this."
          : "Type a fighter. We chalk it up. You step into the ring."}
      </p>

      <label className="prompt-label" htmlFor="fighter-prompt">
        Describe your fighter
      </label>
      <textarea
        id="fighter-prompt"
        className="prompt-input"
        value={text}
        placeholder={`e.g. "${examples[0]}"`}
        rows={3}
        maxLength={300}
        disabled={generating}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />

      <div className="chips" aria-label="Example fighters">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            className="chip"
            disabled={generating}
            onClick={() => setText(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <button type="button" className="btn-tape" disabled={!canSubmit} onClick={submit}>
        {generating ? "Chalking up your fighter…" : "Generate fighter"}
      </button>
      <p className="fine-print">One prompt, one fighter. Stats are budget-capped — style wins, not numbers.</p>
      <button type="button" className="chip" disabled={generating} onClick={toModeSelect}>
        ‹ change mode
      </button>
    </main>
  );
}
