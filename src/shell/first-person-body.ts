// The player's first-person body (docs/animation.md, "First person"): the first-person
// skeleton (meshes\actors\character\_1stperson\skeleton.nif) running the first-person graph,
// whose animated Camera1st node the first-person camera rides, and on it the arms the player
// sees: the first-person models of what they wear (ARMA MOD4 / MOD5: the skin's hands, a
// cuirass's sleeves, gauntlets, a shield), dressed as the world models are. The weapons in its
// hands are combat's (src/shell/actor-weapons.ts, on this pose). It stands on the player's
// feet facing their way, turned about the camera by the view's pitch, so the arms stay in
// view as the player looks up and down. What it wears there: the pieces in its race's
// first-person slots, a piece without a first-person model in its world model (docs/
// animation.md, "First person"). Game.ShowFirstPersonGeometry hides it (the beast
// forms, the carriage ride: src/shell/world-viewer.ts draws it only in first person).
// TODO(M13): the engine draws first-person geometry in a pass of its own (its own near plane
// and field of view, over the world); here it shares the view's camera.

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import type { GraphEvent } from '../animation/graph-events.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import type { HkxSkeleton } from '../formats/hkx/animation.ts';
import { firstPersonMatrix } from '../render/first-person-placement.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import { partitionVisible, seededRandom, type ActorLook } from '../world/actors.ts';
import { FIRST_PERSON_SKELETON } from '../world/player-body.ts';
import type { GameSession } from './game-session.ts';

/** The first-person behavior project (the engine's own path). */
const FIRST_PERSON_PROJECT = 'meshes\\actors\\character\\_1stperson\\firstperson.hkx';
/** The node the first-person camera rides. */
export const CAMERA_NODE = 'Camera1st [Cam1]';
/** The Player reference (its graph's random seed). */
const PLAYER_REFERENCE = 0x14;

/** The skeleton the graph moves; its pose is made again as the arms are dressed anew. */
interface Skeleton {
  pose: ActorPose;
  readonly behavior: BehaviorRuntime;
  time: number | undefined;
  onEvents?: (events: readonly GraphEvent[]) => void;
  onScriptEvents?: (events: readonly GraphEvent[]) => void;
}

export class FirstPersonBody {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #rig: RigData;
  readonly #havok: HkxSkeleton;
  readonly #skeleton: Skeleton;
  #scene: GpuScene | undefined;
  /** The placement its instances (and the weapons in its hands) share. */
  readonly world = new Float32Array(16);
  readonly motion: InstanceMotion = { version: 0 };
  #dressing = 0;
  #destroyed = false;

  private constructor(
    session: GameSession,
    renderer: Renderer,
    rig: RigData,
    havok: HkxSkeleton,
    skeleton: Skeleton,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#rig = rig;
    this.#havok = havok;
    this.#skeleton = skeleton;
  }

  /** The first-person skeleton running the first-person graph of the sex (IsFemale). */
  static async create(
    session: GameSession,
    renderer: Renderer,
    female: boolean,
  ): Promise<FirstPersonBody | undefined> {
    const animation = session.animation;
    const behaviors = await animation.behaviors(FIRST_PERSON_PROJECT);
    const rigPath = behaviors?.character.rig;
    if (!behaviors || !rigPath) return undefined;
    const [rig, havok] = await Promise.all([
      session.loader.loadRig(FIRST_PERSON_SKELETON).catch(() => undefined),
      animation.havokSkeleton(rigPath),
    ]);
    if (!rig || !havok) return undefined;
    const host = animation.host(behaviors, female);
    const behavior = new BehaviorRuntime({
      root: behaviors.root,
      host,
      skeleton: havok,
      random: seededRandom(PLAYER_REFERENCE),
      properties: {
        ...behaviors.character.propertyValues,
        IsFemale: female ? 1 : 0,
        IsMale: female ? 0 : 1,
        IsPlayer: 1,
      },
      ...(behaviors.character.mirror && { mirror: behaviors.character.mirror }),
      defaultEventMode: behaviors.character.defaultEventMode,
    });
    behavior.update(0);
    await host.loaded();
    behavior.update(0);
    const pose = new ActorPose(new ActorSkeleton(rig, havok));
    pose.update(behavior.pose);
    return new FirstPersonBody(session, renderer, rig, havok, {
      pose,
      behavior,
      time: undefined,
    });
  }

  /** The skeleton its graph moves (its Camera1st node is the first-person camera). */
  get skeleton(): AnimatedSkeleton {
    return this.#skeleton;
  }

  /** The scene that draws the arms (undefined until dressed). */
  get scene(): GpuScene | undefined {
    return this.#destroyed ? undefined : this.#scene;
  }

  /** Where the weapons in its hands hang: its pose and placement. */
  get pose(): ActorPose {
    return this.#skeleton.pose;
  }

  /**
   * Dresses the arms in a look's first-person models (what it wears now); the latest look
   * asked for wins. The skeleton takes the nodes the models bring, as a body's does.
   */
  async dress(look: ActorLook): Promise<void> {
    const dressing = ++this.#dressing;
    const placer = await this.#session.actors();
    const made = (await placer.wornModels(look, true)).filter((entry) => entry !== undefined);
    if (dressing !== this.#dressing || this.#destroyed) return;
    const dressed = wearOnRig(
      this.#rig,
      made.map(({ model }) => ({ nodes: model.nodes ?? [], attachTo: model.attachTo })),
    );
    const pose = new ActorPose(new ActorSkeleton(dressed.rig, this.#havok));
    pose.update(this.#skeleton.behavior.pose);
    const tints = look.skinTone ? { skin: look.skinTone } : {};
    // A piece's partitions of slots another piece owns are hidden, as on the body (the
    // cuirass's bare forearms under gauntlets).
    const instances = made.map(({ model, addon }, i): ModelInstance => ({
      model,
      world: this.world,
      motion: this.motion,
      pose,
      ...(dressed.nodeMaps[i] && { poseNodes: dressed.nodeMaps[i] }),
      tints,
      partitionVisible: (bodyPart) => partitionVisible(bodyPart, look.owners, addon),
    }));
    const scene = instances.length > 0 ? this.#renderer.scene.createScene(instances) : undefined;
    this.#scene?.destroy();
    this.#scene = scene;
    this.#skeleton.pose = pose;
  }

  /**
   * Places it for the frame: on the feet, facing `yaw` (compass heading), at the race's
   * `scale`, turned about its camera node by the view's `pitch` (radians, up positive).
   */
  place(feet: Vec3, yaw: number, scale: number, pitch: number): void {
    const node = this.#skeleton.pose.world(CAMERA_NODE);
    firstPersonMatrix(
      this.world,
      feet,
      yaw,
      scale,
      node ? [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0] : [0, 0, 0],
      pitch,
    );
    this.motion.version++;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#scene?.destroy();
    this.#scene = undefined;
  }
}
