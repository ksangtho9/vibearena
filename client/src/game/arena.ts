import Matter from "matter-js";

export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;

export interface Arena {
  engine: Matter.Engine;
  world: Matter.World;
  width: number;
  height: number;
  /** Y of the ground's top surface (where feet rest). */
  groundY: number;
  ground: Matter.Body;
}

/** Matter world with a floor, two walls and a ceiling so nobody leaves the board. */
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

  Matter.Composite.add(engine.world, [ground, leftWall, rightWall, ceiling]);

  return { engine, world: engine.world, width, height, groundY, ground };
}

export function destroyArena(arena: Arena): void {
  Matter.World.clear(arena.world, false);
  Matter.Engine.clear(arena.engine);
}
