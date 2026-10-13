// Actor skeletons and poses. A race's skeleton model (skeleton.nif) gives the node tree that
// bodies, armor and heads are skinned to; its Havok skeleton (skeleton.hkx) the bones that
// animations move, matched to the nodes by name. A pose turns the bones' local transforms
// (an animation's sample) into model-space matrices of every node; nodes no animation moves
// keep their place under their parent. Platform-independent.

import type { NifFile } from '../formats/nif/nif.ts';
import { TRANSFORM_FLOATS, type HkxSkeleton } from '../formats/hkx/animation.ts';
import { fromNifTransform } from '../render/math.ts';

/** A skeleton model's node tree, parents before children. */
export interface RigData {
  readonly names: readonly string[];
  /** Parent of each node (−1 for the root). */
  readonly parents: Int16Array;
  /** Each node's transform under its parent, column-major (the root's is ignored). */
  readonly local: Float32Array;
}

/** The node tree of a skeleton model (the roots' own transforms are ignored, as for models). */
export function buildRig(file: NifFile): RigData {
  const names: string[] = [];
  const parents: number[] = [];
  const locals: Float32Array[] = [];
  const visit = (ref: number, parent: number, depth: number): void => {
    const block = file.blocks[ref];
    if (depth > 128 || block?.kind !== 'node') return;
    const index = names.length;
    names.push(block.name);
    parents.push(parent);
    const { translation, rotation, scale } = block.transform;
    locals.push(
      depth === 0
        ? fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1)
        : fromNifTransform(translation, rotation, scale),
    );
    for (const child of block.children) visit(child, index, depth + 1);
  };
  for (const root of file.roots) visit(root, -1, 0);
  const local = new Float32Array(names.length * 16);
  locals.forEach((matrix, i) => {
    local.set(matrix, i * 16);
  });
  return { names, parents: Int16Array.from(parents), local };
}

/** Writes an hkQsTransform (translation, quaternion xyzw, scale xyz) as a 4x4 matrix. */
export function qsMatrix(source: Float32Array, at: number, out: Float32Array, outAt: number): void {
  const tx = source[at] ?? 0;
  const ty = source[at + 1] ?? 0;
  const tz = source[at + 2] ?? 0;
  const x = source[at + 3] ?? 0;
  const y = source[at + 4] ?? 0;
  const z = source[at + 5] ?? 0;
  const w = source[at + 6] ?? 1;
  const sx = source[at + 7] ?? 1;
  const sy = source[at + 8] ?? 1;
  const sz = source[at + 9] ?? 1;
  out[outAt] = (1 - 2 * (y * y + z * z)) * sx;
  out[outAt + 1] = 2 * (x * y + z * w) * sx;
  out[outAt + 2] = 2 * (x * z - y * w) * sx;
  out[outAt + 3] = 0;
  out[outAt + 4] = 2 * (x * y - z * w) * sy;
  out[outAt + 5] = (1 - 2 * (x * x + z * z)) * sy;
  out[outAt + 6] = 2 * (y * z + x * w) * sy;
  out[outAt + 7] = 0;
  out[outAt + 8] = 2 * (x * z + y * w) * sz;
  out[outAt + 9] = 2 * (y * z - x * w) * sz;
  out[outAt + 10] = (1 - 2 * (x * x + y * y)) * sz;
  out[outAt + 11] = 0;
  out[outAt + 12] = tx;
  out[outAt + 13] = ty;
  out[outAt + 14] = tz;
  out[outAt + 15] = 1;
}

/** out = a · b for column-major 4x4 matrices stored in arrays at offsets. */
function multiplyAt(
  a: Float32Array,
  aAt: number,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  outAt: number,
): void {
  for (let col = 0; col < 4; col++) {
    const b0 = b[bAt + col * 4] ?? 0;
    const b1 = b[bAt + col * 4 + 1] ?? 0;
    const b2 = b[bAt + col * 4 + 2] ?? 0;
    const b3 = b[bAt + col * 4 + 3] ?? 0;
    for (let row = 0; row < 4; row++) {
      out[outAt + col * 4 + row] =
        (a[aAt + row] ?? 0) * b0 +
        (a[aAt + 4 + row] ?? 0) * b1 +
        (a[aAt + 8 + row] ?? 0) * b2 +
        (a[aAt + 12 + row] ?? 0) * b3;
    }
  }
}

/** A skeleton model with the Havok skeleton that animates it. */
export class ActorSkeleton {
  readonly rig: RigData;
  readonly hkx: HkxSkeleton | undefined;
  /** The Havok bone of each node (−1: not animated). */
  readonly boneOfNode: Int16Array;
  /** Node index by lower-case name. */
  readonly nodeByName: ReadonlyMap<string, number>;

  constructor(rig: RigData, hkx: HkxSkeleton | undefined) {
    this.rig = rig;
    this.hkx = hkx;
    const nodeByName = new Map<string, number>();
    rig.names.forEach((name, i) => {
      const key = name.toLowerCase();
      if (!nodeByName.has(key)) nodeByName.set(key, i);
    });
    this.nodeByName = nodeByName;
    const boneByName = new Map(hkx?.bones.map((bone, i) => [bone.name.toLowerCase(), i]) ?? []);
    this.boneOfNode = Int16Array.from(
      rig.names,
      (name) => boneByName.get(name.toLowerCase()) ?? -1,
    );
  }

  get nodeCount(): number {
    return this.rig.names.length;
  }

  /** The Havok skeleton's reference pose: bone-local transforms (TRANSFORM_FLOATS each). */
  referenceLocals(): Float32Array {
    return this.hkx ? this.hkx.referencePose.slice() : new Float32Array(0);
  }
}

/** The model-space matrix of every node of an actor's skeleton, changing as it animates. */
export class ActorPose {
  readonly skeleton: ActorSkeleton;
  /** 16 floats per node, model space (column-major). */
  readonly worlds: Float32Array;
  /** Bumped by every update (palettes are rewritten when it changes). */
  version = 0;
  readonly #local = new Float32Array(16);

  constructor(skeleton: ActorSkeleton) {
    this.skeleton = skeleton;
    this.worlds = new Float32Array(skeleton.nodeCount * 16);
    this.update(undefined);
  }

  /**
   * Places every node: animated ones by `bones` (bone-local hkQsTransforms of the Havok
   * skeleton, TRANSFORM_FLOATS each), the others by the skeleton model.
   */
  update(bones: Float32Array | undefined): void {
    const { rig, boneOfNode } = this.skeleton;
    const local = this.#local;
    for (let node = 0; node < rig.names.length; node++) {
      const bone = boneOfNode[node] ?? -1;
      let source: Float32Array = rig.local;
      let sourceAt = node * 16;
      if (bones && bone >= 0 && (bone + 1) * TRANSFORM_FLOATS <= bones.length) {
        qsMatrix(bones, bone * TRANSFORM_FLOATS, local, 0);
        source = local;
        sourceAt = 0;
      }
      const parent = rig.parents[node] ?? -1;
      if (parent < 0) {
        this.worlds.set(source.subarray(sourceAt, sourceAt + 16), node * 16);
      } else {
        multiplyAt(this.worlds, parent * 16, source, sourceAt, this.worlds, node * 16);
      }
    }
    this.version++;
  }

  /** A node's model-space matrix by name, or undefined. */
  world(name: string): Float32Array | undefined {
    const node = this.skeleton.nodeByName.get(name.toLowerCase());
    return node === undefined ? undefined : this.worlds.subarray(node * 16, node * 16 + 16);
  }
}
