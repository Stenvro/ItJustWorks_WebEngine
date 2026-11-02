import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from './physics-world.ts';
import { queryShape } from './query-shape.ts';

beforeAll(async () => {
  await initPhysics();
});

/** A world with one round convex hull (a controller's kind of shape) and a box beside it. */
function makeWorld(): { world: RAPIER.World; hull: RAPIER.Collider; box: RAPIER.Collider } {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const points = new Float32Array([
    -0.3, -0.3, -0.9, 0.3, -0.3, -0.9, 0.3, 0.3, -0.9, -0.3, 0.3, -0.9, -0.3, -0.3, 0.9, 0.3, -0.3,
    0.9, 0.3, 0.3, 0.9, -0.3, 0.3, 0.9,
  ]);
  const desc = RAPIER.ColliderDesc.roundConvexHull(points, 0.05);
  if (!desc) throw new Error('no hull');
  const hull = world.createCollider(desc);
  const box = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(1, 0, 0),
  );
  world.step();
  return { world, hull, box };
}

describe('queryShape', () => {
  it('answers queries as the shape it copies, query after query', () => {
    const { world, hull, box } = makeWorld();
    const shape = hull.shape;
    const kept = queryShape(shape);
    expect(kept).not.toBe(shape);
    expect(queryShape(shape)).toBe(kept);
    for (let i = 0; i < 5; i++) {
      const at = { x: 0.2 * i, y: 0, z: 0 };
      const rotation = { x: 0, y: 0, z: 0, w: 1 };
      const found = (query: RAPIER.Shape): number[] => {
        const handles: number[] = [];
        world.intersectionsWithShape(at, rotation, query, (other) => {
          handles.push(other.handle);
          return true;
        });
        return handles;
      };
      expect(found(kept)).toEqual(found(shape));
      const cast = (query: RAPIER.Shape) =>
        world.castShape(
          at,
          rotation,
          { x: 1, y: 0, z: 0 },
          query,
          0,
          5,
          true,
          undefined,
          undefined,
          hull,
        )?.time_of_impact;
      expect(cast(kept)).toBeCloseTo(cast(shape) ?? NaN, 6);
      const contact = (query: RAPIER.Shape) =>
        query.contactShape(at, rotation, box.shape, box.translation(), box.rotation(), 1)?.distance;
      expect(contact(kept)).toBeCloseTo(contact(shape) ?? NaN, 6);
    }
  });

  it('makes its Rapier form once', () => {
    const { hull } = makeWorld();
    const kept = queryShape(hull.shape);
    expect(kept.intoRaw()).toBe(kept.intoRaw());
    // The queries' free leaves it whole.
    kept.intoRaw().free();
    const at = { x: 0, y: 0, z: 0 };
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const ball = new RAPIER.Ball(0.5);
    expect(kept.contactShape(at, rotation, ball, at, rotation, 0)?.distance).toBeLessThan(0);
  });

  it('hands cheap shapes back as they are', () => {
    const ball = new RAPIER.Ball(1);
    expect(queryShape(ball)).toBe(ball);
  });
});
