import type { Effect } from "./combat";
import { withAlpha } from "../render/color";

/**
 * Ability VFX: renders "motif" effects — the MOTIF picks the shape (nova,
 * beam, orbs, shards, wave, aura, slash, burst) and the ELEMENT restyles it
 * (lightning is jagged, fire embers, ice shatters, poison drips, shadow
 * smolders, holy radiates, arcane inscribes). All flat + glow, matching the
 * game's painterly look.
 */

const hash = (n: number) => {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
};

/** Draw a circle path, jagged for lightning, faceted for ice, smooth else. */
function elementRing(
  ctx: CanvasRenderingContext2D,
  e: Effect,
  r: number,
  time: number,
): void {
  const el = e.element ?? "none";
  ctx.beginPath();
  if (el === "lightning") {
    const frame = Math.floor(time * 12);
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rr = r * (1 + (hash(frame * 13 + i) - 0.5) * 0.22);
      const x = e.x + Math.cos(a) * rr;
      const y = e.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else if (el === "ice") {
    const N = 8;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = e.x + Math.cos(a) * r;
      const y = e.y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
  }
  ctx.stroke();
}

/** Small element-flavored garnish scattered around the effect. */
function elementGarnish(
  ctx: CanvasRenderingContext2D,
  e: Effect,
  r: number,
  life: number, // 1 → 0
  time: number,
): void {
  const el = e.element ?? "none";
  const grow = 1 - life;
  switch (el) {
    case "fire":
      for (let i = 0; i < 4; i++) {
        const a = hash(i + 1) * Math.PI * 2;
        ctx.fillStyle = withAlpha(e.color, life * 0.8);
        ctx.beginPath();
        ctx.arc(
          e.x + Math.cos(a) * r * 0.8,
          e.y + Math.sin(a) * r * 0.6 - grow * 16,
          2 - grow,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      break;
    case "poison":
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        ctx.fillStyle = withAlpha(e.color, life * 0.8);
        ctx.beginPath();
        ctx.arc(e.x + Math.cos(a) * r * 0.7, e.y + Math.sin(a) * r * 0.4 + grow * 14, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "shadow":
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = withAlpha(e.color, life * 0.25);
        ctx.beginPath();
        ctx.arc(
          e.x + (hash(i + 5) - 0.5) * r * 1.4,
          e.y + (hash(i + 9) - 0.5) * r * 0.8 - grow * 8,
          4 + grow * 4,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      break;
    case "holy":
      ctx.strokeStyle = withAlpha("#ffffff", life * 0.8);
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + time;
        const x = e.x + Math.cos(a) * r * 0.75;
        const y = e.y + Math.sin(a) * r * 0.55;
        const s = 3.5 * life + 1;
        ctx.beginPath();
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
        ctx.stroke();
      }
      break;
    case "arcane":
      ctx.fillStyle = withAlpha(e.color, life * 0.8);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - time * 2;
        const x = e.x + Math.cos(a) * r * 0.85;
        const y = e.y + Math.sin(a) * r * 0.6;
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + 2.5, y);
        ctx.lineTo(x, y + 3);
        ctx.lineTo(x - 2.5, y);
        ctx.closePath();
        ctx.fill();
      }
      break;
    default:
      break;
  }
}

export function drawMotifEffect(
  ctx: CanvasRenderingContext2D,
  e: Effect,
  time: number,
): void {
  const life = Math.max(0, e.ttl / e.maxTtl); // 1 → 0
  const grow = 1 - life;
  const R = e.radius ?? 60;
  const dir = e.dir ?? 1;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = withAlpha(e.color, life * 0.9);
  ctx.fillStyle = withAlpha(e.color, life * 0.5);
  ctx.shadowColor = e.color;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3;

  switch (e.motif) {
    case "nova": {
      // Expanding double ring from the caster.
      elementRing(ctx, e, R * (0.35 + grow * 0.65), time);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = withAlpha(e.color, life * 0.5);
      elementRing(ctx, e, R * (0.2 + grow * 0.5), time);
      break;
    }
    case "beam": {
      // A directional streak that stretches then fades.
      const len = R * (0.8 + grow * 1.4);
      const w = 9 * life + 2;
      ctx.fillStyle = withAlpha(e.color, life * 0.55);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y - w / 2);
      ctx.lineTo(e.x + dir * len, e.y - w * 0.15);
      ctx.lineTo(e.x + dir * len, e.y + w * 0.15);
      ctx.lineTo(e.x, e.y + w / 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "orbs": {
      // A ring of orbs spiraling outward.
      const n = 5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + grow * 2.2;
        const rr = R * (0.25 + grow * 0.65);
        ctx.beginPath();
        ctx.arc(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr * 0.7, 4 * life + 1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "shards": {
      // Sharp fragments flying outward.
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash(i) * 0.5;
        const rr = R * (0.2 + grow * 0.85);
        const x = e.x + Math.cos(a) * rr;
        const y = e.y + Math.sin(a) * rr * 0.8;
        const s = 6 * life + 1.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
        ctx.lineTo(x - Math.sin(a) * s * 0.35, y + Math.cos(a) * s * 0.35);
        ctx.lineTo(x + Math.sin(a) * s * 0.35, y - Math.cos(a) * s * 0.35);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "wave": {
      // Arcs rolling along the ground in the facing direction.
      ctx.lineWidth = 3.5;
      for (let i = 0; i < 3; i++) {
        const d = (grow * R * 1.1 + i * 14) * dir;
        const rr = 16 + i * 7;
        ctx.strokeStyle = withAlpha(e.color, life * (0.85 - i * 0.22));
        ctx.beginPath();
        ctx.arc(e.x + d, e.y + 8, rr, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.stroke();
      }
      break;
    }
    case "aura": {
      // Soft pulsing halo + rising motes around the target.
      ctx.fillStyle = withAlpha(e.color, life * 0.18);
      ctx.beginPath();
      ctx.arc(e.x, e.y, R * 0.55 * (1 + grow * 0.25), 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = withAlpha(e.color, life * 0.6);
      ctx.beginPath();
      ctx.arc(e.x, e.y, R * 0.55 * (1 + grow * 0.35), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = withAlpha(e.color, life * 0.8);
      for (let i = 0; i < 4; i++) {
        const x = e.x + (hash(i + 2) - 0.5) * R * 0.9;
        ctx.beginPath();
        ctx.arc(x, e.y + 16 - grow * 34 - hash(i) * 10, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "slash": {
      // Crossing crescent strokes.
      ctx.lineWidth = 3.5;
      for (let i = 0; i < 2; i++) {
        const tilt = (i === 0 ? -0.5 : 0.6) + dir * 0.2;
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(tilt);
        ctx.strokeStyle = withAlpha(e.color, life * (0.9 - i * 0.3));
        ctx.beginPath();
        ctx.arc(0, R * 0.6, R * (0.55 + grow * 0.3), -Math.PI * 0.75, -Math.PI * 0.25);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case "burst":
    default: {
      // Quick radial spokes.
      const n = 8;
      ctx.lineWidth = 2.5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.3;
        const inner = R * 0.15 + grow * R * 0.4;
        const outer = inner + R * 0.28 * life + 4;
        ctx.beginPath();
        ctx.moveTo(e.x + Math.cos(a) * inner, e.y + Math.sin(a) * inner);
        ctx.lineTo(e.x + Math.cos(a) * outer, e.y + Math.sin(a) * outer);
        ctx.stroke();
      }
      break;
    }
  }

  elementGarnish(ctx, e, R * 0.8, life, time);
  ctx.restore();
}
