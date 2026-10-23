// The engine's answers to the events actors' behavior graphs raise (docs/animation.md, "Graph
// events"): every placed actor's graph, the player's body and first-person arms dispatch what
// they raise here (src/animation/graph-events.ts), the response files pick each event's handler
// class for that actor (the player's list for the player), and the handler's implementation
// answers it. The systems implement theirs (combat's swings and hits, casting's SpellFire,
// furniture's enters and exits, mounts' ends); this module registers them all in one place and
// implements the handlers no system owns: the movement drive, death into the ragdoll, the
// camera's shake and animated cameras, the character's pitch and bumper, dialogue idle locks,
// summons, activation; animation objects go to their module, PickNewIdle to a hook.

import {
  GraphEventDispatch,
  type GraphEvent,
  type GraphEventSource,
} from '../animation/graph-events.ts';
import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { DRIVE_HANDLERS } from '../ai/movement-drive.ts';
import { COMBAT_HANDLERS } from '../gameplay/combat/combat-state.ts';
import { multiply, type Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { placedActorSounds, type GaitMotion, type SoundingWorld } from './actor-sounds.ts';
import {
  FURNITURE_ENTER_HANDLERS,
  FURNITURE_EXIT_HANDLERS,
  type FurnitureUser,
} from './actor-furniture.ts';
import type { ActorStage, StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerAvatar } from './player-avatar.ts';
import type { PlayerFurniture } from './player-furniture.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

/** The graph that raised events: whose they are, and which of its graphs. */
export interface ActorGraphSource extends GraphEventSource {
  /** The skeleton whose graph raised them (an actor's body; the player's first-person arms). */
  readonly skeleton: AnimatedSkeleton;
  /** The player's first-person graph. */
  readonly firstPerson: boolean;
}

export interface ActorGraphEventsOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly stage: ActorStage;
  readonly sounding: SoundingWorld;
  readonly gait: (reference: number) => GaitMotion | undefined;
  readonly player?: () => PlayerView | undefined;
  readonly seat?: () => PlayerFurniture | undefined;
}

/**
 * A dying actor whose graph plays its death (DeathAnim): its ragdoll joins the world as the
 * graph adds it (AddRagdollToWorld), driven by the graph's pose while the graph keyframes or
 * powers it, limp after.
 */
interface Dying {
  readonly staged: StagedActor;
  phase: 'animating' | 'driven';
  /** Seconds since it died. */
  since: number;
  /** Its Death line waits for its graph's DeathEmote (until then, or DEATH_EMOTE_WAIT). */
  cry: (() => void) | undefined;
  /**
   * The graph's active states as its death idle was sent (undefined: checked, or a killmove's):
   * a graph whose states did not change by DEATH_TAKEN did not take it.
   */
  before: string | undefined;
}

/**
 * A death whose graph never adds its ragdoll, or never lets it go (still keyframing or powering
 * it), goes limp this long after it began (seconds; a killmove's victim's clip lasts a few).
 * TODO(M13): what the engine does with a graph that never raises AddRagdollToWorld or deathStop,
 * or keeps its ragdoll driven.
 */
const DEATH_WAIT = 8;
/**
 * A death idle its graph names but does not take (no active state answers it: a cow's
 * DeathAnimation while it grazes) leaves its states as they were: after this long the body is
 * let go (seconds). The engine's graphs report an event no active node takes as not handled.
 */
const DEATH_TAKEN = 0.3;
/** A death cry waiting for its graph's DeathEmote is said after this at the latest (seconds). */
const DEATH_EMOTE_WAIT = 2;
/** The engine's death actions (AACT), as the idle tree has them: creatures', then humans'. */
const DEATH_ACTIONS = ['ActionDeath', 'ActionDeathWait'] as const;
/** The events a death idle sends that drop the actor as a ragdoll at once. */
const RAGDOLL_EVENTS = new Set(['ragdoll', 'ragdollinstant']);
/** An NPC's activation waits this long for its graph's ActivationDone at most (seconds). */
const ACTIVATION_WAIT = 3;

export class ActorGraphEvents {
  readonly dispatch = new GraphEventDispatch<ActorGraphSource>();
  readonly #options: ActorGraphEventsOptions;
  readonly #sounds = new WeakMap<AnimatedSkeleton, (events: readonly GraphEvent[]) => void>();
  readonly #dying = new Map<number, Dying>();
  /** Actors whose graph locked dialogue idles (IdleDialogueLock), with the idle held back. */
  readonly #dialogueLocked = new Map<number, (() => void) | undefined>();
  /** Actors whose character pitch the graph enabled (EnableCharacterPitch). */
  readonly #pitch = new Set<number>();
  /** Actors whose bumper the graph disabled (DisableBumper). */
  readonly #noBumper = new Set<number>();
  /** NPCs waiting for their graph's ActivationDone, with what it activates. */
  readonly #activations = new Map<number, { done: () => void; wait: number }>();
  /** The nodes the graphs attached actors to (NPCAttach's payload), by actor. */
  readonly #attached = new Map<number, string | undefined>();

  constructor(options: ActorGraphEventsOptions) {
    this.#options = options;
    void options.session.animation.animationData().then(
      (library) => {
        this.dispatch.setResponses(library.actorResponses, library.playerResponses);
      },
      (error: unknown) => {
        options.terminal.log('actor', `the animation responses: ${describe(error)}`, 'warn');
        this.dispatch.setResponses(undefined, undefined);
      },
    );
    this.#register();
  }

  // --- Sources -----------------------------------------------------------------------------------

  /** An actor placed on the stage: its graph's events come here, its sounds play by them. */
  attach(staged: StagedActor): void {
    const placed = staged.placed;
    const reference = staged.reference;
    this.#sounds.set(placed, placedActorSounds(placed, this.#options.sounding, this.#options.gait));
    const source: ActorGraphSource = {
      reference,
      player: false,
      firstPerson: false,
      skeleton: placed,
    };
    placed.onEvents = (events) => {
      this.dispatch.dispatch(source, events);
    };
    placed.onScriptEvents = undefined;
  }

  /** The player's graphs' events (their body's; their first-person arms', firstPerson). */
  player(avatar: PlayerAvatar, events: readonly GraphEvent[], firstPerson: boolean): void {
    const skeleton = firstPerson ? avatar.firstPerson : avatar.body;
    if (!skeleton) return;
    this.dispatch.dispatch({ reference: PLAYER_REF, player: true, firstPerson, skeleton }, events);
  }

  // --- The handlers, in one place ----------------------------------------------------------------

  #register(): void {
    const { stage } = this.#options;
    const d = this.dispatch;
    // Everything an actor's graph raises: its sounds (SoundPlay, footsteps), its scripts
    // (OnAnimationEvent, by the event's name as the graph has it), the systems that follow its
    // events by name (flight states, a get-up, a ride's paired end, a cart's rider, a held
    // weapon's own graph, the casting art), the animation objects (their unload events: the
    // reference's own event sink in the engine).
    d.listen((source, events) => {
      if (!source.player) this.#sounds.get(source.skeleton)?.(events);
      if (!source.firstPerson) {
        const runtime = this.#options.session.scriptsReady;
        for (const event of events) runtime?.animationEvent(source.reference, event.text);
      }
      stage.combat.heard(source, events);
      stage.casting.graphEvents(source, events);
      stage.flight.graphEvents(source, events);
      stage.knockdowns.graphEvents(source, events);
      stage.mounts.graphEvents(source, events);
      const graph = source.skeleton.behavior;
      if (graph && !source.firstPerson) stage.vehicles.riderEvents(source.reference, graph, events);
      stage.animObjects.graphEvents(
        source.reference,
        events.map((event) => event.name),
      );
    });
    // Events the response files name no handler for are the actor's own (WeapEquip_Out,
    // blockStop, bowEnd: the combat state's).
    d.otherwise((source, event) => {
      stage.combat.graphEvent(source, event, undefined);
    });
    // Combat: swings, hits, the attack's windows, the bow, draws and sheathes, staggers,
    // recoils, paired ends, killmoves.
    for (const handler of COMBAT_HANDLERS) {
      d.handle(handler, (source, event) => {
        stage.combat.graphEvent(source, event, handler);
      });
    }
    // KillActor (an execution's chop, a killmove's victim): the actor dies, by its killmove's
    // leader if it has one.
    d.handle('KillActorHandler', (source) => {
      if (source.firstPerson) return;
      const runtime = this.#options.session.scriptsReady;
      void runtime?.actors.kill(source.reference, stage.combat.killerOf(source.reference));
    });
    // Decapitate (an execution's chop): the actor's head comes off
    // (src/shell/actor-dismemberment.ts; a killmove's victim hears its killer's 2_Decapitate).
    d.handle('DecapitateHandler', (source) => {
      if (!source.firstPerson) void stage.dismemberment.decapitate(source.reference);
    });
    // Casting: the hands' SpellFire, the voice's (shouts) and its start, interrupts.
    d.handle('LeftHandSpellFireHandler', (source) => {
      stage.casting.spellFire(source, 'left');
    });
    d.handle('RightHandSpellFireHandler', (source) => {
      stage.casting.spellFire(source, 'right');
    });
    d.handle('VoiceSpellFireHandler', (source) => {
      stage.casting.voiceFire(source);
    });
    d.handle('VoiceSpellCastHandler', (source) => {
      stage.casting.voiceCast(source);
    });
    d.handle('InterruptCastHandler', (source) => {
      if (!source.firstPerson) stage.casting.interruptCast(source.reference);
    });
    // Furniture: the graph reached its furniture's state, or left it.
    for (const handler of FURNITURE_ENTER_HANDLERS) {
      d.handle(handler, (source) => {
        const user = this.#user(source);
        if (user) stage.furniture.graphEntered(user);
      });
    }
    for (const handler of FURNITURE_EXIT_HANDLERS) {
      d.handle(handler, (source) => {
        const user = this.#user(source);
        if (user) stage.furniture.graphExit(user, handler);
      });
    }
    // Mounts: the paired mount or dismount ended.
    d.handle('MountDismountEndHandler', (source) => {
      if (!source.firstPerson) stage.mounts.mountDismountEnd(source.reference);
    });
    // Head tracking: the graph's runtime answers HeadTrackingOn and HeadTrackingOff itself
    // (BehaviorRuntime.headTrackingAllowed).
    d.handle('HeadTrackingOnHandler', () => undefined);
    d.handle('HeadTrackingOffHandler', () => undefined);
    // The movement drive (StartAnimationDriven, StartMotionDriven, StartAllowRotation): the
    // movement controller switches at once.
    for (const [handler, drive] of Object.entries(DRIVE_HANDLERS)) {
      d.handle(handler, (source) => {
        if (!source.player) stage.movers.setDrive(source.reference, drive);
      });
    }
    // Death into the ragdoll.
    d.handle('AddRagdollHandler', (source) => {
      this.#addRagdoll(source.reference);
    });
    d.handle('RemoveRagdollHandler', (source) => {
      this.#removeRagdoll(source.reference);
    });
    d.handle('DeathStopHandler', (source) => {
      this.#deathStop(source.reference);
    });
    d.handle('DeathEmoteHandler', (source) => {
      this.#deathEmote(source.reference);
    });
    // The camera's shake: the event's payload is its strength, from the actor's place.
    d.handle('CameraShakeHandler', (source, event) => {
      const strength = Number.parseFloat(event.payload ?? '');
      if (!(strength > 0)) return;
      const at = this.#placeOf(source.reference);
      if (at) this.shakeCamera(strength, at);
    });
    // The player's camera: animated cameras, pitch.
    d.handle('AnimatedCameraStartHandler', (source, event) => {
      this.#animatedCamera(source, event.payload, false);
    });
    d.handle('AnimatedCameraDeltaStartHandler', (source, event) => {
      this.#animatedCamera(source, event.payload, true);
    });
    d.handle('AnimatedCameraEndHandler', (source) => {
      if (source.player) this.#camera()?.endAnimatedCamera();
    });
    d.handle('PitchOverrideStartHandler', (source) => {
      if (source.player) this.#camera()?.setPitchOverride(true);
    });
    d.handle('PitchOverrideEndHandler', (source) => {
      if (source.player) this.#camera()?.setPitchOverride(false);
    });
    d.handle('ZeroPitchHandler', (source) => {
      if (source.player) this.#camera()?.zeroPitch();
    });
    // The character controller's pitch and bumper.
    d.handle('EnableCharacterPitchHandler', (source) => {
      this.#pitch.add(source.reference);
    });
    d.handle('DisableCharacterPitchHandler', (source) => {
      this.#pitch.delete(source.reference);
    });
    d.handle('EnableCharacterBumperHandler', (source) => {
      this.#noBumper.delete(source.reference);
    });
    d.handle('DisableCharacterBumperHandler', (source) => {
      this.#noBumper.add(source.reference);
    });
    // Dialogue idles held while the graph plays an idle that must not be interrupted.
    d.handle('IdleDialogueEnterHandler', (source) => {
      if (!this.#dialogueLocked.has(source.reference))
        this.#dialogueLocked.set(source.reference, undefined);
    });
    d.handle('IdleDialogueExitHandler', (source) => {
      const held = this.#dialogueLocked.get(source.reference);
      this.#dialogueLocked.delete(source.reference);
      held?.();
    });
    // A summoned creature's arrival played out: it fights its summoner's foe.
    d.handle('EndSummonAnimationHandler', (source) => {
      this.#summoned(source.reference);
    });
    // An NPC's activation (ActionActivate's idle) reached its moment.
    d.handle('ActionActivateDoneHandler', (source) => {
      const waiting = this.#activations.get(source.reference);
      this.#activations.delete(source.reference);
      waiting?.done();
    });
    // A vampire's feeding ended: the feeding procedure is done.
    d.handle('VampireFeedEndHandler', (source) => {
      // TODO(M11): observed in the original, an actor running a vampire feeding package
      // procedure is done with it here; our AI runs no feeding procedure yet (the player's
      // feeding is the combat's paired idle, which its own end ends).
      this.#options.terminal.log(
        'actor',
        `${source.reference.toString(16)}: VampireFeedEnd (no feeding procedure runs)`,
        'info',
      );
    });
    // The graph attaches the actor to a node of the furniture it uses, or lets it go.
    d.handle('NPCAttachHandler', (source, event) => {
      // TODO(M13): observed in the original, the actor is attached to the named node (the
      // payload) of its furniture's 3D and moves with it; our furniture keeps its markers, not
      // its animated nodes, so the attachment is recorded and the actor stays at its marker.
      this.#attached.set(source.reference, event.payload);
    });
    d.handle('NPCDetachHandler', (source) => {
      this.#attached.delete(source.reference);
    });
    // Animation objects (ANIO: a tankard, a broom, a hammer) load to the hand or are drawn,
    // the object the payload names (src/shell/actor-anim-objects.ts).
    d.handle('AnimationObjectLoadHandler', (source, event) => {
      stage.animObjects.animObject(source.reference, 'load', event.payload);
    });
    d.handle('AnimationObjectDrawHandler', (source, event) => {
      stage.animObjects.animObject(source.reference, 'draw', event.payload);
    });
    // Ambient idles: the graph asks for a new idle.
    d.handle('PickNewIdleHandler', (source) => {
      stage.pickNewIdle?.(source.reference);
    });
  }

  /** Who uses furniture for a graph's furniture handler (the player's seat for the player). */
  #user(source: ActorGraphSource): FurnitureUser | undefined {
    if (source.firstPerson) return undefined;
    if (source.player) return this.#options.seat?.()?.user;
    const staged = this.#options.stage.get(source.reference);
    return staged && this.#options.stage.userOf(staged);
  }

  #placeOf(reference: number): Vec3 | undefined {
    if (reference === PLAYER_REF) return this.#options.player?.()?.play.player.feet;
    return this.#options.stage.get(reference)?.position;
  }

  #camera(): PlayerView['play']['player'] | undefined {
    return this.#options.player?.()?.play.player;
  }

  // --- The camera --------------------------------------------------------------------------------

  /**
   * The camera shakes from a place (a stomp, Game.ShakeCamera, a shout): its strength there by
   * its distance from the camera (src/shell/camera-shake.ts).
   */
  shakeCamera(strength: number, at: Vec3, seconds?: number): void {
    const camera = this.#camera();
    if (!camera) return;
    const [x, y, z] = camera.position;
    camera.shake.start(strength, Math.hypot(at[0] - x, at[1] - y, at[2] - z), seconds);
  }

  /** Game.ShakeCamera's source (none: the player). */
  shakeCameraFrom(strength: number, seconds: number, source: number | undefined): void {
    const at = this.#placeOf(source ?? PLAYER_REF);
    if (at) this.shakeCamera(strength, at, seconds);
  }

  /**
   * StartAnimatedCamera and StartAnimatedCameraDelta (the player's graph: a werewolf's change,
   * a dragon's mount): observed in the original, the node the payload names in the
   * player's third-person body is looked for; without the delta the camera goes over
   * (iAnimatedTransitionMillis) to an animated camera that rides that node; with it, the
   * third-person camera adds the node's motion. Not in the camera states that refuse it.
   */
  #animatedCamera(source: ActorGraphSource, node: string | undefined, delta: boolean): void {
    if (!source.player || node === undefined) return;
    const view = this.#options.player?.();
    const body = view?.avatar?.body;
    if (!view || !body) return;
    const world = (): Float32Array | undefined => {
      const local = body.pose.world(node);
      const placement = body.instances[0]?.world;
      return local && placement ? multiply(placement, local, new Float32Array(16)) : undefined;
    };
    if (!world()) return;
    const millis = this.#options.session.ini.number('Camera', 'iAnimatedTransitionMillis');
    view.play.player.startAnimatedCamera({
      node: world,
      delta,
      transition: millis / 1000,
    });
  }

  // --- Death -------------------------------------------------------------------------------------

  /**
   * An actor died (the stage's killed): its death plays through the idle tree, as the engine's
   * death actions do (ActionDeath, else the humans' ActionDeathWait: the ragdoll at once for
   * some, DeathAnim for the others). A death idle that drops it (Ragdoll), or none, lets its
   * ragdoll go at once; an animated death keeps its body on its graph until the graph adds the
   * ragdoll (AddRagdollToWorld). Its Death line is said now, unless its graph has a DeathEmote
   * to say it by. A killmove's victim dies in its paired clip.
   */
  async died(staged: StagedActor, killer: number | undefined, silent: boolean): Promise<void> {
    const { stage } = this.#options;
    const reference = staged.reference;
    const cry = silent
      ? undefined
      : (): void => {
          stage.talk
            .bark(reference, 'Death', killer ?? PLAYER_REF, { interrupt: true })
            .catch((error: unknown) => {
              this.#options.terminal.log('actor', `a death cry: ${describe(error)}`, 'warn');
            });
        };
    const graph = staged.placed.behavior;
    const knocked = stage.bodies.knocked(reference);
    const paired = stage.combat.paired(reference);
    let event: string | undefined;
    const before = graph && !paired ? statesOf(graph) : undefined;
    if (graph && !knocked && !paired) {
      const user = stage.userOf(staged);
      // The idles' conditions on their target ask the killer (what it holds: a bow, a staff,
      // magic drop the dead as a ragdoll); without one, conditions on a target fail.
      // TODO(M13): the engine's target for the death actions is inferred (the killer).
      const runtime = this.#options.session.scriptsReady;
      const target = killer === undefined || !runtime ? undefined : runtime.referenceHandle(killer);
      for (const action of DEATH_ACTIONS) {
        event = await stage.furniture.actionEvent(user, action, target);
        if (event !== undefined) break;
      }
    }
    if (stage.get(reference) !== staged) return;
    const animated =
      graph !== undefined &&
      (paired || (event !== undefined && !RAGDOLL_EVENTS.has(event.toLowerCase())));
    if (!animated) {
      void stage.bodies.kill(staged);
      cry?.();
      return;
    }
    const waitsForEmote = graph.declares('DeathEmote');
    this.#dying.set(reference, {
      staged,
      phase: 'animating',
      since: 0,
      cry: waitsForEmote ? cry : undefined,
      before,
    });
    if (!waitsForEmote) cry?.();
  }

  /**
   * AddRagdollToWorld (the engine's AddRagdollHandler): observed in the original, the
   * actor's ragdoll joins the physics world, driven by its graph where [Animation]
   * bDriveRagdollWithGraph says so. Driven, its bodies follow the graph's pose while the graph
   * keyframes or powers them (its AnimateToRagdoll state), and are let go once it does
   * neither (FullyRagdoll); undriven they are let go at once.
   */
  #addRagdoll(reference: number): void {
    const dying = this.#dying.get(reference);
    if (!dying) return;
    const driven = this.#options.session.ini.number('Animation', 'bDriveRagdollWithGraph') !== 0;
    if (driven) dying.phase = 'driven';
    else this.#limp(dying);
  }

  /** RemoveRagdollFromWorld: the ragdoll leaves the world; a dying body follows its graph again. */
  #removeRagdoll(reference: number): void {
    const dying = this.#dying.get(reference);
    if (dying) dying.phase = 'animating';
  }

  /**
   * deathStop (the engine's DeathStopHandler): observed in the original, the actor's
   * dying ends (it is dead: KillDying). Its body lies as its ragdoll from where it is.
   */
  #deathStop(reference: number): void {
    const dying = this.#dying.get(reference);
    if (dying) this.#limp(dying);
  }

  /**
   * DeathEmote (the engine's DeathEmoteHandler): observed in the original, the actor's
   * Death line (the combat dialogue's Death subtype) is queued, once a death.
   */
  #deathEmote(reference: number): void {
    const dying = this.#dying.get(reference);
    const cry = dying?.cry;
    if (!dying || !cry) return;
    dying.cry = undefined;
    cry();
  }

  #limp(dying: Dying): void {
    const reference = dying.staged.reference;
    this.#dying.delete(reference);
    dying.cry?.();
    void this.#options.stage.bodies.kill(dying.staged);
  }

  // --- Every frame -------------------------------------------------------------------------------

  /** Deaths go on (driven ragdolls let go, waits run out); activations wait. */
  frame(seconds: number): void {
    for (const dying of [...this.#dying.values()]) {
      const { staged } = dying;
      if (this.#options.stage.get(staged.reference) !== staged) {
        this.#dying.delete(staged.reference);
        continue;
      }
      dying.since += seconds;
      if (dying.cry && dying.since >= DEATH_EMOTE_WAIT) {
        const cry = dying.cry;
        dying.cry = undefined;
        cry();
      }
      const graph = staged.placed.behavior;
      if (dying.phase === 'driven') {
        const holds =
          graph !== undefined &&
          (graph.poweredRagdollForce() > 0 || graph.keyframedRagdollBones().size > 0);
        if (!holds || dying.since >= DEATH_WAIT) this.#limp(dying);
        continue;
      }
      if (dying.before !== undefined && dying.since >= DEATH_TAKEN) {
        const before = dying.before;
        dying.before = undefined;
        if (!graph || statesOf(graph) === before) {
          this.#limp(dying);
          continue;
        }
      }
      if (dying.since >= DEATH_WAIT) this.#limp(dying);
    }
    for (const [reference, waiting] of [...this.#activations]) {
      waiting.wait -= seconds;
      if (waiting.wait > 0) continue;
      this.#activations.delete(reference);
      waiting.done();
    }
  }

  /** Whether an actor dies by its graph now (its body still on its graph). */
  dying(reference: number): boolean {
    return this.#dying.has(reference);
  }

  /** An actor left the stage. */
  remove(reference: number): void {
    this.#dying.delete(reference);
    this.#dialogueLocked.delete(reference);
    this.#pitch.delete(reference);
    this.#noBumper.delete(reference);
    this.#attached.delete(reference);
    const waiting = this.#activations.get(reference);
    this.#activations.delete(reference);
    waiting?.done();
  }

  // --- Asked by others ---------------------------------------------------------------------------

  /**
   * A dialogue idle for an actor (a line's speaker or listener idle, ActionTalking's): while its
   * graph has locked dialogue idles (IdleDialogueLock) it is held, the last one played as the
   * graph unlocks them (the engine's IdleDialogueExitHandler plays the idle its process holds).
   * Whether it was held.
   */
  holdDialogueIdle(reference: number, play: () => void): boolean {
    if (!this.#dialogueLocked.has(reference)) return false;
    this.#dialogueLocked.set(reference, play);
    return true;
  }

  /**
   * An NPC activates something with an idle (ActionActivate gave one): the activation waits
   * for its graph's ActivationDone (the engine's ActionActivateDoneHandler activates the
   * object its process holds then), at most ACTIVATION_WAIT seconds.
   */
  activationDone(reference: number): Promise<void> {
    this.#activations.get(reference)?.done();
    return new Promise((resolve) => {
      this.#activations.set(reference, { done: resolve, wait: ACTIVATION_WAIT });
    });
  }

  /**
   * EnableCharacterPitch / DisableCharacterPitch: observed in the original, the actor's
   * character controller may pitch it (its pitch is zeroed as it is disabled).
   * TODO(M13): our character controllers keep actors upright; nothing reads this yet.
   */
  characterPitch(reference: number): boolean {
    return this.#pitch.has(reference);
  }

  /**
   * EnableBumper / DisableBumper: observed in the original, the actor's character
   * controller's bumper (what pushes it off others) is switched on or off.
   * TODO(M13): our character controllers have no bumper; nothing reads this yet.
   */
  bumper(reference: number): boolean {
    return !this.#noBumper.has(reference);
  }

  /**
   * summonStop (the engine's EndSummonAnimationHandler): observed in the original, a
   * summoned actor's arrival played out, it takes on its commander's combat target.
   */
  #summoned(reference: number): void {
    const runtime = this.#options.session.scriptsReady;
    const commander = runtime?.magic.commander(reference);
    if (commander === undefined) return;
    const target = this.#options.stage.combat.targetOf(commander);
    if (target !== undefined) this.#options.stage.combat.startCombat(reference, target);
  }
}

/** A graph's active states, as one text (to tell whether an event moved it). */
function statesOf(graph: { states(): { machine: string; state: string }[] }): string {
  return graph
    .states()
    .map((entry) => `${entry.machine}:${entry.state}`)
    .join('|');
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
