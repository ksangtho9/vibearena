import Matter from "matter-js";
import type { CharacterSpec } from "../types/character";
import { resolveStyle, type ResolvedStyle } from "../generation/enrich";
import { mix, parseColor, shade, withAlpha } from "../render/color";
import { ARCHETYPES, type WeaponStyle } from "./weapons/archetypes";

// Re-exported for UI code that colors HP bars etc.
export { safeCssColor } from "../render/color";

/**
 * Ragdoll stickman: head, torso, two arms, two legs, held together with
 * constraints. While alive the torso has infinite inertia (it stays upright
 * and controllable) and the limbs dangle with real physics. On death the
 * torso's inertia is restored and the whole thing collapses into a ragdoll.
 *
 * Rendering is flat "animator" style: slim tapered capsules over the ragdoll
 * joints in a single uniform body color — no internal shading of any kind.
 * The only shadow is the soft contact shadow on the ground. The drawn vector
 * weapon from the archetype library attaches to the weapon hand. While alive
 * the head is rendered upright on the neck (tracking the torso, not the
 * dangling physics head body); the floppy head is KO-ragdoll only.
 */

export type Side = "player" | "bot";

export interface Limb {
  body: Matter.Body;
  halfLen: number;
}

export interface FighterBuffs {
  speedMul: number;
  strengthMul: number;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface Fighter {
  spec: CharacterSpec;
  side: Side;
  color: string;
  style: ResolvedStyle;
  scale: number;
  facing: 1 | -1;

  root: Matter.Body;
  head: Matter.Body;
  arms: [Limb, Limb]; // [left, right] — right hand holds the weapon
  legs: [Limb, Limb];
  /** Bodies that count as "hit me here". */
  hittable: Matter.Body[];
  constraints: Matter.Constraint[];

  hp: number;
  maxHp: number;
  alive: boolean;
  grounded: boolean;

  // Countdown timers, in seconds.
  attackCooldown: number;
  attackWindow: number;
  hasHitThisSwing: boolean;
  jumpCooldown: number;
  abilityCooldown: number;
  shieldTimer: number;
  buffTimer: number;
  introTimer: number;

  buffs: FighterBuffs;
  savedInertia: number;

  /** Recent weapon-tip positions for the swing trail (render-only state). */
  trail: TrailPoint[];
}

const COLLISION_GROUP: Record<Side, number> = { player: -1, bot: -2 };

export function createFighter(
  world: Matter.World,
  spec: CharacterSpec,
  x: number,
  groundY: number,
  side: Side,
): Fighter {
  const s = spec.appearance.height; // already clamped to 0.8–1.2 by the balancer
  const group = COLLISION_GROUP[side];
  const filter = { group };

  const rootHalfH = 44 * s;
  const rootY = groundY - rootHalfH;
  const headR = 11 * s;
  const armLen = 30 * s;
  const legLen = 34 * s;
  const shoulderY = -26 * s; // offsets from root center
  const hipY = 14 * s;

  const root = Matter.Bodies.rectangle(x, rootY, 16 * s, rootHalfH * 2, {
    collisionFilter: filter,
    density: 0.004,
    friction: 0.05,
    frictionAir: 0.015,
    restitution: 0,
    label: `${side}-root`,
  });
  const savedInertia = root.inertia;
  Matter.Body.setInertia(root, Infinity); // stands upright until it dies

  const head = Matter.Bodies.circle(x, rootY - rootHalfH - headR * 0.7, headR, {
    collisionFilter: filter,
    density: 0.0015,
    frictionAir: 0.02,
    label: `${side}-head`,
  });

  const limb = (
    lx: number,
    ly: number,
    thickness: number,
    length: number,
    label: string,
  ): Limb => ({
    body: Matter.Bodies.rectangle(lx, ly + length / 2, thickness, length, {
      collisionFilter: filter,
      density: 0.0008,
      frictionAir: 0.03,
      friction: 0.4,
      label,
    }),
    halfLen: length / 2,
  });

  const arms: [Limb, Limb] = [
    limb(x - 3 * s, rootY + shoulderY, 5 * s, armLen, `${side}-arm-l`),
    limb(x + 3 * s, rootY + shoulderY, 5 * s, armLen, `${side}-arm-r`),
  ];
  const legs: [Limb, Limb] = [
    limb(x - 4 * s, rootY + hipY, 6 * s, legLen, `${side}-leg-l`),
    limb(x + 4 * s, rootY + hipY, 6 * s, legLen, `${side}-leg-r`),
  ];

  const pin = (
    bodyB: Matter.Body,
    pointA: Matter.Vector,
    pointB: Matter.Vector,
    stiffness = 0.9,
  ): Matter.Constraint =>
    Matter.Constraint.create({
      bodyA: root,
      bodyB,
      pointA,
      pointB,
      length: 0,
      stiffness,
      damping: 0.1,
    });

  /** Soft spring that keeps a dangling limb loosely at rest — the jiggle. */
  const restSpring = (
    limbOf: Limb,
    anchorOnRoot: Matter.Vector,
    stiffness: number,
  ): Matter.Constraint =>
    Matter.Constraint.create({
      bodyA: root,
      bodyB: limbOf.body,
      pointA: anchorOnRoot,
      pointB: { x: 0, y: limbOf.halfLen },
      length: 8 * s,
      stiffness,
      damping: 0.05,
    });

  const constraints = [
    // Neck: head bobbles above the torso.
    pin(head, { x: 0, y: -rootHalfH }, { x: 0, y: headR * 0.7 }, 0.7),
    // Shoulders and hips.
    pin(arms[0].body, { x: -3 * s, y: shoulderY }, { x: 0, y: -arms[0].halfLen }),
    pin(arms[1].body, { x: 3 * s, y: shoulderY }, { x: 0, y: -arms[1].halfLen }),
    pin(legs[0].body, { x: -4 * s, y: hipY }, { x: 0, y: -legs[0].halfLen }),
    pin(legs[1].body, { x: 4 * s, y: hipY }, { x: 0, y: -legs[1].halfLen }),
    // Rest springs so limbs hang instead of flailing.
    restSpring(arms[0], { x: -9 * s, y: shoulderY + armLen * 0.8 }, 0.012),
    restSpring(arms[1], { x: 9 * s, y: shoulderY + armLen * 0.8 }, 0.012),
    restSpring(legs[0], { x: -6 * s, y: rootHalfH }, 0.02),
    restSpring(legs[1], { x: 6 * s, y: rootHalfH }, 0.02),
  ];

  const bodies = [root, head, arms[0].body, arms[1].body, legs[0].body, legs[1].body];
  Matter.Composite.add(world, [...bodies, ...constraints]);

  const style = resolveStyle(spec);

  return {
    spec,
    side,
    color: style.fill,
    style,
    scale: s,
    facing: side === "player" ? 1 : -1,
    root,
    head,
    arms,
    legs,
    hittable: bodies,
    constraints,
    hp: maxHpOf(spec),
    maxHp: maxHpOf(spec),
    alive: true,
    grounded: false,
    attackCooldown: 0,
    attackWindow: 0,
    hasHitThisSwing: false,
    jumpCooldown: 0,
    abilityCooldown: 0,
    shieldTimer: 0,
    buffTimer: 0,
    introTimer: 0,
    buffs: { speedMul: 1, strengthMul: 1 },
    savedInertia,
    trail: [],
  };
}

export function maxHpOf(spec: CharacterSpec): number {
  return Math.round(spec.stats.hp * 1.5);
}

/** Death: give the torso its inertia back and let physics have the body. */
export function collapse(fighter: Fighter): void {
  fighter.alive = false;
  Matter.Body.setInertia(fighter.root, fighter.savedInertia);
  Matter.Body.setAngularVelocity(fighter.root, -fighter.facing * (0.15 + Math.random() * 0.1));
}

// ---------------------------------------------------------------------------
// Solid-fill rendering
// ---------------------------------------------------------------------------

const TRAIL_SECONDS = 0.22;

function limbEndpoints(l: Limb): [Matter.Vector, Matter.Vector] {
  const { position, angle } = l.body;
  const dx = -Math.sin(angle) * l.halfLen;
  const dy = Math.cos(angle) * l.halfLen;
  return [
    { x: position.x - dx, y: position.y - dy },
    { x: position.x + dx, y: position.y + dy },
  ];
}

/** Tapered capsule between two points: round-capped, r1 at p1 → r2 at p2. */
function capsulePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r1: number,
  r2: number,
): Path2D {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = new Path2D();
  p.arc(x1, y1, r1, a + Math.PI / 2, a - Math.PI / 2);
  p.arc(x2, y2, r2, a - Math.PI / 2, a + Math.PI / 2);
  p.closePath();
  return p;
}

function circlePath(x: number, y: number, r: number): Path2D {
  const p = new Path2D();
  p.arc(x, y, r, 0, Math.PI * 2);
  return p;
}

interface Vec {
  x: number;
  y: number;
}

/**
 * ONE continuous smoothly-tapered stroke: a quadratic curve from `p0`
 * through the joint point `via` to `p2`, whose half-width interpolates from
 * r0 to r2 along the whole path, with round caps at both ends. Elbows and
 * knees are BENDS in this single silhouette — never a separate capsule per
 * bone and never a ball at the joint.
 */
function taperedPath(p0: Vec, via: Vec, p2: Vec, r0: number, r2: number): Path2D {
  // Control point chosen so the curve passes through `via` at t = 0.5.
  const cx = 2 * via.x - (p0.x + p2.x) / 2;
  const cy = 2 * via.y - (p0.y + p2.y) / 2;

  const N = 10;
  const left: Vec[] = [];
  const right: Vec[] = [];
  let nStart: Vec = { x: 0, y: 0 };
  let nEnd: Vec = { x: 0, y: 0 };
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * cx + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * cy + t * t * p2.y;
    let tx = 2 * mt * (cx - p0.x) + 2 * t * (p2.x - cx);
    let ty = 2 * mt * (cy - p0.y) + 2 * t * (p2.y - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const n = { x: ty, y: -tx };
    if (i === 0) nStart = n;
    if (i === N) nEnd = n;
    const r = r0 + (r2 - r0) * t;
    left.push({ x: x + n.x * r, y: y + n.y * r });
    right.push({ x: x - n.x * r, y: y - n.y * r });
  }

  const p = new Path2D();
  p.moveTo(left[0].x, left[0].y);
  for (let i = 1; i <= N; i++) p.lineTo(left[i].x, left[i].y);
  const aEnd = Math.atan2(nEnd.y, nEnd.x);
  p.arc(p2.x, p2.y, r2, aEnd, aEnd + Math.PI); // round tip cap
  for (let i = N; i >= 0; i--) p.lineTo(right[i].x, right[i].y);
  const aStart = Math.atan2(nStart.y, nStart.x);
  p.arc(p0.x, p0.y, r0, aStart + Math.PI, aStart + 2 * Math.PI); // round base cap
  p.closePath();
  return p;
}

/**
 * Relaxed joint position for a limb: the midpoint pushed perpendicular to
 * the base→tip axis by `frac` of the limb length (sign picks the side).
 */
function bendPoint(base: Vec, tip: Vec, frac: number): Vec {
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  return {
    x: (base.x + tip.x) / 2 + dy * frac,
    y: (base.y + tip.y) / 2 - dx * frac,
  };
}

function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Flat silhouette fill — one uniform color, no gradient, rim, gloss or core
 * shadow. Light-colored fills get a thin, slightly-darker edge so they still
 * read against a busy background; dark fills get no outline at all.
 */
function flatPart(ctx: CanvasRenderingContext2D, path: Path2D, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fill(path);
  const lum = luminance(fill);
  if (lum > 0.5) {
    const alpha = Math.min(0.85, (lum - 0.5) * 3);
    ctx.strokeStyle = shade(fill, 0.7, alpha);
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }
}

/**
 * Whole-body flat fill: strokes every part FIRST, then fills them all, so
 * the fills bury each part's internal stroke edges wherever parts overlap —
 * the figure reads as ONE continuous silhouette with only an outer edge
 * (and, for dark fighters, no edge at all).
 */
function flatBody(ctx: CanvasRenderingContext2D, paths: Path2D[], fill: string): void {
  const lum = luminance(fill);
  if (lum > 0.5) {
    const alpha = Math.min(0.85, (lum - 0.5) * 3);
    ctx.strokeStyle = shade(fill, 0.7, alpha);
    ctx.lineWidth = 2; // half of it sticks out; the inner half gets filled over
    for (const p of paths) ctx.stroke(p);
  }
  ctx.fillStyle = fill;
  for (const p of paths) ctx.fill(p);
}

/** Soft blurred ellipse under the fighter — sells the weight. */
export function drawContactShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  footY: number,
  scale: number,
): void {
  const air = Math.max(0, Math.min(1, (groundY - footY) / 240));
  const spread = 1 - air * 0.55;
  const alpha = 0.28 * (1 - air * 0.7);
  const rx = 34 * scale * spread;
  const ry = 6.5 * scale * spread;
  ctx.save();
  ctx.translate(x, groundY + 4);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(10, 14, 10, ${alpha})`);
  g.addColorStop(0.7, `rgba(10, 14, 10, ${alpha * 0.55})`);
  g.addColorStop(1, "rgba(10, 14, 10, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function weaponStyle(style: ResolvedStyle): WeaponStyle {
  return {
    fill: style.fill,
    accent: style.accent,
    glow: style.glow,
    outline: style.outline,
  };
}

/** Weapon angle: swings flat toward the opponent mid-attack, else hangs with the arm. */
function weaponAngle(fighter: Fighter, shoulder: Matter.Vector, hand: Matter.Vector): number {
  if (fighter.attackWindow > 0) return fighter.facing > 0 ? 0 : Math.PI;
  return Math.atan2(hand.y - shoulder.y, hand.x - shoulder.x);
}

function drawWeapon(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Matter.Vector,
  angle: number,
  time: number,
): void {
  const def = ARCHETYPES[fighter.style.archetype];
  ctx.save();
  ctx.translate(hand.x, hand.y);
  if (!def.floating) ctx.rotate(angle);
  ctx.scale(fighter.scale * 0.95, fighter.scale * 0.95);
  def.draw(ctx, weaponStyle(fighter.style), time);
  ctx.restore();
}

/** Fading ribbon behind the weapon tip during a swing. */
function updateAndDrawTrail(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  hand: Matter.Vector,
  angle: number,
  time: number,
): void {
  if (!fighter.style.trail) return;
  const def = ARCHETYPES[fighter.style.archetype];

  if (fighter.attackWindow > 0 && fighter.alive) {
    const len = def.tip * fighter.scale * 0.95;
    fighter.trail.push({
      x: hand.x + Math.cos(angle) * len,
      y: hand.y + Math.sin(angle) * len,
      t: time,
    });
  }
  while (fighter.trail.length > 0 && time - fighter.trail[0].t > TRAIL_SECONDS) {
    fighter.trail.shift();
  }
  if (fighter.trail.length < 2) return;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.shadowColor = fighter.style.glow;
  ctx.shadowBlur = 10;
  for (let i = 1; i < fighter.trail.length; i++) {
    const a = fighter.trail[i - 1];
    const b = fighter.trail[i];
    const age = (time - b.t) / TRAIL_SECONDS;
    ctx.strokeStyle = withAlpha(fighter.style.glow, Math.max(0, 0.5 * (1 - age)));
    ctx.lineWidth = Math.max(1.5, 9 * (1 - age));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

interface HeadPose {
  x: number;
  y: number;
  angle: number;
}

function drawAccessories(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  headPose: HeadPose,
  which: "back" | "front",
  time: number,
): void {
  const n = fighter.spec.appearance.accessories.length;
  const { root, scale: s, style } = fighter;

  if (which === "back" && n >= 2) {
    // Cape: filled flowing shape off the back shoulder, drawn behind the body.
    const sway = Math.sin(time * 3 + root.position.x * 0.01) * 6 * s;
    const sx = root.position.x - fighter.facing * 6 * s;
    const sy = root.position.y - 26 * s;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx - fighter.facing * 24 * s + sway,
      sy + 24 * s,
      sx - fighter.facing * 16 * s - sway,
      sy + 52 * s,
    );
    ctx.quadraticCurveTo(
      sx - fighter.facing * 4 * s + sway * 0.4,
      sy + 34 * s,
      sx + fighter.facing * 3 * s,
      sy + 12 * s,
    );
    ctx.closePath();
    ctx.fillStyle = mix(style.accent, "#20242a", 0.25);
    ctx.fill();
    ctx.restore();
  }

  if (which !== "front") return;

  if (n >= 1) {
    // Hat riding on the head: brim capsule + crown.
    ctx.save();
    ctx.translate(headPose.x, headPose.y);
    ctx.rotate(headPose.angle);
    const r = 8.5 * s;
    flatPart(ctx, capsulePath(-r * 1.45, -r * 0.72, r * 1.45, -r * 0.72, 2.2 * s, 2.2 * s), style.accent);
    const crown = new Path2D();
    crown.roundRect(-r * 0.75, -r * 1.75, r * 1.5, r, 2.5 * s);
    flatPart(ctx, crown, style.accent);
    ctx.restore();
  }
  if (n >= 3) {
    // Belt with a glowing buckle.
    const y = root.position.y + 10 * s;
    flatPart(
      ctx,
      capsulePath(root.position.x - 8.5 * s, y, root.position.x + 8.5 * s, y, 3 * s, 3 * s),
      style.accent,
    );
    ctx.save();
    ctx.shadowColor = fighter.style.glow;
    ctx.shadowBlur = 6;
    ctx.fillStyle = fighter.style.glow;
    ctx.beginPath();
    ctx.arc(root.position.x + fighter.facing * 2 * s, y, 1.8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderFighter(
  ctx: CanvasRenderingContext2D,
  fighter: Fighter,
  time: number,
  groundY: number,
): void {
  const { root, head, scale: s, style } = fighter;
  const fill = style.fill;

  // Contact shadow first, under everything — the only shadow on a fighter.
  const feetY = Math.max(limbEndpoints(fighter.legs[0])[1].y, limbEndpoints(fighter.legs[1])[1].y);
  drawContactShadow(ctx, root.position.x, groundY, feetY, s);

  ctx.save();
  ctx.globalAlpha = fighter.alive ? 1 : 0.8;

  // Torso axis endpoints (neck → pelvis) from the root body's angle.
  const dx = -Math.sin(root.angle);
  const dy = Math.cos(root.angle);
  const neck = { x: root.position.x - dx * 30 * s, y: root.position.y - dy * 30 * s };
  const pelvis = { x: root.position.x + dx * 22 * s, y: root.position.y + dy * 22 * s };

  // Alive: head sits upright and firm on the neck, tracking the torso.
  // KO only: read the dangling physics head body for the full ragdoll flop.
  const headPose: HeadPose = fighter.alive
    ? { x: neck.x - dx * 11.5 * s, y: neck.y - dy * 11.5 * s, angle: root.angle }
    : { x: head.position.x, y: head.position.y, angle: head.angle };

  const [lShoulder, lHand] = limbEndpoints(fighter.arms[0]);
  const [rShoulder, rHand] = limbEndpoints(fighter.arms[1]);
  const [lHip, lFoot] = limbEndpoints(fighter.legs[0]);
  const [rHip, rFoot] = limbEndpoints(fighter.legs[1]);

  // Lean build: thin arms (finer than legs), slim legs, half-width spine.
  const armR0 = 1.9 * s, armR1 = 1.1 * s;
  const legR0 = 2.4 * s, legR1 = 1.4 * s;
  // Relaxed joints: elbows bend away from facing, knees toward it.
  const elbow = (sh: Vec, hd: Vec) => bendPoint(sh, hd, -fighter.facing * 0.16);
  const knee = (hp: Vec, ft: Vec) => bendPoint(hp, ft, fighter.facing * 0.1);

  // Back-to-front: cape, whole body as one silhouette, accessories, weapon.
  drawAccessories(ctx, fighter, headPose, "back", time);

  // Every body part in one batch so overlaps merge into a single continuous
  // silhouette: limbs, slim spine, thin short neck, small round head.
  flatBody(
    ctx,
    [
      taperedPath(lShoulder, elbow(lShoulder, lHand), lHand, armR0, armR1),
      taperedPath(lHip, knee(lHip, lFoot), lFoot, legR0, legR1),
      taperedPath(neck, { x: (neck.x + pelvis.x) / 2, y: (neck.y + pelvis.y) / 2 }, pelvis, 2.8 * s, 2 * s),
      taperedPath(rHip, knee(rHip, rFoot), rFoot, legR0, legR1),
      capsulePath(neck.x, neck.y, headPose.x, headPose.y, 1.5 * s, 1.5 * s),
      circlePath(headPose.x, headPose.y, 8.5 * s),
      taperedPath(rShoulder, elbow(rShoulder, rHand), rHand, armR0, armR1),
    ],
    fill,
  );

  drawAccessories(ctx, fighter, headPose, "front", time);

  // Swing trail + weapon over the hand.
  const wAngle = weaponAngle(fighter, rShoulder, rHand);
  updateAndDrawTrail(ctx, fighter, rHand, wAngle, time);
  drawWeapon(ctx, fighter, rHand, wAngle, time);

  // Shield bubble.
  if (fighter.shieldTimer > 0) {
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.15 * Math.sin(time * 10);
    ctx.strokeStyle = style.glow;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = 12;
    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    ctx.arc(root.position.x, root.position.y - 10 * s, 58 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  // Buff motes.
  if (fighter.buffTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = withAlpha(style.glow, 0.8);
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = 8;
    for (let i = 0; i < 3; i++) {
      const a = time * 6 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(
        root.position.x + Math.cos(a) * 30 * s,
        root.position.y - 20 * s + Math.sin(a) * 40 * s,
        2.2 * s,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Static solid-fill portrait for the preview card — no physics, just a posed
 * figure with its mapped weapon, spotlight and contact shadow.
 */
export function drawStickmanPreview(
  ctx: CanvasRenderingContext2D,
  spec: CharacterSpec,
  w: number,
  h: number,
): void {
  const style = resolveStyle(spec);
  const s = spec.appearance.height;
  const cx = w / 2;
  const groundY = h * 0.88;
  const u = (h / 180) * s; // unit scale fitted to the canvas
  const fill = style.fill;

  ctx.clearRect(0, 0, w, h);

  // Soft spotlight behind the figure.
  const spot = ctx.createRadialGradient(cx, h * 0.5, 0, cx, h * 0.5, h * 0.55);
  spot.addColorStop(0, withAlpha(style.glow, 0.12));
  spot.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);

  const hipY = groundY - 48 * u;
  const shoulderY = hipY - 40 * u;
  const headR = 8.5 * u;
  const headY = shoulderY - 11.5 * u;

  const armR0 = 1.9 * u, armR1 = 1.1 * u;
  const legR0 = 2.4 * u, legR1 = 1.4 * u;
  const hip = { x: cx, y: hipY };
  const shoulder = { x: cx, y: shoulderY + 4 * u };

  drawContactShadow(ctx, cx, groundY, groundY, u);

  // Whole body in one batch: legs in a slight stance (knees bent), slim
  // spine, off arm down with a relaxed elbow, thin neck, small round head.
  const lFoot = { x: cx - 14 * u, y: groundY };
  const rFoot = { x: cx + 14 * u, y: groundY };
  const offHand = { x: cx - 20 * u, y: shoulderY + 26 * u };
  const weaponHand = { x: cx + 23 * u, y: shoulderY - 8 * u };
  flatBody(
    ctx,
    [
      taperedPath(hip, bendPoint(hip, lFoot, -0.1), lFoot, legR0, legR1),
      taperedPath(hip, bendPoint(hip, rFoot, 0.1), rFoot, legR0, legR1),
      taperedPath({ x: cx, y: shoulderY }, { x: cx, y: (shoulderY + hipY) / 2 }, hip, 2.8 * u, 2 * u),
      taperedPath(shoulder, bendPoint(shoulder, offHand, -0.16), offHand, armR0, armR1),
      capsulePath(cx, shoulderY, cx, headY, 1.5 * u, 1.5 * u),
      circlePath(cx, headY, headR),
      taperedPath(shoulder, bendPoint(shoulder, weaponHand, 0.12), weaponHand, armR0, armR1),
    ],
    fill,
  );

  // Hat.
  if (spec.appearance.accessories.length > 0) {
    flatPart(
      ctx,
      capsulePath(cx - headR * 1.45, headY - headR * 0.72, cx + headR * 1.45, headY - headR * 0.72, 2.2 * u, 2.2 * u),
      style.accent,
    );
    const crown = new Path2D();
    crown.roundRect(cx - headR * 0.75, headY - headR * 1.75, headR * 1.5, headR, 2.5 * u);
    flatPart(ctx, crown, style.accent);
  }

  // Weapon in the raised hand.
  const def = ARCHETYPES[style.archetype];
  ctx.save();
  ctx.translate(weaponHand.x, weaponHand.y);
  if (!def.floating) ctx.rotate(-Math.PI / 5);
  ctx.scale(u * 1.05, u * 1.05);
  def.draw(
    ctx,
    { fill: style.fill, accent: style.accent, glow: style.glow, outline: style.outline },
    1.7, // frozen time: mid-pulse so glows read in a still image
  );
  ctx.restore();
}
