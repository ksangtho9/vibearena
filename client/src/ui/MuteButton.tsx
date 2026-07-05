import { useState } from "react";
import { isMuted, toggleMuted } from "../audio/sfx";

/** Master mute for the procedural SFX engine; state persists in localStorage. */
export function MuteButton() {
  const [muted, setMuted] = useState(isMuted());
  return (
    <button
      type="button"
      className="btn-mute"
      aria-label={muted ? "Unmute sound" : "Mute sound"}
      title={muted ? "Unmute sound" : "Mute sound"}
      onClick={() => setMuted(toggleMuted())}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
