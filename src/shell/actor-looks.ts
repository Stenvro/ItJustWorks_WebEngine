// Where the actors of the loaded area look, and the world their graphs' procedural modifiers
// see (docs/animation.md, "Head tracking" and "Procedural modifiers"). Every frame, before
// their graphs run, each living actor's head track target is chosen (src/ai/head-tracking.ts:
// what scripts, scenes, dialogue and AI asked through ScriptWorld.lookTargets, the player it
// talks with, else the player near it and in front of it), eased at the head tracking speed,
// and given to its graph as the engine's channels do: bHeadTracking and TargetLocation (the
// BSLookAtModifier's), camerafromx/y/z. Its graph gets its place in the world and the ground
// under its feet (foot IK's rays, its own controller left out).

import {
  HEAD_TRACK_KINDS,
  HEAD_TRACK_SETTINGS,
  HeadTracker,
  noticesPlayer,
  VANILLA_HEAD_TRACK,
  type HeadTrackKind,
  type HeadTrackSettings,
  type LookTarget,
  type Vec3,
} from '../ai/head-tracking.ts';
import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { seededRandom } from '../world/actors.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import { headPosition } from './actors.ts';
import type { GameSession } from './game-session.ts';

/** The world the looks are found in: its rays, the player's eyes. */
export interface LooksWorld {
  readonly physics: PhysicsWorld;
  readonly player?: { readonly eye: Vec3 };
}

export interface ActorLooksOptions {
  readonly session: GameSession;
  readonly movers: ActorMovers;
  /** Where the camera is (the graphs' camerafromx/y/z). */
  readonly camera: () => { readonly position: Vec3 } | undefined;
  /** A staged actor by its reference (looked at by others: its head). */
  readonly actor: (reference: number) => StagedActor | undefined;
  /**
   * The point an actor's graph watches it fly past (BSPassByTargetTriggerModifier: a dragon's
   * combat target; src/shell/actor-flight.ts), if any.
   */
  readonly passByTarget?: (reference: number) => Vec3 | undefined;
}

export class ActorLooks {
  readonly #options: ActorLooksOptions;
  #world: LooksWorld | undefined;
  #settings: HeadTrackSettings = VANILLA_HEAD_TRACK;
  #settingsAsked = false;
  readonly #trackers = new Map<number, HeadTracker>();
  /** The graphs given their world (and the engine's foot IK switch) already. */
  readonly #prepared = new WeakSet<BehaviorRuntime>();

  constructor(options: ActorLooksOptions) {
    this.#options = options;
  }

  attach(world: LooksWorld | undefined): void {
    this.#world = world;
  }

  remove(reference: number): void {
    this.#trackers.delete(reference);
  }

  /** Before the actors' graphs run (real seconds since the last frame). */
  frame(actors: Iterable<StagedActor>, dt: number): void {
    if (!this.#settingsAsked) {
      this.#settingsAsked = true;
      void this.#readSettings().catch(() => undefined);
    }
    const camera = this.#options.camera()?.position;
    for (const staged of actors) {
      const behavior = staged.placed.behavior;
      if (staged.dead || staged.visibility.hidden || !behavior) continue;
      this.#prepare(staged, behavior);
      if (camera) {
        behavior.setVariable('camerafromx', camera[0]);
        behavior.setVariable('camerafromy', camera[1]);
        behavior.setVariable('camerafromz', camera[2]);
      }
      const aim = this.#aim(staged, behavior, dt);
      behavior.setVariable('bHeadTracking', aim ? 1 : 0);
      if (aim) behavior.setVector('TargetLocation', [aim[0], aim[1], aim[2], 0]);
    }
  }

  /** The point an actor's look-at aims at now, or undefined if it looks at nothing. */
  #aim(staged: StagedActor, behavior: BehaviorRuntime, dt: number): Vec3 | undefined {
    const reference = staged.reference;
    let tracker = this.#trackers.get(reference);
    if (!tracker) {
      tracker = new HeadTracker(seededRandom(reference ^ 0x1b873593));
      this.#trackers.set(reference, tracker);
    }
    const head = headPosition(staged.placed);
    const heading = staged.heading;
    const forward: Vec3 = [Math.sin(heading), Math.cos(heading), 0];
    const allowed =
      this.#options.session.scriptWorld.lookTargets.headTracking(reference) &&
      behavior.headTrackingAllowed;
    const chosen = allowed ? this.#target(staged, head) : undefined;
    const point = chosen && this.#point(chosen.target);
    return tracker.update(dt, head, forward, point, this.#settings, chosen?.kind === 'dialogue');
  }

  /**
   * What an actor looks at: the highest kind asked for (ScriptWorld.lookTargets), the player
   * it talks with (dialogue), else the player near it and in front of it (default).
   */
  #target(
    staged: StagedActor,
    head: Vec3,
  ): { readonly target: LookTarget; readonly kind: HeadTrackKind } | undefined {
    const session = this.#options.session;
    const reference = staged.reference;
    let chosen = session.scriptWorld.lookTargets.target(reference);
    const rank = (kind: HeadTrackKind): number => HEAD_TRACK_KINDS.indexOf(kind);
    if (session.scriptsReady?.dialogueSpeaker === reference) {
      if (!chosen || rank(chosen.kind) < rank('dialogue'))
        chosen = { target: PLAYER_REF, kind: 'dialogue' };
    }
    if (chosen) return chosen;
    const eye = this.#world?.player?.eye;
    return eye && noticesPlayer(head, staged.heading, eye)
      ? { target: PLAYER_REF, kind: 'default' }
      : undefined;
  }

  /** Where a look target is: the player's eyes, an actor's head, a reference, a point. */
  #point(target: LookTarget): Vec3 | undefined {
    if (typeof target !== 'number') return target;
    if (target === PLAYER_REF) return this.#world?.player?.eye;
    const other = this.#options.actor(target);
    if (other && !other.visibility.hidden) return headPosition(other.placed);
    return this.#options.session.scriptWorld.livePlacement(target)?.position;
  }

  /**
   * A graph seen for the first time: its place in the world (its instances' shared matrix)
   * and the ground under it for foot IK; the engine turns its humanoid foot IK on
   * (bHumanoidFootIKEnable; the graph turns it off in furniture). TODO(M13): when the engine
   * sets it is not documented.
   */
  #prepare(staged: StagedActor, behavior: BehaviorRuntime): void {
    if (this.#prepared.has(behavior)) return;
    const matrix = staged.placed.instances[0]?.world;
    if (!matrix) return;
    this.#prepared.add(behavior);
    behavior.setVariable('bHumanoidFootIKEnable', 1);
    const reference = staged.reference;
    const passBy = this.#options.passByTarget;
    behavior.world = {
      worldFromModel: matrix,
      get passByTarget() {
        return passBy?.(reference);
      },
      ground: (from, length) => {
        const physics = this.#world?.physics;
        if (!physics?.queriesCurrent) return undefined;
        const hit = physics.raycast(
          [from[0], from[1], from[2]],
          [0, 0, -1],
          length,
          Layer.charController,
          this.#options.movers.colliderOf(reference),
        );
        return hit && { point: hit.point, normal: hit.normal };
      },
    };
  }

  async #readSettings(): Promise<void> {
    const settings = await this.#options.session.settings();
    const read: Record<string, number> = {};
    for (const name of HEAD_TRACK_SETTINGS)
      read[name] = settings.number(name) ?? VANILLA_HEAD_TRACK[name];
    this.#settings = { ...VANILLA_HEAD_TRACK, ...read };
  }
}
