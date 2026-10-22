// A held weapon's own behavior graph (docs/animation.md, "Held weapons"): a bow's or a
// crossbow's model names a project (BSBehaviorGraphExtraData: Weapons\Bow\BowProject.hkx and its
// kin) whose clips move the model's bones (Bow_MidBone, the limbs, the string). The engine runs
// it beside its wielder's graph: every event the wielder's graph raises reaches it (BowDraw,
// bowDrawStart, BowRelease, bowReset; a crossbow's Reload, BowReleaseFast, attackStop), and so do
// the variables the engine sets on the wielder (weaponSpeedMult, which the draw's pull plays
// at; bPerkQuickDraw). Its events of its own (BowDrawOut, BowReleaseOut) come from its clips.
// Its pose is in the model's space; the model hangs on a node of the wielder (its hand or its
// sheath), so the moved nodes are placed under that node. Platform-independent.

import {
  startObjectSkeleton,
  type ObjectSkeleton,
  type SkeletonNode,
} from './animated-skeleton.ts';
import type { SkeletalGraph } from './behavior-runtime.ts';
import { multiply } from '../render/math.ts';

/** A frame longer than this (a hitch) advances the graph by this much. */
const MAX_STEP = 0.1;

export class WeaponGraph {
  readonly #object: ObjectSkeleton;
  /** Per node of the weapon's model: its node in the pose it is placed into (−1: none). */
  readonly #placed: Int16Array;

  private constructor(object: ObjectSkeleton, placed: Int16Array) {
    this.#object = object;
    this.#placed = placed;
  }

  /**
   * The weapon model's graph on its nodes, in its start state; `placed` gives, per node of the
   * model, its node in the pose its nodes are placed into. Undefined when no bone of the graph
   * names a node of the model (nothing would move).
   */
  static start(
    nodes: readonly SkeletonNode[],
    graph: SkeletalGraph,
    random: () => number,
    placed: Int16Array,
  ): WeaponGraph | undefined {
    const object = startObjectSkeleton(nodes, graph, random);
    return object && new WeaponGraph(object, placed);
  }

  /** The events the wielder's graph raised (those it does not know it ignores). */
  hear(events: readonly string[]): void {
    const behavior = this.#object.skeleton.behavior;
    if (!behavior) return;
    for (const event of events) behavior.sendEvent(event);
  }

  /** A variable the engine set on the wielder's graph. */
  setVariable(name: string, value: number): void {
    this.#object.skeleton.behavior?.setVariable(name, value);
  }

  /** A variable's value in the weapon's graph (undefined: it has none so named). */
  variable(name: string): number | undefined {
    return this.#object.skeleton.behavior?.variable(name);
  }

  /** The weapon's pose: model-space matrices of its model's nodes. */
  get pose(): Float32Array {
    return this.#object.skeleton.pose.worlds;
  }

  /** The states its graph is in (machine and state names). */
  states(): { machine: string; state: string }[] {
    return this.#object.skeleton.behavior?.states() ?? [];
  }

  /**
   * Runs the graph on by `seconds` and places its moved nodes: each one's model-space matrix
   * under `hang` (the matrix of the node the model hangs on, in the space of `driven`) goes
   * into `driven` at its placed node.
   */
  update(seconds: number, hang: Float32Array, driven: Map<number, Float32Array>): void {
    const { pose, behavior } = this.#object.skeleton;
    if (!behavior) return;
    behavior.update(Math.max(0, Math.min(seconds, MAX_STEP)));
    // Its own events (BowDrawOut) were taken by its own transitions as it ran.
    behavior.takeRaised();
    pose.update(behavior.pose);
    const moved = this.#object.poseNodes;
    // The model's root is the node it hangs on: its children follow from there.
    for (let node = 1; node < moved.length; node++) {
      if ((moved[node] ?? -1) < 0) continue;
      const target = this.#placed[node] ?? -1;
      if (target < 0) continue;
      let world = driven.get(target);
      if (!world) {
        world = new Float32Array(16);
        driven.set(target, world);
      }
      multiply(hang, pose.worlds.subarray(node * 16, node * 16 + 16), world);
    }
  }
}
