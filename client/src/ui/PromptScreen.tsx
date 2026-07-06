import { useState } from "react";
import { useVibeStore } from "../store";

/**
 * Curated example fighters in THREE escalating tiers. One chip is drawn from
 * each tier per mount (simplest first), so the suggestions read as a power
 * curve — intentionally NOT LLM-generated (no API cost just for loading the
 * page).
 */
const MEDIUM = [
  "a grumpy lumberjack with an axe that bursts into flames",
  "a ballet assassin who dashes across the stage on pointe",
  "a retired sumo who belly-flops shockwaves",
  "a vampire barista who drains life with a scalding espresso whip",
  "a punk skater swinging a rocket-powered skateboard",
  "a tiny wizard grandpa with a nap-powered shield and a walking-stick zap",
  "a cowboy raccoon who flings spinning trash-can lids",
];
const COMPLEX = [
  "a frost witch who freezes the floor slick and splits into a mirror image",
  "a cactus gunslinger who fans six thorn-bullets and roots you to the spot",
  "a thunder monk whose fists chain lightning and who blinks behind you to counter",
  "a plague alchemist who lobs poison bombs and heals off every hit",
  "a gravity-hexed knight whose greatsword slams a shockwave and yanks you in",
  "a beekeeper general who calls in hive artillery and hides behind a swarm shield",
  "a mirror duelist who parries with a shield of glass and launches you skyward",
];
const CHAOS = [
  "a cosmic disco lich who fires rainbow lasers from his third eye, flips gravity on the beat, and splits into two glowing clone dancers",
  "an ancient clockwork god with no hands who levitates twin hourglass blades, rewinds out of danger, and freezes you mid-swing",
  "a black-hole sorcerer whose floating orb drags you in, rains meteors from the sky, and grows giant when he's cornered",
  "a storm titan who hurls boomerang lightning, blinks through the rain, and summons two thunder-clones to mob you",
  "a void jester juggling three floating knives who teleports behind you, drops a gravity trap, and shrinks you to a bug",
  "a phoenix empress made of fire whose eye-beams scorch the ground, who bursts back to life on death, and slows the world to embers",
  "a doomsday DJ whose speaker-cannon fires bass shockwaves, raises a wall of sound, and quakes the whole arena on the drop",
];

interface TieredExample {
  text: string;
  /** Escalation pips: ◆ / ◆◆ / ◆◆◆. */
  pips: string;
  label: string;
}

const TIERS: { pool: string[]; pips: string; label: string }[] = [
  { pool: MEDIUM, pips: "◆", label: "warm-up" },
  { pool: COMPLEX, pips: "◆◆", label: "spicy" },
  { pool: CHAOS, pips: "◆◆◆", label: "chaos" },
];

const pickFrom = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)];

/** One chip per tier, ordered simplest → wildest. */
function pickExamples(): TieredExample[] {
  return TIERS.map((t) => ({ text: pickFrom(t.pool), pips: t.pips, label: t.label }));
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
        placeholder={`e.g. "${examples[0].text}"`}
        rows={3}
        maxLength={300}
        disabled={generating}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />

      <div className="chips chips-tiered" aria-label="Example fighters, simplest to wildest">
        {examples.map((example) => (
          <button
            key={example.text}
            type="button"
            className="chip chip-tiered"
            disabled={generating}
            onClick={() => setText(example.text)}
          >
            <span className="chip-tier" aria-label={example.label} title={example.label}>
              {example.pips}
            </span>
            {example.text}
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
