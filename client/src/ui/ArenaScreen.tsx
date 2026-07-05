import { useEffect, useRef } from "react";
import { useVibeStore } from "../store";
import { startGame } from "../game/loop";
import { ARENA_HEIGHT, ARENA_WIDTH } from "../game/arena";
import { safeCssColor } from "../game/stickman";

function HpBar({
  name,
  hp,
  maxHp,
  color,
  side,
}: {
  name: string;
  hp: number;
  maxHp: number;
  color: string;
  side: "left" | "right";
}) {
  const pct = maxHp > 0 ? (hp / maxHp) * 100 : 0;
  return (
    <div className={`hp-corner hp-${side}`}>
      <span className="hp-name" style={{ color }}>
        {name}
      </span>
      <div className="hp-track" role="meter" aria-label={`${name} health`} aria-valuenow={hp} aria-valuemin={0} aria-valuemax={maxHp}>
        <div className="hp-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AbilityHint({
  keyLabel,
  ability,
  cdFrac,
  showReady = false,
}: {
  keyLabel: string;
  ability: { name: string; cooldown: number };
  cdFrac: number;
  showReady?: boolean;
}) {
  return (
    <span className={cdFrac > 0 ? "ability-cooling" : "ability-ready"}>
      <kbd>{keyLabel}</kbd> {ability.name}
      {cdFrac > 0 ? ` (${Math.ceil(cdFrac * ability.cooldown)}s)` : showReady ? " — ready" : ""}
    </span>
  );
}

/**
 * The ring: canvas + corner-tape HP bars + controls hint.
 */
export function ArenaScreen() {
  const mode = useVibeStore((s) => s.mode);
  const spec = useVibeStore((s) => s.spec);
  const botSpec = useVibeStore((s) => s.botSpec);
  const hud = useVibeStore((s) => s.hud);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec || !botSpec) return;
    // React 19 StrictMode double-invokes effects in dev; startGame returns a
    // full cleanup so the second mount gets a fresh world.
    return startGame(canvas, spec, botSpec, mode, {
      onHud: (h) => useVibeStore.getState().setHud(h),
      onEnd: (winner) => useVibeStore.getState().endFight(winner),
    });
  }, [spec, botSpec, mode]);

  if (!spec || !botSpec) return null;

  return (
    <main className="screen arena-screen">
      <div className="arena-hud">
        <HpBar
          name={spec.name}
          hp={hud?.playerHp ?? 0}
          maxHp={hud?.playerMaxHp ?? 1}
          color={safeCssColor(spec.appearance.color)}
          side="left"
        />
        <span className="vs-mark">VS</span>
        <HpBar
          name={botSpec.name}
          hp={hud?.botHp ?? 0}
          maxHp={hud?.botMaxHp ?? 1}
          color={safeCssColor(botSpec.appearance.color)}
          side="right"
        />
      </div>

      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", aspectRatio: `${ARENA_WIDTH} / ${ARENA_HEIGHT}` }}
        />
      </div>

      {mode === "1p" ? (
        <div className="controls-hint">
          <span><kbd>A</kbd><kbd>D</kbd> move</span>
          <span><kbd>W</kbd>/<kbd>Space</kbd> jump</span>
          <span><kbd>J</kbd> attack</span>
          <AbilityHint keyLabel="K" ability={spec.ability} cdFrac={hud?.abilityCdFrac ?? 0} showReady />
          {spec.utility && (
            <AbilityHint keyLabel="L" ability={spec.utility} cdFrac={hud?.utilityCdFrac ?? 0} showReady />
          )}
        </div>
      ) : (
        <div className="controls-hint controls-hint-2p">
          <div className="controls-cluster">
            <span className="cluster-label">P1</span>
            <span><kbd>A</kbd><kbd>D</kbd> move</span>
            <span><kbd>W</kbd> jump</span>
            <span><kbd>F</kbd> attack</span>
            <AbilityHint keyLabel="G" ability={spec.ability} cdFrac={hud?.abilityCdFrac ?? 0} />
            {spec.utility && (
              <AbilityHint keyLabel="H" ability={spec.utility} cdFrac={hud?.utilityCdFrac ?? 0} />
            )}
          </div>
          <div className="controls-cluster">
            <span className="cluster-label">P2</span>
            <span><kbd>←</kbd><kbd>→</kbd> move</span>
            <span><kbd>↑</kbd> jump</span>
            <span><kbd>.</kbd> attack</span>
            <AbilityHint keyLabel="/" ability={botSpec.ability} cdFrac={hud?.botAbilityCdFrac ?? 0} />
            {botSpec.utility && (
              <AbilityHint keyLabel="'" ability={botSpec.utility} cdFrac={hud?.botUtilityCdFrac ?? 0} />
            )}
          </div>
        </div>
      )}
    </main>
  );
}
