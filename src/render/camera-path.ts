// A camera path (meshes\cameras\*.nif, a loading screen's MOD2): a CameraPathNode moved by the
// "CameraPath" sequence, with an NiCamera under it. The paths place the camera in front of the
// shown model on the -Y side and loop (60 s); the camera looks along the node's +Y with +Z up
// (the NiCamera's 90° turn maps Gamebryo's X-forward camera onto the world's axes). The field
// of view is the NiCamera's frustum (45° across a 4:3 frame for all vanilla paths).
// Notes: docs/ui.md.

import type { NifFile } from '../formats/nif/nif.ts';
import { sampleTransform, type TransformSource } from './animation.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from './math.ts';
import type { Camera } from './renderer.ts';

export interface CameraPath {
  readonly source: TransformSource;
  /** The path's length (its sequence's stop time), seconds. */
  readonly duration: number;
  /** The NiCamera's vertical field of view, radians. */
  readonly fovY: number;
  readonly near: number;
}

/** Reads a camera path NIF; undefined if it has no CameraPath sequence. */
export function readCameraPath(file: NifFile): CameraPath | undefined {
  let node: { translation: Vec3; rotation: readonly number[]; scale: number } | undefined;
  let source: TransformSource | undefined;
  let duration = 0;
  let fovY = (34.5 * Math.PI) / 180;
  let near = 1;
  for (const block of file.blocks) {
    if (block.kind === 'node' && block.name === 'CameraPathNode') {
      const [x, y, z] = block.transform.translation;
      node = {
        translation: [x, y, z],
        rotation: block.transform.rotation,
        scale: block.transform.scale,
      };
    } else if (block.kind === 'camera') {
      fovY = 2 * Math.atan(Math.abs(block.frustum.top));
      near = Math.max(0.1, block.frustum.near);
    }
  }
  for (const block of file.blocks) {
    if (block.kind !== 'controller-sequence' || block.name !== 'CameraPath') continue;
    duration = block.stopTime - block.startTime;
    const entry = block.blocks.find((controlled) => controlled.nodeName === 'CameraPathNode');
    const interpolator = entry ? file.blocks[entry.interpolator] : undefined;
    if (interpolator?.kind !== 'transform-interpolator') continue;
    const data = file.blocks[interpolator.data];
    source = {
      translation: node?.translation,
      rotation: undefined,
      scale: node?.scale,
      data: data?.kind === 'transform-data' ? data : undefined,
    };
  }
  if (!source) return undefined;
  return { source, duration: duration > 0 ? duration : 60, fovY, near };
}

/** A camera that follows a path, looping. */
export class PathCamera implements Camera {
  readonly near: number;
  position: Vec3 = [0, 0, 0];
  forward: Vec3 = [0, 1, 0];
  readonly #path: CameraPath;
  #time = 0;

  constructor(path: CameraPath) {
    this.#path = path;
    this.near = path.near;
    this.update(0);
  }

  update(deltaSeconds: number): void {
    this.#time = (this.#time + deltaSeconds) % this.#path.duration;
    const sample = sampleTransform(this.#path.source, this.#time);
    const t = sample.translation ?? [0, 0, 0];
    this.position = [t[0], t[1], t[2]];
    // The node's rotation keys turn its +Y (all vanilla paths keep it straight).
    const q = sample.rotation;
    if (q) {
      const [w, x, y, z] = q;
      this.forward = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    }
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const p = this.position;
    const f = this.forward;
    const view = lookAt(p, [p[0] + f[0], p[1] + f[1], p[2] + f[2]], [0, 0, 1]);
    return multiply(perspectiveReversedZ(this.#path.fovY, aspect, this.near), view, out);
  }
}
