// Whole-scene culling and draw order (scene-renderer.ts GpuScene): a sphere round a scene's
// draws, so a pass leaves a scene outside its view without testing each draw, and an order of
// draws by what they bind, so instances of one model follow each other.
// Platform-independent.

/** A bounding sphere. */
export interface SceneBound {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** What boundOf needs of a draw. */
export interface BoundedDraw {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** Never culled (the sky's, first person's): the scene then has no bound. */
  readonly sky?: boolean;
  readonly firstPerson?: boolean;
}

/**
 * A sphere round all of `draws` (centred on their box), or null when there are none or one of
 * them is never culled.
 */
export function boundOf(draws: readonly BoundedDraw[]): SceneBound | null {
  if (draws.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const draw of draws) {
    if (draw.sky === true || draw.firstPerson === true) return null;
    const [x, y, z] = draw.center;
    const r = draw.radius;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    minZ = Math.min(minZ, z - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
    maxZ = Math.max(maxZ, z + r);
  }
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  let radius = 0;
  for (const draw of draws) {
    const dx = draw.center[0] - center[0];
    const dy = draw.center[1] - center[1];
    const dz = draw.center[2] - center[2];
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + draw.radius);
  }
  return { center, radius };
}

/** Small ids for objects (ordering draws by what they bind). */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(object: object | undefined): number {
  if (object === undefined) return 0;
  let id = objectIds.get(object);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(object, id);
  }
  return id;
}

/**
 * `items` ordered by the objects `key` names for each (first key first; undefined before any
 * object), keeping their order otherwise: items binding the same things follow each other.
 */
export function orderByBindings<T>(
  items: readonly T[],
  key: (item: T) => readonly (object | undefined)[],
): T[] {
  const keyed = items.map((item) => ({ item, ids: key(item).map(objectId) }));
  keyed.sort((a, b) => {
    const length = Math.max(a.ids.length, b.ids.length);
    for (let i = 0; i < length; i++) {
      const d = (a.ids[i] ?? 0) - (b.ids[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return keyed.map(({ item }) => item);
}
