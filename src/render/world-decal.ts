// Dynamic decals on the world (a hit's blood or scorch on a wall, the floor, the land) as the
// original builds them (observed in the original): every shape under the node that holds the
// struck collision takes a decal shape of its own, made of its triangles that face the decal
// and lie in the decal's box, clipped to that box. Platform-independent.
// Notes: docs/rendering.md ("Decals").
//
// The box: the decal's width across its X, its height up its Z, and its DODT depth either side
// of the struck point along the projection (Y, into the surface). A triangle takes part when its
// face (its winding's normal) turns less than the impact's angle threshold (IPCT DATA) from the
// surface the decal was made on; it is clipped against the box's six planes and the polygon left
// is cut into a fan. The copied vertices keep what the shape's have (their normals carried
// along the cut edges), their texture coordinates are projected across the box (the decal's atlas
// quarter) and their tangent frames made again for those coordinates.

import { invert } from './frustum.ts';
import { toHalf, type Mat4 } from './math.ts';
import type { AlphaState, LightingMaterial, ModelPart, VertexLayout } from './model-data.ts';

/** SLSF1 Skinned (a decal shape on a rigid shape is not); SLSF2 Vertex_Colors. */
const SLSF1_SKINNED = 0x2;
const SLSF2_VERTEX_COLORS = 0x20;

/**
 * The cosine a face's turn from the decal's surface must stay above (observed in the original:
 * the cosine of the impact's angle threshold, at least 0.01).
 */
export function worldDecalFaceLimit(angleThreshold: number): number {
  return Math.max(0.01, Math.cos((angleThreshold * Math.PI) / 180));
}

/**
 * The box a world decal is clipped to: a placed decal's box (X its width, Z its height, Y the
 * projection) made `depth` deep either side of its centre along Y (observed in the original:
 * the planes across the projection lie at ±the decal's DODT depth).
 */
export function worldDecalBox(box: Mat4, depth: number): Mat4 {
  const out = Float32Array.from(box);
  const length = Math.hypot(box[4] ?? 0, box[5] ?? 0, box[6] ?? 0);
  const scale = length > 0 ? (2 * Math.max(0, depth)) / length : 0;
  for (let k = 4; k < 7; k++) out[k] = (box[k] ?? 0) * scale;
  return out;
}

/** A vertex of a clipped polygon: in the box's unit cube, in its shape's space, its normal. */
interface ClipVertex {
  readonly cube: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** The shape's vertex whose other data it keeps (the nearer end of a cut edge). */
  readonly source: number;
}

const lerp3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** A polygon clipped to the unit cube −0.5..0.5 (Sutherland–Hodgman, plane by plane). */
export function clipToUnitCube(polygon: readonly ClipVertex[]): ClipVertex[] {
  let current = [...polygon];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [1, -1]) {
      if (current.length === 0) return current;
      const inside = (v: ClipVertex): number => 0.5 - side * (v.cube[axis] ?? 0);
      const next: ClipVertex[] = [];
      for (let i = 0; i < current.length; i++) {
        const a = current[i];
        const b = current[(i + 1) % current.length];
        if (!a || !b) continue;
        const da = inside(a);
        const db = inside(b);
        if (da >= 0) next.push(a);
        if (da >= 0 !== db >= 0) {
          const t = da / (da - db);
          next.push({
            cube: lerp3(a.cube, b.cube, t),
            position: lerp3(a.position, b.position, t),
            normal: lerp3(a.normal, b.normal, t),
            source: t < 0.5 ? a.source : b.source,
          });
        }
      }
      current = next;
    }
  }
  return current;
}

/** A surface a world decal is built on: its triangles in its own space and where it is drawn. */
export interface DecalSurface {
  /** xyz per vertex (the shape's space). */
  readonly positions: Float32Array;
  /** Unit xyz per vertex (the shape's space); without: each face's own. */
  readonly normals: Float32Array | undefined;
  readonly indices: ArrayLike<number>;
  /** The shape's space → world, as it is drawn now. */
  readonly world: Mat4;
}

/**
 * The clipped polygons of a surface's triangles in a decal's box (`box`: the clip box, world)
 * whose faces turn towards `outward` (the struck surface's normal, a unit vector) by more than
 * `faceLimit` (a cosine). Empty: none.
 */
export function clippedDecalPolygons(
  surface: DecalSurface,
  box: Mat4,
  outward: readonly [number, number, number],
  faceLimit: number,
): ClipVertex[][] {
  const toBox = invert(box);
  if (!toBox) return [];
  const { positions, normals, indices, world } = surface;
  const count = positions.length / 3;
  const cube = new Float32Array(count * 3);
  const placed = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3] ?? 0;
    const y = positions[v * 3 + 1] ?? 0;
    const z = positions[v * 3 + 2] ?? 0;
    for (let r = 0; r < 3; r++) {
      placed[v * 3 + r] =
        (world[r] ?? 0) * x +
        (world[4 + r] ?? 0) * y +
        (world[8 + r] ?? 0) * z +
        (world[12 + r] ?? 0);
    }
  }
  for (let v = 0; v < count; v++) {
    const x = placed[v * 3] ?? 0;
    const y = placed[v * 3 + 1] ?? 0;
    const z = placed[v * 3 + 2] ?? 0;
    for (let r = 0; r < 3; r++) {
      cube[v * 3 + r] =
        (toBox[r] ?? 0) * x +
        (toBox[4 + r] ?? 0) * y +
        (toBox[8 + r] ?? 0) * z +
        (toBox[12 + r] ?? 0);
    }
  }
  const at = (array: Float32Array, v: number): [number, number, number] => [
    array[v * 3] ?? 0,
    array[v * 3 + 1] ?? 0,
    array[v * 3 + 2] ?? 0,
  ];
  const polygons: ClipVertex[][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i] ?? 0, indices[i + 1] ?? 0, indices[i + 2] ?? 0] as const;
    // Wholly beyond one face of the box: nothing to clip.
    let outside = false;
    for (let axis = 0; axis < 3 && !outside; axis++) {
      const values = tri.map((v) => cube[v * 3 + axis] ?? 0);
      outside = Math.min(...values) > 0.5 || Math.max(...values) < -0.5;
    }
    if (outside) continue;
    // Its face, as wound, against the surface the decal was made on.
    const [p0, p1, p2] = tri.map((v) => at(placed, v)) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n: [number, number, number] = [
      (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
      (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
      (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
    ];
    const length = Math.hypot(n[0], n[1], n[2]);
    if (!(n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] > length * faceLimit)) {
      continue;
    }
    let faceNormal: [number, number, number] | undefined;
    const normalOf = (v: number): [number, number, number] => {
      if (normals) return at(normals, v);
      if (!faceNormal) {
        const [l0, l1, l2] = tri.map((w) => at(positions, w)) as [
          [number, number, number],
          [number, number, number],
          [number, number, number],
        ];
        const a = [l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]];
        const b = [l2[0] - l0[0], l2[1] - l0[1], l2[2] - l0[2]];
        const c: [number, number, number] = [
          (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
          (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
          (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
        ];
        const size = Math.hypot(c[0], c[1], c[2]) || 1;
        faceNormal = [c[0] / size, c[1] / size, c[2] / size];
      }
      return faceNormal;
    };
    const polygon = clipToUnitCube(
      tri.map((v) => ({
        cube: at(cube, v),
        position: at(positions, v),
        normal: normalOf(v),
        source: v,
      })),
    );
    if (polygon.length >= 3) polygons.push(polygon);
  }
  return polygons;
}

/** Byte value of a −1..1 component (as the files store normals and tangents). */
function toUnorm(value: number): number {
  return Math.round((Math.min(1, Math.max(-1, value)) * 0.5 + 0.5) * 255);
}

/**
 * The polygons' vertices written in `layout` (fan triangles), each copying its source vertex's
 * bytes from `sourceVertices` (when given) under its own position, normal, texture coordinates
 * (projected across the box into `rect`) and colour; then the tangent frames for those
 * coordinates. Undefined: too many vertices for one shape.
 */
function decalShape(
  polygons: readonly ClipVertex[][],
  layout: VertexLayout,
  sourceVertices: Uint8Array | undefined,
  rect: readonly [number, number, number, number],
  color: readonly [number, number, number],
): { vertices: Uint8Array; vertexCount: number; indices: Uint16Array } | undefined {
  const vertexCount = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
  if (vertexCount === 0 || vertexCount > 0xffff) return undefined;
  const stride = layout.stride;
  const vertices = new Uint8Array(vertexCount * stride);
  const view = new DataView(vertices.buffer);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];
  let next = 0;
  for (const polygon of polygons) {
    const first = next;
    for (const vertex of polygon) {
      const base = next * stride;
      if (sourceVertices) {
        vertices.set(
          sourceVertices.subarray(vertex.source * stride, (vertex.source + 1) * stride),
          base,
        );
      }
      for (let k = 0; k < 3; k++) view.setFloat32(base + k * 4, vertex.position[k] ?? 0, true);
      if (layout.normal >= 0) {
        const n = vertex.normal;
        const length = Math.hypot(n[0], n[1], n[2]) || 1;
        for (let k = 0; k < 3; k++)
          vertices[base + layout.normal + k] = toUnorm((n[k] ?? 0) / length);
      }
      const u = rect[0] + (vertex.cube[0] + 0.5) * rect[2];
      const v = rect[1] + (0.5 - vertex.cube[2]) * rect[3];
      uvs[next * 2] = u;
      uvs[next * 2 + 1] = v;
      if (layout.uv >= 0) {
        view.setUint16(base + layout.uv, toHalf(u), true);
        view.setUint16(base + layout.uv + 2, toHalf(v), true);
      }
      if (layout.color >= 0) {
        for (let k = 0; k < 3; k++) {
          vertices[base + layout.color + k] = Math.round(
            Math.min(1, Math.max(0, color[k] ?? 1)) * 255,
          );
        }
        vertices[base + layout.color + 3] = 255;
      }
      next++;
    }
    for (let i = 1; i + 1 < polygon.length; i++) indices.push(first, first + i, first + i + 1);
  }
  if (layout.tangent >= 0 && layout.normal >= 0) writeTangents(vertices, layout, uvs, indices);
  return { vertices, vertexCount, indices: Uint16Array.from(indices) };
}

/**
 * Tangent frames for the decal's texture coordinates in the files' convention (the stored
 * tangent along +v, the bitangent along +u, perpendicular to the vertex normal).
 */
function writeTangents(
  vertices: Uint8Array,
  layout: VertexLayout,
  uvs: Float32Array,
  indices: readonly number[],
): void {
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const stride = layout.stride;
  const count = uvs.length / 2;
  const du = new Float32Array(count * 3);
  const dv = new Float32Array(count * 3);
  const position = (v: number, k: number): number => view.getFloat32(v * stride + k * 4, true);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] ?? 0;
    const b = indices[i + 1] ?? 0;
    const c = indices[i + 2] ?? 0;
    const u1 = (uvs[b * 2] ?? 0) - (uvs[a * 2] ?? 0);
    const v1 = (uvs[b * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0);
    const u2 = (uvs[c * 2] ?? 0) - (uvs[a * 2] ?? 0);
    const v2 = (uvs[c * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0);
    const det = u1 * v2 - u2 * v1;
    if (Math.abs(det) < 1e-12) continue;
    for (let k = 0; k < 3; k++) {
      const e1 = position(b, k) - position(a, k);
      const e2 = position(c, k) - position(a, k);
      const alongU = (e1 * v2 - e2 * v1) / det;
      const alongV = (e2 * u1 - e1 * u2) / det;
      for (const v of [a, b, c]) {
        du[v * 3 + k] = (du[v * 3 + k] ?? 0) + alongU;
        dv[v * 3 + k] = (dv[v * 3 + k] ?? 0) + alongV;
      }
    }
  }
  for (let v = 0; v < count; v++) {
    const base = v * stride;
    const n = [0, 1, 2].map((k) => ((vertices[base + layout.normal + k] ?? 128) / 255) * 2 - 1);
    const frame = (d: Float32Array): number[] => {
      const t = [d[v * 3] ?? 0, d[v * 3 + 1] ?? 0, d[v * 3 + 2] ?? 0];
      const along = t.reduce((sum, x, k) => sum + x * (n[k] ?? 0), 0);
      const o = t.map((x, k) => x - along * (n[k] ?? 0));
      const length = Math.hypot(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0);
      return length > 1e-9 ? o.map((x) => x / length) : [0, 0, 0];
    };
    const tangent = frame(dv);
    const bitangent = frame(du);
    for (let k = 0; k < 3; k++) vertices[base + layout.tangent + k] = toUnorm(tangent[k] ?? 0);
    view.setFloat32(base + 12, bitangent[0] ?? 0, true);
    vertices[base + layout.normal + 3] = toUnorm(bitangent[1] ?? 0);
    vertices[base + layout.tangent + 3] = toUnorm(bitangent[2] ?? 0);
  }
}

/** What a world decal shape looks like: its material, alpha, colour and atlas quarter. */
export interface WorldDecalLook {
  readonly material: LightingMaterial;
  readonly alpha: AlphaState | undefined;
  readonly color: readonly [number, number, number];
  readonly rect: readonly [number, number, number, number];
}

/** The positions and normals of a rigid shape's vertices (its space). */
function partSurface(part: ModelPart, world: Mat4): DecalSurface {
  const layout = part.layout;
  const view = new DataView(
    part.vertices.buffer,
    part.vertices.byteOffset,
    part.vertices.byteLength,
  );
  const positions = new Float32Array(part.vertexCount * 3);
  const normals = layout.normal >= 0 ? new Float32Array(part.vertexCount * 3) : undefined;
  for (let v = 0; v < part.vertexCount; v++) {
    for (let k = 0; k < 3; k++) {
      positions[v * 3 + k] = view.getFloat32(v * layout.stride + k * 4, true);
      if (normals) {
        normals[v * 3 + k] =
          ((part.vertices[v * layout.stride + layout.normal + k] ?? 128) / 255) * 2 - 1;
      }
    }
  }
  return { positions, normals, indices: part.indices, world };
}

/**
 * The decal shape a rigid shape of the world takes (`world`: where the shape is drawn now): its
 * triangles that face the decal clipped to `box` (worldDecalBox), drawn where the shape is
 * (`node`: the pose node it hangs on, as rigidDecalPart). Undefined: the shape is skinned, has
 * no texture coordinates, or none of it takes the decal.
 */
export function worldDecalPart(
  part: ModelPart,
  world: Mat4,
  box: Mat4,
  outward: readonly [number, number, number],
  faceLimit: number,
  look: WorldDecalLook,
  node?: number,
): ModelPart | undefined {
  const layout = part.layout;
  if (part.skin || layout.uv < 0) return undefined;
  const polygons = clippedDecalPolygons(partSurface(part, world), box, outward, faceLimit);
  const shape = decalShape(polygons, layout, part.vertices, look.rect, look.color);
  if (!shape) return undefined;
  const material = look.material;
  const flags2 = material.flags2 & ~(layout.color >= 0 ? 0 : SLSF2_VERTEX_COLORS);
  return {
    name: `${part.name}:decal`,
    block: -1,
    shader: -1,
    alphaProperty: -1,
    world: part.world,
    layout,
    vertices: shape.vertices,
    vertexCount: shape.vertexCount,
    indices: shape.indices,
    material: { ...material, flags1: material.flags1 & ~SLSF1_SKINNED, flags2 },
    alpha: look.alpha,
    center: part.center,
    radius: part.radius,
    ...(node !== undefined && { node }),
    ...(part.local && { local: part.local }),
  };
}

/**
 * The vertex layout of a decal shape on the land: position (f32, with the bitangent's X),
 * texture coordinates (f16), normal, tangent and colour (unorm8 ×4), full precision.
 */
export const LAND_DECAL_LAYOUT: VertexLayout = {
  stride: 32,
  attributes: 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x400,
  uv: 16,
  normal: 20,
  tangent: 24,
  color: 28,
};

/** The land of one cell: its 33×33 heights and normals, row by row from its south-west corner. */
export interface DecalLand {
  readonly heights: Float32Array;
  readonly normals: Float32Array | undefined;
  /** The cell's south-west corner (world). */
  readonly origin: readonly [number, number];
  /** Points per side (33) and the units between two (128). */
  readonly grid: number;
  readonly spacing: number;
}

/**
 * The decal shape the land of a cell takes (world space): the triangles of its grid squares
 * under the box (each square cut south-west to north-east, as the land's shapes are), facing
 * the decal and clipped to `box`. Undefined: none takes it.
 */
export function landDecalPart(
  land: DecalLand,
  box: Mat4,
  outward: readonly [number, number, number],
  faceLimit: number,
  look: WorldDecalLook,
): ModelPart | undefined {
  // The squares under the box's corners.
  const corners: [number, number][] = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        corners.push([
          (box[0] ?? 0) * x + (box[4] ?? 0) * y + (box[8] ?? 0) * z + (box[12] ?? 0),
          (box[1] ?? 0) * x + (box[5] ?? 0) * y + (box[9] ?? 0) * z + (box[13] ?? 0),
        ]);
      }
    }
  }
  const { grid, spacing, origin } = land;
  const cellOf = (value: number, start: number): number =>
    Math.min(grid - 2, Math.max(0, Math.floor((value - start) / spacing)));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  if (Math.max(...xs) < origin[0] || Math.min(...xs) > origin[0] + spacing * (grid - 1)) {
    return undefined;
  }
  if (Math.max(...ys) < origin[1] || Math.min(...ys) > origin[1] + spacing * (grid - 1)) {
    return undefined;
  }
  const x0 = cellOf(Math.min(...xs), origin[0]);
  const x1 = cellOf(Math.max(...xs), origin[0]);
  const y0 = cellOf(Math.min(...ys), origin[1]);
  const y1 = cellOf(Math.max(...ys), origin[1]);
  const columns = x1 - x0 + 2;
  const rows = y1 - y0 + 2;
  const positions = new Float32Array(columns * rows * 3);
  const normals = land.normals ? new Float32Array(columns * rows * 3) : undefined;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const point = (y0 + row) * grid + x0 + column;
      const v = row * columns + column;
      positions[v * 3] = origin[0] + (x0 + column) * spacing;
      positions[v * 3 + 1] = origin[1] + (y0 + row) * spacing;
      positions[v * 3 + 2] = land.heights[point] ?? 0;
      if (normals && land.normals) {
        for (let k = 0; k < 3; k++) normals[v * 3 + k] = land.normals[point * 3 + k] ?? 0;
      }
    }
  }
  const indices: number[] = [];
  for (let row = 0; row + 1 < rows; row++) {
    for (let column = 0; column + 1 < columns; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // Counter-clockwise seen from above, as the land's own triangles (terrain-data.ts).
      indices.push(a, b, d, a, d, c);
    }
  }
  const identityWorld = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const polygons = clippedDecalPolygons(
    { positions, normals, indices, world: identityWorld },
    box,
    outward,
    faceLimit,
  );
  const shape = decalShape(polygons, LAND_DECAL_LAYOUT, undefined, look.rect, look.color);
  if (!shape) return undefined;
  const center: [number, number, number] = [box[12] ?? 0, box[13] ?? 0, box[14] ?? 0];
  // Half the box's diagonal.
  const radius =
    0.5 *
    Math.hypot(...[0, 4, 8].map((k) => Math.hypot(box[k] ?? 0, box[k + 1] ?? 0, box[k + 2] ?? 0)));
  return {
    name: 'land:decal',
    block: -1,
    shader: -1,
    alphaProperty: -1,
    world: identityWorld,
    layout: LAND_DECAL_LAYOUT,
    vertices: shape.vertices,
    vertexCount: shape.vertexCount,
    indices: shape.indices,
    material: { ...look.material, flags1: look.material.flags1 & ~SLSF1_SKINNED },
    alpha: look.alpha,
    center,
    radius,
  };
}
