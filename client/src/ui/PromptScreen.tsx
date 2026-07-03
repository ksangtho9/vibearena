import { useState } from "react";
import { useVibeStore } from "../store";

const EXAMPLES = [
  "a drunk samurai who throws exploding sake bottles and dashes on a hangover",
  "a librarian who silences the arena and hurls overdue encyclopedias",
  "a tiny wizard grandpa with a walking-stick railgun and a nap-powered shield",
];

/**
 * The fight poster. Type a fighter, get chalked onto the board.
 */
export function PromptScreen() {
  const phase = useVibeStore((s) => s.phase);
  const generate = useVibeStore((s) => s.generate);
  const storedPrompt = useVibeStore((s) => s.prompt);
  const [text, setText] = useState(storedPrompt);
  const generating = phase === "generating";
  const canSubmit = text.trim().length > 2 && !generating;

  const submit = () => {
    if (canSubmit) void generate(text.trim());
  };

  return (
    <main className="screen prompt-screen">
      <p className="eyebrow">TONIGHT, ON THE BOARD</p>
      <h1 className="poster-title">
        VIBE<span className="title-mark">✕</span>ARENA
      </h1>
      <p className="tagline">Type a fighter. We chalk it up. You step into the ring.</p>

      <label className="prompt-label" htmlFor="fighter-prompt">
        Describe your fighter
      </label>
      <textarea
        id="fighter-prompt"
        className="prompt-input"
        value={text}
        placeholder={`e.g. "${EXAMPLES[0]}"`}
        rows={3}
        maxLength={300}
        disabled={generating}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />

      <div className="chips" aria-label="Example fighters">
        {EXAMPLES.map((example) => (
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
    </main>
  );
}
