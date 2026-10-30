// Skinned decals: a hit's blood on an actor as the original puts it there. The decal's box is
// laid against the skinned shapes of the actor's models as they are posed at the hit; the
// triangles of each shape that lie in the box are copied, with their bone weights, into a decal
// shape skinned to the same bones, its texture coordinates projected from the box (across its X,
// down its Z). The copy then moves with the body as the body does. Platform-independent.
// Notes: docs/rendering.md ("Skinned decals").

import { PALETTE_BONE_FLOATS, skinPositions, writePaletteBone } from './bone-palette.ts';
import { invert } from './frustum.ts';
import { toHalf, type Mat4 } from './math.ts';
import type {
  AlphaState,
  IndexRange,
  LightingMaterial,
  ModelData,
  ModelPart,
} from './model-data.ts';
import type { SkinPartitionRange } from './skinning.ts';

/** SLSF1 bits of a decal shape. */
const SLSF1_SPECULAR = 0x1;
const SLSF1_SKINNED = 0x2;
const SLSF1_RECEIVE_SHADOWS = 0x100;
const SLSF1_MODEL_SPACE_NORMALS = 0x1000;
const SLSF1_DECAL = 0x4000000;
const SLSF1_DYNAMIC_DECAL = 0x8000000;
const SLSF1_ZBUFFER_TEST = 0x80000000;
/** SLSF2 Vertex_Colors: the decal's colour rides on the copied vertices' colours. */
const SLSF2_VERTEX_COLORS = 0x20;

/** NiAlphaProperty: blending source alpha over inverse source alpha (flags 0x00ED). */
const ALPHA_BLEND = 0x1 | (6 << 1) | (7 << 5);
/** NiAlphaProperty: alpha test, passing above the threshold (test function 4, greater). */
const ALPHA_TEST = 0x200 | (4 << 10);
/** The alpha test's threshold of a tested decal (TODO(M13): the engine's value is unread). */
const ALPHA_TEST_THRESHOLD = 128;

/** A pose that places a skin's bones by name (an actor's skeleton). */
export interface DecalPose {
  readonly worlds: Float32Array;
  readonly skeleton: { readonly nodeByName: ReadonlyMap<string, number> };
}

/** The look of a skinned decal: its texture set's textures and its decal data. */
export interface SkinnedDecalLook {
  /** TX00..TX07 (diffuse, normal, ...; '' = none). */
  readonly textures: readonly string[];
  /** DODT flags (DecalFlag: alpha blending 0x2, alpha testing 0x4). */
  readonly flags: number;
  readonly shininess: number;
  /** Multiplies the texture colour (0..1). */
  readonly color: readonly [number, number, number];
  /** TXST: without a specular map (no specular), model-space normals. */
  readonly noSpecular: boolean;
  readonly modelSpaceNormals: boolean;
}

/** The material a skinned decal shape is drawn with: its texture set, as a decal. */
export function skinnedDecalMaterial(look: SkinnedDecalLook): {
  readonly material: LightingMaterial;
  readonly alpha: AlphaState | undefined;
} {
  const flags1 =
    SLSF1_SKINNED |
    SLSF1_RECEIVE_SHADOWS |
    SLSF1_DECAL |
    SLSF1_DYNAMIC_DECAL |
    SLSF1_ZBUFFER_TEST |
    (look.noSpecular ? 0 : SLSF1_SPECULAR) |
    (look.modelSpaceNormals ? SLSF1_MODEL_SPACE_NORMALS : 0);
  const material: LightingMaterial = {
    kind: 'lighting',
    shaderType: 0,
    flags1,
    flags2: SLSF2_VERTEX_COLORS,
    uvOffset: [0, 0],
    uvScale: [1, 1],
    textures: look.textures,
    emissiveColor: [0, 0, 0],
    emissiveMultiple: 0,
    alpha: 1,
    glossiness: look.shininess,
    specularColor: [1, 1, 1],
    specularStrength: 1,
    environmentMapScale: 0,
    tintColor: undefined,
    refractionStrength: 0,
    softLightRolloff: 0,
    rimLightPower: 0,
    multiLayer: undefined,
    sparkle: undefined,
  };
  const blend = (look.flags & 0x2) !== 0;
  const test = (look.flags & 0x4) !== 0;
  const alpha: AlphaState | undefined =
    blend || test
      ? {
          flags: (blend ? ALPHA_BLEND : 0) | (test ? ALPHA_TEST : 0),
          threshold: test ? ALPHA_TEST_THRESHOLD : 0,
        }
      : undefined;
  return { material, alpha };
}

/**
 * Whether a triangle (in the box's unit-cube space) overlaps the cube −0.5..0.5: the separating
 * axis test over the cube's three axes, the triangle's normal and the nine cross products of
 * their edges.
 */
export function triangleInUnitBox(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): boolean {
  const v = [a, b, c];
  for (let axis = 0; axis < 3; axis++) {
    const values = v.map((p) => p[axis] ?? 0);
    if (Math.min(...values) > 0.5 || Math.max(...values) < -0.5) return false;
  }
  const edge = (p: readonly number[], q: readonly number[]): number[] => [
    (q[0] ?? 0) - (p[0] ?? 0),
    (q[1] ?? 0) - (p[1] ?? 0),
    (q[2] ?? 0) - (p[2] ?? 0),
  ];
  const edges = [edge(a, b), edge(b, c), edge(c, a)];
  const cross = (p: readonly number[], q: readonly number[]): number[] => [
    (p[1] ?? 0) * (q[2] ?? 0) - (p[2] ?? 0) * (q[1] ?? 0),
    (p[2] ?? 0) * (q[0] ?? 0) - (p[0] ?? 0) * (q[2] ?? 0),
    (p[0] ?? 0) * (q[1] ?? 0) - (p[1] ?? 0) * (q[0] ?? 0),
  ];
  const separates = (axis: readonly number[]): boolean => {
    const reach = 0.5 * (Math.abs(axis[0] ?? 0) + Math.abs(axis[1] ?? 0) + Math.abs(axis[2] ?? 0));
    if (reach === 0) return false;
    const values = v.map(
      (p) =>
        (p[0] ?? 0) * (axis[0] ?? 0) + (p[1] ?? 0) * (axis[1] ?? 0) + (p[2] ?? 0) * (axis[2] ?? 0),
    );
    return Math.min(...values) > reach || Math.max(...values) < -reach;
  };
  const [e0, e1] = edges;
  if (e0 && e1 && separates(cross(e0, e1))) return false;
  const units = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (const e of edges) for (const u of units) if (separates(cross(u, e))) return false;
  return true;
}

/** A skinned part of an actor's model as it stands at the hit. */
export interface DecalTarget {
  readonly part: ModelPart;
  /** The instance's placement (model space → world). */
  readonly world: Mat4;
  readonly pose: DecalPose;
  /** Whether a partition's body part is drawn now (equipment hides some); all without. */
  readonly partitionVisible?: (bodyPart: number) => boolean;
}

/**
 * The decal shape of one skinned part: the part's triangles inside `box` (unit cube → world)
 * as the pose places them, their vertices copied with their bone weights, the texture
 * coordinates of `rect` (atlas u, v, width, height) projected across the box. Undefined: the
 * part is not skinned or nothing of it lies in the box.
 */
export function skinnedDecalPart(
  target: DecalTarget,
  box: Mat4,
  rect: readonly [number, number, number, number],
  material: LightingMaterial,
  alpha: AlphaState | undefined,
  color: readonly [number, number, number] = [1, 1, 1],
): ModelPart | undefined {
  const { part, pose } = target;
  const skin = part.skin;
  const layout = part.layout;
  const skinning = layout.skinning;
  if (!skin || skinning === undefined || layout.uv < 0) return undefined;
  const toBox = invert(box);
  if (!toBox) return undefined;
  // Where the pose has the vertices (model space), then in the box's unit cube.
  const palette = new Float32Array(skin.bones.length * PALETTE_BONE_FLOATS);
  for (let i = 0; i < skin.bones.length; i++) {
    const node = pose.skeleton.nodeByName.get((skin.names[i] ?? '').toLowerCase()) ?? -1;
    if (node >= 0) {
      writePaletteBone(palette, i * PALETTE_BONE_FLOATS, pose.worlds, node * 16, skin.bind, i * 16);
    } else {
      writePaletteBone(palette, i * PALETTE_BONE_FLOATS, skin.rest, i * 16, skin.bind, i * 16);
    }
  }
  const posed = skinPositions(part.vertices, layout.stride, skinning, part.vertexCount, palette);
  const toCube = new Float32Array(16);
  multiplyInto(toBox, target.world, toCube);
  const local = new Float32Array(part.vertexCount * 3);
  for (let v = 0; v < part.vertexCount; v++) {
    const x = posed[v * 3] ?? 0;
    const y = posed[v * 3 + 1] ?? 0;
    const z = posed[v * 3 + 2] ?? 0;
    for (let r = 0; r < 3; r++) {
      local[v * 3 + r] =
        (toCube[r] ?? 0) * x +
        (toCube[4 + r] ?? 0) * y +
        (toCube[8 + r] ?? 0) * z +
        (toCube[12 + r] ?? 0);
    }
  }
  const at = (v: number): number[] => [
    local[v * 3] ?? 0,
    local[v * 3 + 1] ?? 0,
    local[v * 3 + 2] ?? 0,
  ];
  // The triangles in the box, partition by partition (the decal keeps its partitions, so
  // equipment hides it with the skin beneath).
  const ranges: (IndexRange & { readonly bodyPart?: number })[] = skin.partitions
    ? skin.partitions.map((p) => ({ first: p.first, count: p.count, bodyPart: p.bodyPart }))
    : [{ first: 0, count: part.indices.length }];
  const remap = new Map<number, number>();
  const sources: number[] = [];
  const indices: number[] = [];
  const partitions: SkinPartitionRange[] = [];
  for (const range of ranges) {
    if (range.bodyPart !== undefined && target.partitionVisible?.(range.bodyPart) === false) {
      continue;
    }
    const first = indices.length;
    for (let i = range.first; i + 2 < range.first + range.count; i += 3) {
      const tri = [part.indices[i] ?? 0, part.indices[i + 1] ?? 0, part.indices[i + 2] ?? 0];
      if (!triangleInUnitBox(at(tri[0] ?? 0), at(tri[1] ?? 0), at(tri[2] ?? 0))) continue;
      for (const v of tri) {
        let index = remap.get(v);
        if (index === undefined) {
          index = sources.length;
          remap.set(v, index);
          sources.push(v);
        }
        indices.push(index);
      }
    }
    if (range.bodyPart !== undefined && indices.length > first) {
      partitions.push({ first, count: indices.length - first, bodyPart: range.bodyPart });
    }
  }
  if (indices.length === 0 || sources.length > 0xffff) return undefined;
  const stride = layout.stride;
  const vertices = new Uint8Array(sources.length * stride);
  const view = new DataView(vertices.buffer);
  const uvs = new Float32Array(sources.length * 2);
  sources.forEach((source, i) => {
    vertices.set(part.vertices.subarray(source * stride, (source + 1) * stride), i * stride);
    const [x, , z] = at(source);
    const u = rect[0] + ((x ?? 0) + 0.5) * rect[2];
    const v = rect[1] + (0.5 - (z ?? 0)) * rect[3];
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
    view.setUint16(i * stride + layout.uv, toHalf(u), true);
    view.setUint16(i * stride + layout.uv + 2, toHalf(v), true);
    if (layout.color >= 0) {
      for (let k = 0; k < 3; k++) {
        vertices[i * stride + layout.color + k] = Math.round(
          Math.min(1, Math.max(0, color[k] ?? 1)) * 255,
        );
      }
      vertices[i * stride + layout.color + 3] = 255;
    }
  });
  if (layout.tangent >= 0 && layout.normal >= 0) writeTangents(vertices, layout, uvs, indices);
  const decalFlags = material.flags2 & ~(layout.color >= 0 ? 0 : SLSF2_VERTEX_COLORS);
  return {
    name: `${part.name}:decal`,
    block: -1,
    shader: -1,
    alphaProperty: -1,
    world: part.world,
    layout,
    vertices,
    vertexCount: sources.length,
    indices: Uint16Array.from(indices),
    material: { ...material, flags2: decalFlags },
    alpha,
    center: part.center,
    radius: part.radius,
    skin: {
      ...skin,
      ...(skin.partitions ? { partitions } : {}),
    },
  };
}

/** The decal shapes of a hit's box on a body's skinned parts, as one model (none: undefined). */
export function skinnedDecalModel(
  targets: readonly DecalTarget[],
  box: Mat4,
  rect: readonly [number, number, number, number],
  look: SkinnedDecalLook,
): ModelData | undefined {
  const { material, alpha } = skinnedDecalMaterial(look);
  const parts: ModelPart[] = [];
  for (const target of targets) {
    const part = skinnedDecalPart(target, box, rect, material, alpha, look.color);
    if (part) parts.push(part);
  }
  const first = parts[0];
  if (!first) return undefined;
  return {
    parts,
    center: first.center,
    radius: Math.max(...parts.map((p) => p.radius)),
    skipped: [],
    editorMarker: false,
    particles: [],
    addons: [],
  };
}

/** a × b into out (column-major 4×4). */
function multiplyInto(a: Mat4, b: Mat4, out: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = sum;
    }
  }
}

/** Byte value of a −1..1 component (as the files store normals and tangents). */
function toUnorm(value: number): number {
  return Math.round((Math.min(1, Math.max(-1, value)) * 0.5 + 0.5) * 255);
}

/**
 * The copied vertices' tangent frames for the decal's texture coordinates, in the files'
 * convention (measured on the vanilla bodies): the stored tangent runs along +v, the
 * bitangent along +u, both made perpendicular to the vertex normal. Positions are the stored
 * (skin space) ones: the skinning turns the frame as it turns the normal.
 */
function writeTangents(
  vertices: Uint8Array,
  layout: ModelPart['layout'],
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
