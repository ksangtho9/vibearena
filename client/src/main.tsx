import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initAudio, playSfx } from "./audio/sfx";
import "./styles.css";

// Procedural SFX: unlock the AudioContext on the first trusted gesture, and
// give every button a tick centrally rather than per-component.
initAudio();
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.("button")) playSfx("uiClick");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
