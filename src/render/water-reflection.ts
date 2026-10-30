// The water's reflections. The original's water shader looks its reflection up in a cube by the
// view direction reflected about the wave normal (and lays the screen-space reflection over it);
// every water technique of its shader cache samples that cube, none a planar texture. The cube
// holds what the water reflects ([Water] in the INI, all on by default): the sky
// (bReflectSky), the land and its LOD (bReflectLODLand), tree LOD (bReflectLODTrees), object LOD
// (bReflectLODObjects) and the references flagged "Reflected By Auto Water" (REFR flag bit 28).
//
// Here the cube is rendered from the camera mirrored under the water's plane: from there the
// straight line through a water point continues as the reflected view ray, so a lookup by the
// reflected direction finds what the mirror shows. What lies under the plane is clipped
// (frame.wgsl reflectionClipped). The faces are layers of a 2D array (+X, −X, +Y, −Y, +Z; no
// face looks down), each with the matrix the water shader projects a direction with.
//
// Cost, against the original's: its cube faces are 512 texels a side in half floats with one
// sample; ours are 256 a side with four samples (as many samples a face). It redraws two faces a
// frame without a pause; ours one (two while a new plane's faces are due, ReflectionSchedule).
// Each face draws only what lies inside its own view: the sky, the land's quadrants, the tree
// LOD blocks, the reflected draws (LOD, sky objects, flagged references; listed once per scene,
// GpuScene.reflected); Renderer.reflectionStats counts them.
//
// TODO(M13): unread of the original: which water plane it mirrors when several are in view (uMaxExteriorWaterReflections 2,
// fExteriorWaterReflectionThreshold 300; ours the nearest), whether the reflection is fogged
// (ours leaves the deferred lit objects unfogged) and interiors (ours reflect the sky colours).

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

  /** The faces to draw for a plane at `height` (undefined: no reflection this frame). */
  facesFor(height: number | undefined): readonly number[] {
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
        if (faces.length >= REFLECTION_FACES_PER_FRAME_MAX) break;
        faces.push(face);
      }
    } else {
      faces.push(this.#next);
    }
    for (const face of faces) {
      this.#due.delete(face);
      this.#filled.add(face);
      this.#next = (face + 1) % REFLECTION_FACES;
    }
    return faces;
  }

  /** Whether every face holds a drawing (the water shows the reflection only then). */
  get complete(): boolean {
    return this.#filled.size === REFLECTION_FACES;
  }
}
