import type { Effect, Projectile } from "./combat";
import { mix, shade, withAlpha } from "../render/color";

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
      // Jittered star-spikes + drifting motes — the fallback look should
      // still have shape + motion, not read as another ring.
      const n = 7;
      for (let i = 0; i < n; i++) {
        const j = Math.sin(i * 37.7) * 0.5; // fixed per-spike jitter
        const a = (i / n) * Math.PI * 2 + 0.3 + j * 0.25;
        const inner = R * (0.12 + Math.abs(j) * 0.1) + grow * R * 0.4;
        const outer = inner + R * (0.2 + Math.abs(j) * 0.25) * life + 4;
        ctx.lineWidth = 1.6 + Math.abs(j) * 2.2;
        ctx.beginPath();
        ctx.moveTo(e.x + Math.cos(a) * inner, e.y + Math.sin(a) * inner);
        ctx.lineTo(e.x + Math.cos(a) * outer, e.y + Math.sin(a) * outer);
        ctx.stroke();
      }
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + grow * 2;
        const r = R * (0.3 + grow * 0.5);
        ctx.beginPath();
        ctx.arc(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r - grow * 10, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }

  elementGarnish(ctx, e, R * 0.8, life, time);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Projectile rendering: the LOOK comes from the source (visual only — the
// hitbox is still the physics body). Arrows fly point-first, bullets streak,
// thrown weapons spin, ability bolts wear their element.
// ---------------------------------------------------------------------------

/** Ghosted afterimages along the flight path. */
function motionTrail(
  ctx: CanvasRenderingContext2D,
  p: Projectile,
  length: number,
  width: number,
  alpha: number,
): void {
  const { x, y } = p.body.position;
  const v = p.body.velocity;
  ctx.strokeStyle = withAlpha(p.glow, alpha);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - v.x * length, y - v.y * length);
  ctx.stroke();
}

export function drawProjectile(
  ctx: CanvasRenderingContext2D,
  p: Projectile,
  time: number,
): void {
  const { x, y } = p.body.position;
  const v = p.body.velocity;
  const angle = Math.atan2(v.y, v.x);
  const age = p.maxTtl - p.ttl;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  switch (p.visual) {
    case "arrow": {
      motionTrail(ctx, p, 1.6, 2.5, 0.3);
      ctx.globalCompositeOperation = "source-over";
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      // Shaft.
      ctx.strokeStyle = mix("#7a5a3c", p.color, 0.3);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-11, 0);
      ctx.lineTo(7, 0);
      ctx.stroke();
      // Head.
      ctx.fillStyle = "#ccd3de";
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(6, -3);
      ctx.lineTo(6, 3);
      ctx.closePath();
      ctx.fill();
      // Fletching.
      ctx.strokeStyle = p.glow;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-11, 0);
      ctx.lineTo(-15, -3.5);
      ctx.moveTo(-8, 0);
      ctx.lineTo(-12, -3.5);
      ctx.moveTo(-11, 0);
      ctx.lineTo(-15, 3.5);
      ctx.moveTo(-8, 0);
      ctx.lineTo(-12, 3.5);
      ctx.stroke();
      ctx.restore();
      break;
    }

    case "bullet": {
      // Long hot tracer + tiny slug.
      motionTrail(ctx, p, 3.6, 3, 0.45);
      motionTrail(ctx, p, 1.4, 1.4, 0.8);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.shadowColor = p.glow;
      ctx.shadowBlur = 8;
      ctx.fillStyle = mix("#ffe9b0", p.glow, 0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, 4, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }

    case "thrown": {
      motionTrail(ctx, p, 1.2, 2.5, 0.25);
      ctx.globalCompositeOperation = "source-over";
      ctx.save();
      ctx.translate(x, y);
      const spin = age * (p.form === "chakram" ? 20 : 12) * Math.sign(v.x || 1);
      switch (p.form) {
        case "dagger": {
          ctx.rotate(spin);
          ctx.fillStyle = "#ccd3de";
          ctx.beginPath();
          ctx.moveTo(9, 0);
          ctx.lineTo(1, -2.6);
          ctx.lineTo(-3, -1.6);
          ctx.lineTo(-3, 1.6);
          ctx.lineTo(1, 2.6);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = shade(p.color, 0.6);
          ctx.lineWidth = 2.2;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-3, 0);
          ctx.lineTo(-8, 0);
          ctx.stroke();
          break;
        }
        case "chakram": {
          ctx.rotate(spin);
          ctx.shadowColor = p.glow;
          ctx.shadowBlur = 8;
          ctx.strokeStyle = mix("#ccd3de", p.glow, 0.3);
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          ctx.arc(0, 0, 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(-7, 0);
          ctx.lineTo(7, 0);
          ctx.moveTo(0, -7);
          ctx.lineTo(0, 7);
          ctx.stroke();
          break;
        }
        case "axe": {
          ctx.rotate(spin);
          ctx.strokeStyle = mix("#7a5a3c", p.color, 0.3);
          ctx.lineWidth = 2.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-8, 0);
          ctx.lineTo(5, 0);
          ctx.stroke();
          ctx.fillStyle = "#ccd3de";
          ctx.beginPath();
          ctx.moveTo(4, -2);
          ctx.quadraticCurveTo(8, -8, 12, -6);
          ctx.quadraticCurveTo(10, -1, 10, 2);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "spear": {
          ctx.rotate(angle); // javelins fly point-first, no spin
          ctx.strokeStyle = mix("#7a5a3c", p.color, 0.3);
          ctx.lineWidth = 2.6;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-13, 0);
          ctx.lineTo(8, 0);
          ctx.stroke();
          ctx.fillStyle = "#ccd3de";
          ctx.beginPath();
          ctx.moveTo(14, 0);
          ctx.lineTo(7, -3);
          ctx.lineTo(7, 3);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "hammer": {
          ctx.rotate(spin);
          ctx.strokeStyle = mix("#7a5a3c", p.color, 0.3);
          ctx.lineWidth = 2.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-8, 0);
          ctx.lineTo(4, 0);
          ctx.stroke();
          ctx.fillStyle = "#ccd3de";
          ctx.beginPath();
          ctx.roundRect(3, -5.5, 6, 11, 1.5);
          ctx.fill();
          break;
        }
        case "orb": {
          ctx.shadowColor = p.glow;
          ctx.shadowBlur = 12;
          ctx.fillStyle = mix(p.glow, "#ffffff", 0.25);
          ctx.beginPath();
          ctx.arc(0, 0, 6, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        default: {
          // bomb & friends: round body, cap, flickering fuse spark.
          const wob = Math.sin(age * 10) * 0.3;
          ctx.rotate(wob);
          ctx.fillStyle = mix("#3a3f4a", p.color, 0.35);
          ctx.beginPath();
          ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = withAlpha("#ffffff", 0.35);
          ctx.beginPath();
          ctx.arc(-2, -2, 1.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = p.color;
          ctx.fillRect(-1.6, -9, 3.2, 3);
          const spark = 0.6 + 0.4 * Math.sin(time * 14);
          ctx.shadowColor = p.glow;
          ctx.shadowBlur = 8;
          ctx.fillStyle = withAlpha(p.glow, spark);
          ctx.beginPath();
          ctx.arc(0, -11, 1.6 * spark + 0.8, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
      ctx.restore();
      break;
    }

    case "bolt":
    default: {
      const el = p.element ?? "none";
      ctx.shadowColor = p.glow;
      ctx.shadowBlur = 12;

      if (el === "lightning") {
        // A jagged dart re-rolled every few frames, crackle behind it.
        const frame = Math.floor(time * 14);
        ctx.strokeStyle = withAlpha(p.glow, 0.95);
        ctx.lineWidth = 2;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(9, 0);
        for (let i = 1; i <= 4; i++) {
          ctx.lineTo(9 - i * 6, (hash(frame * 5 + i) - 0.5) * 9);
        }
        ctx.stroke();
        ctx.restore();
      } else if (el === "ice") {
        // Sharp shard flying point-first + glints.
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = mix(p.glow, "#ffffff", 0.3);
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(0, -4);
        ctx.lineTo(-7, 0);
        ctx.lineTo(0, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        motionTrail(ctx, p, 1.6, 1.5, 0.4);
      } else if (el === "arcane") {
        // Rune orb: core + orbiting glyph.
        ctx.fillStyle = mix(p.glow, "#ffffff", 0.2);
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 0.7, 0, Math.PI * 2);
        ctx.fill();
        const a = time * 6;
        const gx = x + Math.cos(a) * p.radius * 1.4;
        const gy = y + Math.sin(a) * p.radius * 1.4;
        ctx.fillStyle = withAlpha(p.glow, 0.9);
        ctx.beginPath();
        ctx.moveTo(gx, gy - 3);
        ctx.lineTo(gx + 2.4, gy);
        ctx.lineTo(gx, gy + 3);
        ctx.lineTo(gx - 2.4, gy);
        ctx.closePath();
        ctx.fill();
        motionTrail(ctx, p, 2, 2, 0.3);
      } else if (el === "fire") {
        // Flaming orb: trailing flame lobes + embers.
        for (let i = 1; i <= 3; i++) {
          ctx.fillStyle = withAlpha(p.glow, 0.4 - i * 0.1);
          ctx.beginPath();
          ctx.arc(x - v.x * i * 0.9, y - v.y * i * 0.9, p.radius * (0.85 - i * 0.15), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = mix(p.glow, "#ffffff", 0.35);
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 0.75, 0, Math.PI * 2);
        ctx.fill();
        const ph = (time * 3) % 1;
        ctx.fillStyle = withAlpha(p.glow, 1 - ph);
        ctx.beginPath();
        ctx.arc(x - v.x * 1.5, y - v.y * 1.5 - ph * 7, 1.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (el === "poison") {
        ctx.fillStyle = mix(p.glow, "#3a3f4a", 0.2);
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 0.75, 0, Math.PI * 2);
        ctx.fill();
        const ph = (time * 2.2) % 1;
        ctx.fillStyle = withAlpha(p.glow, 0.8 * (1 - ph));
        ctx.beginPath();
        ctx.arc(x - v.x * 1.2, y - v.y * 1.2 + ph * 8, 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (el === "shadow") {
        for (let i = 0; i <= 2; i++) {
          ctx.fillStyle = withAlpha(p.glow, 0.35 - i * 0.11);
          ctx.beginPath();
          ctx.arc(x - v.x * i * 1.6, y - v.y * i * 1.6, p.radius * (0.8 - i * 0.12), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (el === "holy") {
        motionTrail(ctx, p, 3, 2.5, 0.4);
        ctx.fillStyle = mix(p.glow, "#ffffff", 0.5);
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 0.7, 0, Math.PI * 2);
        ctx.fill();
        const r = p.radius * 1.5 * (0.8 + 0.2 * Math.sin(time * 10));
        ctx.strokeStyle = withAlpha("#ffffff", 0.85);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x - r, y);
        ctx.lineTo(x + r, y);
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
        ctx.stroke();
      } else {
        // Unaligned bolt: the classic glowing orb + streak.
        motionTrail(ctx, p, 2.4, p.radius * 1.2, 0.4);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = withAlpha("#ffffff", 0.5);
        ctx.beginPath();
        ctx.arc(x - p.radius * 0.3, y - p.radius * 0.3, p.radius * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }

  ctx.restore();
}

/**
 * SINGLE SOURCE OF TRUTH for drawing one combat Effect — used by the game
 * loop, the fighter preview, and any future render surface. New effect kinds
 * belong here, nowhere else.
 */
export function drawEffect(g: CanvasRenderingContext2D, e: Effect, time: number): void {
  try {
    drawEffectInner(g, e, time);
  } catch {
    // A malformed effect must never take down the render loop.
  }
}

/** Cheap deterministic hash → [-1, 1] (lightning jitter, shockwave wobble). */
const jitter = (seed: number, i: number) => {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

function drawEffectInner(g: CanvasRenderingContext2D, e: Effect, time: number): void {
  if (e.kind === "motif") {
    drawMotifEffect(g, e, time);
    return;
  }
  if (e.kind === "decal") {
    // Flat ground mark under AoEs/hazards: squashed ellipse + kind detail.
    const life = Math.max(0, e.ttl / e.maxTtl);
    const r = e.radius ?? 46;
    g.save();
    g.globalAlpha = 0.5 * Math.min(1, life * 2); // hold, then fade out
    g.translate(e.x, e.y);
    g.scale(1, 0.28);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    if (e.decalKind === "frost") {
      grad.addColorStop(0, "rgba(190, 230, 255, 0.7)");
      grad.addColorStop(1, "rgba(190, 230, 255, 0)");
    } else if (e.decalKind === "crack") {
      grad.addColorStop(0, "rgba(30, 26, 22, 0.75)");
      grad.addColorStop(1, "rgba(30, 26, 22, 0)");
    } else {
      grad.addColorStop(0, "rgba(26, 18, 10, 0.8)");
      grad.addColorStop(1, "rgba(26, 18, 10, 0)");
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    // Kind detail: cracks radiate, frost crystallizes, scorch embers.
    g.strokeStyle = e.decalKind === "frost" ? "rgba(225, 245, 255, 0.8)" : "rgba(12, 9, 6, 0.8)";
    g.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + (e.decalKind === "frost" ? 0.3 : 0.11);
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.15, Math.sin(a) * r * 0.15);
      g.lineTo(Math.cos(a + 0.35) * r * 0.62, Math.sin(a + 0.35) * r * 0.62);
      g.stroke();
    }
    g.restore();
    return;
  }
  const life = e.ttl / e.maxTtl; // 1 → 0
  g.save();
  g.globalAlpha = Math.max(0, life) * 0.9;
  g.strokeStyle = e.color;
  g.fillStyle = e.color;
  if (e.kind === "shockwave") {
    // Expanding ring with a wobbled edge + thickness falloff — an impact
    // wave, not a clean circle.
    const age = e.maxTtl - e.ttl;
    const r = Math.max(2, (e.radius ?? 16) + (e.expand ?? 240) * age);
    const seed = e.seed ?? 1;
    g.lineWidth = Math.max(0.8, (e.width ?? 5) * life);
    g.shadowColor = e.color;
    g.shadowBlur = 12;
    g.beginPath();
    const STEPS = 26;
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      const wobble = 1 + jitter(seed, i % STEPS) * 0.08;
      const px = e.x + Math.cos(a) * r * wobble;
      const py = e.y + Math.sin(a) * r * wobble;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.stroke();
  } else if (e.kind === "lightning") {
    // Jagged branching bolt start→end; jitter re-rolls over its life so it
    // crackles. Glow pass + white-hot core.
    const seed = (e.seed ?? 1) + Math.floor((e.maxTtl - e.ttl) * 24) * 7;
    const x2 = e.x2 ?? e.x + 60;
    const y2 = e.y2 ?? e.y;
    const dx = x2 - e.x;
    const dy = y2 - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const SEG = 7;
    const pts: [number, number][] = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const amp = i === 0 || i === SEG ? 0 : jitter(seed, i) * len * 0.14;
      pts.push([e.x + dx * t + nx * amp, e.y + dy * t + ny * amp]);
    }
    const polyline = () => {
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) g.moveTo(pts[i][0], pts[i][1]);
        else g.lineTo(pts[i][0], pts[i][1]);
      }
      g.stroke();
    };
    g.lineWidth = e.width ?? 2.5;
    g.shadowColor = e.color;
    g.shadowBlur = 10;
    polyline();
    // Forks off two interior joints.
    g.lineWidth = (e.width ?? 2.5) * 0.55;
    for (const fi of [2, 4]) {
      const [fx, fy] = pts[fi];
      g.beginPath();
      g.moveTo(fx, fy);
      g.lineTo(
        fx + (dx / SEG) * 0.9 + nx * jitter(seed, fi + 11) * len * 0.2,
        fy + (dy / SEG) * 0.9 + ny * jitter(seed, fi + 17) * len * 0.2,
      );
      g.stroke();
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = (e.width ?? 2.5) * 0.4;
    g.shadowBlur = 0;
    polyline();
  } else if (e.kind === "slasharc") {
    // Crescent swipe: arc width tapers thick→thin toward both ends.
    const r = e.radius ?? 40;
    const a0 = e.a0 ?? -0.6;
    const a1 = e.a1 ?? 0.6;
    const W = (e.width ?? 9) * (0.4 + 0.6 * life);
    const STEPS = 14;
    g.shadowColor = e.color;
    g.shadowBlur = 10;
    g.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const a = a0 + (a1 - a0) * t;
      const w = W * Math.sin(t * Math.PI);
      const rr = r + w / 2;
      const px = e.x + Math.cos(a) * rr;
      const py = e.y + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    for (let i = STEPS; i >= 0; i--) {
      const t = i / STEPS;
      const a = a0 + (a1 - a0) * t;
      const w = W * Math.sin(t * Math.PI);
      g.lineTo(e.x + Math.cos(a) * (r - w / 2), e.y + Math.sin(a) * (r - w / 2));
    }
    g.closePath();
    g.fill();
  } else if (e.kind === "flash") {
    // Impact pop: radial spike-lines + a quick bloom ring — no filled disc.
    const age = e.maxTtl - e.ttl;
    const r = (e.radius ?? 18) * (0.5 + age / e.maxTtl);
    const seed = e.seed ?? 1;
    g.lineWidth = 2.2 * life + 0.6;
    g.shadowColor = e.color;
    g.shadowBlur = 14;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + jitter(seed, i) * 0.3;
      const l0 = r * 0.35;
      const l1 = r * (0.9 + jitter(seed, i + 7) * 0.25);
      g.beginPath();
      g.moveTo(e.x + Math.cos(a) * l0, e.y + Math.sin(a) * l0);
      g.lineTo(e.x + Math.cos(a) * l1, e.y + Math.sin(a) * l1);
      g.stroke();
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(e.x, e.y, r * 0.3, 0, Math.PI * 2);
    g.stroke();
  } else if (e.kind === "ring") {
    const age = e.maxTtl - e.ttl;
    // expand (px/s) lets behaviors design their own ring motion.
    const r =
      e.expand !== undefined
        ? Math.max(1, (e.radius ?? 20) + e.expand * age)
        : (e.radius ?? 20) * (1.6 - life * 0.6);
    g.lineWidth = e.width ?? 3;
    g.shadowColor = e.color;
    g.shadowBlur = 10;
    g.beginPath();
    g.arc(e.x, e.y, r, 0, Math.PI * 2);
    g.stroke();
  } else if (e.kind === "particle") {
    // Behavior-authored free-flying particle.
    const size = (e.size ?? 4) * (0.4 + life * 0.6);
    g.shadowColor = e.color;
    g.shadowBlur = 7;
    if (e.particleShape === "square") {
      g.fillRect(e.x - size / 2, e.y - size / 2, size, size);
    } else if (e.particleShape === "spark") {
      const v = Math.hypot(e.vx ?? 0, e.vy ?? 1) || 1;
      g.lineWidth = Math.max(1, size * 0.4);
      g.beginPath();
      g.moveTo(e.x, e.y);
      g.lineTo(e.x - ((e.vx ?? 0) / v) * size * 2, e.y - ((e.vy ?? 0) / v) * size * 2);
      g.stroke();
    } else if (e.particleShape === "shard") {
      // Angular rotating fragment (ice/earth/shatter debris).
      const rot = (e.seed ?? 0) + (e.maxTtl - e.ttl) * 9;
      g.save();
      g.translate(e.x, e.y);
      g.rotate(rot);
      g.beginPath();
      g.moveTo(-size, 0);
      g.lineTo(-size * 0.2, -size * 0.8);
      g.lineTo(size, 0);
      g.lineTo(-size * 0.2, size * 0.6);
      g.closePath();
      g.fill();
      g.restore();
    } else if (e.particleShape === "star") {
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const rr = k % 2 === 0 ? size : size * 0.4;
        g[k === 0 ? "moveTo" : "lineTo"](e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
    } else {
      g.beginPath();
      g.arc(e.x, e.y, size, 0, Math.PI * 2);
      g.fill();
    }
  } else if (e.kind === "shape") {
    // Behavior-engine draw verb: bare glowing strokes.
    g.lineWidth = e.width ?? 2.5;
    g.shadowColor = e.color;
    g.shadowBlur = 9;
    g.beginPath();
    if (e.shape === "line") {
      g.moveTo(e.x, e.y);
      g.lineTo(e.x2 ?? e.x, e.y2 ?? e.y);
    } else if (e.shape === "arc") {
      g.arc(e.x, e.y, e.radius ?? 20, e.a0 ?? 0, e.a1 ?? Math.PI);
    } else {
      g.arc(e.x, e.y, e.radius ?? 20, 0, Math.PI * 2);
    }
    g.stroke();
  } else if (e.kind === "spark") {
    g.lineWidth = 2.5;
    g.shadowColor = e.color;
    g.shadowBlur = 8;
    const r = e.radius ?? 12;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + e.maxTtl;
      g.beginPath();
      g.moveTo(e.x + Math.cos(a) * r * 0.4, e.y + Math.sin(a) * r * 0.4);
      g.lineTo(e.x + Math.cos(a) * r * (1.5 - life), e.y + Math.sin(a) * r * (1.5 - life));
      g.stroke();
    }
  } else {
    const big = e.text === "FIGHT!" || e.text === "K.O." || e.text === "FLATTENED";
    g.font = big ? "48px Anton, Impact, sans-serif" : "20px Anton, Impact, sans-serif";
    g.textAlign = "center";
    g.shadowColor = "rgba(0, 0, 0, 0.45)";
    g.shadowBlur = 6;
    g.shadowOffsetY = 2;
    g.fillText(e.text ?? "", e.x, e.y - (1 - life) * 26);
  }
  g.restore();
}
