import { useVibeStore } from "../store";

/**
 * First screen: pick the fight. One human vs the house bot, or two humans
 * sharing the keyboard.
 */
export function ModeScreen() {
  const chooseMode = useVibeStore((s) => s.chooseMode);

  return (
    <main className="screen mode-screen">
      <p className="eyebrow">TONIGHT, ON THE BOARD</p>
      <h1 className="poster-title">
        VIBE<span className="title-mark">✕</span>ARENA
      </h1>
      <p className="tagline">Type a fighter. We chalk it up. Choose your fight.</p>

      <div className="mode-buttons">
        <button type="button" className="btn-tape btn-mode" onClick={() => chooseMode("1p")}>
          1 Player
          <span className="btn-mode-sub">vs the house bot</span>
        </button>
        <button type="button" className="btn-tape btn-mode btn-mode-alt" onClick={() => chooseMode("2p")}>
          2 Players
          <span className="btn-mode-sub">hotseat duel · one keyboard</span>
        </button>
      </div>
      <p className="fine-print">Hotseat: P1 fights on A/D + W + F/G, P2 on arrows + . and /</p>
    </main>
  );
}
