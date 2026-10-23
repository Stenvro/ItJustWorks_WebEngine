// Where the actors of the loaded area look, and the world their graphs' procedural modifiers
// see (docs/animation.md, "Head tracking" and "Procedural modifiers"). Every frame, before
// their graphs run, each living actor's head track target is chosen (src/ai/head-tracking.ts:
// what scripts, scenes, dialogue and AI asked through ScriptWorld.lookTargets, the player it
// talks with, else the player or another actor near it and in front of it that it chose every
// second or so: the story manager's Actor Hello as it turns to a new one), eased at the head
// tracking speed, and given to its graph as the engine's channels do: bHeadTracking and
// TargetLocation (the BSLookAtModifier's), camerafromx/y/z. Its graph gets its place in the
// world and the ground under its feet (foot IK's rays, its own controller left out).

import {
  chooseLookActor,
  HEAD_TRACK_KINDS,
  HEAD_TRACK_SETTINGS,
  HeadTracker,
  VANILLA_HEAD_TRACK,
  type HeadTrackKind,
  type HeadTrackSettings,
  type LookTarget,
  type Vec3,
} from '../ai/head-tracking.ts';
import { aiSettingsOf } from '../ai/ai-settings.ts';
import { RaceSize } from '../ai/race-combat-records.ts';
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
  /** Whether an actor detects another (src/shell/actor-senses.ts): it looks at the player only then. */
  readonly detects?: (observer: number, target: number) => boolean;
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
  /**
   * Each actor's choice of whom to look at when nothing else is asked of it (made every
   * fUpdateDelaySecondsMin–Max), the seconds to the next choice, and how long a new one is held
   * (fUpdateDelayNewTargetSecondsMin–Max).
   */
  readonly #choices = new Map<number, { wait: number; chosen: number | undefined; hold: number }>();
  /** The choices made this frame (at most iUpdateActorsPerFrame). */
  #chosenThisFrame = 0;
  /**
   * Each actor's script look's clock (seconds): held fAIStayonScriptHeadtrack, below 0 its own
   * look, at fAIRevertToScriptTracking the script's again.
   */
  readonly #scriptLooks = new Map<number, number>();
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
    this.#choices.delete(reference);
    this.#scriptLooks.delete(reference);
  }

  /** Before the actors' graphs run (real seconds since the last frame). */
  frame(actors: Iterable<StagedActor>, dt: number): void {
    if (!this.#settingsAsked) {
      this.#settingsAsked = true;
      void this.#readSettings().catch(() => undefined);
    }
    const camera = this.#options.camera()?.position;
    const all = [...actors];
    this.#chosenThisFrame = 0;
    for (const staged of all) {
      const behavior = staged.placed.behavior;
      if (staged.dead || staged.visibility.hidden || !behavior) continue;
      this.#prepare(staged, behavior);
      this.#choose(staged, all, dt);
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
    const chosen = allowed ? this.#target(staged, dt) : undefined;
    const point = chosen && this.#point(chosen.target);
    return tracker.update(dt, head, forward, point, this.#settings, chosen?.kind === 'dialogue');
  }

  /**
   * What an actor looks at: the highest kind asked for (ScriptWorld.lookTargets; a script's
   * not all the time), the player it talks with (dialogue), else whom it chose (default).
   */
  #target(
    staged: StagedActor,
    dt: number,
  ): { readonly target: LookTarget; readonly kind: HeadTrackKind } | undefined {
    const session = this.#options.session;
    const reference = staged.reference;
    let chosen = session.scriptWorld.lookTargets.target(reference);
    const rank = (kind: HeadTrackKind): number => HEAD_TRACK_KINDS.indexOf(kind);
    if (session.scriptsReady?.dialogueSpeaker === reference) {
      if (!chosen || rank(chosen.kind) < rank('dialogue'))
        chosen = { target: PLAYER_REF, kind: 'dialogue' };
    }
    if (chosen?.kind === 'script' && this.#restsFromScript(reference, dt)) chosen = undefined;
    else if (chosen?.kind !== 'script') this.#scriptLooks.delete(reference);
    if (chosen) return chosen;
    // Its own choice: the player (once it has detected them) or another actor.
    const other = this.#choices.get(reference)?.chosen;
    if (other === PLAYER_REF) {
      return this.#options.detects?.(reference, PLAYER_REF) !== false
        ? { target: PLAYER_REF, kind: 'default' }
        : undefined;
    }
    const seen = other === undefined ? undefined : this.#options.actor(other);
    return seen && !seen.dead && !seen.visibility.hidden
      ? { target: seen.reference, kind: 'default' }
      : undefined;
  }

  /**
   * A script's look is held fAIStayonScriptHeadtrack seconds; then the actor looks as it would
   * itself until fAIRevertToScriptTracking (below 0) is reached, and the script's look comes
   * back (observed in the original). Whether it rests from the script's look now.
   */
  #restsFromScript(reference: number, dt: number): boolean {
    const settings = aiSettingsOf(this.#options.session);
    let left = (this.#scriptLooks.get(reference) ?? settings.stayOnScriptHeadtrack) - dt;
    if (left < settings.revertToScriptTracking) left = settings.stayOnScriptHeadtrack;
    this.#scriptLooks.set(reference, left);
    return left < 0;
  }

  /** How far an actor looks at others by itself (an extra large race's farther). */
  #reaches(reference: number): { readonly others: number; readonly fromPlayer: number } {
    const settings = aiSettingsOf(this.#options.session);
    const large = this.#options.movers.raceSize(reference) === RaceSize.extraLarge;
    return large
      ? {
          others: settings.maxLargeCreatureHeadTrackDistance,
          fromPlayer: settings.maxLargeCreatureHeadTrackDistance,
        }
      : { others: settings.maxHeadTrackDistance, fromPlayer: settings.maxHeadTrackDistanceFromPC };
  }

  /**
   * Every fUpdateDelaySecondsMin–Max an actor chooses its own look (observed in the
   * original; at most iUpdateActorsPerFrame actors a frame, the others the next): only within
   * fAIMaxHeadTrackDistanceFromPC of the player (an extra large race:
   * fAIMaxLargeCreatureHeadTrackDistance), whom it detects within fAIMaxHeadTrackDistance and
   * 120° of its facing, the player as any other (chooseLookActor). A new one is kept
   * fUpdateDelayNewTargetSecondsMin–Max while it still may be looked at. Turning to another
   * actor than the one before is the story manager's Actor Hello (the dogs', soldiers' and
   * market's greetings), unless either is in a scene. TODO(M13): two more conditions of the
   * engine's on the actor are not read yet.
   */
  #choose(staged: StagedActor, all: readonly StagedActor[], dt: number): void {
    const reference = staged.reference;
    const ini = this.#options.session.ini;
    const min = ini.number('HeadTracking', 'fUpdateDelaySecondsMin');
    const max = ini.number('HeadTracking', 'fUpdateDelaySecondsMax');
    let choice = this.#choices.get(reference);
    if (!choice) {
      // The first choices spread over the interval (not all on one frame).
      choice = { wait: Math.random() * max, chosen: undefined, hold: 0 };
      this.#choices.set(reference, choice);
    }
    choice.wait -= dt;
    choice.hold -= dt;
    if (choice.wait > 0) return;
    if (this.#chosenThisFrame >= ini.number('HeadTracking', 'iUpdateActorsPerFrame')) return;
    this.#chosenThisFrame++;
    choice.wait = min + Math.random() * (max - min);
    const head = headPosition(staged.placed);
    const reach = this.#reaches(reference);
    const eye = this.#world?.player?.eye;
    const before = choice.chosen;
    let chosen: number | undefined;
    if (
      !eye ||
      Math.hypot(eye[0] - head[0], eye[1] - head[1], eye[2] - head[2]) <= reach.fromPlayer
    ) {
      const detects = this.#options.detects;
      const candidates = all
        .filter(
          (other) =>
            other !== staged &&
            !other.dead &&
            !other.visibility.hidden &&
            detects?.(reference, other.reference) !== false,
        )
        .map((other) => ({ reference: other.reference, head: headPosition(other.placed) }));
      if (eye && detects?.(reference, PLAYER_REF) !== false) {
        candidates.push({ reference: PLAYER_REF, head: eye });
      }
      // A new choice held a while stays while it still may be looked at.
      const kept =
        choice.hold > 0 && before !== undefined
          ? candidates.filter((candidate) => candidate.reference === before)
          : [];
      chosen =
        chooseLookActor(head, staged.heading, kept, reach.others) ??
        chooseLookActor(head, staged.heading, candidates, reach.others);
    }
    choice.chosen = chosen;
    if (chosen === undefined || chosen === before) return;
    choice.hold =
      ini.number('HeadTracking', 'fUpdateDelayNewTargetSecondsMin') +
      Math.random() *
        (ini.number('HeadTracking', 'fUpdateDelayNewTargetSecondsMax') -
          ini.number('HeadTracking', 'fUpdateDelayNewTargetSecondsMin'));
    if (chosen === PLAYER_REF) return;
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    if (runtime.scenes.sceneOf(reference) !== undefined) return;
    if (runtime.scenes.sceneOf(chosen) !== undefined) return;
    runtime.detach(runtime.storyEvents.actorHello(reference, chosen));
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
