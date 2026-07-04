import { useVibeStore } from "./store";
import { ModeScreen } from "./ui/ModeScreen";
import { PromptScreen } from "./ui/PromptScreen";
import { PreviewCard } from "./ui/PreviewCard";
import { ArenaScreen } from "./ui/ArenaScreen";
import { ResultScreen } from "./ui/ResultScreen";

/**
 * Top-level state machine: mode → prompt → (generating) → preview → fight →
 * result. In 2P mode the prompt/preview pair runs once per player.
 */
export default function App() {
  const phase = useVibeStore((s) => s.phase);

  return (
    <div className="board">
      <div className="board-frame">
        {phase === "mode" && <ModeScreen />}
        {(phase === "prompt" || phase === "generating") && <PromptScreen />}
        {phase === "preview" && <PreviewCard />}
        {phase === "fight" && <ArenaScreen />}
        {phase === "result" && <ResultScreen />}
      </div>
    </div>
  );
}
