import { useEffect, useRef } from "react";
import { useVibeStore } from "../store";
import { drawStickmanPreview } from "../game/stickman";
import { TOTAL_STAT_BUDGET } from "../balance/statBudget";

const STAT_LABELS = [
  ["hp", "Health"],
  ["speed", "Speed"],
  ["strength", "Strength"],
  ["defense", "Defense"],
] as const;

const NOTE_TEXT = {
  mocked: "No API key on the server yet — the house generator drew this one. Set .env to summon the real LLM.",
  fallback: "The LLM's answer didn't validate, so you got the house default. Re-roll to try again.",
} as const;

/**
 * The fight card: chalk portrait on the left, tale of the tape on the right.
 */
export function PreviewCard() {
  const spec = useVibeStore((s) => s.spec);
  const note = useVibeStore((s) => s.note);
  const enterFight = useVibeStore((s) => s.enterFight);
  const reroll = useVibeStore((s) => s.reroll);
  const newPrompt = useVibeStore((s) => s.newPrompt);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 240 * dpr;
    canvas.height = 260 * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    drawStickmanPreview(ctx, spec, 240, 260);
  }, [spec]);

  if (!spec) return null;

  return (
    <main className="screen preview-screen">
      <p className="eyebrow">TALE OF THE TAPE</p>
      <div className="fight-card">
        <div className="portrait">
          <canvas ref={canvasRef} style={{ width: 240, height: 260 }} aria-label={`Chalk drawing of ${spec.name}`} />
        </div>

        <div className="tape">
          <h2 className="fighter-name">{spec.name}</h2>
          <p className="flavor">“{spec.flavor}”</p>

          <dl className="gear">
            <div>
              <dt>Weapon</dt>
              <dd>
                {spec.weapon.name} <span className="gear-meta">{spec.weapon.type} · dmg {spec.weapon.damage} · reach {spec.weapon.range}</span>
              </dd>
            </div>
            <div>
              <dt>Ability</dt>
              <dd>
                {spec.ability.name} <span className="gear-meta">{spec.ability.kind} · power {spec.ability.power} · {spec.ability.cooldown}s cooldown</span>
              </dd>
            </div>
            {spec.appearance.accessories.length > 0 && (
              <div>
                <dt>Carrying</dt>
                <dd>{spec.appearance.accessories.join(", ")}</dd>
              </div>
            )}
          </dl>

          <div className="stats">
            {STAT_LABELS.map(([key, label]) => (
              <div className="stat-row" key={key}>
                <span className="stat-label">{label}</span>
                <span className="stat-bar">
                  <span
                    className="stat-fill"
                    style={{ width: `${Math.min(100, (spec.stats[key] / 220) * 100)}%` }}
                  />
                </span>
                <span className="stat-value">{spec.stats[key]}</span>
              </div>
            ))}
            <p className="fine-print">Every fighter spends the same {TOTAL_STAT_BUDGET}-point budget.</p>
          </div>
        </div>
      </div>

      {note && <p className="gen-note">{NOTE_TEXT[note]}</p>}

      <div className="button-row">
        <button type="button" className="btn-tape" onClick={enterFight}>
          Enter the ring
        </button>
        <button type="button" className="btn-chalk" onClick={() => void reroll()}>
          Re-roll
        </button>
        <button type="button" className="btn-chalk" onClick={newPrompt}>
          New prompt
        </button>
      </div>
    </main>
  );
}
