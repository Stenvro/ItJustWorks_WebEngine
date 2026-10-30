// The water's reflections. The original's water shader looks its reflection up in a cube by the
// view direction reflected about the wave normal (and lays the screen-space reflection over it);
// every water technique of its shader cache samples that cube, none a planar texture. The cube
// holds what the water reflects ([Water] in the INI, all on by default): the sky
// (bReflectSky), the land and its LOD (bReflectLODLand), tree LOD (bReflectLODTrees), object LOD
// (bReflectLODObjects) and the references flagged "Reflected By Auto Water" (REFR flag bit 28).
//
// Which water gets which reflection follows the original (docs/rendering.md, "Which water
// gets which reflection"), planReflections. With [Water] bUseCubeMapReflections (on by default)
// all water shares one: a cube map file its world or interior cell names, else one cube rendered
// around the player's eyes that draws the sky and the LOD (outdoors; indoors it has nothing to
// draw). With it off, the reflections are of planes: outdoors the world's water height with the
// sky, the LOD and the flagged references, every other height one shared reflection of the sky
// alone (two at most, uMaxExteriorWaterReflections); indoors one per plane of the flagged
// references (four at most, uMaxInteriorWaterReflections).
//
// A plane's reflection is rendered from the camera mirrored under it: from there the straight
// line through a water point continues as the reflected view ray, so a lookup by the reflected
// direction finds what the mirror shows; what lies under the plane is clipped (frame.wgsl
// reflectionClipped). The faces are layers of a 2D array (+X, −X, +Y, −Y, +Z; no face looks
// down), each with the matrix the water shader projects a direction with.
//
// Cost, against the original's: its cube faces are 512 texels a side in half floats with one
// sample; ours are 256 a side with four samples (as many samples a face). It redraws two faces
// of each cube a frame without a pause; ours one a frame in all (two while faces are due,
// ReflectionSchedule), shared out among the reflections in view. Each face draws only what lies
// inside its own view: the sky, the land's quadrants, the tree LOD blocks, the reflected draws
// (LOD, sky objects, flagged references; listed once per scene, GpuScene.reflected);
// Renderer.reflectionStats counts them. TODO(M13): whether the reflection is fogged is unread
// (ours leaves the deferred lit objects unfogged).

import { lookAt, multiply, perspectiveReversedZ } from './math.ts';
import type { Mat4, Vec3 } from './math.ts';

/** Faces rendered: +X, −X, +Y, −Y, +Z (the layers of the reflection texture). */
export const REFLECTION_FACES = 5;
/** Texels along a face's side. */
export const REFLECTION_SIZE = 256;
/** Near plane of the faces' views. */
export const REFLECTION_NEAR = 8;

/** Face directions and their up axes, in layer order. */
const FACES: readonly (readonly [Vec3, Vec3])[] = [
  [
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
];

/** The camera mirrored under (or over) a horizontal water plane at `height`. */
export function mirroredCamera(camera: Vec3, height: number): Vec3 {
  return [camera[0], camera[1], 2 * height - camera[2]];
}

/** A face's view-projection from `eye` (90° square, reversed Z, infinite far). */
export function reflectionFaceViewProjection(face: number, eye: Vec3): Mat4 {
  const [dir, up] = FACES[face] ?? FACES[0] ?? [[1, 0, 0] as Vec3, [0, 0, 1] as Vec3];
  const target: Vec3 = [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]];
  return multiply(perspectiveReversedZ(Math.PI / 2, 1, REFLECTION_NEAR), lookAt(eye, target, up));
}

/** The faces' matrices from the origin: what the water shader projects a direction with. */
export function reflectionLookupMatrices(): Float32Array {
  const out = new Float32Array(REFLECTION_FACES * 16);
  for (let face = 0; face < REFLECTION_FACES; face++) {
    out.set(reflectionFaceViewProjection(face, [0, 0, 0]), face * 16);
  }
  return out;
}

/** The face and texture coordinates a direction is looked up at (the shader's reflectionAt). */
export function reflectionLookup(direction: Vec3): { face: number; u: number; v: number } {
  const [x, y, z] = direction;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let face = 4;
  if (z < 0 || Math.max(ax, ay) > Math.abs(z)) {
    face = ax >= ay ? (x >= 0 ? 0 : 1) : y >= 0 ? 2 : 3;
  }
  const m = reflectionFaceViewProjection(face, [0, 0, 0]);
  const clip = (row: number): number =>
    (m[row] ?? 0) * x + (m[4 + row] ?? 0) * y + (m[8 + row] ?? 0) * z + (m[12 + row] ?? 0);
  const w = Math.max(clip(3), 1e-4);
  const nx = Math.max(-1, Math.min(1, clip(0) / w));
  const ny = Math.max(-1, Math.min(1, clip(1) / w));
  return { face, u: nx * 0.5 + 0.5, v: 0.5 - ny * 0.5 };
}

/**
 * At most this many faces are redrawn in a frame: the original redraws its cube two faces a
 * frame (the whole cube every three frames, fCubeMapRefreshRate 0 meaning without a pause).
 */
export const REFLECTION_FACES_PER_FRAME_MAX = 2;

/**
 * Which faces to redraw this frame. In the steady state one face a frame, one after another
 * (half the original's rate: the faces are mirrored views whose content barely moves between
 * frames). When the mirrored plane changes, every face is due again and the due faces are
 * redrawn two a frame (the original's rate) instead of all in one frame, so a new plane costs
 * no frame more than the original's refresh does.
 */
export class ReflectionSchedule {
  #height: number | undefined;
  #next = 0;
  /** Faces due again (drawn for another plane). */
  readonly #due = new Set<number>();
  /** Faces drawn at least once (a face never drawn holds nothing to show). */
  readonly #filled = new Set<number>();

  /**
   * The faces to draw for a plane at `height` (undefined: no reflection this frame), at most
   * `limit` (the frame's faces left).
   */
  facesFor(height: number | undefined, limit = REFLECTION_FACES_PER_FRAME_MAX): readonly number[] {
    if (height === undefined) {
      this.#height = undefined;
      return [];
    }
    if (this.#height === undefined || Math.abs(this.#height - height) > 1) {
      this.#height = height;
      for (let face = 0; face < REFLECTION_FACES; face++) this.#due.add(face);
    }
    const faces: number[] = [];
    if (this.#due.size > 0) {
      for (const face of this.#due) {
        if (faces.length >= Math.min(limit, REFLECTION_FACES_PER_FRAME_MAX)) break;
        faces.push(face);
      }
    } else if (limit > 0) {
      faces.push(this.#next);
    }
    for (const face of faces) {
      this.#due.delete(face);
      this.#filled.add(face);
      this.#next = (face + 1) % REFLECTION_FACES;
    }
    return faces;
  }

  /** Whether faces are due (drawn for another plane, or never drawn). */
  get pending(): boolean {
    return this.#due.size > 0 || !this.complete;
  }

  /** Whether every face holds a drawing (the water shows the reflection only then). */
  get complete(): boolean {
    return this.#filled.size === REFLECTION_FACES;
  }
}

/**
 * What a reflection draws. `probe`: the cube rendered around the player's eyes (with cube map
 * reflections), the sky and the LOD; `world`: the world's water height mirrored, the sky, the
 * LOD and the flagged references; `sky`: another height mirrored, the sky alone;
 * `references`: an interior plane mirrored, the flagged references alone.
 */
export type ReflectionKind = 'probe' | 'world' | 'sky' | 'references';

/** A reflection the water's planes share: what it draws and the plane it mirrors. */
export interface PlannedReflection {
  readonly kind: ReflectionKind;
  /** The plane's height (a probe: the first water's; it mirrors nothing). */
  readonly height: number;
}

/** What decides which water gets which reflection. */
export interface ReflectionRules {
  /** [Water] bUseCubeMapReflections (on by default). */
  readonly cubeMaps: boolean;
  /** The water is in an interior cell. */
  readonly interior: boolean;
  /**
   * The world's water height the full reflection mirrors (the world's LOD water height, WRLD
   * NAM4); undefined indoors.
   */
  readonly worldWaterHeight?: number | undefined;
}

/** [Water] uMaxExteriorWaterReflections: reflections outdoors. */
export const MAX_EXTERIOR_REFLECTIONS = 2;
/** [Water] uMaxInteriorWaterReflections: reflections indoors. */
export const MAX_INTERIOR_REFLECTIONS = 4;
/** Planes nearer than this share a reflection (observed in the original). */
export const REFLECTION_PLANE_TOLERANCE = 0.01;

/** The reflections of a set of water planes and which plane takes which. */
export interface ReflectionPlan {
  readonly reflections: readonly PlannedReflection[];
  /** The reflection water at `height` takes (an index of `reflections`), if any. */
  readonly reflectionOf: (height: number) => number | undefined;
}

/**
 * Which water gets which reflection, as the original assigns them while water is added
 * (`heights`: the water planes in the order they came). With cube map reflections, one
 * reflection for all water outdoors (a cube map file the world names takes its place, see
 * WaterFrame.environment) and none rendered indoors (the cell's file, else nothing: the cube
 * the original renders there has no world to draw). Without, outdoors the planes at the world's
 * water height share the full reflection and every other plane one of the sky alone (the first
 * such plane's); indoors each plane its own of the flagged references, at most four.
 * TODO(M13): what a plane past the interior's four takes is unread (ours: none).
 */
export function planReflections(heights: Iterable<number>, rules: ReflectionRules): ReflectionPlan {
  const reflections: PlannedReflection[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= REFLECTION_PLANE_TOLERANCE;
  if (rules.cubeMaps) {
    if (!rules.interior) {
      for (const height of heights) {
        reflections.push({ kind: 'probe', height });
        break;
      }
    }
    return { reflections, reflectionOf: () => (reflections.length > 0 ? 0 : undefined) };
  }
  if (rules.interior) {
    for (const height of heights) {
      if (reflections.length >= MAX_INTERIOR_REFLECTIONS) break;
      if (!reflections.some((r) => near(r.height, height))) {
        reflections.push({ kind: 'references', height });
      }
    }
    return {
      reflections,
      reflectionOf: (height) => {
        const index = reflections.findIndex((r) => near(r.height, height));
        return index < 0 ? undefined : index;
      },
    };
  }
  const world = rules.worldWaterHeight;
  const atWorld = (height: number): boolean => world !== undefined && near(height, world);
  for (const height of heights) {
    const kind: ReflectionKind = atWorld(height) ? 'world' : 'sky';
    if (!reflections.some((r) => r.kind === kind)) reflections.push({ kind, height });
    if (reflections.length >= MAX_EXTERIOR_REFLECTIONS) break;
  }
  return {
    reflections,
    reflectionOf: (height) => {
      const kind: ReflectionKind = atWorld(height) ? 'world' : 'sky';
      const index = reflections.findIndex((r) => r.kind === kind);
      return index < 0 ? undefined : index;
    },
  };
}

/** What a reflection of `kind` draws besides being cleared. */
export function reflectionContent(kind: ReflectionKind): {
  readonly sky: boolean;
  readonly lod: boolean;
  readonly references: boolean;
  /** Mirrored under its plane (a probe sits at the eyes). */
  readonly mirrored: boolean;
} {
  return {
    sky: kind !== 'references',
    lod: kind === 'probe' || kind === 'world',
    references: kind === 'world' || kind === 'references',
    mirrored: kind !== 'probe',
  };
}
