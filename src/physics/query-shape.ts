import RAPIER from '@dimforge/rapier3d-compat';

type RawShape = ReturnType<RAPIER.Shape['intoRaw']>;

/** The shapes whose Rapier form is costly to make: built from their points, triangles or parts. */
const LENT: ReadonlySet<RAPIER.ShapeType> = new Set([
  RAPIER.ShapeType.ConvexPolyhedron,
  RAPIER.ShapeType.RoundConvexPolyhedron,
  RAPIER.ShapeType.TriMesh,
  RAPIER.ShapeType.HeightField,
  RAPIER.ShapeType.Polyline,
  RAPIER.ShapeType.Compound,
  RAPIER.ShapeType.Voxels,
]);

/** The query copies of shapes (queryShape), by the shape they copy. */
const kept = new WeakMap<RAPIER.Shape, RAPIER.Shape>();

/**
 * A shape to hand Rapier's queries (shape casts, intersections, contacts) in place of `shape`,
 * the same shape: its Rapier form is made once and lent to every query. Rapier makes a query's
 * shape anew for each query and frees it after; a convex hull (the actors' controllers, most
 * clutter) is computed again from its points every time, and the actors' queries spent more
 * time on that than on the queries themselves. A mesh is worse: its triangles are copied and
 * its tree of bounds built again for each query (a controller held against Helgen's tower wall
 * asked its contact with the wall's mesh every step, 60 ms of a frame). The primitives (balls,
 * boxes, capsules, ...) are cheap to make and are returned as they are. The copy's Rapier form is
 * freed with it (wasm-bindgen's finalizer).
 */
export function queryShape(shape: RAPIER.Shape): RAPIER.Shape {
  if (!LENT.has(shape.type)) return shape;
  let copy = kept.get(shape);
  if (!copy) {
    copy = lentShape(shape);
    kept.set(shape, copy);
  }
  return copy;
}

/** `shape` with its Rapier form made at the first query and kept (its `free` does nothing). */
function lentShape(shape: RAPIER.Shape): RAPIER.Shape {
  const copy = Object.create(shape) as RAPIER.Shape;
  let lent: RawShape | undefined;
  copy.intoRaw = (): RawShape => {
    if (!lent) {
      // Typed as always made; undefined where Rapier could not make it (handed on as before).
      const raw = shape.intoRaw() as RawShape | undefined;
      if (!raw) return shape.intoRaw();
      // A view of the kept form for the queries to take and "free": the form itself lives on
      // as long as the copy does.
      const view = Object.create(raw) as RawShape;
      view.free = (): void => undefined;
      lent = view;
    }
    return lent;
  };
  return copy;
}
