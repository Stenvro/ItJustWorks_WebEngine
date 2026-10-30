// A camera model (meshes\cameras\*.nif, the kill cameras' shots: CAMS MODL): an NiCamera under a
// chain of nodes, the chain's nodes moved by their own controllers (an NiTransformController with
// keys or an NiPathInterpolator along a path: base.nif, baseleft.nif) and the camera's frustum
// widened and narrowed by a BSFrustumFOVController. The root's own transform is the camera's
// place in the shot's frame (x right, y forward, z up of the shot's location); Gamebryo's camera
// looks along its local +X with +Y up (each NiCamera turns that onto its node's +Y forward, +Z
// up). The FOV controller animates the frustum's right edge (its value at time 0 is the
// frustum's own: the tangent of half the horizontal field of view); the top edge keeps its
// ratio to it. Each controller runs on its own clock from the shot's start (all vanilla ones
// clamp at their end). Platform-free.

import type { NifFile } from '../formats/nif/nif.ts';
import type { NifTransform, Ref, Vec3 } from '../formats/nif/types.ts';
import {
  controllerTime,
  floatSource,
  sampleFloat,
  sampleTransform,
  timingOf,
  transformSource,
  type FloatSource,
  type Timing,
  type TransformSource,
} from './animation.ts';
import { fromNifTransform, multiply, type Mat4 } from './math.ts';

/** One node of the chain from the root to the camera: its rest transform and its motion. */
interface ChainNode {
  readonly rest: NifTransform;
  readonly motion: { readonly source: TransformSource; readonly timing: Timing } | undefined;
}

export interface CameraModel {
  /** The root first, the NiCamera last. */
  readonly chain: readonly ChainNode[];
  /** The frustum's right and top edges (tangents of the half angles). */
  readonly right: number;
  readonly top: number;
  readonly near: number;
  /** BSFrustumFOVController: the right edge over time. */
  readonly fov: { readonly source: FloatSource; readonly timing: Timing } | undefined;
  /** Seconds until every controller has run (the longest stop time). */
  readonly duration: number;
}

/** The camera of a camera model at a moment. */
export interface CameraSample {
  /** Its place and its view's axes in the model's frame (x right, y forward, z up). */
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
  /** The vertical field of view (radians). */
  readonly fovY: number;
}

/** Reads a camera model; undefined without an NiCamera. */
export function readCameraModel(file: NifFile): CameraModel | undefined {
  const camera = file.blocks.findIndex((block) => block.kind === 'camera');
  const block = file.blocks[camera];
  if (block?.kind !== 'camera') return undefined;
  const parents = new Map<Ref, Ref>();
  file.blocks.forEach((node, ref) => {
    if (node.kind === 'node') for (const child of node.children) parents.set(child, ref);
  });
  const refs: Ref[] = [];
  for (let r: Ref | undefined = camera; r !== undefined; r = parents.get(r)) refs.unshift(r);
  let duration = 0;
  const motionOf = (ref: Ref): ChainNode['motion'] => {
    const node = file.blocks[ref];
    if (!node || !('controller' in node)) return undefined;
    for (let c = node.controller; c >= 0;) {
      const controller = file.blocks[c];
      if (controller?.kind !== 'controller') break;
      if (controller.type === 'NiTransformController') {
        const source = transformSource(file, controller.interpolator);
        if (source) {
          duration = Math.max(duration, controller.stopTime);
          return { source, timing: timingOf(controller) };
        }
      }
      c = controller.next;
    }
    return undefined;
  };
  const chain = refs.flatMap((ref): ChainNode[] => {
    const node = file.blocks[ref];
    return node && 'transform' in node ? [{ rest: node.transform, motion: motionOf(ref) }] : [];
  });
  let fov: CameraModel['fov'];
  for (let c = block.controller; c >= 0;) {
    const controller = file.blocks[c];
    if (controller?.kind !== 'controller') break;
    if (controller.type === 'BSFrustumFOVController') {
      const source = floatSource(file, controller.interpolator);
      if (source) {
        fov = { source, timing: timingOf(controller) };
        duration = Math.max(duration, controller.stopTime);
      }
    }
    c = controller.next;
  }
  const { right, top, near } = block.frustum;
  return {
    chain,
    right: Math.abs(right),
    top: Math.abs(top),
    near: Math.max(0.1, near),
    fov,
    duration,
  };
}

/** The camera of a model at `seconds` since its shot began. */
export function sampleCameraModel(model: CameraModel, seconds: number): CameraSample {
  let world: Mat4 | undefined;
  for (const node of model.chain) {
    let { translation, rotation, scale } = node.rest;
    if (node.motion) {
      const sample = sampleTransform(
        node.motion.source,
        controllerTime(node.motion.timing, seconds),
      );
      if (sample.translation) translation = sample.translation;
      if (sample.rotation) rotation = quaternionRows(sample.rotation);
      if (sample.scale !== undefined) scale = sample.scale;
    }
    const local = fromNifTransform(translation, rotation, scale);
    world = world ? multiply(world, local) : local;
  }
  const m = world ?? fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1);
  const axis = (column: number): Vec3 => {
    const v: Vec3 = [m[column * 4] ?? 0, m[column * 4 + 1] ?? 0, m[column * 4 + 2] ?? 0];
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const right = model.fov
    ? Math.abs(sampleFloat(model.fov.source, controllerTime(model.fov.timing, seconds)))
    : model.right;
  const tanY = model.right > 0 ? (right * model.top) / model.right : model.top;
  return {
    position: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0],
    // Gamebryo's camera: local +X forward, +Y up.
    forward: axis(0),
    up: axis(1),
    fovY: 2 * Math.atan(tanY),
  };
}

/** Quaternion (w, x, y, z) to a row-major 3×3 rotation (as NIF transforms store it). */
function quaternionRows(q: readonly [number, number, number, number]): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}
