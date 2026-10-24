// The automated QA monitors in the running game (development builds only: engineDev.qa;
// docs/qa.md). They read the engine every frame while started and report anomalies (glides,
// animation chatter, bind poses, actors off the ground or stuck, jittering bodies, stalled
// scenes, error lines, long frames) with the actor, its graph's states and clips, where and
// when. Nothing of them runs until start(): no frame hook, no wrapped method.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { BehaviorRuntime } from '../../animation/behavior-runtime.ts';
import { HAVOK_SCALE } from '../../physics/collision-data.ts';
import { Layer } from '../../physics/collision-layers.ts';
import { AttackState, WeaponState } from '../../gameplay/combat/combat-state.ts';
import { ActorPose } from '../../animation/skeleton.ts';
import { FlyCamera } from '../../render/fly-camera.ts';
import type { Vec3 } from '../../render/math.ts';
import type { Renderer } from '../../render/renderer.ts';
import { PLAYER_REF } from '../../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../../scripting/runtime/runtime.ts';
import { playerTrigger } from '../../scripting/runtime/trigger-gates.ts';
import type { ActorStage, StagedActor } from '../actor-stage.ts';
import type { GameSession } from '../game-session.ts';
import { clock } from '../object-graphs.ts';
import type { Terminal, LogTone } from '../terminal.ts';
import type { PlaySession } from '../play-session.ts';
import type { PlayerFurniture } from '../player-furniture.ts';
import type { Player } from '../player.ts';
import type { PlayerView } from '../race-menu.ts';
import type { Menu } from '../../ui/menu-host.ts';
import { MenuTextWatch } from './menu-texts.ts';
import {
  AnomalyLog,
  BodyWatch,
  brokenBone,
  ClipWatch,
  CombatWatch,
  Episode,
  FrameStats,
  isLocomotionClip,
  isReferencePose,
  messageKey,
  RateWindow,
  sceneWait,
  SpeedMeter,
  StateWatch,
  TravelWatch,
  type AnomalyInput,
} from './detectors.ts';
import {
  DEFAULT_THRESHOLDS,
  type QaAnomaly,
  type QaSnapshot,
  type QaSubject,
  type QaThresholds,
} from './types.ts';

/** What the harness reads of the place played (WorldViewer and ModelViewer both have it). */
export interface QaWorld {
  readonly actorStage: ActorStage | undefined;
  readonly play: PlaySession | undefined;
  readonly player: Player | undefined;
  readonly playerView: PlayerView | undefined;
  readonly playerFurniture: PlayerFurniture | undefined;
  readonly loading: string | undefined;
}

/** What the harness reads the game through. */
export interface QaHost {
  /** The viewer of the place played (the world viewer outside, the model viewer in interiors). */
  readonly world: () => QaWorld | undefined;
  readonly session: () => GameSession | undefined;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  /** The menus open (the placeholder-text check reads their text fields). */
  readonly menus?: () => Iterable<Menu>;
}

export interface QaStartOptions {
  /** Thresholds to change (the rest keep their defaults: DEFAULT_THRESHOLDS). */
  readonly thresholds?: Partial<QaThresholds>;
  /** Quests whose stage must change within the seconds given (quest form id → seconds). */
  readonly watchQuests?: Readonly<Record<string, number>>;
  /** Anomalies kept per kind (the rest only counted). */
  readonly keep?: number;
  /**
   * Also report the log's warnings and errors from before the start (the page's boot: a new
   * game's or a coc's quest starts), at negative times.
   */
  readonly bootLog?: boolean;
}

/** A notable moment that is no anomaly (a quest stage, a scene's phase): the run's timeline. */
export interface QaEvent {
  readonly time: number;
  readonly text: string;
}

/**
 * How far from a stalled scene's actors a trigger volume may lie that it waits for the player
 * to walk into (game units: a cell; Riften's gate triggers lie 300 to 1,000 units from theirs).
 */
const TRIGGER_GATE_RADIUS = 4096;
/** A screenshot's camera stands at most this far from the anomaly (game units). */
const FRAME_DISTANCE = 260;
/** The subject of long frames (one, so they are kept as the worst of one kind). */
const FRAMES: QaSubject = { id: 'frames', name: 'frames', kind: 'log' };
/**
 * A corpse whose head is higher above its feet than this share of its standing head height
 * stands (for CORPSE_SECONDS).
 */
const CORPSE_UPRIGHT = 0.6;
const CORPSE_SECONDS = 5;
/** A corpse whose head comes up by this share of its standing head height rises. */
const CORPSE_RISE = 0.25;
/** …one that died with its head under this share of its standing height (seated, kneeling). */
const CORPSE_LOW = 0.75;
/**
 * The player's camera this far above or below their body's head (game units at race height 1)
 * for PLAYER_CAMERA_SECONDS is off it (the Camera1st node sits a few units from the head's).
 */
const PLAYER_CAMERA_GAP = 30;
const PLAYER_CAMERA_SECONDS = 5;
/** Doors this near an actor or a cart (game units, across) are checked for it going through. */
const DOOR_NEAR = 600;
/** The heights above an actor's feet (a cart's root) its way is followed at (game units). */
const DOOR_RAY_HEIGHTS = [40, 100];
/** One mover through one door counts once in this long (seconds). */
const DOOR_REPEAT = 10;
/** WEAPON_STATE drawn and ATTACK_STATE_ENUM bow drawn (src/gameplay/combat/combat-state.ts). */
const WEAPON_DRAWN = WeaponState.drawn;
const BOW_DRAWN = AttackState.bowDrawn;
/** A melee target this much beyond reach counts as within it (units: a step in). */
const MELEE_SLACK = 64;
/** A corpse's ragdoll with a body still awake this long (seconds) has not come to rest. */
const RESTLESS_SECONDS = 20;

/** A corpse's ragdoll as the detail says it: its bodies awake, asleep, keyframed; dying. */
function ragdollState(state: readonly number[] | undefined, dying: boolean): string {
  const [awake = 0, asleep = 0, keyframed = 0] = state ?? [];
  const bodies = state
    ? `${String(awake)} awake, ${String(asleep)} asleep, ${String(keyframed)} keyframed`
    : 'none';
  return dying ? `${bodies}; its graph still plays its death` : bodies;
}

/** How high a node of a model-space pose (16 floats per node) is in the world. */
function headHeight(worlds: Float32Array, node: number, world: ArrayLike<number>): number {
  const at = node * 16;
  const x = worlds[at + 12] ?? 0;
  const y = worlds[at + 13] ?? 0;
  const z = worlds[at + 14] ?? 0;
  return (world[2] ?? 0) * x + (world[6] ?? 0) * y + (world[10] ?? 0) * z + (world[14] ?? 0);
}

/** Seconds between the slower checks (poses, ground, travels, scenes). */
const SLOW_EVERY = 0.25;
/** How often the open menus' texts are read (seconds). */
const MENU_TEXTS_EVERY = 1;
/** A move farther than this in one frame is a teleport (game units): no speed from it. */
const TELEPORT = 300;
/** Where a ground ray starts above the feet, and how far below them it looks (game units). */
const RAY_ABOVE = 64;
const RAY_BELOW = 512;
/** Hits on these layers say nothing of the ground (actors, small things, weapons, debris). */
const NOT_GROUND = new Set<number>([
  Layer.clutter,
  Layer.weapon,
  Layer.projectile,
  Layer.biped,
  Layer.charController,
  Layer.deadBip,
  Layer.bipedNoCc,
  Layer.debrisSmall,
  Layer.debrisLarge,
  Layer.trigger,
]);

/** One watched actor (the player too). */
interface Watched {
  readonly reference: number;
  subject: QaSubject;
  last: readonly [number, number, number] | undefined;
  graphTime: number | undefined;
  /** The graph has delivered root motion at some point (its clips have motion data). */
  hasRoot: boolean;
  readonly speed: SpeedMeter;
  readonly root: SpeedMeter;
  readonly glide: Episode;
  readonly mismatch: Episode;
  readonly clips: ClipWatch;
  readonly states: StateWatch;
  readonly clipEpisode: Episode;
  readonly stateEpisode: Episode;
  readonly moveEvents: RateWindow;
  readonly turnEvents: RateWindow;
  /** The last movement and turn events sent, in order (the report's detail). */
  readonly sent: string[];
  readonly moveEpisode: Episode;
  readonly turnEpisode: Episode;
  readonly bind: Episode;
  readonly bone: Episode;
  readonly floating: Episode;
  readonly sunk: Episode;
  readonly travel: TravelWatch;
  /** The anomaly of each running episode (its duration grows with it). */
  readonly open: Map<string, QaAnomaly>;
  seen: number;
}

/** What one actor is now, read from the engine. */
interface ActorNow {
  readonly reference: number;
  readonly subject: QaSubject;
  readonly position: readonly [number, number, number];
  readonly behavior: BehaviorRuntime | undefined;
  readonly graphTime: number | undefined;
  readonly worlds: Float32Array | undefined;
  /** It moves without animation by design (rider, vehicle, ragdoll, flight): why. */
  readonly exempt: string | undefined;
  /**
   * The player's controls drive it (the player, the horse the player rides). Observed in the
   * original: the player's graph is told the controls' wish, never what the controller made of it
   * (bPlayerGraphFeedback 0), and a horse's graph is told the wish whenever the movement made
   * disagrees with it (motion feedback), so pressed against a wall or a fence either runs on the
   * spot as long as the controls say so: no speed mismatch. (An NPC doing so is caught as stuck.)
   */
  readonly controls?: boolean;
  /** What it does (package, furniture, AI-driven), for the report. */
  readonly context: string | undefined;
  readonly grounded: boolean;
  readonly cell: string | undefined;
  readonly travel: readonly [number, number, number] | undefined;
  readonly collider: RAPIER.Collider | undefined;
  /** Its capsule's radius (game units). */
  readonly radius: number;
  readonly shown: boolean;
}

const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');

/** The automated QA monitors: start, let the game run, take the snapshot. */
export class QaHarness {
  readonly #host: QaHost;
  #thresholds: QaThresholds = DEFAULT_THRESHOLDS;
  #log = new AnomalyLog();
  #frames = new FrameStats();
  #events: QaEvent[] = [];
  #running = false;
  #raf = 0;
  #lastFrame: number | undefined;
  #startedAt = 0;
  /** Seconds the game ran (out of menus and loading) since the start. */
  #clock = 0;
  #slow = 0;
  /** Seconds since the menus' texts were last read (placeholder-text). */
  #menusAt = 0;
  readonly #menuTexts = new MenuTextWatch();
  /** The placeholders on screen now (each reported once while it stays). */
  #placeholders = new Set<string>();
  readonly #watched = new Map<number, Watched>();
  readonly #bodies = new Map<number, { watch: BodyWatch; anomaly: QaAnomaly | undefined }>();
  /** Each fighter's combat watch and its paired clip's mark episode. */
  readonly #combat = new Map<number, { watch: CombatWatch; pair: Episode }>();
  #actorsWatched = 0;
  #bodiesSeen = new Set<number>();
  #scenes = new Map<
    number,
    {
      phase: number;
      since: number;
      readonly at: Map<number, readonly [number, number, number]>;
      moved: number;
      reported: boolean;
      /** Played here at some point (its end goes in the timeline). */
      here: boolean;
      /** The stages of the quests its phase's conditions read (their moving restarts the wait). */
      stages: string;
      /** Its wait for the player is in the timeline. */
      noted: boolean;
    }
  >();
  #quests = new Map<number, { stage: number; since: number; limit: number; reported: boolean }>();
  readonly #names = new Map<number, string>();
  readonly #logLines = new Map<string, QaAnomaly>();
  #restore: (() => void)[] = [];
  readonly #wrapped = new Set<BehaviorRuntime>();
  readonly #eventSink = new WeakMap<BehaviorRuntime, Watched>();
  #longTasks: PerformanceObserver | undefined;

  /** Called with each anomaly as it is added (the runner's screenshot hook goes here). */
  onAnomaly: ((anomaly: QaAnomaly) => void) | undefined;

  constructor(host: QaHost) {
    this.#host = host;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Starts the monitors (a fresh run: what an earlier run saw is dropped). */
  start(options: QaStartOptions = {}): void {
    if (this.#running) this.stop();
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.#log = new AnomalyLog(options.keep);
    this.#frames = new FrameStats();
    this.#events = [];
    this.#watched.clear();
    this.#combat.clear();
    this.#bodies.clear();
    this.#bodiesSeen = new Set();
    this.#actorsWatched = 0;
    this.#scenes = new Map();
    this.#quests = new Map();
    this.#logLines.clear();
    this.#triggerGates.clear();
    this.#entered.clear();
    this.#doorWays.clear();
    this.#doorPassed.clear();
    this.#playerCamera = new Episode(PLAYER_CAMERA_SECONDS, 1);
    this.#enteredFrom = undefined;
    for (const [id, seconds] of Object.entries(options.watchQuests ?? {})) {
      this.#quests.set(Number(id), { stage: -1, since: 0, limit: seconds, reported: false });
      // Its editor id read now, for the timeline's lines.
      this.#formName(Number(id));
    }
    this.#clock = 0;
    this.#slow = 0;
    this.#menusAt = 0;
    this.#placeholders = new Set();
    this.#startedAt = performance.now();
    this.#lastFrame = undefined;
    this.#running = true;
    if (options.bootLog === true) {
      for (const line of this.#host.terminal.problems)
        this.#logLine(line.tag, line.text, line.tone, (line.at - this.#startedAt) / 1000);
    }
    this.#wrapLogs();
    this.#raf = requestAnimationFrame(this.#frame);
  }

  /** Stops the monitors and undoes what they wrapped; the snapshot stays readable. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    for (const undo of this.#restore.splice(0).reverse()) undo();
    for (const behavior of this.#wrapped) Reflect.deleteProperty(behavior, 'sendEvent');
    this.#wrapped.clear();
    this.#longTasks?.disconnect();
    this.#longTasks = undefined;
    for (const watched of this.#watched.values()) this.#closeAll(watched);
    for (const body of this.#bodies.values()) {
      if (body.anomaly) body.anomaly.duration = Math.round(body.watch.jitter.duration * 100) / 100;
    }
  }

  /** What the monitors saw so far. */
  snapshot(): QaSnapshot & { readonly events: readonly QaEvent[] } {
    const snapshot = this.#log.snapshot(
      this.#frames.stats(),
      (performance.now() - this.#startedAt) / 1000,
      this.#actorsWatched,
      this.#bodiesSeen.size,
    );
    // Subjects named by their form id before their editor id was read get it now.
    const named = (subject: QaSubject | undefined): QaSubject | undefined => {
      if (!subject || !/^[0-9A-F]{8}$/.test(subject.id)) return subject;
      const formId = Number.parseInt(subject.id, 16);
      const name = this.#names.get(formId);
      if (!name || name === subject.id || !subject.name.startsWith(subject.id)) return subject;
      return { ...subject, name: name + subject.name.slice(subject.id.length) };
    };
    return {
      ...snapshot,
      anomalies: snapshot.anomalies.map((anomaly) => {
        const subject = named(anomaly.subject);
        return subject === anomaly.subject ? anomaly : { ...anomaly, subject };
      }),
      events: this.#events,
    };
  }

  /** The anomalies added since an id (the runner polls with the last it saw). */
  since(id: number): QaAnomaly[] {
    return this.#log.all.filter((anomaly) => anomaly.id > id);
  }

  /** Adds an anomaly seen from outside (the runner: a hang, a scenario step that failed). */
  report(input: AnomalyInput): QaAnomaly {
    return this.#add(input);
  }

  /**
   * Points a camera of its own at an anomaly's place for a screenshot (from where the view is,
   * at most FRAME_DISTANCE away, a little above), once the next frames are drawn. False: it has
   * no place, or another camera (a kill move's, death's) holds the view. unframe() gives the
   * view back.
   */
  async frame(id: number): Promise<boolean> {
    const play = this.#host.world()?.play;
    const anomaly = this.#log.all.find((a) => a.id === id);
    const at = anomaly?.position;
    if (!play || !at || (play.cameraOverride !== undefined && play.cameraOverride !== this.#camera))
      return false;
    const camera = (this.#camera ??= new FlyCamera());
    // Bodies (carts, ragdolls) are framed from farther and higher than actors.
    const object = anomaly.subject?.kind === 'object';
    const target: [number, number, number] = [at[0], at[1], at[2] + (object ? 0 : 70)];
    const from = play.view.position;
    const away = Math.hypot(from[0] - target[0], from[1] - target[1]);
    const most = object ? FRAME_DISTANCE * 1.8 : FRAME_DISTANCE;
    const dx = away > 1 ? (from[0] - target[0]) / away : 0;
    const dy = away > 1 ? (from[1] - target[1]) / away : 1;
    const rise = object ? 0.6 : 0.25;
    const length = Math.hypot(1, rise);
    const direction: [number, number, number] = [dx / length, dy / length, rise / length];
    // Not through a wall: as far as a camera's sphere goes from beside the target.
    const start: [number, number, number] = [
      target[0] + direction[0] * 40,
      target[1] + direction[1] * 40,
      target[2] + direction[2] * 40,
    ];
    const own = anomaly.subject ? Number.parseInt(anomaly.subject.id, 16) : -1;
    const free = play.physics.sphereCast(
      start,
      direction,
      most,
      12,
      Layer.charController,
      undefined,
      (owner) => owner?.kind === 'actor' || owner?.reference === own,
    );
    const distance = Math.max(90, Math.min(most, Math.max(80, away), free + 40));
    camera.position = [
      target[0] + direction[0] * distance,
      target[1] + direction[1] * distance,
      target[2] + direction[2] * distance,
    ];
    camera.lookAtPoint(target);
    play.cameraOverride = camera;
    // Two frames: one drawn from the camera, one shown.
    for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return true;
  }

  /** Gives the view back after frame(). */
  unframe(): void {
    const play = this.#host.world()?.play;
    if (play && play.cameraOverride === this.#camera && this.#camera)
      play.cameraOverride = undefined;
  }

  #camera: FlyCamera | undefined;

  /** Adds a line to the timeline (the runner's steps). */
  note(text: string): void {
    this.#events.push({ time: this.#now(), text });
  }

  // --- Frame ---------------------------------------------------------------------------------

  readonly #frame = (now: number): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#frame);
    const last = this.#lastFrame;
    this.#lastFrame = now;
    if (last === undefined) return;
    const ms = now - last;
    const world = this.#host.world();
    const session = this.#host.session();
    const loading = world?.loading;
    this.#frames.add(ms);
    if (ms > this.#thresholds.longFrameMs && document.visibilityState === 'visible') {
      this.#add({
        kind: 'long-frame',
        subject: FRAMES,
        time: this.#now(),
        detail: `a ${ms.toFixed(0)} ms frame${loading ? ` (loading ${loading})` : ''}`,
        values: { ms: Math.round(ms) },
        severity: ms,
        context: loading,
      });
    }
    // The open menus' texts, menus or not (a second apart).
    this.#menusAt += ms / 1000;
    if (session && this.#menusAt >= MENU_TEXTS_EVERY) {
      this.#menusAt = 0;
      this.#menusCheck(session);
    }
    // In menus and loading screens the game stands: nothing to watch.
    if (!world || !session || loading !== undefined || session.menuMode) return;
    const dt = Math.min(0.25, ms / 1000);
    this.#clock += dt;
    try {
      this.#actorsFrame(world, session, dt);
      this.#bodiesFrame(world, dt);
      this.#slow += dt;
      if (this.#slow >= SLOW_EVERY) {
        const step = this.#slow;
        this.#slow = 0;
        this.#slowChecks(world, session, step);
      }
    } catch (error: unknown) {
      // A monitor's own failure is reported once per message, never thrown into the game.
      this.#logLine(
        'qa',
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        'error',
      );
    }
  };

  #now(): number {
    return (performance.now() - this.#startedAt) / 1000;
  }

  /** placeholder-text: a field of an open menu that shows its authored placeholder. */
  #menusCheck(session: GameSession): void {
    const menus = this.#host.menus?.();
    if (!menus) return;
    const now = new Set<string>();
    try {
      for (const shown of this.#menuTexts.check(session.vfs, menus)) {
        const key = `${shown.movie} ${shown.path}`;
        now.add(key);
        if (this.#placeholders.has(key)) continue;
        this.#add({
          kind: 'placeholder-text',
          subject: { id: shown.movie, name: shown.movie, kind: 'menu' },
          time: this.#now(),
          detail: `${shown.path} shows its placeholder "${shown.text.split('\n').join(' / ')}"`,
          severity: 1,
        });
      }
    } catch (error: unknown) {
      this.#logLine('qa', error instanceof Error ? error.message : String(error), 'error');
    }
    this.#placeholders = now;
  }

  // --- Actors --------------------------------------------------------------------------------

  /** The actors to watch now: the enabled, shown, living ones on the stage and the player. */
  *#actors(world: QaWorld, session: GameSession): Iterable<ActorNow> {
    const stage = world.actorStage;
    if (stage) {
      for (const staged of stage.all()) {
        // The dead (placed dead too: no graph, their ragdolls pose them) are not watched.
        if (staged.dead || staged.visibility.hidden || staged.placed.actor.startsDead) continue;
        yield this.#actorNow(staged, world, session);
      }
    }
    const player = world.player;
    const avatar = world.playerView?.avatar;
    if (player && avatar && !avatar.dead) {
      const body = avatar.body;
      const seated = world.playerFurniture?.seated === true;
      const riding =
        stage?.vehicles.holds(PLAYER_REF) === true || stage?.mounts.holds(PLAYER_REF) === true;
      const knocked = stage?.knockdowns.holds(PLAYER_REF) === true;
      const driven = session.scriptsReady?.controls.aiDriven === true;
      const feet = player.drawnFeet;
      yield {
        reference: PLAYER_REF,
        subject: { id: hex(PLAYER_REF), name: 'Player', kind: 'player' },
        position: [feet[0], feet[1], feet[2]],
        behavior: body.behavior,
        graphTime: body.time,
        worlds: body.pose.worlds,
        exempt: riding ? 'riding' : knocked ? 'ragdoll' : undefined,
        controls: !driven,
        context:
          [seated ? 'in furniture' : '', driven ? 'AI-driven' : ''].filter(Boolean).join(', ') ||
          undefined,
        grounded: player.character.grounded && !seated && !riding && !player.swimming,
        cell: undefined,
        travel: stage?.pilot.destination,
        collider: player.character.collider,
        radius: player.character.shape.radius,
        shown: true,
      };
    }
  }

  #actorNow(staged: StagedActor, world: QaWorld, session: GameSession): ActorNow {
    const stage = world.actorStage;
    const reference = staged.reference;
    const look = staged.placed.look;
    const kind: QaSubject['kind'] = /horse/i.test(look.raceEditorId)
      ? 'horse'
      : look.faceGen !== undefined || /\\character\\/i.test(look.behavior ?? '')
        ? 'npc'
        : 'creature';
    let exempt: string | undefined;
    if (stage) {
      if (stage.vehicles.holds(reference)) exempt = 'vehicle rider';
      else if (stage.mounts.holds(reference)) exempt = 'riding';
      else if (stage.knockdowns.holds(reference) || stage.bodies.knocked(reference))
        exempt = 'ragdoll';
      else if (stage.flight.holds(reference)) exempt = 'flying';
    }
    const context: string[] = [];
    const furniture = stage?.furniture.holds(reference) === true;
    if (furniture) context.push('in furniture');
    if (stage?.ai.held(reference)) context.push('held by a reaction');
    const pack =
      stage?.ai.current(reference)?.id ?? session.scriptsReady?.currentPackage(reference);
    if (pack !== undefined) context.push(`package ${this.#formName(pack)}`);
    const scene = session.scriptsReady?.scenes.sceneOf(reference);
    if (scene !== undefined) context.push(`scene ${this.#formName(scene)}`);
    const name = look.name || look.editorId || hex(reference);
    return {
      reference,
      subject: { id: hex(reference), name, kind },
      position: [staged.position[0], staged.position[1], staged.position[2]],
      behavior: staged.placed.behavior,
      graphTime: staged.placed.time,
      worlds: staged.placed.pose.worlds,
      exempt,
      controls: stage?.mounts.riderOf(reference) === PLAYER_REF,
      context: context.length > 0 ? context.join(', ') : undefined,
      grounded:
        staged.grounded &&
        !furniture &&
        exempt === undefined &&
        stage?.movers.moves(reference) === true,
      cell: staged.cell,
      travel: stage?.movers.travelOf(reference)?.destination,
      collider: stage?.movers.colliderOf(reference),
      radius: stage?.movers.radius(reference) ?? 20,
      shown: staged.scene !== undefined,
    };
  }

  #watch(now: ActorNow): Watched {
    let watched = this.#watched.get(now.reference);
    const t = this.#thresholds;
    if (!watched) {
      watched = {
        reference: now.reference,
        subject: now.subject,
        last: undefined,
        graphTime: undefined,
        hasRoot: false,
        speed: new SpeedMeter(0.3),
        root: new SpeedMeter(0.3),
        glide: new Episode(t.glideSeconds),
        mismatch: new Episode(t.mismatchSeconds),
        clips: new ClipWatch(),
        states: new StateWatch(),
        clipEpisode: new Episode(0.5, 1),
        stateEpisode: new Episode(0.5, 1),
        moveEvents: new RateWindow(1),
        turnEvents: new RateWindow(1),
        sent: [],
        moveEpisode: new Episode(0.5, 1),
        turnEpisode: new Episode(0.5, 1),
        bind: new Episode(t.bindPoseSeconds, 1),
        bone: new Episode(0, 5),
        floating: new Episode(t.groundSeconds, 1),
        sunk: new Episode(t.groundSeconds, 1),
        travel: new TravelWatch(t.stuckSeconds),
        open: new Map(),
        seen: 0,
      };
      this.#watched.set(now.reference, watched);
    }
    watched.subject = now.subject;
    watched.seen = this.#clock;
    const behavior = now.behavior;
    if (behavior && !this.#wrapped.has(behavior)) this.#wrapEvents(behavior);
    if (behavior) this.#eventSink.set(behavior, watched);
    return watched;
  }

  /** Counts the movement and turn events the engine sends an actor's graph. */
  #wrapEvents(behavior: BehaviorRuntime): void {
    const send = behavior.sendEvent.bind(behavior);
    this.#wrapped.add(behavior);
    behavior.sendEvent = (name: string, payload?: string): boolean => {
      const watched = this.#eventSink.get(behavior);
      if (watched) {
        const key = name.toLowerCase();
        const move = key === 'movestart' || key === 'movestop';
        const turn = key === 'turnleft' || key === 'turnright' || key === 'turnstop';
        if (move) watched.moveEvents.add(this.#clock);
        else if (turn) watched.turnEvents.add(this.#clock);
        if (move || turn) {
          watched.sent.push(name);
          if (watched.sent.length > 12) watched.sent.shift();
        }
      }
      return send(name, payload);
    };
  }

  #actorsFrame(world: QaWorld, session: GameSession, dt: number): void {
    const t = this.#thresholds;
    const clock = this.#clock;
    let count = 0;
    for (const now of this.#actors(world, session)) {
      count++;
      const watched = this.#watch(now);
      // Its real speed (drawn feet from frame to frame), unless it was put somewhere else.
      const last = watched.last;
      watched.last = now.position;
      if (last) {
        const moved = Math.hypot(now.position[0] - last[0], now.position[1] - last[1]);
        if (moved > TELEPORT) {
          watched.speed.reset();
          watched.root.reset();
        } else watched.speed.add(dt, moved);
      }
      // What its graph moved it by (root motion of the clips of its last update).
      const behavior = now.behavior;
      if (behavior && now.graphTime !== undefined) {
        const before = watched.graphTime;
        watched.graphTime = now.graphTime;
        if (before !== undefined && now.graphTime > before) {
          const [x, y] = behavior.rootMotion().translation;
          const distance = Math.hypot(x, y);
          if (distance > 0) watched.hasRoot = true;
          watched.root.add(now.graphTime - before, distance);
        }
      }
      const clips = behavior ? behavior.playing() : [];
      const states = behavior ? behavior.states() : [];
      const speed = watched.speed.speed;
      const rootSpeed = watched.root.speed;
      const ready = watched.speed.ready;
      const shown = now.shown;
      const free = now.exempt === undefined && shown;
      const describe = (): Pick<
        AnomalyInput,
        'states' | 'clips' | 'position' | 'context' | 'cell'
      > => ({
        states: states.map((s) => `${s.machine}:${s.state}`),
        clips: [...new Set(clips.map((c) => c.animation))],
        position: now.position,
        context: [now.exempt, now.context].filter(Boolean).join(', ') || undefined,
        cell: now.cell,
      });
      // Glide: moving while nothing of its graph walks.
      const walking =
        rootSpeed >= t.locomotionRootSpeed || clips.some((c) => isLocomotionClip(c.animation));
      this.#episode(
        watched,
        'glide',
        watched.glide.update(free && ready && speed > t.glideSpeed && !walking, dt, speed),
        watched.glide,
        () => ({
          kind: 'glide',
          detail: `moves ${speed.toFixed(0)} u/s while no locomotion clip plays (root motion ${rootSpeed.toFixed(0)} u/s)`,
          values: { speed: Math.round(speed), rootSpeed: Math.round(rootSpeed) },
          severity: speed,
          ...describe(),
        }),
      );
      // Speed mismatch: the graph walks at one speed, the actor at another.
      const difference = Math.abs(speed - rootSpeed);
      const mismatched =
        free &&
        now.controls !== true &&
        ready &&
        watched.hasRoot &&
        watched.root.ready &&
        difference > t.mismatchAbsolute &&
        difference > t.mismatchRelative * Math.max(speed, rootSpeed);
      this.#episode(
        watched,
        'speed-mismatch',
        watched.mismatch.update(mismatched, dt, difference),
        watched.mismatch,
        () => ({
          kind: 'speed-mismatch',
          detail: `moves ${speed.toFixed(0)} u/s, its graph's root motion ${rootSpeed.toFixed(0)} u/s`,
          values: { speed: Math.round(speed), rootSpeed: Math.round(rootSpeed) },
          severity: difference,
          ...describe(),
        }),
      );
      if (!behavior) continue;
      // Stutter: a machine changing state, a clip restarting, events chattering.
      const chatter = watched.states.update(clock, states, t.stateChangesPerSecond);
      this.#episode(
        watched,
        'state-chatter',
        watched.stateEpisode.update(chatter !== undefined, dt, chatter?.changes ?? 0),
        watched.stateEpisode,
        () => ({
          kind: 'state-chatter',
          detail: `${chatter?.machine ?? '?'} changes state ${chatter?.changes ?? 0}×/s: ${(chatter?.visited ?? []).join(' → ')}`,
          values: { changesPerSecond: chatter?.changes ?? 0 },
          severity: chatter?.changes ?? 0,
          ...describe(),
        }),
      );
      const restart = watched.clips.update(
        clock,
        clips,
        t.clipRestartsPerSecond,
        t.clipRestartReach,
      );
      this.#episode(
        watched,
        'clip-restart',
        watched.clipEpisode.update(restart !== undefined, dt, restart?.restarts ?? 0),
        watched.clipEpisode,
        () => ({
          kind: 'clip-restart',
          detail: `${restart?.clip ?? '?'} restarts ${restart?.restarts ?? 0}×/s, reaching ${(restart?.reach ?? 0).toFixed(2)} s`,
          values: { restartsPerSecond: restart?.restarts ?? 0, reach: restart?.reach ?? 0 },
          severity: restart?.restarts ?? 0,
          ...describe(),
        }),
      );
      const moves = watched.moveEvents.count(clock);
      this.#episode(
        watched,
        'move-chatter',
        watched.moveEpisode.update(moves >= t.moveEventsPerSecond, dt, moves),
        watched.moveEpisode,
        () => ({
          kind: 'move-chatter',
          detail: `moveStart/moveStop sent ${moves}×/s: ${watched.sent.join(' ')}`,
          values: { eventsPerSecond: moves, speed: Math.round(speed) },
          severity: moves,
          ...describe(),
        }),
      );
      const turns = watched.turnEvents.count(clock);
      this.#episode(
        watched,
        'turn-chatter',
        watched.turnEpisode.update(turns >= t.turnEventsPerSecond, dt, turns),
        watched.turnEpisode,
        () => ({
          kind: 'turn-chatter',
          detail: `turn events sent ${turns}×/s: ${watched.sent.join(' ')}`,
          values: { eventsPerSecond: turns },
          severity: turns,
          ...describe(),
        }),
      );
    }
    this.#actorsWatched = Math.max(this.#actorsWatched, count);
    // Those gone (unloaded, dead, hidden) end their episodes.
    for (const [reference, watched] of this.#watched) {
      if (watched.seen === clock) continue;
      this.#closeAll(watched);
      this.#watched.delete(reference);
    }
  }

  /** The slower checks: poses, ground, travels, scenes, quests. */
  #slowChecks(world: QaWorld, session: GameSession, dt: number): void {
    const t = this.#thresholds;
    const physics = world.play?.physics;
    for (const now of this.#actors(world, session)) {
      const watched = this.#watched.get(now.reference);
      if (!watched) continue;
      const behavior = now.behavior;
      const describe = (): Pick<
        AnomalyInput,
        'states' | 'clips' | 'position' | 'context' | 'cell'
      > => ({
        states: behavior?.states().map((s) => `${s.machine}:${s.state}`),
        clips: behavior ? [...new Set(behavior.playing().map((c) => c.animation))] : undefined,
        position: now.position,
        context: [now.exempt, now.context].filter(Boolean).join(', ') || undefined,
        cell: now.cell,
      });
      // Bind pose: a shown skeleton without a graph, or whose graph gives the reference pose.
      const bind =
        now.shown &&
        now.exempt !== 'ragdoll' &&
        (behavior === undefined || isReferencePose(behavior.pose, behavior.skeleton.referencePose));
      this.#episode(watched, 'bind-pose', watched.bind.update(bind, dt), watched.bind, () => ({
        kind: 'bind-pose',
        detail: behavior
          ? 'its skeleton stays at its bind pose'
          : 'it has no behavior graph: it stands at its bind pose',
        severity: 1,
        ...describe(),
      }));
      const broken = now.worlds ? brokenBone(now.worlds, t.boneLimit) : undefined;
      this.#episode(
        watched,
        'bad-bone',
        watched.bone.update(broken !== undefined, dt),
        watched.bone,
        () => ({
          kind: 'bad-bone',
          detail: `node ${broken?.node ?? '?'} is ${Number.isFinite(broken?.value) ? `${Math.round(broken?.value ?? 0)} units out` : 'NaN'}`,
          values: { node: broken?.node ?? -1 },
          severity: Number.isFinite(broken?.value) ? (broken?.value ?? 0) : 1e9,
          ...describe(),
        }),
      );
      // Ground: what is under the feet of an actor its controller stands.
      if (physics && now.grounded && physics.queriesCurrent) {
        const ground = this.#ground(world, physics, now);
        if (ground) {
          const { gap, depth, layer } = ground;
          this.#episode(
            watched,
            'floating',
            watched.floating.update(gap > t.floatGap, dt, gap),
            watched.floating,
            () => ({
              kind: 'floating',
              detail:
                gap < RAY_BELOW
                  ? `its feet are ${gap.toFixed(0)} units above the ground`
                  : `nothing under its feet within ${RAY_BELOW} units`,
              values: { gap: Math.round(gap), layer },
              severity: gap,
              ...describe(),
            }),
          );
          this.#episode(
            watched,
            'sunk',
            watched.sunk.update(depth > t.sunkDepth, dt, depth),
            watched.sunk,
            () => ({
              kind: 'sunk',
              detail: `a surface is ${depth.toFixed(0)} units above its feet (layer ${layer})`,
              values: { depth: Math.round(depth), layer },
              severity: depth,
              ...describe(),
            }),
          );
        }
      }
      // Stuck: a travel that gets no nearer.
      const progress = watched.travel.update(dt, now.position, now.travel, t.stuckProgress);
      const destination = now.travel;
      this.#episode(watched, 'stuck', progress.change, watched.travel.episode, () => ({
        kind: 'stuck',
        detail: `its travel gets no nearer for ${t.stuckSeconds} s (${progress.distance.toFixed(0)} units to go)`,
        values: {
          distance: Math.round(progress.distance),
          toX: Math.round(destination?.[0] ?? 0),
          toY: Math.round(destination?.[1] ?? 0),
          toZ: Math.round(destination?.[2] ?? 0),
        },
        severity: progress.distance,
        ...describe(),
      }));
      this.#combatCheck(world, now, watched, dt, describe);
    }
    this.#corpsesCheck(world, dt);
    this.#playerCameraCheck(world, dt);
    this.#doorsCheck(world, dt);
    this.#scenesCheck(world, session);
    this.#questsCheck(session);
  }

  /**
   * A fighter's combat (src/shell/actor-combat.ts qaFighter): an archer fighting within its
   * range that looses nothing, or holds its bow drawn; a creature fighting within its reach
   * that never attacks, or never hits; a paired animation's partner away from its mark.
   */
  #combatCheck(
    world: QaWorld,
    now: ActorNow,
    watched: Watched,
    dt: number,
    describe: () => Pick<AnomalyInput, 'states' | 'clips' | 'position' | 'context' | 'cell'>,
  ): void {
    const stage = world.actorStage;
    const fighter = stage?.combat.qaFighter(now.reference);
    if (!stage || !fighter || now.reference === PLAYER_REF) return;
    const t = this.#thresholds;
    let combat = this.#combat.get(now.reference);
    if (!combat) {
      combat = { watch: new CombatWatch(), pair: new Episode(0.3, 0.5) };
      this.#combat.set(now.reference, combat);
    }
    const target = fighter.target;
    const there =
      target === undefined
        ? undefined
        : target === PLAYER_REF
          ? world.player?.drawnFeet
          : stage.get(target)?.position;
    const distance = there
      ? Math.hypot(there[0] - now.position[0], there[1] - now.position[1])
      : Infinity;
    const targetRadius = target === undefined ? 0 : (stage.movers.radius(target) ?? 20);
    const inRange = fighter.ranged
      ? distance <= fighter.range
      : distance <= fighter.reach + targetRadius + MELEE_SLACK;
    const melee = !fighter.ranged && watched.subject.kind === 'creature';
    const change = combat.watch.update(
      {
        fighting: fighter.engaged && target !== undefined && !fighter.fleeing,
        ranged: fighter.ranged,
        inRange,
        weaponDrawn: fighter.weaponState === WEAPON_DRAWN,
        bowDrawnFor: fighter.attackState === BOW_DRAWN ? fighter.drawnFor : 0,
        attacks: fighter.attacks,
        shots: fighter.shots,
        hits: fighter.hits,
      },
      dt,
      t,
    );
    const values = {
      distance: Math.round(distance),
      attacks: fighter.attacks,
      shots: fighter.shots,
      hits: fighter.hits,
      weaponState: fighter.weaponState,
      attackState: fighter.attackState,
    };
    this.#episode(watched, 'archer-silent', change.archer, combat.watch.archer, () => ({
      kind: 'archer-silent',
      detail:
        fighter.attackState === BOW_DRAWN && fighter.drawnFor >= t.bowHeldSeconds
          ? `holds its bow drawn ${fighter.drawnFor.toFixed(0)} s at ${hex(target ?? 0)} without loosing`
          : `fights ${hex(target ?? 0)} ${distance.toFixed(0)} units away (its range ${fighter.range.toFixed(0)}) and looses nothing for ${combat.watch.quiet.toFixed(0)} s (weapon state ${fighter.weaponState}, attack state ${fighter.attackState}, ${fighter.shots} shots so far)`,
      values,
      severity: Math.max(combat.watch.quiet, fighter.drawnFor),
      ...describe(),
    }));
    if (melee) {
      this.#episode(watched, 'creature-passive', change.melee, combat.watch.melee, () => ({
        kind: 'creature-passive',
        detail:
          combat.watch.misses >= t.creatureMisses
            ? `attacked ${hex(target ?? 0)} ${combat.watch.misses} times within reach without a hit`
            : `fights ${hex(target ?? 0)} ${distance.toFixed(0)} units away (its reach ${fighter.reach.toFixed(0)}) and attacks not once for ${combat.watch.quiet.toFixed(0)} s (weapon state ${fighter.weaponState}, attack state ${fighter.attackState}, ${fighter.attacks} attacks so far)`,
        values,
        severity: combat.watch.quiet + combat.watch.misses,
        ...describe(),
      }));
    }
    const mark = fighter.mark;
    const off =
      mark !== undefined &&
      (mark.distance > t.pairMarkUnits || mark.turn > t.pairMarkDegrees || !mark.partnerSide);
    this.#episode(watched, 'pair-misaligned', combat.pair.update(off, dt), combat.pair, () => ({
      kind: 'pair-misaligned',
      detail: mark
        ? `${mark.clip} at ${mark.time.toFixed(2)} s: ${mark.distance.toFixed(0)} units from its mark before ${hex(mark.leader)}, turned ${mark.turn.toFixed(0)}° off${mark.partnerSide ? '' : ', its graph playing the leader’s side'}`
        : 'out of its paired clip',
      values: {
        distance: Math.round(mark?.distance ?? 0),
        turn: Math.round(mark?.turn ?? 0),
      },
      severity: (mark?.distance ?? 0) + (mark?.turn ?? 0),
      ...describe(),
    }));
  }

  /**
   * What is under a grounded actor: rays straight down from above its feet at its centre and
   * at four points of its capsule's rim (it may stand on an edge). `gap`: how far its feet are
   * above the highest ground found (RAY_BELOW: none); `depth`: how far a surface at its centre
   * is above its feet. Undefined: nothing usable (an actor, clutter, a pulled cart under it, or
   * a ray starting inside a shape).
   */
  #ground(
    world: QaWorld,
    physics: PlaySession['physics'],
    now: ActorNow,
  ): { readonly gap: number; readonly depth: number; readonly layer: number } | undefined {
    const [x, y, z] = now.position;
    const rim = now.radius * 0.8;
    const points: readonly (readonly [number, number])[] = [
      [0, 0],
      [rim, 0],
      [-rim, 0],
      [0, rim],
      [0, -rim],
    ];
    let gap = RAY_BELOW;
    let depth = 0;
    let layer = -1;
    let usable = false;
    for (const [dx, dy] of points) {
      const hit = physics.raycast(
        [x + dx, y + dy, z + RAY_ABOVE],
        [0, 0, -1],
        RAY_ABOVE + RAY_BELOW,
        Layer.charController,
        now.collider,
      );
      const owner = hit?.owner;
      if (
        hit &&
        (owner?.kind === 'actor' ||
          NOT_GROUND.has(hit.layer) ||
          hit.distance <= 0.5 ||
          (owner && world.actorStage?.vehicles.owns(owner.reference)))
      ) {
        if (dx === 0 && dy === 0) return undefined;
        continue;
      }
      usable = true;
      if (!hit) continue;
      const above = z - hit.point[2];
      if (above < gap) {
        gap = above;
        layer = hit.layer;
      }
      if (dx === 0 && dy === 0) depth = -above;
    }
    return usable ? { gap: Math.max(0, gap), depth, layer } : undefined;
  }

  /**
   * The player's camera (their first-person graph's Camera1st, scaled by their race's height)
   * far above or below their drawn body's head for a while: a first-person graph left in a
   * furniture's or a vehicle's state the body has left (the camera at a cart seat's height on
   * the ground: the player "still a giant"), or the camera and the body at different sizes.
   */
  #playerCameraCheck(world: QaWorld, dt: number): void {
    const player = world.player;
    const avatar = world.playerView?.avatar;
    const body = avatar?.body;
    const headNode = body?.look.headNode;
    const head =
      headNode === undefined
        ? undefined
        : body?.pose.skeleton.nodeByName.get(headNode.toLowerCase());
    if (!player || !avatar || !body || head === undefined || avatar.dead || avatar.knocked) {
      this.#playerCamera.update(false, dt);
      return;
    }
    // The body is drawn at the avatar's placement (its instances share it).
    const gap = player.eye[2] - headHeight(body.pose.worlds, head, avatar.placement.world);
    const off = Math.abs(gap) > PLAYER_CAMERA_GAP * player.height;
    if (this.#playerCamera.update(off, dt, Math.abs(gap)) !== 'begin') return;
    const first = avatar.firstPerson?.behavior;
    const feet = player.drawnFeet;
    this.#add({
      kind: 'player-camera',
      subject: { id: hex(PLAYER_REF), name: 'Player', kind: 'player' },
      time: this.#now(),
      gameHour: this.#host.session()?.scriptsReady?.gameHour,
      position: [feet[0], feet[1], feet[2]],
      cell: undefined,
      states: first?.states().map((s) => `${s.machine}:${s.state}`),
      clips: first ? [...new Set(first.playing().map((c) => c.animation))] : undefined,
      context: `first-person graph (states, clips); body: ${(body.behavior?.states() ?? [])
        .slice(-3)
        .map((s) => `${s.machine}:${s.state}`)
        .join(', ')}`,
      detail: `the camera is ${Math.round(gap)} units ${gap > 0 ? 'above' : 'below'} the body's head (race height ${player.height.toFixed(2)})`,
      values: { gap: Math.round(gap), height: Math.round(player.height * 100) },
      severity: Math.abs(gap),
      duration: this.#playerCamera.duration,
    });
  }

  #playerCamera = new Episode(PLAYER_CAMERA_SECONDS, 1);

  /**
   * Actors and carts through a shut door: the way each moved since the last check (at two
   * heights) meets the collision of a door of the loaded area that is shut (its open sequence
   * not half played, or its close sequence half played or more). A door's collision is solid to
   * them, so going through it means it was not where its door is drawn, or not in the world.
   */
  #doorsCheck(world: QaWorld, dt: number): void {
    const stage = world.actorStage;
    const play = world.play;
    const physics = play?.physics;
    if (!stage || !play || !physics?.queriesCurrent) return;
    const now = clock();
    const doors: { readonly reference: number; readonly at: Vec3; readonly state: string }[] = [];
    for (const { reference, instance } of play.sequenced()) {
      const playback = instance.playback;
      const sequences = instance.model.sequences;
      if (!playback || !sequences?.byName.has('open') || !stage.doors.swinging(reference)) continue;
      const sequence = playback.sequence ?? 'close';
      const length = sequences.byName.get(sequence)?.duration ?? 0;
      const into = now - playback.start;
      const shut = sequence === 'open' ? into < length / 2 : into >= length / 2;
      if (!shut) continue;
      const w = instance.world;
      doors.push({
        reference,
        at: [w[12] ?? 0, w[13] ?? 0, w[14] ?? 0],
        state: `${sequence} ${into.toFixed(1)} s in`,
      });
    }
    const movers: { readonly key: string; readonly subject: QaSubject; readonly at: Vec3 }[] = [];
    for (const staged of stage.all()) {
      if (staged.dead || staged.visibility.hidden) continue;
      const look = staged.placed.look;
      movers.push({
        key: `a${hex(staged.reference)}`,
        subject: {
          id: hex(staged.reference),
          name: look.name || look.editorId || hex(staged.reference),
          kind: /horse/i.test(look.raceEditorId)
            ? 'horse'
            : look.faceGen !== undefined
              ? 'npc'
              : 'creature',
        },
        at: [staged.position[0], staged.position[1], staged.position[2]],
      });
    }
    const player = world.player;
    if (player) {
      const feet = player.feet;
      movers.push({
        key: `a${hex(PLAYER_REF)}`,
        subject: { id: hex(PLAYER_REF), name: 'Player', kind: 'player' },
        at: [feet[0], feet[1], feet[2]],
      });
    }
    for (const { reference, at } of stage.vehicles.cartPlaces()) {
      movers.push({
        key: `c${hex(reference)}`,
        subject: { id: hex(reference), name: this.#formName(reference), kind: 'object' },
        at,
      });
    }
    const seen = new Set<string>();
    for (const mover of movers) {
      seen.add(mover.key);
      const last = this.#doorWays.get(mover.key);
      this.#doorWays.set(mover.key, mover.at);
      if (!last || doors.length === 0) continue;
      const way: Vec3 = [mover.at[0] - last[0], mover.at[1] - last[1], mover.at[2] - last[2]];
      const length = Math.hypot(...way);
      // Still, or a teleport (a script's move, out of a load door).
      if (length < 1 || length > TELEPORT) continue;
      for (const door of doors) {
        if (Math.hypot(door.at[0] - mover.at[0], door.at[1] - mover.at[1]) > DOOR_NEAR) continue;
        const key = `${mover.key}:${hex(door.reference)}`;
        if ((this.#doorPassed.get(key) ?? -Infinity) > this.#clock - DOOR_REPEAT) continue;
        const through = DOOR_RAY_HEIGHTS.some((height) =>
          physics.pick(
            [last[0], last[1], last[2] + height],
            way,
            length,
            2,
            Layer.charController,
            undefined,
            (owner) => owner?.kind !== 'object' || owner.reference !== door.reference,
          ),
        );
        if (!through) continue;
        this.#doorPassed.set(key, this.#clock);
        this.#add({
          kind: 'door-passed',
          subject: mover.subject,
          time: this.#now(),
          gameHour: this.#host.session()?.scriptsReady?.gameHour,
          position: [mover.at[0], mover.at[1], mover.at[2]],
          cell: undefined,
          context: `door ${this.#formName(door.reference)}`,
          detail: `went through ${this.#formName(door.reference)} while it was shut (${door.state}), ${Math.round(length / dt)} units a second`,
          values: { speed: Math.round(length / dt) },
          severity: length / dt,
          duration: 0,
        });
      }
    }
    for (const key of this.#doorWays.keys()) if (!seen.has(key)) this.#doorWays.delete(key);
  }

  /** Where each actor and cart was at the last door check (door-passed). */
  readonly #doorWays = new Map<string, Vec3>();
  /** When each mover went through each door last (door-passed: once in DOOR_REPEAT). */
  readonly #doorPassed = new Map<string, number>();

  /**
   * The dead shown upright: a corpse whose drawn skeleton spans (top to bottom) most of what it
   * spans standing, for a while, was never laid down by its ragdoll (it stands at its bind pose).
   */
  #corpsesCheck(world: QaWorld, dt: number): void {
    const stage = world.actorStage;
    if (!stage) return;
    const seen = new Set<number>();
    // The awake simulated bodies of each actor's ragdoll.
    const awake = new Map<number, number>();
    // Each actor's ragdoll bodies by state (simulated awake, asleep, keyframed), for the detail.
    const states = new Map<number, [number, number, number]>();
    // Each actor's lowest ragdoll body (its centre's height, game units).
    const lowest = new Map<number, number>();
    const physics = world.play?.physics;
    physics?.world.bodies.forEach((body) => {
      if (body.numColliders() === 0 || body.isFixed()) return;
      const owner = physics.ownerOf(body.collider(0));
      if (owner?.kind !== 'actor') return;
      const z = body.translation().z * HAVOK_SCALE;
      lowest.set(owner.reference, Math.min(lowest.get(owner.reference) ?? Infinity, z));
      const state = states.get(owner.reference) ?? [0, 0, 0];
      states.set(owner.reference, state);
      if (!body.isDynamic()) state[2]++;
      else if (body.isSleeping()) state[1]++;
      else {
        state[0]++;
        awake.set(owner.reference, (awake.get(owner.reference) ?? 0) + 1);
      }
    });
    for (const staged of stage.all()) {
      if (!(staged.dead || staged.placed.actor.startsDead) || staged.visibility.hidden) continue;
      const instance = staged.placed.instances[0];
      if (!instance || !staged.scene) continue;
      const reference = staged.reference;
      seen.add(reference);
      const look = staged.placed.look;
      let corpse = this.#corpses.get(reference);
      if (!corpse) {
        // Its head (the look's head node, else the usual names): how high it is standing.
        const skeleton = staged.placed.pose.skeleton;
        const head = [look.headNode, 'NPC Head [Head]', 'Head']
          .map((name) =>
            name === undefined ? undefined : skeleton.nodeByName.get(name.toLowerCase()),
          )
          .find((node) => node !== undefined);
        const rest = head === undefined ? 0 : (new ActorPose(skeleton).worlds[head * 16 + 14] ?? 0);
        corpse = {
          head,
          rest,
          low: Infinity,
          first: undefined,
          episode: new Episode(CORPSE_SECONDS, 1),
          restless: new Episode(RESTLESS_SECONDS, 1),
          rises: new Episode(0, CORPSE_SECONDS),
        };
        this.#corpses.set(reference, corpse);
      }
      const subject: QaSubject = {
        id: hex(reference),
        name: look.name || look.editorId || hex(reference),
        kind: /horse/i.test(look.raceEditorId)
          ? 'horse'
          : look.faceGen !== undefined
            ? 'npc'
            : 'creature',
      };
      const context = staged.placed.actor.startsDead
        ? `placed dead (${look.editorId})`
        : 'died here';
      const stirring = awake.get(reference) ?? 0;
      if (corpse.restless.update(stirring > 0, dt, stirring) === 'begin') {
        this.#add({
          kind: 'ragdoll-restless',
          subject,
          time: this.#now(),
          gameHour: this.#host.session()?.scriptsReady?.gameHour,
          position: [staged.position[0], staged.position[1], staged.position[2]],
          cell: staged.cell,
          context,
          detail: `dead, its ragdoll still stirs (${String(stirring)} bodies awake) after ${String(RESTLESS_SECONDS)} s`,
          values: { awake: stirring },
          severity: stirring,
          duration: corpse.restless.duration,
        });
      }
      if (corpse.head === undefined) continue;
      // A placed dead whose ragdoll is held in its placed pose (none of its bodies let go)
      // lies as the Creation Kit settled it (a skeever draped over roots, its head up).
      const [simulated = 0, sleeping = 0, held = 0] = states.get(reference) ?? [];
      if (staged.placed.actor.startsDead && held > 0 && simulated + sleeping === 0) continue;
      const scale = staged.placed.actor.scale * look.scale;
      // Over its lowest body (a corpse placed lying on a ledge, roots or a table is not
      // upright), or its feet without bodies.
      const height =
        headHeight(staged.placed.pose.worlds, corpse.head, instance.world) -
        Math.min(staged.position[2], lowest.get(reference) ?? Infinity);
      // Rising: one that died here whose head came up again by CORPSE_RISE of its standing
      // height over the lowest it had since (a death that stood the body up first, then let it
      // fall: its look made again in a fresh graph, a death animation from a standing pose). Only
      // while its graph moves it (dying, its bodies keyframed): a ragdoll flung or carried (a
      // dragon's grab) rises by physics. And only for one that died low (seated, kneeling,
      // lying: its head under CORPSE_LOW of its standing height): a bear's death rears it up.
      if (!staged.placed.actor.startsDead && corpse.rest > 1) {
        corpse.first ??= height;
        corpse.low = Math.min(corpse.low, height);
        const rise = height - corpse.low;
        const [awake = 0, asleep = 0, keyframed = 0] = states.get(reference) ?? [];
        const animated =
          stage.graphEvents.dying(reference) || (keyframed > 0 && awake + asleep === 0);
        const diedLow = corpse.first < CORPSE_LOW * corpse.rest * scale;
        const rose = animated && diedLow && rise > CORPSE_RISE * corpse.rest * scale;
        if (corpse.rises.update(rose, dt, rise) === 'begin') {
          const behavior = staged.placed.behavior;
          this.#add({
            kind: 'corpse-rises',
            subject,
            time: this.#now(),
            gameHour: this.#host.session()?.scriptsReady?.gameHour,
            position: [staged.position[0], staged.position[1], staged.position[2]],
            cell: staged.cell,
            context,
            states: behavior?.states().map((s) => `${s.machine}:${s.state}`),
            clips: behavior ? [...new Set(behavior.playing().map((c) => c.animation))] : undefined,
            detail: `dead, its head rose ${Math.round(rise)} units (to ${Math.round(height)} above its feet) after it was down (its bodies: ${ragdollState(states.get(reference), stage.graphEvents.dying(reference))})`,
            values: { rise: Math.round(rise), head: Math.round(height) },
            severity: rise,
            duration: 0,
          });
        }
      }
      const upright = corpse.rest > 1 && height > CORPSE_UPRIGHT * corpse.rest * scale;
      if (corpse.episode.update(upright, dt, height) !== 'begin') continue;
      const span = height;
      this.#add({
        kind: 'corpse-upright',
        subject,
        time: this.#now(),
        gameHour: this.#host.session()?.scriptsReady?.gameHour,
        position: [staged.position[0], staged.position[1], staged.position[2]],
        cell: staged.cell,
        context,
        detail: `dead, but its head is ${Math.round(span)} units up (${Math.round((100 * span) / (corpse.rest * scale))} % of its standing height): no ragdoll laid it down (its bodies: ${ragdollState(states.get(reference), stage.graphEvents.dying(reference))})`,
        values: { head: Math.round(span), standing: Math.round(corpse.rest * scale) },
        severity: span,
        duration: corpse.episode.duration,
      });
    }
    for (const reference of this.#corpses.keys())
      if (!seen.has(reference)) this.#corpses.delete(reference);
  }

  readonly #corpses = new Map<
    number,
    {
      readonly head: number | undefined;
      readonly rest: number;
      /** The lowest its head was above its feet since it died (corpse-rises). */
      low: number;
      /** Its head's height above its feet as it was first seen dead (corpse-rises). */
      first: number | undefined;
      readonly episode: Episode;
      /** Whether its ragdoll keeps a body awake (ragdoll-restless). */
      readonly restless: Episode;
      /** Whether its head came up again after it was down (corpse-rises). */
      readonly rises: Episode;
    }
  >();

  /**
   * The trigger volumes near a scene's actors (within TRIGGER_GATE_RADIUS, loaded) that wait
   * for the player (trigger-gates.ts) and whose scripts name a quest the phase's conditions
   * read, and that the player has not walked into: the phase waits for the player to walk in.
   * Undefined: none; 'pending' while they are read (once per phase).
   */
  #triggerGate(
    scene: number,
    phase: number,
    quests: readonly number[],
    positions: ReadonlyMap<number, readonly [number, number, number]>,
    world: QaWorld,
    runtime: ScriptRuntime,
  ): readonly number[] | 'pending' | undefined {
    if (quests.length === 0) return undefined;
    const key = `${String(scene)}:${String(phase)}`;
    const known = this.#triggerGates.get(key);
    if (known === undefined) {
      const physics = world.play?.physics;
      if (!physics) return undefined;
      const near = new Set<number>();
      for (const at of positions.values()) {
        for (const trigger of physics.triggersNear([...at], TRIGGER_GATE_RADIUS)) near.add(trigger);
      }
      this.#triggerGates.set(key, 'pending');
      void Promise.all([...near].map((trigger) => playerTrigger(runtime, trigger)))
        .then((found) => {
          const gates = found.flatMap((trigger) =>
            trigger && quests.some((quest) => trigger.names.has(quest)) ? [trigger.reference] : [],
          );
          this.#triggerGates.set(key, gates);
        })
        .catch(() => this.#triggerGates.set(key, []));
      return 'pending';
    }
    if (known === 'pending') return known;
    const open = known.filter(
      (trigger) =>
        !this.#entered.has(trigger) && !runtime.triggerVolumes.inside(trigger).has(PLAYER_REF),
    );
    return open.length > 0 ? open : undefined;
  }

  readonly #triggerGates = new Map<string, readonly number[] | 'pending'>();
  /** The trigger volumes the player walked into since the start (the game's event). */
  readonly #entered = new Set<number>();
  #enteredFrom: ScriptRuntime | undefined;

  /** Follows the player walking into trigger volumes (once per game's runtime). */
  #followTriggers(runtime: ScriptRuntime): void {
    if (this.#enteredFrom === runtime) return;
    this.#enteredFrom = runtime;
    const off = runtime.events.on('triggerEnterLeave', (event) => {
      if (event.reference === PLAYER_REF && event.entered) this.#entered.add(event.trigger);
    });
    this.#restore.push(off);
  }

  /** Scenes whose phase stands while none of their actors moves. */
  #scenesCheck(world: QaWorld, session: GameSession): void {
    const runtime = session.scriptsReady;
    const stage = world.actorStage;
    if (!runtime || !stage) return;
    this.#followTriggers(runtime);
    const now = this.#now();
    const playing = runtime.scenes.snapshot();
    const live = new Set<number>();
    for (const scene of playing) {
      live.add(scene.scene);
      let seen = this.#scenes.get(scene.scene);
      const positions = new Map<number, readonly [number, number, number]>();
      for (const actor of scene.cast) {
        const at = actor === PLAYER_REF ? world.player?.feet : stage.get(actor)?.position;
        if (at) positions.set(actor, [at[0], at[1], at[2]]);
      }
      // The timeline has the scenes played here (one of their actors in the loaded area).
      const here = positions.size > 0;
      if (!seen && here) {
        this.#events.push({ time: now, text: `scene ${this.#formName(scene.scene)} starts` });
      }
      // What its phase waits for: the quests its conditions read (as they move on, the wait
      // starts again: the scene follows its quest, a cart's arrival setting the stage it waits
      // for), and whether it waits for the player to come.
      const wait = sceneWait(
        scene.waits,
        (formId) => (formId === PLAYER_REF ? 'Player' : this.#formName(formId)),
        (formId) => runtime.state.quests.has(formId),
      );
      const stages = wait.quests
        .map((quest) => String(runtime.state.quests.get(quest)?.stage ?? -1))
        .join(',');
      if (seen?.phase !== scene.phase) {
        if (seen && here)
          this.#events.push({
            time: now,
            text: `scene ${this.#formName(scene.scene)} phase ${scene.phase}`,
          });
        seen = {
          phase: scene.phase,
          since: now,
          at: positions,
          moved: 0,
          reported: false,
          here: here || seen?.here === true,
          stages,
          noted: false,
        };
        this.#scenes.set(scene.scene, seen);
        continue;
      }
      if (here) seen.here = true;
      if (seen.stages !== stages) {
        seen.stages = stages;
        seen.since = now;
      }
      for (const [actor, at] of positions) {
        const from = seen.at.get(actor);
        if (from) seen.moved = Math.max(seen.moved, Math.hypot(at[0] - from[0], at[1] - from[1]));
        else seen.at.set(actor, at);
      }
      // Paused, starting, or played away from the loaded area (no actor of it here): not judged.
      if (scene.paused || scene.state !== 'playing' || positions.size === 0) {
        seen.since = now;
        continue;
      }
      const stalled = now - seen.since;
      if (seen.reported || stalled < this.#thresholds.sceneStallSeconds || seen.moved > 64)
        continue;
      // Waiting for the player: the scene is where its data has it, the timeline says so. A
      // phase with completion conditions ends by them alone (its open actions, a sandbox or a
      // stand beside them, hold nothing: MG01MirabelleAncanoScene waits for the player within
      // 600 units while Mirabelle's package runs); one without waits for its actions.
      const byConditions = scene.waits.length > 0;
      // Its conditions name the player (RiverwoodIntroSceneHildeSoldierScene waits for Sven
      // within 1000 units of the player), or read a quest that a trigger box near it sets as
      // the player walks in (Riften's north gate: RDS01Scene waits for DialogueRiftenSS01's
      // pGo, set by RDS01Trigger's stage).
      const gate = byConditions
        ? this.#triggerGate(scene.scene, scene.phase, wait.quests, positions, world, runtime)
        : undefined;
      if (gate === 'pending') continue;
      if ((wait.onPlayer && (scene.open.length === 0 || byConditions)) || gate !== undefined) {
        if (!seen.noted) {
          seen.noted = true;
          const into =
            gate === undefined
              ? ''
              : ` to walk into ${gate.map((t) => this.#formName(t)).join(', ')}`;
          this.#events.push({
            time: now,
            text: `scene ${this.#formName(scene.scene)} phase ${scene.phase} waits for the player${into}: ${wait.text}`,
          });
        }
        continue;
      }
      seen.reported = true;
      const open = scene.open
        .map(
          (action) =>
            `${action.type}${action.actor === undefined ? '' : ` of ${this.#formName(action.actor)}`} (${action.status})`,
        )
        .join('; ');
      const first = scene.cast[0];
      const at = first === undefined ? undefined : positions.get(first);
      this.#add({
        kind: 'scene-stall',
        subject: { id: hex(scene.scene), name: this.#formName(scene.scene), kind: 'scene' },
        time: now,
        gameHour: runtime.gameHour,
        position: at,
        detail: `phase ${scene.phase} stands ${stalled.toFixed(0)} s, its actors still; open: ${open || 'none'}; waits for: ${wait.text || 'its actions'}`,
        values: { phase: scene.phase, seconds: Math.round(stalled), moved: Math.round(seen.moved) },
        severity: stalled,
        context: `cast ${scene.cast.map((a) => this.#formName(a)).join(', ')}`,
        duration: stalled,
      });
    }
    for (const [scene, seen] of this.#scenes) {
      if (live.has(scene)) continue;
      this.#scenes.delete(scene);
      if (seen.here) this.#events.push({ time: now, text: `scene ${this.#formName(scene)} ends` });
    }
  }

  /** Watched quests whose stage stands too long. */
  #questsCheck(session: GameSession): void {
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const now = this.#now();
    for (const [quest, seen] of this.#quests) {
      const state = runtime.state.quests.get(quest);
      const stage = state?.running ? state.stage : -1;
      if (stage !== seen.stage) {
        if (stage >= 0)
          this.#events.push({ time: now, text: `${this.#formName(quest)} stage ${stage}` });
        seen.stage = stage;
        seen.since = now;
        seen.reported = false;
        continue;
      }
      if (stage < 0 || seen.reported || now - seen.since < seen.limit) continue;
      seen.reported = true;
      this.#add({
        kind: 'quest-stall',
        subject: { id: hex(quest), name: this.#formName(quest), kind: 'quest' },
        time: now,
        gameHour: runtime.gameHour,
        detail: `stage ${stage} unchanged for ${seen.limit} s`,
        values: { stage, seconds: seen.limit },
        severity: seen.limit,
        duration: seen.limit,
      });
    }
  }

  // --- Bodies --------------------------------------------------------------------------------

  /** The simulated bodies awake: vertical velocity flipping, one-frame velocity jumps. */
  #bodiesFrame(world: QaWorld, dt: number): void {
    const physics = world.play?.physics;
    if (!physics) return;
    const t = this.#thresholds;
    const clock = this.#clock;
    const seen = new Set<number>();
    physics.world.bodies.forEach((body) => {
      if (!body.isDynamic() || body.isSleeping()) return;
      const handle = body.handle;
      seen.add(handle);
      this.#bodiesSeen.add(handle);
      let entry = this.#bodies.get(handle);
      if (!entry) {
        entry = { watch: new BodyWatch(t.jitterSeconds), anomaly: undefined };
        this.#bodies.set(handle, entry);
      }
      const v = body.linvel();
      const velocity: [number, number, number] = [
        v.x * HAVOK_SCALE,
        v.y * HAVOK_SCALE,
        v.z * HAVOK_SCALE,
      ];
      const result = entry.watch.update(clock, dt, velocity, t);
      if (result.jitter === undefined && result.spike === undefined) return;
      const collider = body.numColliders() > 0 ? body.collider(0) : undefined;
      const owner = collider ? physics.ownerOf(collider) : undefined;
      const p = body.translation();
      const position: [number, number, number] = [
        p.x * HAVOK_SCALE,
        p.y * HAVOK_SCALE,
        p.z * HAVOK_SCALE,
      ];
      const reference = owner?.reference ?? 0;
      const subject: QaSubject = {
        id: hex(reference),
        name:
          owner?.kind === 'actor'
            ? `${this.#formName(reference)} (ragdoll)`
            : this.#formName(reference),
        kind: 'object',
      };
      if (result.jitter === 'begin') {
        entry.anomaly = this.#add({
          kind: 'physics-jitter',
          subject,
          time: this.#now(),
          position,
          detail: `vertical velocity flips ${result.flips}×/s (now ${velocity[2].toFixed(0)} u/s)`,
          values: { flipsPerSecond: result.flips, vz: Math.round(velocity[2]) },
          severity: result.flips,
        });
      } else if (result.jitter === 'end' && entry.anomaly) {
        entry.anomaly.duration = Math.round(entry.watch.jitter.duration * 100) / 100;
        entry.anomaly.severity =
          Math.max(entry.anomaly.severity, entry.watch.jitter.peak) *
          Math.max(1, entry.anomaly.duration);
        entry.anomaly = undefined;
      }
      if (result.spike !== undefined) {
        this.#add({
          kind: 'velocity-spike',
          subject,
          time: this.#now(),
          position,
          detail: `velocity changes by ${result.spike.toFixed(0)} u/s in one frame (now ${Math.hypot(...velocity).toFixed(0)} u/s)`,
          values: { change: Math.round(result.spike), speed: Math.round(Math.hypot(...velocity)) },
          severity: result.spike,
        });
      }
    });
    for (const [handle, entry] of this.#bodies) {
      if (seen.has(handle)) continue;
      if (entry.anomaly)
        entry.anomaly.duration = Math.round(entry.watch.jitter.duration * 100) / 100;
      this.#bodies.delete(handle);
    }
  }

  // --- Logs ----------------------------------------------------------------------------------

  /** The engine's log lines and the console's errors, while the monitors run. */
  #wrapLogs(): void {
    const terminal = this.#host.terminal;
    const log = terminal.log.bind(terminal);
    terminal.log = (tag: string, text: string, tone?: LogTone): void => {
      log(tag, text, tone);
      if (tone === 'error' || tone === 'warn') this.#logLine(tag, text, tone);
    };
    this.#restore.push(() => {
      Reflect.deleteProperty(terminal, 'log');
    });
    const error = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      error(...args);
      this.#consoleLine(args.map(String).join(' '));
    };
    this.#restore.push(() => {
      console.error = error;
    });
    const onError = (event: ErrorEvent): void => {
      this.#consoleLine(`uncaught: ${event.message}`);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason;
      this.#consoleLine(
        `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.#restore.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      this.#longTasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.#frames.longTask(entry.duration);
      });
      this.#longTasks.observe({ type: 'longtask' });
    }
  }

  #logLine(tag: string, text: string, tone: LogTone, time = this.#now()): void {
    const kind = tone === 'error' ? 'log-error' : 'log-warning';
    const key = `${kind}|${tag}|${messageKey(text)}`;
    const known = this.#logLines.get(key);
    if (known) {
      known.values.count = (known.values.count ?? 1) + 1;
      known.severity = known.values.count;
      return;
    }
    this.#logLines.set(
      key,
      this.#add({
        kind,
        subject: { id: tag, name: tag, kind: 'log' },
        time,
        gameHour: time < 0 ? undefined : this.#host.session()?.scriptsReady?.gameHour,
        detail: text.slice(0, 400),
        values: { count: 1 },
        severity: 1,
      }),
    );
  }

  #consoleLine(text: string): void {
    const key = `console|${messageKey(text)}`;
    const known = this.#logLines.get(key);
    if (known) {
      known.values.count = (known.values.count ?? 1) + 1;
      known.severity = known.values.count;
      return;
    }
    this.#logLines.set(
      key,
      this.#add({
        kind: 'console-error',
        subject: { id: 'console', name: 'console', kind: 'log' },
        time: this.#now(),
        detail: text.slice(0, 400),
        values: { count: 1 },
        severity: 1,
      }),
    );
  }

  // --- Anomalies -----------------------------------------------------------------------------

  /** An episode's change: its anomaly added as it begins, its duration set as it ends. */
  #episode(
    watched: Watched,
    key: string,
    change: 'begin' | 'end' | undefined,
    episode: Episode,
    make: () => Omit<AnomalyInput, 'time' | 'subject'>,
  ): void {
    if (change === 'begin') {
      const input = make();
      const anomaly = this.#add({
        ...input,
        subject: watched.subject,
        time: this.#now(),
        gameHour: this.#host.session()?.scriptsReady?.gameHour,
        duration: episode.duration,
      });
      watched.open.set(key, anomaly);
    } else if (change === 'end') {
      const anomaly = watched.open.get(key);
      watched.open.delete(key);
      if (anomaly) this.#ended(anomaly, episode);
    } else if (episode.active) {
      const anomaly = watched.open.get(key);
      if (anomaly) anomaly.duration = Math.round(episode.duration * 100) / 100;
    }
  }

  #ended(anomaly: QaAnomaly, episode: Episode): void {
    anomaly.duration = Math.round(Math.max(anomaly.duration, episode.duration) * 100) / 100;
    // Glides and the like: the longer, the worse.
    if (anomaly.kind === 'glide' || anomaly.kind === 'speed-mismatch' || anomaly.kind === 'stuck')
      anomaly.severity = Math.round(anomaly.severity * Math.max(1, anomaly.duration));
  }

  #closeAll(watched: Watched): void {
    for (const anomaly of watched.open.values()) {
      anomaly.duration = Math.round(anomaly.duration * 100) / 100;
    }
    watched.open.clear();
  }

  #add(input: AnomalyInput): QaAnomaly {
    const anomaly = this.#log.add(input);
    this.onAnomaly?.(anomaly);
    return anomaly;
  }

  /** A form's editor id (once read; its hex id until then). */
  #formName(formId: number): string {
    if (formId === PLAYER_REF) return 'Player';
    const known = this.#names.get(formId);
    if (known !== undefined) return known;
    const id = hex(formId);
    this.#names.set(formId, id);
    const stage = this.#host.world()?.actorStage;
    const staged = stage?.get(formId);
    if (staged) {
      const name = staged.placed.look.name || staged.placed.look.editorId;
      if (name) this.#names.set(formId, `${name} [${id}]`);
      return this.#names.get(formId) ?? id;
    }
    const session = this.#host.session();
    if (session) {
      void session.db
        .then(async (db) => {
          const record = await db.get(formId);
          const own = record?.editorId;
          const base = record?.formIdField('NAME');
          const baseName = base === undefined ? undefined : (await db.get(base))?.editorId;
          const name = own ?? baseName;
          if (name) this.#names.set(formId, `${name} [${id}]`);
        })
        .catch(() => undefined);
    }
    return id;
  }
}
