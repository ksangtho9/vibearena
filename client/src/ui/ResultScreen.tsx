import { useVibeStore } from "../store";

/**
 * Win/lose card. Rematch keeps your fighter; new prompt wipes the board.
 */
export function ResultScreen() {
  const mode = useVibeStore((s) => s.mode);
  const result = useVibeStore((s) => s.result);
  const spec = useVibeStore((s) => s.spec);
  const botSpec = useVibeStore((s) => s.botSpec);
  const rematch = useVibeStore((s) => s.rematch);
  const newPrompt = useVibeStore((s) => s.newPrompt);

  const won = result === "player";
  const hotseat = mode === "2p";
  const winnerName = (won ? spec?.name : botSpec?.name) ?? "The winner";
  const loserName = (won ? botSpec?.name : spec?.name) ?? "the loser";

  return (
    <main className="screen result-screen">
      <p className="eyebrow">
        {hotseat ? "SETTLED ON THE BOARD" : won ? "STILL STANDING" : "WIPED OFF THE BOARD"}
      </p>
      <h1 className={`poster-title ${won || hotseat ? "title-win" : "title-lose"}`}>
        {hotseat ? `PLAYER ${won ? 1 : 2} WINS` : won ? "YOU WIN" : "YOU LOSE"}
      </h1>
      <p className="tagline">
        {hotseat
          ? `${winnerName} erases ${loserName}. The chalk remembers.`
          : won
            ? `${spec?.name ?? "Your fighter"} erases ${botSpec?.name ?? "the bot"}.`
            : `${botSpec?.name ?? "The bot"} erases ${spec?.name ?? "your fighter"}. The chalk remembers.`}
      </p>

      <div className="button-row">
        <button type="button" className="btn-tape" onClick={rematch}>
          Rematch
        </button>
        <button type="button" className="btn-chalk" onClick={newPrompt}>
          {hotseat ? "New fighters" : "New fighter"}
        </button>
      </div>
    </main>
  );
}
