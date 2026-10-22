// Actors using furniture (docs/ai.md, "Furniture"; docs/m10-plan.md, 3.3): a chair, a bench, a
// bed, a wall to lean on. An actor picks a free active marker of the furniture (its model's
// markers, those the FURN record makes active) and the entry point that faces it (the record's
// entry points less those it disables); it is about to enter (GetSitting / GetSleeping 2) and
// the idle tree under ActionActivate, its conditions on the actor and the furniture, gives the
// animation event it enters by (IdleChairFrontEnter, IdleBedLeftEnterStart, ...). Where that
// enter's root motion ends at the marker is where the actor walks to and which way it turns;
// then its graph plays the enter, which moves it in (its root motion, with no controller), and
// at its end what is left to the marker is made up in a quarter of a second (the engine's path
// tweener: CommonLibSSE's PathTweenerStart / End; its rule is not documented). In it (3) its
// scripts hear OnSit; about to leave (4) the idle tree gives the exit, whose root motion takes
// it out; then it stands (0), its scripts hear OnGetUp and its controller is back. An actor
// placed in furniture as its cell loads is in it at once: the "instant" idles
// (IsEnteringInteractionQuick).

import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import {
  behaviorGraphKey,
  IdleCollectionFlag,
  IdleMarkerRecordFlag,
  parseIdleMarker,
  readIdleTree,
  type IdleTree,
} from '../ai/idle-records.ts';
import type { SandboxSpot } from '../ai/package-runtime.ts';
import { parseNif } from '../formats/nif/nif.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorInteraction } from '../scripting/runtime/runtime.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { meshPath, seededRandom } from '../world/actors.ts';
import { furnitureMarkers, markerPlacement } from '../world/furniture.ts';
import {
  FurnitureEntry,
  FurnitureFlag,
  FurnitureMarkerFlag,
  FurnitureMarkerType,
  isMarkerActive,
  markerData,
  parseFurniture,
} from '../world/furniture-records.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/**
 * Who uses furniture: an actor of the stage (src/shell/actor-stage.ts) or the player (its body
 * and controller).
 */
export interface FurnitureUser {
  readonly reference: number;
  /** Its look (behavior project, sex) and its body's graph (root motion). */
  readonly placed: PlacedActor;
  /** Where its feet are and which way it faces (radians about z). */
  readonly position: Vec3;
  readonly heading: number;
  /** Puts it at a place facing a heading (nothing else holds it while it uses furniture). */
  moveTo(position: Vec3, heading: number): void;
  /** Sends an animation event to its graphs; whether one took it. */
  send(event: string): boolean;
}

/** A marker of a placed furniture, in the world. */
interface WorldMarker {
  readonly index: number;
  readonly position: Vec3;
  readonly heading: number;
  /** 1 sit, 2 sleep, 4 lean. */
  readonly animationType: number;
  /** FurnitureEntry: the ways in it allows. */
  readonly entries: number;
}

interface FurnitureInfo {
  readonly reference: number;
  readonly base: number;
  readonly markers: readonly WorldMarker[];
}

/** How an actor's graph moves it from an event on: its root motion and how long it takes. */
interface EventMotion {
  /** In the actor's frame where it began (x right, y forward). */
  readonly translation: readonly [number, number, number];
  /** Counter-clockwise radians. */
  readonly yaw: number;
  readonly seconds: number;
}

/** An actor in, entering or leaving furniture. */
interface Use extends ActorInteraction {
  state: number;
  quickEnter: boolean;
  quickExit: boolean;
  readonly worldMarker: WorldMarker;
  /**
   * approaching: on its way (its controller moves it); entering, leaving: its graph's root
   * motion moves it; in: held at the marker.
   */
  phase: 'approaching' | 'entering' | 'in' | 'leaving';
  /** Entering or leaving: seconds left of it, and how long it takes. */
  left: number;
  duration: number;
  /** The height of the floor it entered from (it leaves to it). */
  floor: number;
  /** The animation events it entered by, in order (an instant enter: two). */
  events: readonly string[];
}

export interface ActorFurnitureOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  /** An actor enters: its controller goes (its graph moves it until it stands again). */
  readonly release: (actor: number) => void;
  /** The enabled objects and markers of the loaded area (sandboxing actors use some). */
  readonly objects?: () => Iterable<StageObject>;
  /**
   * An idle played on a target is a paired one (pa_: a vampire's bite): the target plays its
   * side (src/shell/actor-combat.ts pairIdle).
   */
  readonly paired?: (actor: number, target: number, event: string) => void;
}

/** A placed object of the loaded area, as the view knows it. */
export interface StageObject {
  readonly reference: number;
  readonly base: number;
  readonly baseType: string;
  readonly position: readonly [number, number, number];
}

/** A cell's object as the stage knows it. */
export function stageObject(object: CellObject): StageObject {
  const { world } = object;
  return {
    reference: object.reference,
    base: object.base,
    baseType: object.baseType,
    position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
  };
}

/** What sandboxing makes of a base object (undefined: not used in a sandbox). */
interface SpotKind {
  readonly kind: SandboxSpot['kind'];
  readonly childCanUse: boolean;
}

/** KYWD FurnitureSpecial (Skyrim.esm): workbenches, forges, the wood chopping block, ... */
const FURNITURE_SPECIAL = 0x6e9c7;
/** Spots this far above or below a sandbox's centre are on another floor (units). */
const SPOT_HEIGHT = 160;
/** The event that ends an idle and returns the graph to its default state. */
const FORCE_DEFAULT_STATE = 'IdleForceDefaultState';

/** The engine's action of activating (AACT ActionActivate). */
const ACTION_ACTIVATE = 'ActionActivate';
/** What is left to the marker after an enter is made up in this long (seconds). */
const TWEEN_SECONDS = 0.25;
/** A dry run of a graph follows an event this long at most (seconds). */
const MOTION_SECONDS = 8;
/** Root motion slower than this counts as none (units per second). */
const STILL = 2;
/** An actor turns to where its enter begins for this long at most (seconds). */
const TURN_SECONDS = 2;

/** The FurnitureEntry flag as IsFurnitureEntryType names it. */
const entryType = (entry: number): number => entry << 16;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorFurniture {
  readonly #options: ActorFurnitureOptions;
  readonly #uses = new Map<number, Use>();
  /** Actors placed in furniture whose use is being set up (their controllers wait). */
  readonly #holding = new Set<number>();
  readonly #furniture = new Map<number, Promise<FurnitureInfo | undefined>>();
  readonly #motions = new Map<string, Promise<EventMotion | undefined>>();
  /** The idle marker each actor took. */
  readonly #markers = new Map<number, number>();
  readonly #kinds = new Map<number, Promise<SpotKind | undefined>>();
  #idleTree: Promise<IdleTree> | undefined;

  constructor(options: ActorFurnitureOptions) {
    this.#options = options;
  }

  /** What an actor uses now (its conditions and natives read it). */
  interaction(actor: number): ActorInteraction | undefined {
    return this.#uses.get(actor);
  }

  /** Whether furniture holds an actor: in, entering or leaving it (it has no controller). */
  holds(actor: number): boolean {
    if (this.#holding.has(actor)) return true;
    const use = this.#uses.get(actor);
    return use !== undefined && use.phase !== 'approaching';
  }

  /** Whether a furniture's marker (any marker, without one) is taken. */
  inUse(furniture: number, marker?: number): boolean {
    for (const use of this.#uses.values()) {
      if (use.furniture === furniture && (marker === undefined || use.marker === marker)) {
        return true;
      }
    }
    return false;
  }

  /** The actor left the stage, died or was moved: what it used is free at once. */
  remove(actor: number): void {
    this.#uses.delete(actor);
    this.#holding.delete(actor);
    this.#markers.delete(actor);
  }

  /**
   * The free furniture and idle markers within a radius of a point (and on its floor), that
   * sandboxing does not ignore (FURN FNAM, IDLM IDLF) and, for a child, that children may use.
   */
  async spots(center: Vec3, radius: number, child: boolean): Promise<SandboxSpot[]> {
    const found: SandboxSpot[] = [];
    const taken = new Set(this.#markers.values());
    for (const object of this.#options.objects?.() ?? []) {
      const [x, y, z] = object.position;
      if (Math.hypot(x - center[0], y - center[1]) > radius) continue;
      if (Math.abs(z - center[2]) > SPOT_HEIGHT) continue;
      if (object.baseType !== 'FURN' && object.baseType !== 'IDLM') continue;
      const kind = await this.#spotKind(object.base);
      if (!kind || (child && !kind.childCanUse)) continue;
      if (kind.kind === 'idle' ? taken.has(object.reference) : this.inUse(object.reference)) {
        continue;
      }
      found.push({ reference: object.reference, kind: kind.kind, position: [x, y, z] });
    }
    return found;
  }

  /** An actor takes an idle marker (false: another has it). */
  takeMarker(actor: number, marker: number): boolean {
    for (const [other, taken] of this.#markers) {
      if (taken === marker && other !== actor) return false;
    }
    this.#markers.set(actor, marker);
    return true;
  }

  /** An actor leaves the idle marker it took: its idle ends. */
  leaveMarker(user: FurnitureUser): void {
    if (!this.#markers.delete(user.reference)) return;
    user.send(FORCE_DEFAULT_STATE);
  }

  /**
   * Plays an idle (IDLE) on an actor's graph: its event if it has one and its conditions hold
   * (on the actor, its target), else the first of its children whose conditions hold (their
   * first, and so on). Whether an event was sent.
   */
  async playIdle(
    user: FurnitureUser,
    idle: number,
    target?: number,
    options: {
      /** A script's PlayIdle: it plays in furniture too (its graph takes it or not). */
      readonly inFurniture?: boolean;
      /** Those whose graphs get its event too (AddDependentAnimatedObjectReference). */
      readonly dependents?: readonly FurnitureUser[];
    } = {},
  ): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const tree = await this.#tree();
    const record = tree.idles.get(idle);
    if (!runtime || !record) return false;
    const subject = new ObjectHandle(user.reference, 'actor');
    const context = target === undefined ? {} : { target: runtime.referenceHandle(target) };
    if (!(await runtime.conditionsHold(record.conditions, subject, undefined, context))) {
      return false;
    }
    let event = record.event;
    if (event === undefined) {
      const graph = await this.#graphKey(user);
      if (graph === undefined) return false;
      const child = await tree.resolveAsync(idle, graph, (candidate) =>
        runtime.conditionsHold(candidate.conditions, subject, undefined, context),
      );
      event = child?.event;
    }
    if (event === undefined) return false;
    if (this.#uses.has(user.reference) && options.inFurniture !== true) return false;
    const sent = user.send(event);
    for (const dependent of options.dependents ?? []) dependent.send(event);
    if (sent && target !== undefined && event.toLowerCase().startsWith('pa_'))
      this.#options.paired?.(user.reference, target, event);
    return sent;
  }

  /**
   * Plays the idle an action gives with an item in use (ActionIdle and the food an actor eats:
   * EatingRoot's GetIsUsedItemType(Potion), then idleEatingStandingStart or ChairEatingStart);
   * whether one played.
   */
  useItem(user: FurnitureUser, item: number, action = 'ActionIdle'): Promise<boolean> {
    return this.playAction(user, action, new ObjectHandle(item, 'form'));
  }

  /**
   * Plays the idle an action (AACT) gives an actor now: the first of its idle tree for the
   * actor's graph whose conditions hold, on the actor and `target` (ActionBumpedInto: the
   * bump's direction). Whether one played.
   */
  async playAction(user: FurnitureUser, action: string, target?: ObjectHandle): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const tree = await this.#tree();
    const parent = tree.action(action);
    const graph = await this.#graphKey(user);
    if (!runtime || !parent || graph === undefined || this.#uses.has(user.reference)) {
      return false;
    }
    const subject = new ObjectHandle(user.reference, 'actor');
    const context = target === undefined ? {} : { target };
    const idle = await tree.resolveAsync(parent.formId, graph, (candidate) =>
      runtime.conditionsHold(candidate.conditions, subject, undefined, context),
    );
    return idle?.event !== undefined && user.send(idle.event);
  }

  /** What sandboxing makes of a base object, read once per base. */
  #spotKind(base: number): Promise<SpotKind | undefined> {
    let entry = this.#kinds.get(base);
    if (!entry) {
      entry = this.#readSpotKind(base).catch(() => undefined);
      this.#kinds.set(base, entry);
    }
    return entry;
  }

  async #readSpotKind(base: number): Promise<SpotKind | undefined> {
    const record = await (await this.#options.session.db).get(base);
    if (record?.type === 'IDLM') {
      const marker = parseIdleMarker(record);
      if ((marker.flags & IdleCollectionFlag.noSandbox) !== 0) return undefined;
      return { kind: 'idle', childCanUse: marker.childCanUse };
    }
    if (record?.type !== 'FURN') return undefined;
    const furniture = parseFurniture(record);
    if ((furniture.flags & FurnitureFlag.ignoredBySandbox) !== 0) return undefined;
    const childCanUse = (record.flags & IdleMarkerRecordFlag.childCanUse) !== 0;
    if (furniture.keywords.includes(FURNITURE_SPECIAL)) return { kind: 'special', childCanUse };
    // Its markers' kinds: the entry points (FNPR), else its "can" flags (MNAM).
    const types = new Set(furniture.entryPoints.map((entry) => entry.type));
    const flags = furniture.markerFlags ?? 0;
    const sits =
      types.has(FurnitureMarkerType.sit) ||
      types.has(FurnitureMarkerType.lean) ||
      (flags & (FurnitureMarkerFlag.canSit | FurnitureMarkerFlag.canLean)) !== 0;
    const sleeps =
      types.has(FurnitureMarkerType.sleep) || (flags & FurnitureMarkerFlag.canSleep) !== 0;
    if (sits) return { kind: 'sit', childCanUse };
    if (sleeps) return { kind: 'sleep', childCanUse };
    return undefined;
  }

  #tree(): Promise<IdleTree> {
    this.#idleTree ??= this.#options.session.db.then((db) => readIdleTree(db));
    return this.#idleTree;
  }

  /** The idle tree's key of an actor's behavior graph. */
  async #graphKey(user: FurnitureUser): Promise<string | undefined> {
    const project = user.placed.look.behavior;
    if (project === undefined) return undefined;
    const behaviors = await this.#options.session.animation.behaviors(project);
    const graphFile = behaviors?.character.behavior;
    return graphFile === undefined ? undefined : behaviorGraphKey(graphFile);
  }

  /**
   * Uses a furniture: picks its marker and entry, walks to where the enter begins (`walk`: the
   * actor's travel), turns (`face`), enters. Resolves whether it is in it. `quick`: placed in
   * it, it is in it at once (the instant idle). `types`: only markers of these animation types
   * (bits: 1 sit, 2 sleep, 4 lean).
   */
  async use(
    user: FurnitureUser,
    furniture: number,
    walk: (to: Vec3, arrive: number) => Promise<boolean>,
    face: (heading: number | undefined) => void,
    options: {
      readonly quick?: boolean;
      readonly types?: number;
      /** Its AI activates the furniture as it enters (its scripts get OnActivate). */
      readonly activates?: boolean;
    } = {},
  ): Promise<boolean> {
    const actor = user.reference;
    const quick = options.quick === true;
    if (quick) this.#holding.add(actor);
    try {
      const using = this.#uses.get(actor);
      if (using?.furniture === furniture && using.phase !== 'leaving') {
        // In it already, or on its way: it stays.
        return await this.#entered(actor, using);
      }
      if (using) await this.leave(user);
      const info = await this.#info(furniture);
      const chosen = info && this.#choose(info, user.position, options.types);
      if (!info || !chosen) return false;
      const { marker, entry } = chosen;
      const use: Use = {
        furniture,
        base: info.base,
        marker: marker.index,
        animationType: marker.animationType,
        entry: entryType(entry),
        state: 2,
        quickEnter: quick,
        quickExit: false,
        worldMarker: marker,
        phase: 'approaching',
        left: 0,
        duration: 0,
        floor: user.position[2],
        events: [],
      };
      this.#uses.set(actor, use);
      const event = await this.#idleEvent(user, furniture);
      use.events = event === undefined ? [] : [event];
      if (this.#uses.get(actor) !== use) return false;
      if (event === undefined) {
        this.#uses.delete(actor);
        return false;
      }
      if (quick) {
        // In it at once: at the marker, facing its way, its graph in the seated state. The
        // graphs take an instant idle (IdleChairEnterInstant) only within the furniture's own
        // state, which an enter takes them to: the enter it would have had goes first.
        use.quickEnter = false;
        const enter = await this.#idleEvent(user, furniture);
        use.quickEnter = true;
        if (this.#uses.get(actor) !== use) return false;
        use.events = enter === undefined || enter === event ? [event] : [enter, event];
        user.moveTo(marker.position, marker.heading);
        for (const sent of use.events) user.send(sent);
        this.#in(user, use);
        return true;
      }
      // Where the enter begins: its root motion ends at the marker.
      const motion = await this.#motion(user, event);
      const [tx, ty] = motion?.translation ?? [0, 0, 0];
      const heading = marker.heading + (motion?.yaw ?? 0);
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      const start: Vec3 = [
        marker.position[0] - (tx * cos + ty * sin),
        marker.position[1] - (-tx * sin + ty * cos),
        user.position[2],
      ];
      const arrived = await walk(start, 16);
      if (this.#uses.get(actor) !== use) return false;
      if (!arrived) {
        this.#uses.delete(actor);
        return false;
      }
      face(heading);
      for (let waited = 0; waited < TURN_SECONDS; waited += 0.1) {
        if (Math.abs(angle(user.heading, heading)) < 0.1) break;
        await sleep(0.1);
        if (this.#uses.get(actor) !== use) return false;
      }
      face(undefined);
      // Its graph moves it in from here.
      this.#options.release(actor);
      use.phase = 'entering';
      use.floor = user.position[2];
      use.duration = Math.max(motion?.seconds ?? 1, 0.5);
      use.left = use.duration;
      if (options.activates === true) {
        this.#options.session.scriptsReady?.actorActivated(furniture, actor);
      }
      user.send(event);
      return await this.#entered(actor, use);
    } catch (error) {
      this.#options.terminal.log(
        'actor',
        `${actor.toString(16)} using ${furniture.toString(16)}: ${describe(error)}`,
        'warn',
      );
      this.#uses.delete(actor);
      return false;
    } finally {
      if (quick) this.#holding.delete(actor);
    }
  }

  /**
   * Leaves the furniture: the exit idle, its root motion taking the actor out to the floor it
   * came from; then it stands. `quick`: out at once (the instant exit).
   */
  async leave(user: FurnitureUser, quick = false): Promise<void> {
    const actor = user.reference;
    const use = this.#uses.get(actor);
    if (!use) return;
    if (use.phase === 'approaching') {
      this.#uses.delete(actor);
      return;
    }
    if (use.phase === 'leaving') {
      while (this.#uses.get(actor) === use) await sleep(0.1);
      return;
    }
    use.state = 4;
    use.quickExit = quick;
    const event = await this.#idleEvent(user, use.furniture).catch(() => undefined);
    if (this.#uses.get(actor) !== use) return;
    const motion =
      event === undefined || quick ? undefined : await this.#motion(user, event, use.events);
    if (this.#uses.get(actor) !== use) return;
    if (event !== undefined) user.send(event);
    if (!motion) {
      this.#stood(user, use);
      return;
    }
    use.phase = 'leaving';
    use.duration = Math.max(motion.seconds, 0.3);
    use.left = use.duration;
    while (this.#uses.get(actor) === use) await sleep(0.1);
  }

  /**
   * After the skeletons animated: an actor entering or leaving moves by its graph's root motion
   * over `seconds` (no controller holds it), its height going to the marker's or back to the
   * floor's; one entering makes up the rest to the marker as its enter ends.
   */
  animated(user: FurnitureUser, seconds: number): void {
    const use = this.#uses.get(user.reference);
    if (!use || seconds <= 0 || (use.phase !== 'entering' && use.phase !== 'leaving')) return;
    const marker = use.worldMarker;
    const motion = user.placed.behavior?.rootMotion();
    let [x, y] = user.position;
    let heading = user.heading;
    if (motion) {
      const [mx, my] = motion.translation;
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      x += mx * cos + my * sin;
      y += -mx * sin + my * cos;
      heading -= motion.yaw;
    }
    use.left -= seconds;
    const done = Math.min(1, 1 - use.left / use.duration);
    if (use.phase === 'leaving') {
      const z = marker.position[2] + (use.floor - marker.position[2]) * done;
      user.moveTo([x, y, z], heading);
      if (use.left <= 0) this.#stood(user, use);
      return;
    }
    const z = use.floor + (marker.position[2] - use.floor) * done;
    if (use.left <= TWEEN_SECONDS) {
      // The tween: what is left to the marker, made up by the end.
      const share = Math.min(1, seconds / Math.max(use.left, seconds));
      x += (marker.position[0] - x) * share;
      y += (marker.position[1] - y) * share;
      heading += angle(heading, marker.heading) * share;
    }
    if (use.left <= 0) {
      user.moveTo(marker.position, marker.heading);
      this.#in(user, use);
      return;
    }
    user.moveTo([x, y, z], heading);
  }

  /** Waits until a use is in its furniture (true) or ends (false). */
  async #entered(actor: number, use: Use): Promise<boolean> {
    while (this.#uses.get(actor) === use && use.phase !== 'in') {
      if (use.phase === 'leaving') return false;
      await sleep(0.1);
    }
    return this.#uses.get(actor) === use;
  }

  /** It is in its furniture: its scripts hear OnSit. */
  #in(user: FurnitureUser, use: Use): void {
    use.state = 3;
    use.phase = 'in';
    this.#event(user.reference, 'OnSit', use.furniture);
  }

  /** It stands again (its controller comes back): its scripts hear OnGetUp. */
  #stood(user: FurnitureUser, use: Use): void {
    if (this.#uses.get(user.reference) !== use) return;
    this.#uses.delete(user.reference);
    this.#event(user.reference, 'OnGetUp', use.furniture);
  }

  #event(actor: number, event: 'OnSit' | 'OnGetUp', furniture: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    void runtime
      .sendEvent(actor, event, [runtime.referenceHandle(furniture)])
      .catch((error: unknown) => {
        runtime.vm.warn(`${event}: ${describe(error)}`);
      });
  }

  /** The free active marker of the types nearest the actor, and its entry that faces it. */
  #choose(
    info: FurnitureInfo,
    from: Vec3,
    types: number | undefined,
  ): { marker: WorldMarker; entry: number } | undefined {
    let best: { marker: WorldMarker; entry: number; distance: number } | undefined;
    for (const marker of info.markers) {
      if (types !== undefined && (marker.animationType & types) === 0) continue;
      if (this.inUse(info.reference, marker.index)) continue;
      const entry = facingEntry(marker, from);
      if (entry === undefined) continue;
      const distance = Math.hypot(marker.position[0] - from[0], marker.position[1] - from[1]);
      if (!best || distance < best.distance) best = { marker, entry, distance };
    }
    return best && { marker: best.marker, entry: best.entry };
  }

  /** A placed furniture's active markers in the world, read once. */
  #info(reference: number): Promise<FurnitureInfo | undefined> {
    let entry = this.#furniture.get(reference);
    if (!entry) {
      entry = this.#readInfo(reference).catch((error: unknown) => {
        this.#options.terminal.log(
          'actor',
          `furniture ${reference.toString(16)}: ${describe(error)}`,
          'warn',
        );
        return undefined;
      });
      this.#furniture.set(reference, entry);
    }
    return entry;
  }

  async #readInfo(reference: number): Promise<FurnitureInfo | undefined> {
    const session = this.#options.session;
    const runtime = session.scriptsReady;
    const db = await session.db;
    const at = await runtime?.placement(reference);
    const base = await runtime?.baseOf(reference);
    const record = base === undefined ? undefined : await db.get(base);
    if (!at || base === undefined || record?.type !== 'FURN') return undefined;
    const furniture = parseFurniture(record);
    const model = furniture.model === undefined ? undefined : meshPath(furniture.model);
    if (model === undefined || !session.vfs.has(model)) return undefined;
    const positions = furnitureMarkers(parseNif(await session.vfs.read(model)));
    const markers: WorldMarker[] = [];
    positions.forEach((position, index) => {
      if (!isMarkerActive(furniture, index)) return;
      // The root stays at the furniture's own height: its clips put the body on the seat, the
      // bed (the marker's height is the seat's they were made for: a chair's 34, a stool's 49).
      // TODO(M10) 3.5: furniture whose markers are high above it (a cart's seats, alcoves).
      const placed = markerPlacement(
        { position: at.position, rotation: at.rotation },
        position,
        false,
      );
      const allowed = furniture.entryPoints[index]?.entries ?? position.entryPoints;
      const disabled = markerData(furniture, index)?.disabledEntries ?? 0;
      markers.push({
        index,
        position: placed.position,
        heading: placed.heading,
        animationType: furniture.entryPoints[index]?.type ?? position.animationType,
        entries: allowed & ~disabled,
      });
    });
    return { reference, base, markers };
  }

  /**
   * The animation event the actor enters (state 2) or leaves (state 4) by: the idle the idle
   * tree gives under ActionActivate for its behavior graph, its conditions on the actor and the
   * furniture.
   */
  async #idleEvent(user: FurnitureUser, furniture: number): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    const tree = await this.#tree();
    const action = tree.action(ACTION_ACTIVATE);
    const graph = await this.#graphKey(user);
    if (!action || graph === undefined) return undefined;
    const subject = new ObjectHandle(user.reference, 'actor');
    const target = runtime.referenceHandle(furniture);
    const idle = await tree.resolveAsync(action.formId, graph, (candidate) =>
      runtime.conditionsHold(candidate.conditions, subject, undefined, { target }),
    );
    return idle?.event;
  }

  /**
   * How an actor's graph moves it after an event: a run of a fresh copy of its graph (no pose)
   * from its start, the event sent once it stands (after those of `after` have played: an
   * exit's enter), its root motion added up until it is still again. Read once per behavior
   * project, sex and events.
   */
  #motion(
    user: FurnitureUser,
    event: string,
    after: readonly string[] = [],
  ): Promise<EventMotion | undefined> {
    const look = user.placed.look;
    const project = look.behavior;
    if (project === undefined) return Promise.resolve(undefined);
    const events = [...after, event];
    const key = `${project}|${look.female ? 'f' : 'm'}|${events.join('>').toLowerCase()}`;
    let entry = this.#motions.get(key);
    if (!entry) {
      entry = this.#dryRun(project, look.female, events).catch((error: unknown) => {
        this.#options.terminal.log('actor', `${event}: ${describe(error)}`, 'warn');
        return undefined;
      });
      this.#motions.set(key, entry);
    }
    return entry;
  }

  async #dryRun(
    project: string,
    female: boolean,
    events: readonly string[],
  ): Promise<EventMotion | undefined> {
    const animation = this.#options.session.animation;
    const behaviors = await animation.behaviors(project);
    const rig = behaviors?.character.rig;
    const skeleton = rig === undefined ? undefined : await animation.havokSkeleton(rig);
    if (!behaviors || !skeleton) return undefined;
    const host = animation.host(behaviors, female);
    await animation.animationData();
    const runtime = new BehaviorRuntime({
      root: behaviors.root,
      host,
      skeleton,
      random: seededRandom(1),
      properties: { IsFemale: female ? 1 : 0, IsMale: female ? 0 : 1, IsNPC: 1 },
    });
    runtime.setVariable('IsNPC', 1);
    const step = 1 / 30;
    runtime.update(0, false);
    await host.loaded();
    for (let t = 0; t < 0.5; t += step) runtime.update(step, false);
    await host.loaded();
    let motion: EventMotion | undefined;
    for (const event of events) {
      runtime.sendEvent(event);
      motion = await this.#follow(runtime, host, step);
    }
    return motion;
  }

  /** Runs a graph until its root motion stops (or for MOTION_SECONDS): what it moved. */
  async #follow(
    runtime: BehaviorRuntime,
    host: { loaded(): Promise<void> },
    step: number,
  ): Promise<EventMotion> {
    let x = 0;
    let y = 0;
    let z = 0;
    let yaw = 0;
    let moved = 0;
    let still = 0;
    for (let t = 0; t < MOTION_SECONDS; t += step) {
      runtime.update(step, false);
      await host.loaded();
      const motion = runtime.rootMotion();
      const [mx, my, mz] = motion.translation;
      if (Math.hypot(mx, my) / step > STILL || Math.abs(motion.yaw) / step > 0.01) {
        // Into the frame where it began: turned by what it turned so far.
        const sin = Math.sin(-yaw);
        const cos = Math.cos(-yaw);
        x += mx * cos + my * sin;
        y += -mx * sin + my * cos;
        z += mz;
        yaw += motion.yaw;
        moved = t + step;
        still = 0;
      } else if (moved > 0 && (still += step) > 0.4) {
        break;
      }
    }
    return { translation: [x, y, z], yaw, seconds: moved };
  }
}

/** The entry of a marker that faces a point (the actor coming from there), if it has one. */
function facingEntry(marker: WorldMarker, from: Vec3): number | undefined {
  // Directions from the marker, by its heading: front ahead, behind, right, left.
  const toward = Math.atan2(from[0] - marker.position[0], from[1] - marker.position[1]);
  const options: [number, number][] = [
    [FurnitureEntry.front, 0],
    [FurnitureEntry.behind, Math.PI],
    [FurnitureEntry.right, Math.PI / 2],
    [FurnitureEntry.left, -Math.PI / 2],
  ];
  let best: number | undefined;
  let nearest = Infinity;
  for (const [entry, offset] of options) {
    if ((marker.entries & entry) === 0) continue;
    const off = Math.abs(angle(marker.heading + offset, toward));
    if (off < nearest) {
      nearest = off;
      best = entry;
    }
  }
  if (best === undefined && (marker.entries & FurnitureEntry.up) !== 0) return FurnitureEntry.up;
  return best;
}

const angle = (from: number, to: number): number => {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
};

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
