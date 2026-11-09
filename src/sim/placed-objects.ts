// A cell's object as it is placed in the world: its model's instance (where it stands, whether it
// moves on its own matrix, the sequence a door or container plays, its running behavior graph and
// the skeleton that graph moves, the pose its hinged bodies give it), its graph's events going to
// its scripts. The viewers draw these instances; the headless simulation runs them undrawn. One
// rule for interiors, exteriors and the simulation alike.

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { isEvent, soundPlayAt } from '../animation/graph-events.ts';
import { skeletonEventsToScripts, type SavedGraph } from '../animation/script-graphs.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import { articulatedPose } from '../physics/articulation.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { GpuModel } from '../render/gpu-model.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import { switchedVisibility } from '../render/switched-visibility.ts';
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
  /**
   * The trees' switch (the console's tt: Renderer.treeVisibility): a TREE reference is drawn only
   * while it is not hidden either.
   */
  readonly trees?: InstanceVisibility;
  /** A pose of its own where nothing else poses it (a tree swaying in the wind). */
  readonly sway?: (
    model: GpuModel,
    object: CellObject,
  ) => { readonly pose: ActorPose; readonly poseNodes: Int16Array } | undefined;
}

/** The animated state an object kept as its 3D unloaded (GameState.graphs), once. */
function takeUnloadedGraph(session: GameSession, object: CellObject): SavedGraph | undefined {
  const graphs = session.scriptsReady?.state.graphs;
  const graph = graphs?.get(object.reference);
  graphs?.delete(object.reference);
  // What was playing as it unloaded has played to its end by now: no times to go on from.
  if (!graph?.sequences) return graph;
  return {
    ...graph,
    sequences: { states: graph.sequences.states, variables: graph.sequences.variables },
  };
}

/**
 * An object graph's sounds (its clips' annotations): SoundPlay.<descriptor> at the object,
 * SoundPlayAt.<descriptor>.<node> at that node of its model as it moves (the sawmill's saw at
 * its blade), as the actors' animations sound theirs (src/shell/actor-sounds.ts).
 */
function objectSounds(session: GameSession, object: CellObject, skeleton: AnimatedSkeleton): void {
  const previous = skeleton.onEvents;
  const at = (node: string | undefined) => (): Vec3 => {
    const model = node === undefined ? undefined : skeleton.pose.world(node);
    const local: Vec3 = model ? [model[12] ?? 0, model[13] ?? 0, model[14] ?? 0] : [0, 0, 0];
    return transformPoint(object.world, local);
  };
  skeleton.onEvents = (events) => {
    previous?.(events);
    const sounds = session.soundSystem;
    if (!sounds) return;
    for (const event of events) {
      const placed = soundPlayAt(event);
      if (placed) {
        void sounds.playNamed(placed.descriptor, at(placed.node), object.reference);
      } else if (isEvent(event, 'SoundPlay') && event.payload !== undefined) {
        void sounds.playNamed(event.payload, at(undefined), object.reference);
      }
    }
  };
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
  // A loaded save's graph: in the state it was saved in (a lever pulled stays down); else the
  // state it had as its 3D last unloaded (a chest left open is open as its cell loads again).
  const saved = options.simulated
    ? (session.restoring?.takeGraph(object.reference) ?? takeUnloadedGraph(session, object))
    : undefined;
  if (graph && saved?.sequences) graph.restoreState(saved.sequences, clock());
  // An imported original save's, by names (the original keeps one state for either kind).
  if (graph && saved?.named) graph.restoreNamed(saved.named, clock());
  // The events its sequences raise reach its scripts (OnAnimationEvent).
  if (graph)
    graph.onEvent = (event) => session.scriptsReady?.animationEvent(object.reference, event);
  const skeletal = startPlacedSkeleton(model, object.reference);
  if (saved?.skeleton) skeletal?.skeleton.behavior?.restoreState(saved.skeleton);
  if (saved?.named) {
    skeletal?.skeleton.behavior?.restoreActorState({
      files: [],
      variables: [],
      named: saved.named,
    });
  }
  if (skeletal) {
    skeletonEventsToScripts(skeletal.skeleton, (event) =>
      session.scriptsReady?.animationEvent(object.reference, event),
    );
    objectSounds(session, object, skeletal.skeleton);
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
  const visibility =
    object.baseType === 'TREE' && options.trees
      ? switchedVisibility(options.visibility, options.trees)
      : options.visibility;
  return {
    object,
    ...(skeletal && { skeleton: skeletal.skeleton }),
    ...(articulated && { articulated: articulated.pose }),
    instance: {
      model,
      world: moves ? new Float32Array(object.world) : object.world,
      ...(moves && { motion: { version: 0 } }),
      ...(visibility && { visibility }),
      ...(object.fade && { fade: { kind: object.fade } }),
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
      ...(object.reflectedByWater === true && { reflected: true }),
    },
  };
}
