// A cell's object as it is placed in the world: its model's instance (where it stands, whether it
// moves on its own matrix, the sequence a door or container plays, its running behavior graph and
// the skeleton that graph moves, the pose its hinged bodies give it), its graph's events going to
// its scripts. The viewers draw these instances; the headless simulation runs them undrawn. One
// rule for interiors, exteriors and the simulation alike.

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { skeletonEventsToScripts } from '../animation/script-graphs.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import { articulatedPose } from '../physics/articulation.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { GpuModel } from '../render/gpu-model.ts';
import type {
  GpuWaterType,
  InstanceVisibility,
  ModelInstance,
  PlacedDirectional,
} from '../render/scene-renderer.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { GameSession } from '../shell/game-session.ts';
import { clock, startObjectGraph, startPlacedSkeleton } from '../shell/object-graphs.ts';
import { openable } from '../shell/play-session.ts';

/** A placed object: its instance, the skeleton its graph moves, its hinged bodies' pose. */
export interface PlacedObject {
  readonly object: CellObject;
  readonly instance: ModelInstance;
  readonly skeleton?: AnimatedSkeleton;
  readonly articulated?: ActorPose;
}

/** What an object is placed with: its model, collision, water type and directional material. */
export interface ObjectParts {
  readonly model: GpuModel;
  readonly collision: CollisionData | undefined;
  readonly water?: GpuWaterType | undefined;
  readonly directional?: PlacedDirectional | undefined;
}

export interface PlaceOptions {
  /**
   * The object is in the played world (physics runs): a door or container plays its open and
   * close sequences from its state in the running game.
   */
  readonly simulated: boolean;
  /** Its shown state (hidden while disabled). */
  readonly visibility?: InstanceVisibility;
  /** A pose of its own where nothing else poses it (a tree swaying in the wind). */
  readonly sway?: (
    model: GpuModel,
    object: CellObject,
  ) => { readonly pose: ActorPose; readonly poseNodes: Int16Array } | undefined;
}

/** Places a cell's object with its model (see the file's comment). */
export function placeObject(
  session: GameSession,
  object: CellObject,
  parts: ObjectParts,
  options: PlaceOptions,
): PlacedObject {
  const { model, collision, water, directional } = parts;
  const graph = startObjectGraph(model, object.reference);
  // A loaded save's graph: in the state it was saved in (a lever pulled stays down).
  const saved = options.simulated ? session.restoring?.takeGraph(object.reference) : undefined;
  if (graph && saved?.sequences) graph.restoreState(saved.sequences, clock());
  // The events its sequences raise reach its scripts (OnAnimationEvent).
  if (graph)
    graph.onEvent = (event) => session.scriptsReady?.animationEvent(object.reference, event);
  const skeletal = startPlacedSkeleton(model, object.reference);
  if (saved?.skeleton) skeletal?.skeleton.behavior?.restoreState(saved.skeleton);
  if (skeletal) {
    skeletonEventsToScripts(skeletal.skeleton, (event) =>
      session.scriptsReady?.animationEvent(object.reference, event),
    );
  }
  // Bodies that move nodes one by one pose the model (ragdolls, hinged signs); objects
  // simulated as one body get a matrix of their own.
  const articulated = skeletal ? undefined : articulatedPose(model.nodes, collision);
  const moves =
    !articulated &&
    collision?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom) === true;
  const posed = skeletal
    ? { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }
    : (articulated ?? options.sway?.(model, object));
  const visibility = options.visibility;
  return {
    object,
    ...(skeletal && { skeleton: skeletal.skeleton }),
    ...(articulated && { articulated: articulated.pose }),
    instance: {
      model,
      world: moves ? new Float32Array(object.world) : object.world,
      ...(moves && { motion: { version: 0 } }),
      ...(visibility && { visibility }),
      ...(graph && { graph }),
      ...(posed && { pose: posed.pose, poseNodes: posed.poseNodes }),
      ...(options.simulated && {
        playback: openable(
          object,
          model.sequences?.byName.has('open') === true,
          session.scriptsReady?.state.references.get(object.reference)?.openState,
        ),
      }),
      ...(water && { water }),
      ...(directional && { directional }),
      ...(object.leafAnimation && { leafAnimation: object.leafAnimation }),
      ...(object.emittance !== undefined && {
        emittance: session.emittance(object.emittance),
      }),
    },
  };
}
