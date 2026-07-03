import { useVibeStore } from "./store";
import { PromptScreen } from "./ui/PromptScreen";
import { PreviewCard } from "./ui/PreviewCard";
import { ArenaScreen } from "./ui/ArenaScreen";
import { ResultScreen } from "./ui/ResultScreen";

/**
 * Top-level state machine: prompt → (generating) → preview → fight → result.
 */
export default function App() {
  const phase = useVibeStore((s) => s.phase);

  return (
    <div className="board">
      <div className="board-frame">
        {(phase === "prompt" || phase === "generating") && <PromptScreen />}
        {phase === "preview" && <PreviewCard />}
        {phase === "fight" && <ArenaScreen />}
        {phase === "result" && <ResultScreen />}
      </div>
    </div>
  );
}
