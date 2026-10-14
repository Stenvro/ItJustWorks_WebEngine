// The wind in BSTreeNode trees (pines): their trunk bones lean and their branch bones sway,
// skinning the tree's shapes, by the tree's TREE CNAM settings and the weather's wind. The
// Creation Kit documents only that the trunk moves horizontally and the branches in every
// direction, by their flexibility; how the engine turns the settings into motion is not
// documented. Here (TODO(M13): the engine's formula): each bone turns about its own x axis
// (front and back) and z axis (to the side) by the CNAM amplitudes in radians, oscillating at
// the CNAM frequencies in radians per second, times the wind's speed (0..1); the trunk only
// about the model's horizontal axes, by the trunk amplitude. The motion is the model's own:
// every placement of a tree model sways alike, turned with the reference (as the documentation
// observes the reference's rotation changing the motion). Platform-independent.

import type { SkeletonNode } from './animated-skeleton.ts';
import { ActorPose, ActorSkeleton, type RigData } from './skeleton.ts';

/** TREE CNAM's sway settings (world/cell-loader.ts TreeSwaySettings). */
export interface SwaySettings {
  readonly trunkAmplitude: number;
  /** Front, back, side. */
  readonly amplitudes: readonly [number, number, number];
  readonly frequencies: readonly [number, number, number];
}

/** A tree model's swaying skeleton, shared by its placements. */
export class TreeSway {
  readonly pose: ActorPose;
  /** Every model node is a pose node (the whole tree is skinned to its bones). */
  readonly poseNodes: Int16Array;
  readonly #rig: RigData;
  readonly #trunk: readonly number[];
  readonly #branches: readonly number[];
  readonly #settings: SwaySettings;
  readonly #locals = new Map<number, Float32Array>();

  constructor(
    nodes: readonly SkeletonNode[],
    bones: { readonly trunk: readonly number[]; readonly branches: readonly number[] },
    settings: SwaySettings,
  ) {
    const local = new Float32Array(nodes.length * 16);
    nodes.forEach((node, i) => {
      local.set(node.local, i * 16);
    });
    this.#rig = {
      names: nodes.map((node) => node.name),
      parents: Int16Array.from(nodes, (node) => node.parent),
      local,
    };
    this.pose = new ActorPose(new ActorSkeleton(this.#rig, undefined));
    this.poseNodes = Int16Array.from(nodes, (_, i) => i);
    this.#trunk = bones.trunk;
    this.#branches = bones.branches;
    this.#settings = settings;
    for (const node of [...bones.trunk, ...bones.branches]) {
      this.#locals.set(node, new Float32Array(16));
    }
  }

  /** Whether the settings move anything at all. */
  get moves(): boolean {
    const { trunkAmplitude, amplitudes } = this.#settings;
    return (
      (trunkAmplitude !== 0 && this.#trunk.length > 0) ||
      (amplitudes.some((amplitude) => amplitude !== 0) && this.#branches.length > 0)
    );
  }

  /** Sways to `seconds` with the wind's speed (0..1). */
  update(seconds: number, wind: number): void {
    const { trunkAmplitude, amplitudes, frequencies } = this.#settings;
    const [front, back, side] = amplitudes;
    const [frontRate, backRate, sideRate] = frequencies;
    this.#trunk.forEach((node, i) => {
      const phase = i * GOLDEN_ANGLE;
      const pitch = wind * trunkAmplitude * Math.sin(frontRate * seconds + phase);
      const roll = wind * trunkAmplitude * Math.sin(sideRate * seconds + phase * 0.5);
      this.#turn(node, pitch, roll, true);
    });
    this.#branches.forEach((node, i) => {
      const phase = (i + 1) * GOLDEN_ANGLE;
      const wave = Math.sin(frontRate * seconds + phase);
      // Forward as far as the front amplitude, back as far as the back one.
      const pitch = wind * (wave >= 0 ? front * wave : back * Math.sin(backRate * seconds + phase));
      const roll = wind * side * Math.sin(sideRate * seconds + phase * 1.7);
      this.#turn(node, pitch, roll, false);
    });
    this.pose.placeLocals(this.#locals);
  }

  /**
   * A bone's local transform: its rest turned by `pitch` about x and `roll` about z, either
   * about its own axes or (the trunk) about its parent's horizontal ones.
   */
  #turn(node: number, pitch: number, roll: number, horizontal: boolean): void {
    const out = this.#locals.get(node);
    if (!out) return;
    const rest = this.#rig.local.subarray(node * 16, node * 16 + 16);
    const turn = rotationXZ(pitch, roll);
    if (horizontal) multiply4(turn, rest, out);
    else multiply4(rest, turn, out);
  }
}

/** Spreads the bones' phases (radians). */
const GOLDEN_ANGLE = 2.399963;

/** Column-major rotation: about x by `pitch`, then about z by `roll`. */
function rotationXZ(pitch: number, roll: number): Float32Array {
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  // Rz · Rx
  return Float32Array.of(
    cz,
    sz,
    0,
    0,
    -sz * cx,
    cz * cx,
    sx,
    0,
    sz * sx,
    -cz * sx,
    cx,
    0,
    0,
    0,
    0,
    1,
  );
}

function multiply4(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      out[column * 4 + row] = sum;
    }
  }
}
