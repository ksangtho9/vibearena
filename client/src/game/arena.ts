import Matter from "matter-js";

export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;

/** Fight-plane platform, for physics AND theme rendering. */
export interface PlatformRect {
  /** Center x. */
  cx: number;
  /** Y of the walkable top surface. */
  top: number;
  w: number;
  h: number;
}

export interface Arena {
  engine: Matter.Engine;
  world: Matter.World;
  width: number;
  height: number;
  /** Y of the ground's top surface (where feet rest). */
  groundY: number;
  ground: Matter.Body;
  /** One-way platform bodies (label "platform"). */
  platforms: Matter.Body[];
  platformRects: PlatformRect[];
}

const PLATFORM_THICKNESS = 16;

/**
 * Fighter root capsules carry this collision category, and platforms mask it
 * OUT — fighters never physically touch platforms (they'd head-bonk on the
 * underside: Matter fires collision events AFTER the resolver, so a per-pair
 * veto is always one tick late on fresh contacts). Fighter landings are
 * kinematic in combat.ts instead. Ragdolls and projectiles keep real
 * collisions plus the one-way pair veto below.
 */
export const FIGHTER_CATEGORY = 0x0002;

/**
 * Stable-per-match platform layout: a low ledge on each side plus a higher
 * center one, staggered so the main ground fight stays open. Heights sit
 * within the current jump reach (~200px).
 */
function rollPlatforms(groundY: number): PlatformRect[] {
  const r = () => Math.random();
  // Side heights: above every fighter's standing head, below every fighter's
  // jump reach (~117px for the slowest builds). Center needs a side hop.
  return [
    { cx: 195 + r() * 70, top: groundY - (108 + r() * 10), w: 150 + r() * 40, h: PLATFORM_THICKNESS },
    { cx: 695 + r() * 70, top: groundY - (108 + r() * 10), w: 150 + r() * 40, h: PLATFORM_THICKNESS },
    { cx: 445 + r() * 70, top: groundY - (180 + r() * 15), w: 130 + r() * 30, h: PLATFORM_THICKNESS },
  ];
}

/** Matter world with a floor, walls, ceiling and one-way platforms. */
export function createArena(width = ARENA_WIDTH, height = ARENA_HEIGHT): Arena {
  const engine = Matter.Engine.create();
  engine.gravity.y = 1.3;

  const groundThickness = 60;
  const groundY = height - 50;
  const ground = Matter.Bodies.rectangle(
    width / 2,
    groundY + groundThickness / 2,
    width + 400,
    groundThickness,
    { isStatic: true, friction: 0.9, label: "ground" },
  );
  const wallOpts = { isStatic: true, label: "wall" } as const;
  const leftWall = Matter.Bodies.rectangle(-40, height / 2 - 200, 80, height * 3, wallOpts);
  const rightWall = Matter.Bodies.rectangle(width + 40, height / 2 - 200, 80, height * 3, wallOpts);
  const ceiling = Matter.Bodies.rectangle(width / 2, -320, width + 400, 80, wallOpts);

  const platformRects = rollPlatforms(groundY);
  const platforms = platformRects.map((p) =>
    Matter.Bodies.rectangle(p.cx, p.top + p.h / 2, p.w, p.h, {
      isStatic: true,
      friction: 0.9,
      label: "platform",
      collisionFilter: { category: 0x0004, mask: 0xffff & ~FIGHTER_CATEGORY },
    }),
  );

  Matter.Composite.add(engine.world, [ground, leftWall, rightWall, ceiling, ...platforms]);

  return {
    engine,
    world: engine.world,
    width,
    height,
    groundY,
    ground,
    platforms,
    platformRects,
  };
}

/**
 * One-way platform behavior for FREE bodies (KO ragdoll parts, projectiles):
 * a platform contact is only kept when the body is above the platform's top
 * surface and not moving upward — bodies dropped onto a platform rest on it,
 * bodies below or rising get their contact vetoed. (The veto lands a tick
 * late on brand-new contacts, which for loose bodies just reads as a soft
 * underside bump — acceptable for corpses and bottles.)
 */
export function installOneWayPlatforms(arena: Arena): void {
  const handler = (e: Matter.IEventCollision<Matter.Engine>) => {
    for (const pair of e.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      const platform = a.label === "platform" ? a : b.label === "platform" ? b : null;
      if (!platform) continue;
      const other = platform === a ? b : a;
      if (other.isStatic) continue;
      const solid =
        other.velocity.y >= -0.5 &&
        other.bounds.max.y <= platform.bounds.min.y + 12;
      if (!solid) pair.isActive = false;
    }
  };
  Matter.Events.on(arena.engine, "collisionStart", handler);
  Matter.Events.on(arena.engine, "collisionActive", handler);
}

export function destroyArena(arena: Arena): void {
  // Clears all event handlers (incl. the one-way platform listeners).
  (Matter.Events.off as (object: unknown) => void)(arena.engine);
  Matter.World.clear(arena.world, false);
  Matter.Engine.clear(arena.engine);
}
