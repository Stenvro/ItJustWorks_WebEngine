// The AI of the actors of the loaded area (docs/ai.md, "Packages"): every living actor that
// moves by itself (src/shell/actor-movers.ts) runs its AI packages (src/ai/package-runtime.ts,
// the procedures: src/ai/procedure-runs.ts) once the running game's scripts are there: the
// game's time, quests and scripts choose its package; its controller goes where the package
// sends it. The scripts hear of it (OnPackageStart, OnPackageChange, OnPackageEnd and the
// packages' own fragments) and ask after it (GetCurrentPackage, EvaluatePackage).

import {
  ActorPackages,
  type PackageBody,
  type PackageMind,
  type PackagePlace,
} from '../ai/package-runtime.ts';
import { LocationType, TargetType, type PackageRecord } from '../ai/package-records.ts';
import { PROCEDURES } from '../ai/procedure-runs.ts';
import { isOfObjectType, ObjectType } from '../ai/object-types.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { parseIdleMarker } from '../ai/idle-records.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { ObjectHandle } from '../scripting/values.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { seededRandom } from '../world/actors.ts';
import type { Vec3 } from '../render/math.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { ActorSearch } from './actor-search.ts';
import { spaceOf, type AwayPlace } from './actors-away.ts';
import { findRoute, type RouteDoor } from '../ai/routes.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { Gait } from '../ai/locomotion.ts';
import type { Space } from '../ai/package-start.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';

/** An "in cell" place reaches this far round where the actor is (game units). */
const IN_CELL_RADIUS = 1024;
/** A target named by object or object type is the nearest within this of the actor. */
const TARGET_SEARCH_RADIUS = 4096;
/** The size of an exterior cell (units). */
const CELL_SIZE = 4096;
/** A way to another space that failed holds its package this long (milliseconds). */
const ACROSS_FAILED_MS = 1000;
/** An actor goes through a load door within this of it (units). */
const DOOR_REACH = 96;
/** LockDoors and UnlockDoors reach doors this far round a place without a radius. */
const DOOR_RADIUS = 256;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorAi {
  readonly #session: GameSession;
  readonly #movers: ActorMovers;
  readonly #furniture: ActorFurniture;
  readonly #search: ActorSearch;
  readonly #userOf: (staged: StagedActor) => FurnitureUser;
  readonly #leaveThrough: (
    staged: StagedActor,
    door: RouteDoor,
    destination: AwayPlace,
  ) => Promise<void>;
  readonly #navmeshes: (() => NavmeshSet | undefined) | undefined;
  /** The actors talking with the player now (their packages wait). */
  readonly #talking = new Set<number>();
  /** A food for meals made up (Eat's Create Fake Food): the first in the load order. */
  #fakeFood: Promise<number | undefined> | undefined;
  readonly #actors = new Map<number, { packages: ActorPackages; staged: StagedActor }>();
  readonly #mind: PackageMind;

  constructor(options: {
    readonly session: GameSession;
    readonly movers: ActorMovers;
    readonly furniture: ActorFurniture;
    readonly search: ActorSearch;
    readonly userOf: (staged: StagedActor) => FurnitureUser;
    /** An actor goes through a load door on its way to a place (it leaves the stage). */
    readonly leaveThrough: (
      staged: StagedActor,
      door: RouteDoor,
      destination: AwayPlace,
    ) => Promise<void>;
    /** The navigation meshes of the loaded area. */
    readonly navmeshes?: () => NavmeshSet | undefined;
  }) {
    this.#session = options.session;
    this.#movers = options.movers;
    this.#furniture = options.furniture;
    this.#search = options.search;
    this.#userOf = options.userOf;
    this.#leaveThrough = options.leaveThrough;
    this.#navmeshes = options.navmeshes;
    this.#mind = this.#makeMind();
  }

  /** The package running for an actor now (GetCurrentPackage), if its AI runs. */
  current(reference: number): { id: number; procedure: string | undefined } | undefined {
    return this.#actors.get(reference)?.packages.current;
  }

  /** EvaluatePackage: the actor chooses its package again. */
  evaluate(reference: number): void {
    this.#actors.get(reference)?.packages.evaluate();
  }

  /** The actor leaves its AI (it left the stage, died). */
  remove(reference: number): void {
    const entry = this.#actors.get(reference);
    if (!entry) return;
    entry.packages.stop();
    this.#actors.delete(reference);
  }

  /**
   * Every frame (real seconds): the actors of the high process run their packages; those that
   * no longer are (far, dead, gone) leave them.
   */
  frame(actors: Iterable<StagedActor>, seconds: number, player?: Vec3): void {
    const runtime = this.#session.scriptsReady;
    const live = new Set<number>();
    const speaker = runtime?.dialogueSpeaker;
    for (const staged of actors) {
      if (!runtime || staged.dead || !this.#movers.runsAi(staged.reference)) continue;
      live.add(staged.reference);
      let entry = this.#actors.get(staged.reference);
      if (entry?.staged !== staged) {
        entry?.packages.stop();
        entry = {
          staged,
          packages: new ActorPackages(
            staged.reference,
            this.#mind,
            this.#body(staged),
            PROCEDURES,
            seededRandom(staged.reference ^ 0x2545f491),
          ),
        };
        this.#actors.set(staged.reference, entry);
      }
      // Talking with the player (the engine's in-game dialogue package): its package waits; it
      // stops where it is and faces the player (sitting, it stays seated).
      const reference = staged.reference;
      if (speaker === reference) {
        if (!this.#talking.has(reference)) {
          this.#talking.add(reference);
          this.#movers.stop(reference);
        }
        if (player && !this.#furniture.holds(reference)) {
          const heading = Math.atan2(
            player[0] - staged.position[0],
            player[1] - staged.position[1],
          );
          this.#movers.request(reference, { gait: 'walk', face: heading });
        }
        continue;
      }
      if (this.#talking.delete(reference)) {
        this.#movers.request(reference, undefined);
        entry.packages.evaluate();
      }
      entry.packages.update(seconds);
    }
    for (const reference of [...this.#actors.keys()]) {
      if (!live.has(reference)) this.remove(reference);
    }
  }

  /**
   * What an actor's packages move: its controller (travel, stop, turning) and the furniture
   * it uses (it gets up before it goes anywhere).
   */
  #body(staged: StagedActor): PackageBody {
    const movers = this.#movers;
    const furniture = this.#furniture;
    const reference = staged.reference;
    const user = this.#userOf(staged);
    const face = (heading: number | undefined): void => {
      movers.request(
        reference,
        heading === undefined ? undefined : { gait: 'walk', face: heading },
      );
    };
    return {
      reference,
      position: () => staged.position,
      heading: () => staged.heading,
      travel: async (to, gait, arrive, space) => {
        await furniture.leave(user);
        if (space && !(await this.#inSpace(reference, space))) {
          if (await this.#across(staged, { space, position: to }, gait)) return true;
          // No way there (or it went through a door): a moment before its package goes on, so
          // nothing that asks again at once runs round without end.
          await new Promise((resolve) => setTimeout(resolve, ACROSS_FAILED_MS));
          return false;
        }
        return movers.travel(reference, to, gait, arrive);
      },
      stop: () => {
        movers.stop(reference);
      },
      face,
      useFurniture: (target, types) =>
        furniture.use(
          user,
          target,
          (to, arrive) => movers.travel(reference, to, 'walk', arrive),
          face,
          types === undefined ? {} : { types },
        ),
      leaveFurniture: () => furniture.leave(user),
      takeIdleMarker: (marker) => furniture.takeMarker(reference, marker),
      leaveIdleMarker: () => {
        furniture.leaveMarker(user);
      },
      playIdle: (idle) => furniture.playIdle(user, idle),
      say: (topic) => {
        // TODO(M10) 4.3: a topic subtype's line (the dialogue engine picks among its topics).
        if (typeof topic === 'number')
          this.#session.scriptsReady?.say(reference, topic, undefined, false);
      },
      standing: () =>
        movers.moves(reference) &&
        movers.travelOf(reference) === undefined &&
        movers.requestOf(reference) === undefined &&
        !furniture.holds(reference),
      activate: async (target) => {
        const scripts = this.#session.scriptsReady;
        if (!scripts) return false;
        // Furniture activated is furniture used.
        const base = await scripts.baseOf(target);
        const record = base === undefined ? undefined : await scripts.forms.record(base);
        if (record?.type === 'FURN') {
          return furniture.use(
            user,
            target,
            (to, arrive) => movers.travel(reference, to, 'walk', arrive),
            face,
          );
        }
        return scripts.activate(target, reference, false);
      },
      take: async (target) => {
        const scripts = this.#session.scriptsReady;
        if (!scripts) return false;
        await scripts.pickUp(target, reference);
        return true;
      },
      useItem: async (item, consume) => {
        const scripts = this.#session.scriptsReady;
        if (!(await furniture.useItem(user, item))) return false;
        if (consume) await scripts?.removeItem(reference, item, 1, true, undefined);
        return true;
      },
      greet: (topic) => {
        const scripts = this.#session.scriptsReady;
        const menus = this.#session.hud.menus;
        if (!scripts || !menus || scripts.dialogueSpeaker !== undefined) return false;
        menus.talk(staged.placed, topic);
        return true;
      },
    };
  }

  /** A place in a cell: an exterior cell's middle, an interior's navmeshes. */
  async #cellPlace(cell: number, radius: number): Promise<PackagePlace | undefined> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return undefined;
    const world = scripts.forms.db.worldOfCell(cell);
    if (world !== undefined) {
      const xclc = (await scripts.forms.record(cell))?.fields.first('XCLC');
      if (!xclc || xclc.length < 8) return undefined;
      const grid = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
      const x = (grid.getInt32(0, true) + 0.5) * CELL_SIZE;
      const y = (grid.getInt32(4, true) + 0.5) * CELL_SIZE;
      return { position: [x, y, 0], radius, space: { kind: 'world', world } };
    }
    const routes = await this.#session.routeMap();
    const space: Space = { kind: 'interior', cell };
    const navmesh = routes.nearestNavmesh(space, [0, 0, 0]);
    const position = navmesh === undefined ? undefined : routes.location(navmesh);
    return position && { position, radius, space };
  }

  /** Whether an actor is in a space now. */
  async #inSpace(actor: number, space: Space): Promise<boolean> {
    const at = await this.#session.scriptsReady?.placement(actor);
    if (!at) return true;
    const here = spaceOf(at);
    return here.kind === 'world'
      ? space.kind === 'world' && here.world === space.world
      : space.kind === 'interior' && here.cell === space.cell;
  }

  /**
   * To a place in another cell or worldspace: along its route (src/ai/routes.ts) to the first
   * load door, through it (src/shell/actor-stage.ts: it leaves the stage; the low process or
   * the other side's stage goes on). False: no way there, or it left (its package goes on
   * where it comes out).
   */
  async #across(staged: StagedActor, destination: AwayPlace, gait: Gait): Promise<boolean> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const at = await runtime?.placement(staged.reference);
    if (!runtime || !at) return false;
    const routes = await session.routeMap();
    const here = spaceOf(at);
    const start =
      this.#navmeshes?.()?.locate(staged.position)?.navmesh.formId ??
      routes.nearestNavmesh(here, staged.position);
    const end = routes.nearestNavmesh(destination.space, destination.position);
    if (start === undefined || end === undefined) return false;
    const route = findRoute(
      routes,
      { space: here, position: staged.position, navmesh: start },
      { ...destination, navmesh: end },
    );
    const door = route?.doors[0];
    if (!door) return false;
    const arrived = await this.#movers.travel(staged.reference, door.position, gait, DOOR_REACH);
    if (!arrived) return false;
    await this.#leaveThrough(staged, door, destination);
    return false;
  }

  /** What the packages ask of the game: the running game's scripts and records. */
  #makeMind(): PackageMind {
    const session = this.#session;
    const runtime = (): ScriptRuntime | undefined => session.scriptsReady;
    /** Where a reference is, in its cell or worldspace (the way there may be through doors). */
    const placementOf = async (
      reference: number,
    ): Promise<{ position: Vec3; heading: number; space: Space } | undefined> => {
      const at = await runtime()?.placement(reference);
      return at && { position: [...at.position], heading: at.rotation[2], space: spaceOf(at) };
    };
    const staged = (actor: number): StagedActor | undefined => this.#actors.get(actor)?.staged;
    /** The reference an alias of a quest holds now. */
    const aliasReference = (quest: number | undefined, alias: number): number | undefined =>
      quest === undefined ? undefined : runtime()?.state.quests.get(quest)?.aliases.get(alias);
    return {
      time: () => session.gameTime(),
      day: () => Math.floor(session.gameDaysPassed),
      package: async (formId) => (await session.packageData()).package(formId),
      packagesOf: async (actor) => {
        const data = await session.packageData();
        const own = staged(actor)?.placed.look.packages ?? [];
        // The packages of the quest aliases that hold it first, by quest priority.
        const aliases = runtime()
          ? await data.aliasPackages({
              reference: actor,
              base: 0,
              npc: 0,
              race: 0,
              female: false,
              factions: new Map(),
              packages: own,
              space: { kind: 'interior', cell: 0 },
              linked: () => undefined,
            })
          : [];
        // Its default package list (NPC_ DPLT: a form list of packages) after its own.
        const list = staged(actor)?.placed.look.defaultPackages;
        const defaults = list === undefined ? [] : ((await runtime()?.formList(list)) ?? []);
        return [...(aliases ?? []), ...own, ...defaults];
      },
      conditionsHold: async (conditions, actor, data) => {
        const scripts = runtime();
        if (!scripts || conditions.length === 0) return true;
        return scripts.conditionsHold(conditions, new ObjectHandle(actor, 'actor'), undefined, {
          packageData: (input) => {
            const value = data.inputs.get(input)?.value;
            if (value?.kind === 'bool') return value.value ? 1 : 0;
            if (value?.kind === 'int' || value?.kind === 'float') return value.value;
            return value === undefined ? undefined : 'none';
          },
          packageTarget: (input) => {
            const value = data.inputs.get(input)?.value;
            return value?.kind === 'singleRef' && value.target.type === TargetType.specificReference
              ? value.target.value
              : undefined;
          },
        });
      },
      place: async (location, actor, context) => {
        const scripts = runtime();
        const self = staged(actor);
        switch (location.type) {
          case LocationType.nearReference: {
            const at = await placementOf(location.form);
            return at && { ...at, radius: location.radius, reference: location.form };
          }
          case LocationType.nearLinkedReference: {
            const linked = await scripts?.linkedReference(actor, location.form);
            const at = linked === undefined ? undefined : await placementOf(linked);
            return at && { ...at, radius: location.radius, reference: linked };
          }
          case LocationType.nearEditorLocation: {
            const at = await scripts?.editorPlacement(actor);
            // Its editor location may be in another space (its home, while it is at the inn).
            const db = scripts?.forms.db;
            const cell = db?.cellOfReference(actor);
            const world = cell === undefined ? undefined : db?.worldOfCell(cell);
            return (
              at && {
                position: [...at.position],
                radius: location.radius,
                heading: at.rotation[2],
                ...(cell !== undefined && { space: spaceOf({ cell, world }) }),
              }
            );
          }
          case LocationType.inCell: {
            // Anywhere in the cell: round the actor, if it is in that cell.
            const at = await scripts?.placement(actor);
            if (self && at?.cell === location.form) {
              return { position: self.position, radius: Math.max(location.radius, IN_CELL_RADIUS) };
            }
            // Another cell: into it (an exterior cell's middle; inside, where its navmeshes are).
            return this.#cellPlace(location.form, Math.max(location.radius, IN_CELL_RADIUS));
          }
          // Where it was as the package began.
          case LocationType.nearPackageStart: {
            const start = context.start ?? self?.position;
            return start && { position: [...start], radius: location.radius };
          }
          case LocationType.nearSelf:
            return self && { position: self.position, radius: location.radius };
          // The reference an alias of the package's quest holds.
          case LocationType.aliasReference: {
            const held = aliasReference(context.quest, location.form);
            const at = held === undefined ? undefined : await placementOf(held);
            return at && { ...at, radius: location.radius, reference: held };
          }
          default:
            // TODO(M10) 3.2: an alias's location (LCTN: where in it), and objects or object
            // types as places (no vanilla package uses either).
            return undefined;
        }
      },
      target: async (target, actor, context) => {
        const scripts = runtime();
        switch (target.type) {
          case TargetType.specificReference:
            return target.value === 0 ? undefined : target.value;
          case TargetType.linkedReference:
            return scripts?.linkedReference(actor, target.value);
          case TargetType.referenceAlias:
            return aliasReference(context.quest, target.value);
          case TargetType.self:
            return actor;
          case TargetType.objectId:
          case TargetType.objectType: {
            // The nearest of them round the actor.
            const self = staged(actor);
            if (!self) return undefined;
            const found = await this.#search.find(target, {
              actor,
              from: self.position,
              center: self.position,
              radius: TARGET_SEARCH_RADIUS,
            });
            return found[0];
          }
          default:
            return undefined;
        }
      },
      carried: async (actor, criteria) => {
        const scripts = runtime();
        if (!scripts) return undefined;
        const db = scripts.forms.db;
        const listed =
          criteria.type === TargetType.objectId
            ? new Set(await scripts.formList(criteria.value))
            : undefined;
        for (const [item, count] of await scripts.inventory(actor)) {
          if (count <= 0) continue;
          if (criteria.type === TargetType.objectId) {
            if (item === criteria.value || listed?.has(item)) return item;
          } else if (criteria.type === TargetType.objectType) {
            const record = await db.get(item);
            if (record && isOfObjectType(criteria.value, record)) return item;
          }
        }
        return undefined;
      },
      fakeFood: () => {
        this.#fakeFood ??= session.db.then(async (db) => {
          for (const formId of db.formIdsOfType('ALCH')) {
            const record = await db.get(formId);
            if (record && isOfObjectType(ObjectType.food, record)) return formId;
          }
          return undefined;
        });
        return this.#fakeFood;
      },
      lockDoors: async (place, locked) => {
        const scripts = runtime();
        if (!scripts) return;
        const doors = await this.#search.find(
          { type: TargetType.objectType, value: ObjectType.doors, count: 0 },
          {
            actor: PLAYER_REF,
            from: place.position,
            center: place.position,
            radius: Math.max(place.radius, DOOR_RADIUS),
            steal: true,
          },
        );
        // Its load doors (XTEL): an actor locks its home, not the doors within it. TODO(M13):
        // the engine's choice of doors.
        for (const door of doors) {
          if ((await scripts.forms.record(door))?.fields.has('XTEL')) {
            await scripts.setLocked(door, locked);
          }
        }
      },
      search: (criteria, place, actor, steal) => {
        const self = staged(actor);
        return this.#search.find(criteria, {
          actor,
          from: self?.position ?? place.position,
          center: place.position,
          radius: place.radius,
          steal,
        });
      },
      placement: placementOf,
      linked: async (reference, keyword) => runtime()?.linkedReference(reference, keyword),
      around: (center, radius, actor) => {
        const flags = staged(actor)?.placed.look.raceFlags ?? 0;
        return this.#furniture.spots(center, radius, (flags & RaceFlag.child) !== 0);
      },
      idleMarker: async (reference) => {
        const scripts = runtime();
        const base = await scripts?.baseOf(reference);
        const record = base === undefined ? undefined : await scripts?.forms.record(base);
        const at = await placementOf(reference);
        if (record?.type !== 'IDLM' || !at) return undefined;
        return { ...parseIdleMarker(record), reference, ...at };
      },
      packageEvent: (actor, event, pack) => {
        void this.#packageEvent(actor, event, pack);
      },
    };
  }

  /**
   * The scripts hear of a package: the actor's OnPackageStart (the new package), OnPackageChange
   * (the one left), OnPackageEnd (one that ended), and the package's own fragments (begin as it
   * starts, change as it is left, end as it ends).
   */
  async #packageEvent(
    actor: number,
    event: 'begin' | 'change' | 'end',
    pack: PackageRecord,
  ): Promise<void> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return;
    try {
      const handle = (record: PackageRecord): ObjectHandle =>
        new ObjectHandle(record.formId, 'package');
      if (event === 'begin') {
        await scripts.sendEvent(actor, 'OnPackageStart', [handle(pack)]);
      } else if (event === 'change') {
        await scripts.sendEvent(actor, 'OnPackageChange', [handle(pack)]);
      } else {
        await scripts.sendEvent(actor, 'OnPackageEnd', [handle(pack)]);
      }
      const attachments = await scripts.forms.attachments(pack.formId);
      for (const fragment of attachments?.fragments ?? []) {
        if (fragment.stage !== event) continue;
        await scripts.vm.call(new ObjectHandle(pack.formId, fragment.script), fragment.function, [
          scripts.referenceHandle(actor),
        ]);
      }
    } catch (error) {
      scripts.vm.warn(`package ${pack.editorId}: ${describe(error)}`);
    }
  }
}
