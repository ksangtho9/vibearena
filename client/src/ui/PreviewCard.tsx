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

const PROPERTY_LABELS: Record<string, string> = {
  bleed: "Bleed",
  knockback: "Knockback",
  lifesteal: "Lifesteal",
  armorPierce: "Piercing",
  reach: "Long Reach",
  attackSpeed: "Fast",
  crit: "Deadly Crits",
  stagger: "Staggering",
  cleave: "Cleave",
  elementalDot: "Elemental Burn",
};

const NOTE_TEXT = {
  mocked:
    "The house generator drew this one — no API key on the server, or the LLM was busy (rate limit). Re-roll to try the real LLM again.",
  fallback: "The LLM's answer didn't validate, so you got the house default. Re-roll to try again.",
} as const;

/**
 * The fight card: chalk portrait on the left, tale of the tape on the right.
 */
export function PreviewCard() {
  const mode = useVibeStore((s) => s.mode);
  const promptFor = useVibeStore((s) => s.promptFor);
  const spec = useVibeStore((s) => (s.promptFor === 2 ? s.spec2 : s.spec));
  const note = useVibeStore((s) => s.note);
  const confirmFighter = useVibeStore((s) => s.confirmFighter);
  const reroll = useVibeStore((s) => s.reroll);
  const newPrompt = useVibeStore((s) => s.newPrompt);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hotseat = mode === "2p";

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
      <p className="eyebrow">
        {hotseat ? `PLAYER ${promptFor} — TALE OF THE TAPE` : "TALE OF THE TAPE"}
      </p>
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
                {(spec.weapon.properties?.length ?? 0) > 0 && (
                  <span className="weapon-props">
                    {spec.weapon.properties!
                      .map((p) => PROPERTY_LABELS[p.kind] ?? p.kind)
                      .join(" · ")}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Attack Ability</dt>
              <dd>
                {spec.ability.name} <span className="gear-meta">{spec.ability.kind} · power {spec.ability.power} · {spec.ability.cooldown}s cooldown</span>
              </dd>
            </div>
            {spec.utility && (
              <div>
                <dt>Utility</dt>
                <dd>
                  {spec.utility.name} <span className="gear-meta">{spec.utility.kind} · power {spec.utility.power} · {spec.utility.cooldown}s cooldown</span>
                </dd>
              </div>
            )}
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
        <button type="button" className="btn-tape" onClick={confirmFighter}>
          {hotseat && promptFor === 1 ? "Lock in — Player 2 is up" : "Enter the ring"}
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
