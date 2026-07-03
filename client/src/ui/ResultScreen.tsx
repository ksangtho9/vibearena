import { useVibeStore } from "../store";

/**
 * Win/lose card. Rematch keeps your fighter; new prompt wipes the board.
 */
export function ResultScreen() {
  const result = useVibeStore((s) => s.result);
  const spec = useVibeStore((s) => s.spec);
  const botSpec = useVibeStore((s) => s.botSpec);
  const rematch = useVibeStore((s) => s.rematch);
  const newPrompt = useVibeStore((s) => s.newPrompt);

  const won = result === "player";

  return (
    <main className="screen result-screen">
      <p className="eyebrow">{won ? "STILL STANDING" : "WIPED OFF THE BOARD"}</p>
      <h1 className={`poster-title ${won ? "title-win" : "title-lose"}`}>
        {won ? "YOU WIN" : "YOU LOSE"}
      </h1>
      <p className="tagline">
        {won
          ? `${spec?.name ?? "Your fighter"} erases ${botSpec?.name ?? "the bot"}.`
          : `${botSpec?.name ?? "The bot"} erases ${spec?.name ?? "your fighter"}. The chalk remembers.`}
      </p>

      <div className="button-row">
        <button type="button" className="btn-tape" onClick={rematch}>
          Rematch
        </button>
        <button type="button" className="btn-chalk" onClick={newPrompt}>
          New fighter
        </button>
      </div>
    </main>
  );
}
