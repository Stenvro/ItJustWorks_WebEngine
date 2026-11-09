// The headless simulation for interaction cases (docs/conformance.md): a new game on the local
// game data with no screen, its world opened in a named cell at a game time, stepped at a fixed
// time step, the player driven by actions, and what happened read from a typed log. Integration
// suites that use it skip without game data (hasGamedata).
//
//   const sim = await openSim({ interior: 0x1605e, hour: 8 });
//   await sim.setStage(quest, 10);
//   sim.activate(lever);
//   await sim.step(2);
//   expect(sim.scriptEvents({ event: 'OnActivate', target: lever })).toHaveLength(1);
//   sim.close();

import { afterAll } from 'vitest';
import { findPath } from '../../src/ai/pathfinding.ts';
import { WeaponState } from '../../src/gameplay/combat/combat-state.ts';
import { Layer } from '../../src/physics/collision-layers.ts';
import { readGameSave, restoreAmbience, saveGame } from '../../src/save/game-save.ts';
import type { SpokenInfo, TopicChoice } from '../../src/scripting/runtime/dialogue-engine.ts';
import { afterInfo } from '../../src/scripting/runtime/dialogue-rules.ts';
import type { GameEvents } from '../../src/scripting/runtime/event-hub.ts';
import { PLAYER_REF } from '../../src/scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../../src/scripting/runtime/runtime.ts';
import type { ObjectHandle, Value } from '../../src/scripting/values.ts';
import type { StagedActor } from '../../src/shell/actor-stage.ts';
import { barterModel } from '../../src/shell/barter-menu.ts';
import { craftingModel, workbenchOf } from '../../src/shell/crafting-models.ts';
import { openBookUnseen } from '../../src/shell/book-reading.ts';
import { fastTravelJourney, fastTravelWay } from '../../src/shell/fast-travel-journey.ts';
import { giftModel } from '../../src/shell/gift-menu.ts';
import { containerModel } from '../../src/shell/container-menu.ts';
import { inventoryModel } from '../../src/shell/inventory-menu.ts';
import {
  LockPick,
  lockOpened,
  pickBroke,
  pickSetup,
  tryLock,
} from '../../src/shell/lock-picking.ts';
import { passHours } from '../../src/shell/sleep-wait-menu.ts';
import type { SimRecord } from '../../src/sim/sim-log.ts';
import { SIM_STEP, SimWorld } from '../../src/sim/sim-world.ts';
import { Vfs } from '../../src/vfs/vfs.ts';
import type { RecordDatabase } from '../../src/world/record-db.ts';
import { InfoFlag } from '../../src/world/dialogue-records.ts';
import type { Arrival } from '../../src/world/worldspace.ts';
import { openGameFolder } from '../../tools/gamedata-path.ts';

export { hasGamedata } from '../../tools/gamedata-path.ts';
export { PLAYER_REF, SIM_STEP };

type Vec3 = [number, number, number];

/** Where the simulation opens, and when. */
export interface OpenOptions {
  /** An interior cell (form id). */
  readonly interior?: number;
  /** An exterior: a worldspace (form id) and a cell of it (grid x, y). */
  readonly exterior?: { readonly world: number; readonly cell: readonly [number, number] };
  /** Where the player arrives (else as through the cell's door / near the exterior cell). */
  readonly arrival?: Arrival;
  /** The game hour (0..24) set before the place opens (its actors start where it has them). */
  readonly hour?: number;
  /** Whole days passed since the game's start, set with the hour. */
  readonly day?: number;
  /** The new game runs its opening (Unbound); default: the main menu's coc start. */
  readonly opening?: boolean;
  /** The seed of the simulation's dice. */
  readonly seed?: number;
  /** Exterior cells loaded on each side of the player's (default 2, uGridsToLoad 5). */
  readonly gridRadius?: number;
  /**
   * The game files' reads come back up to this many event-loop turns late, at random (a disk
   * whose timing varies: what the simulation does must not change with it).
   */
  readonly scrambleReads?: number;
}

/** A package an actor runs now. */
export interface RunningPackage {
  readonly id: number;
  readonly procedure: string | undefined;
}

/** Invisible Continue infos said one after another at most (as the dialogue menu). */
const MAX_CONTINUES = 32;
/** The longest a conversation's step (a line's fragments) is waited for, in seconds. */
const LINE_SECONDS = 30;

/** The player's radius on the navmeshes (a human's collision capsule). */
const PLAYER_RADIUS = 20;
/**
 * The player's ways: their radius, and ledges no higher than their jump (fJumpHeightMin's 76):
 * a ledge-up link the navmesh gives for a drop (the Ratway Warrens' drop-down room) is no way up.
 */
const WAY = { radius: PLAYER_RADIUS, ledgeUp: 76 } as const;
/**
 * How near a corner of the way counts as there. Less than the way's radius, the room it keeps from
 * the navmesh's edge: cutting a corner by more walked the player over a ledge beside it.
 */
const CORNER_REACH = PLAYER_RADIUS / 2;
/** How near a corner they are held before the way goes on from there (units). */
const HELD_CORNER_REACH = 24;
/** How far across a walked-to point may lie from the navmesh under it. */
const PATH_GOAL_REACH = 256;
/** A door the player is held up by is within this of their feet (across). */
const DOOR_REACH = 160;
/** How far the player steps aside round someone standing in their way (doubling each time). */
const SIDESTEP = 48;
/**
 * Held up this far beside a closed door's centre (across the doorway), the player steps back
 * in front of it, this far from it, before opening it (units): out of the leaf's swing.
 */
const DOORWAY_ASIDE = 40;
const DOORWAY_STAND = 140;
/** How long a door opened in the way is waited for to stand open (s). */
const DOOR_SWING_WAIT = 3;
/**
 * Held up at one point this many times (stepped aside each time, and back into the same spot: an
 * open door's leaf against a wall), the player looks for their way again from where they stand.
 */
const HELD_SEARCH_AGAIN = 3;
/** This far under the way they were walking (a step down is far less), the player fell off it. */
const FELL_OFF_THE_WAY = 128;

/** The height of a way's step (`from` to `to`) nearest a place. */
function wayHeightAt(from: readonly number[], to: readonly number[], x: number, y: number): number {
  const toZ = to[2] ?? 0;
  const [fx = 0, fy = 0, fz = 0] = from;
  const dx = (to[0] ?? 0) - fx;
  const dy = (to[1] ?? 0) - fy;
  const t = ((x - fx) * dx + (y - fy) * dy) / (dx * dx + dy * dy || 1);
  return fz + (toZ - fz) * Math.min(1, Math.max(0, t));
}
/** Held up off the navmesh with the way on this much above the feet, the player jumps. */
const JUMP_OUT = 16;
/** What holds the player up is looked for this far ahead, this high above the feet. */
const WAY_REACH = 150;
const WAY_HEIGHT = 40;
/**
 * Blows at most at a destructible object in the way: the attack button held this long (a
 * weapon's power attack, a concentration spell's stream), then let go this long.
 */
const BREAK_BLOWS = 10;
const BLOW_HOLD = 1;
const BREAK_PAUSE = 0.8;
/** The player's eyes above their feet, as they aim a blow (units; ours). */
const EYE_HEIGHT = 110;
/** Seconds a weapon or spell takes to be drawn. */
const DRAW_WAIT = 1.5;
/** The user events of the player's right hand and of drawing it. */
const RIGHT_ATTACK = 'Right Attack/Block';
const READY_WEAPON = 'Ready Weapon';
/** Seconds a pulled chain or lever is given to open what it works (a portcullis rising). */
const PULL_WAIT = 3;

/** The global GameHour (Skyrim.esm): the clock, as scripts set it. */
const GAME_HOUR = 0x38;
/** The global GameDaysPassed (Skyrim.esm). */
const GAME_DAYS_PASSED = 0x39;

/** Opens the simulation: a new game, then the place (if given). Close it when done. */
export async function openSim(options: OpenOptions = {}): Promise<Sim> {
  const folder = openGameFolder();
  folder.reads.scramble = options.scrambleReads ?? 0;
  const vfs = await Vfs.mount(folder);
  const world = await SimWorld.create({
    vfs,
    reads: folder.reads,
    ...(options.opening !== undefined && { opening: options.opening }),
    ...(options.seed !== undefined && { seed: options.seed }),
    ...(options.gridRadius !== undefined && { gridRadius: options.gridRadius }),
  });
  const sim = new Sim(world, vfs, await world.session.db);
  if (options.day !== undefined) sim.setDay(options.day);
  if (options.hour !== undefined) sim.setHour(options.hour);
  // The clock as set reaches the session before the place opens.
  await world.step(0);
  if (options.interior !== undefined) await sim.openInterior(options.interior, options.arrival);
  else if (options.exterior) {
    await world.openExterior(
      options.exterior.world,
      options.arrival ? { arrival: options.arrival } : { cell: options.exterior.cell },
    );
  }
  return sim;
}

/**
 * Loads a save into a fresh simulation (docs/formats/save.md): the plugins' world, the save's
 * game state, the player put down where they stood (their cell or worldspace), the weather.
 */
export async function loadSim(
  bytes: Uint8Array,
  options: { readonly seed?: number; readonly gridRadius?: number } = {},
): Promise<Sim> {
  const { header, save } = await readGameSave(bytes);
  const folder = openGameFolder();
  const vfs = await Vfs.mount(folder);
  const world = await SimWorld.create({
    vfs,
    reads: folder.reads,
    load: { save, header },
    ...(options.seed !== undefined && { seed: options.seed }),
    ...(options.gridRadius !== undefined && { gridRadius: options.gridRadius }),
  });
  const sim = new Sim(world, vfs, await world.session.db);
  await world.step(0);
  const player = save.player;
  const arrival: Arrival = { position: player.position, heading: player.rotation[2] };
  const db = sim.db;
  const interior =
    player.cell !== undefined && db.worldOfCell(player.cell) === undefined
      ? player.cell
      : undefined;
  if (interior !== undefined) await world.openInterior(interior, arrival);
  else if (player.world !== undefined) await world.openExterior(player.world, { arrival });
  restoreAmbience(world.runtime, save);
  return sim;
}

/**
 * The sims not closed yet. A test file's are closed as it ends: one left open would have its
 * file handles closed by the garbage collector, an error in whichever file runs by then.
 */
const openSims = new Set<Sim>();
afterAll(async () => {
  for (const sim of [...openSims]) await sim.close();
});

export class Sim {
  readonly world: SimWorld;
  readonly db: RecordDatabase;
  readonly #vfs: Vfs;
  /** Editor ids by record type, read once per type (lookups by name). */
  readonly #editorIds = new Map<string, Map<string, number>>();
  /** The conversation the player holds: its speaker and the topics listed now. */
  #conversation: { readonly speaker: number; choices: TopicChoice[] } | undefined;
  /** The dialogue menus answered so far (index into the menu records). */
  #menusSeen = 0;

  constructor(world: SimWorld, vfs: Vfs, db: RecordDatabase) {
    openSims.add(this);
    this.world = world;
    this.#vfs = vfs;
    this.db = db;
  }

  get runtime(): ScriptRuntime {
    return this.world.runtime;
  }

  /** Seconds the simulation has run. */
  get time(): number {
    return this.world.time;
  }

  /** Saves the game as it is now (the save file's bytes). */
  async save(name = 'Save 1'): Promise<Uint8Array> {
    const { bytes } = await saveGame(this.runtime, { name, kind: 'save', number: 1, now: 0 });
    return bytes;
  }

  // --- Places and time ----------------------------------------------------------------------

  openInterior(cell: number, arrival?: Arrival): Promise<void> {
    return this.world.openInterior(cell, arrival);
  }

  openExterior(world: number, cell: readonly [number, number]): Promise<void> {
    return this.world.openExterior(world, { cell });
  }

  /**
   * Opens the place the scripts put the player in, as Play does after a new game: the opening
   * (MQ101's stage 10) moves the player onto the cart before any place is open.
   */
  async openAtPlayer(): Promise<void> {
    const at = await this.runtime.placement(PLAYER_REF);
    if (!at) throw new Error('The player has no place');
    const arrival: Arrival = { position: at.position, heading: at.rotation[2] };
    if (at.world !== undefined) await this.world.openExterior(at.world, { arrival });
    else if (at.cell !== undefined) await this.world.openInterior(at.cell, arrival);
  }

  /**
   * The player fast travels to a reference (a map marker), as Play's map does
   * (src/shell/play-mode.ts): the hours the way takes pass, the sky takes its next weather, and
   * the player arrives where the marker sends them (ScriptRuntime.fastTravelArrival). Without
   * `passTime`, a jump there: the player arrives as fast travel would put them, no time passing.
   */
  async fastTravel(destination: number, passTime = true): Promise<void> {
    const session = this.world.session;
    const at = await this.runtime.placement(await this.runtime.fastTravelArrival(destination));
    if (!at) throw new Error(`No place for ${destination.toString(16)}`);
    const enter = async (place: Placement): Promise<void> => {
      const arrival: Arrival = { position: place.position, heading: place.rotation[2] };
      // Play's journey brings the followers, and the player's horse, along (main.ts).
      await this.world.stage.followers.comeAlong(place, true);
      if (place.world !== undefined) await this.world.openExterior(place.world, { arrival });
      else if (place.cell !== undefined) await this.world.openInterior(place.cell, arrival);
    };
    // Play's journey (src/shell/fast-travel-journey.ts): the hours, the sky, the arrival told.
    if (passTime) await fastTravelJourney(session, at, fastTravelWay(session, at), enter);
    else await enter(at);
    await this.world.settle();
  }

  /** Sets the game hour as a script does (GameHour.SetValue): the clock jumps there. */
  setHour(hour: number): void {
    this.runtime.setClockGlobal(GAME_HOUR, hour);
  }

  /** Sets the days passed (GameDaysPassed.SetValue), keeping the hour. */
  setDay(day: number): void {
    this.runtime.setClockGlobal(GAME_DAYS_PASSED, day + (this.runtime.state.gameDaysPassed % 1));
  }

  /** The game hour now. */
  get hour(): number {
    return this.world.session.gameHour;
  }

  /** Steps the world `seconds` at the fixed step (SIM_STEP: 1/60 s). */
  step(seconds: number, step = SIM_STEP): Promise<void> {
    return this.world.run(seconds, step);
  }

  /** Steps until `done` holds (true), or `seconds` have passed (false). */
  until(done: () => boolean, seconds: number, step = SIM_STEP): Promise<boolean> {
    return this.world.until(done, seconds, step);
  }

  // --- World state --------------------------------------------------------------------------

  /** Sets a quest's stage (Quest.SetStage), waiting for its fragment. */
  async setStage(quest: number, stage: number): Promise<boolean> {
    const set = await this.runtime.quests.setStage(quest, stage);
    await this.world.settle();
    return set;
  }

  /** A quest's current stage (GetStage). */
  stage(quest: number): number {
    return this.runtime.state.quests.get(quest)?.stage ?? 0;
  }

  /** Whether a quest's stage is done (GetStageDone). */
  stageDone(quest: number, stage: number): boolean {
    return this.runtime.state.quests.get(quest)?.stagesDone.has(stage) === true;
  }

  isRunning(quest: number): boolean {
    return this.runtime.quests.isRunning(quest);
  }

  /** Sets a global (GlobalVariable.SetValue; the clock's globals move the clock). */
  setGlobal(global: number, value: number): void {
    if (!this.runtime.setClockGlobal(global, value)) this.runtime.state.globals.set(global, value);
  }

  /** A reference's open state (GetOpenState: 1 open, 2 opening, 3 closed, 4 closing; 0 none). */
  openState(reference: number): number {
    return this.runtime.state.references.get(reference)?.openState ?? 0;
  }

  /** Whether a reference is enabled now (IsDisabled's opposite). */
  enabled(reference: number): Promise<boolean> {
    return this.runtime.isEnabled(reference);
  }

  // --- References and actors ----------------------------------------------------------------

  /** A record's form id by its editor id (case-insensitive), among the records of a type. */
  async formId(type: string, editorId: string): Promise<number> {
    let index = this.#editorIds.get(type);
    if (!index) {
      index = new Map();
      for (const formId of this.db.formIdsOfType(type)) {
        const record = await this.db.get(formId);
        if (record?.editorId) index.set(record.editorId.toLowerCase(), formId);
      }
      this.#editorIds.set(type, index);
    }
    const formId = index.get(editorId.toLowerCase());
    if (formId === undefined) throw new Error(`No ${type} ${editorId}`);
    return formId;
  }

  /** An actor of the loaded area. */
  actor(reference: number): StagedActor | undefined {
    return this.world.stage.get(reference);
  }

  /** The actors of the loaded area. */
  actors(): StagedActor[] {
    return [...this.world.stage.all()];
  }

  /** Where a reference is now (the player's feet, an actor's, a moved object's). */
  async position(reference: number): Promise<Vec3 | undefined> {
    const at = await this.runtime.placement(reference);
    return at && [at.position[0], at.position[1], at.position[2]];
  }

  /** The distance between two references now (undefined if either has no place). */
  async distance(a: number, b: number): Promise<number | undefined> {
    const [from, to] = await Promise.all([this.position(a), this.position(b)]);
    if (!from || !to) return undefined;
    return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
  }

  /** The package an actor of the loaded area runs now. */
  package(actor: number): RunningPackage | undefined {
    const current = this.world.stage.ai.current(actor);
    return current && { id: current.id, procedure: current.procedure };
  }

  /** Places a new reference of a base at a reference (PlaceAtMe); its form id. */
  async place(base: number, at: number): Promise<number> {
    const reference = await this.runtime.placeAt(base, at, 1);
    void this.runtime.world.created?.(reference);
    await this.world.settle();
    return reference;
  }

  /**
   * Kills an actor (Actor.Kill) by a killer. The killing does not wait for its death's script
   * handlers (they run on as the world steps); the crime and the story manager's event follow.
   */
  async kill(actor: number, killer?: number): Promise<void> {
    await this.runtime.actors.kill(actor, killer);
    await this.world.settle();
  }

  // --- The player's actions -----------------------------------------------------------------

  /** The player activates a reference (as through the crosshair). False if it cannot be. */
  activate(reference: number): boolean {
    return this.world.activate(reference);
  }

  /** Puts the player at a place (they stand on the ground there). */
  async moveTo(feet: Vec3, yaw?: number): Promise<void> {
    this.world.teleportPlayer(feet, yaw);
    await this.world.step();
  }

  /** The player walks towards a point for at most `seconds` (holding Forward, turning to it). */
  async walkTo(target: Vec3, seconds: number, reach = 64): Promise<boolean> {
    const player = this.world.player;
    this.world.press('Forward', true);
    try {
      return await this.world.until(() => {
        const [x, y] = player.feet;
        const dx = target[0] - x;
        const dy = target[1] - y;
        if (Math.hypot(dx, dy) <= reach) return true;
        // Yaw 0 looks along +Y; it turns clockwise.
        this.world.look(Math.atan2(dx, dy));
        return false;
      }, seconds);
    } finally {
      this.world.press('Forward', false);
    }
  }

  /**
   * The player walks a way over the navmeshes to a point (as one who knows the way: around
   * walls, up stairs), each of its points in turn by walkTo; at most `seconds` in all. False if
   * there is no way (off the navmeshes) or the point was not reached in time. A way that ends
   * short of the point (the navmeshes of the cells loaded so far end, or the point is off them:
   * a burial mound's top) is searched again from where it ended, as the cells round the player
   * load; past the last navmesh the player walks straight on.
   */
  async walkPath(target: Vec3, seconds: number, reach = 64): Promise<boolean> {
    const until = this.time + seconds;
    let last: Vec3 | undefined;
    for (;;) {
      const leg = await this.#walkLeg(target, until - this.time, reach);
      if (leg !== 'short') return leg;
      const feet = this.world.player.feet;
      const left = until - this.time;
      // No nearer than the last way's end: straight on to the point.
      if (last && Math.hypot(feet[0] - last[0], feet[1] - last[1]) < PATH_GOAL_REACH) {
        return left >= SIM_STEP / 2 && (await this.walkTo(target, left, reach));
      }
      if (left < SIM_STEP / 2) return false;
      last = [feet[0], feet[1], feet[2]];
      // The cells round them attach meanwhile.
      await this.world.settle();
    }
  }

  /** One way over the navmeshes loaded now ('short': it ended short of the point). */
  async #walkLeg(target: Vec3, seconds: number, reach: number): Promise<boolean | 'short'> {
    const navmeshes = this.world.navmeshes;
    // A point above the navmesh (a trigger's middle) is walked to where the navmesh is under it.
    const goal = navmeshes.locate(target)
      ? target
      : (navmeshes.nearest?.(target, PATH_GOAL_REACH) ?? target);
    // Off the navmesh (a floor it leaves out), the way starts where it is nearest.
    const feet = this.world.player.feet;
    const from = navmeshes.locate(feet) ? feet : navmeshes.nearest?.(feet, PATH_GOAL_REACH);
    const path = from && findPath(navmeshes, from, goal, WAY);
    if (!path) return false;
    const until = this.time + seconds;
    // Blockers whose activate parent was pulled in this walk (not pulled shut again).
    const pulled = new Set<number>();
    // The open doors they lined up with and went through (#openDoorNear).
    const lined = new Set<number>();
    let points = path.points.slice(from === feet ? 1 : 0);
    let complete = path.complete;
    let searched = false;
    let fellTo = Infinity;
    let origin: readonly number[] = from;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) break;
      const last = index === points.length - 1;
      // A corner well under them (a door's marker above a floor the navmesh leaves out: the way
      // starts on the floor below) is only passed over, not stood on.
      const under = this.world.player.feet[2] - point[2] >= FELL_OFF_THE_WAY;
      const near = last ? reach : under ? PLAYER_RADIUS : CORNER_REACH;
      let side = 1;
      let jumped = false;
      let held = 0;
      for (;;) {
        const left = until - this.time;
        // Under half a step, a wait takes no step: the clock would stand still here.
        if (left < SIM_STEP / 2) return false;
        const [x0, y0] = this.world.player.feet;
        if (await this.walkTo([point[0], point[1], point[2]], Math.min(left, 0.5), near)) break;
        // Held up: a closed door in the way is opened, as a player does, and what else stands in
        // the way is cleared (#clearWay); down in a dip off the navmesh (a gap between rocks under
        // it), with the way on above, they jump out; someone in the way is stepped round.
        const [x1, y1, z1] = this.world.player.feet;
        // They fell (off a ledge, down a slope): the old way's points lie above them now, and
        // heading for those leaves them stuck under them. The way on is searched from here, once
        // for each drop (a way that starts above them, off the navmesh, is not searched for
        // again and again).
        if (
          z1 <= fellTo - FELL_OFF_THE_WAY &&
          wayHeightAt(points[index - 1] ?? origin, point, x1, y1) - z1 >= FELL_OFF_THE_WAY
        ) {
          const here: Vec3 = [x1, y1, z1];
          const start = navmeshes.locate(here) ? here : navmeshes.nearest?.(here, PATH_GOAL_REACH);
          const again = start && findPath(navmeshes, start, goal, WAY);
          if (again) {
            fellTo = z1;
            origin = start;
            points = again.points.slice(start === here ? 1 : 0);
            complete = again.complete;
            index = -1;
            break;
          }
        }
        if (Math.hypot(x1 - x0, y1 - y0) >= 4) continue;
        // Held this near a corner they cannot stand on (a passage narrower than they are wide at
        // that corner): it is as good as reached, and the way goes on.
        if (!last && Math.hypot(point[0] - x1, point[1] - y1) <= HELD_CORNER_REACH) break;
        // Held at the way's last corner within reach of the goal (a shut door that is the goal
        // itself takes up the corner's room): there is nowhere further to go, and no door to open.
        if (
          index >= points.length - 2 &&
          Math.hypot(goal[0] - x1, goal[1] - y1) <= reach &&
          Math.abs(goal[2] - z1) <= reach
        ) {
          return true;
        }
        if (await this.#openDoorNear([x1, y1], goal, lined)) continue;
        if (await this.#clearWay([x1, y1, z1], point, pulled)) continue;
        if (!jumped && point[2] > z1 + JUMP_OUT && !navmeshes.locate([x1, y1, z1])) {
          jumped = true;
          this.press('Jump', true);
          await this.step(SIM_STEP);
          this.press('Jump', false);
          await this.walkTo([point[0], point[1], point[2]], 0.5, near);
          continue;
        }
        // Held up at this point again and again: the way on, searched again from here (once a
        // walk), goes round what holds them (the way's corners lie where it found room).
        if (++held >= HELD_SEARCH_AGAIN && !searched) {
          searched = true;
          const here: Vec3 = [x1, y1, z1];
          const start = navmeshes.locate(here) ? here : navmeshes.nearest?.(here, PATH_GOAL_REACH);
          const again = start && findPath(navmeshes, start, goal, WAY);
          if (again) {
            points = again.points.slice(start === here ? 1 : 0);
            complete = again.complete;
            index = -1;
            break;
          }
        }
        const dx = point[0] - x1;
        const dy = point[1] - y1;
        const length = Math.hypot(dx, dy) || 1;
        const aside: Vec3 = [
          x1 + (-dy / length) * SIDESTEP * side,
          y1 + (dx / length) * SIDESTEP * side,
          point[2],
        ];
        side = side > 0 ? -side : Math.min(-side * 2, 4);
        await this.walkTo(aside, 0.5, 8);
      }
    }
    const [x, y] = this.world.player.feet;
    if (Math.hypot(goal[0] - x, goal[1] - y) <= reach) return true;
    return complete ? false : 'short';
  }

  /**
   * What stands in the way, as a player deals with it: a destructible object (a spider web
   * across a passage) is struck, blow after blow, until its stage changes (#hackThrough); one
   * its activate parents open (a portcullis) has its nearest parent pulled (a chain, a lever),
   * once (a walk cut into pieces does not pull it shut again). True if something was done.
   */
  async #clearWay(feet: Vec3, toward: readonly number[], pulled: Set<number>): Promise<boolean> {
    const character = this.world.player.character;
    const direction: Vec3 = [(toward[0] ?? 0) - feet[0], (toward[1] ?? 0) - feet[1], 0];
    const from: Vec3 = [feet[0], feet[1], feet[2] + WAY_HEIGHT];
    const hit = character.physics.raycast(
      from,
      direction,
      WAY_REACH,
      Layer.charController,
      character.collider,
    );
    const struck = hit?.owner?.kind === 'object' ? hit.owner.reference : 0;
    if (struck === 0) return false;
    const destruction = this.runtime.destruction;
    if (!destruction.isDestroyed(struck) && (await destruction.of(struck))) {
      const point = hit?.point ?? feet;
      return this.#hackThrough(struck, [point[0], point[1], point[2]]);
    }
    if (pulled.has(struck)) return false;
    let parent: number | undefined;
    let nearest = Infinity;
    for (const each of await this.runtime.activateParents(struck)) {
      const at = await this.position(each);
      const away = at ? Math.hypot(at[0] - feet[0], at[1] - feet[1]) : Infinity;
      if (away < nearest) {
        nearest = away;
        parent = each;
      }
    }
    if (parent === undefined || !this.activate(parent)) return false;
    pulled.add(struck);
    await this.step(PULL_WAIT);
    return true;
  }

  /**
   * Strikes a destructible object in the way as the player does, until its stage changes
   * (true) or no blow changes it: facing the point of it that holds them up, with what is in
   * their right hand drawn (fists, a weapon, a spell: Flames' stream burns a web), the attack
   * button held BLOW_HOLD and let go. The blow's hit on the object (actor-combat's strike, the
   * spell's projectile) takes its destruction health.
   */
  async #hackThrough(struck: number, at: Vec3): Promise<boolean> {
    const destruction = this.runtime.destruction;
    const stage = destruction.stage(struck);
    if (this.world.stage.combat.weaponState(PLAYER_REF) !== WeaponState.drawn) {
      this.press(READY_WEAPON, true);
      await this.step(SIM_STEP);
      this.press(READY_WEAPON, false);
      await this.step(DRAW_WAIT);
    }
    for (let blow = 0; blow < BREAK_BLOWS && destruction.stage(struck) === stage; blow++) {
      const [x, y, z] = this.world.player.feet;
      const dx = at[0] - x;
      const dy = at[1] - y;
      const across = Math.hypot(dx, dy);
      this.world.look(Math.atan2(dx, dy), Math.atan2(at[2] - (z + EYE_HEIGHT), across));
      this.press(RIGHT_ATTACK, true);
      await this.step(BLOW_HOLD);
      this.press(RIGHT_ATTACK, false);
      await this.step(BREAK_PAUSE);
    }
    this.world.look(this.world.player.yaw);
    return destruction.stage(struck) !== stage;
  }

  /**
   * Activates the nearest closed door within reach of a point (true if there was one). A door
   * not swung yet is as the plugin placed it (GetOpenState's rule: open by default, ONAM, or
   * closed); an open or opening one is left alone, as activating it would swing it shut again
   * (onto the player held up beside it). Held up beside the doorway (at its frame), they first
   * step back in front of it, as a player lines up with a door: the leaf swings round its hinge
   * at the doorway's side, and opened from beside it, it swept the player behind it. Held at
   * the frame of an open one (`lined`: once a walk) with the way on beyond it (`goal`), they line
   * up in front of it and go through straight: the navmesh's way rounds the frame too closely.
   */
  async #openDoorNear(
    [x, y]: readonly [number, number],
    goal: readonly number[],
    lined: Set<number>,
  ): Promise<boolean> {
    // The nearest closed door within reach, else the nearest open one.
    let closed: { reference: number; world: ArrayLike<number>; away: number } | undefined;
    let opened: { reference: number; world: ArrayLike<number>; away: number } | undefined;
    for (const placed of this.world.placedObjects()) {
      const { object } = placed;
      // A load door is not in the way: it would take them elsewhere.
      if (object.baseType !== 'DOOR' || object.teleport !== undefined) continue;
      const state = this.openState(object.reference) || (object.openByDefault ? 1 : 3);
      if (state === 2) continue;
      const away = Math.hypot((object.world[12] ?? 0) - x, (object.world[13] ?? 0) - y);
      if (away >= DOOR_REACH) continue;
      const found = { reference: object.reference, world: object.world, away };
      if (state === 1) {
        if (!opened || away < opened.away) opened = found;
      } else if (!closed || away < closed.away) closed = found;
    }
    const chosen = closed ?? opened;
    if (!chosen) return false;
    const { reference: door, world } = chosen;
    const open = !closed;
    // The doorway's centre, its facing (the door's local Y) and how far aside of it they are.
    const [cx, cy] = [world[12] ?? 0, world[13] ?? 0];
    const length = Math.hypot(world[4] ?? 0, world[5] ?? 0) || 1;
    const [fx, fy] = [(world[4] ?? 0) / length, (world[5] ?? 0) / length];
    const ahead = (x - cx) * fx + (y - cy) * fy;
    const aside = (x - cx) * -fy + (y - cy) * fx;
    const side = ahead >= 0 ? 1 : -1;
    const z = this.world.player.feet[2];
    // Out from the wall straight (round the end of a leaf swung open beside them), then across to
    // in front of the doorway.
    const out = (along: number, across: number): Vec3 => [
      cx + fx * along - fy * across,
      cy + fy * along + fx * across,
      z,
    ];
    const lineUp = async (): Promise<void> => {
      await this.walkTo(out(side * DOORWAY_STAND, aside), 3, 24);
      await this.walkTo(out(side * DOORWAY_STAND, 0), 3, 24);
    };
    const beyond = (((goal[0] ?? cx) - cx) * fx + ((goal[1] ?? cy) - cy) * fy) * ahead < 0;
    if (open) {
      // Held at an open doorway's frame with the way on beyond it: they line up in front of it
      // and go through straight, once.
      if (lined.has(door) || Math.abs(aside) <= DOORWAY_ASIDE || !beyond) return false;
      lined.add(door);
      await lineUp();
      await this.walkTo(out(-side * DOORWAY_STAND, 0), 3, 24);
      return true;
    }
    if (Math.abs(aside) > DOORWAY_ASIDE || Math.abs(ahead) < DOORWAY_STAND - DOORWAY_ASIDE) {
      await lineUp();
    }
    if (!this.activate(door)) return false;
    // Opened, and the way goes on beyond it: through the doorway's middle, not along the way's
    // corner by its frame (the leaf stands open there).
    if (beyond && !lined.has(door)) {
      lined.add(door);
      await this.until(() => this.openState(door) === 1, DOOR_SWING_WAIT);
      await this.walkTo(out(-side * DOORWAY_STAND, 0), 4, 24);
    }
    return true;
  }

  /**
   * The player talks to an actor as the dialogue menu has it (src/shell/dialogue-menu.ts), the
   * lines said at once: its greeting, then for each pattern the listed topic whose text matches
   * it, each info's begin and end fragments run, Invisible Continue followed. `opening`: the
   * conversation begins with that topic's line (a ForceGreet's: menus()). Returns the topics
   * listed last (their texts); a pattern that matches none ends the talk there.
   */
  async converse(
    actor: number,
    choose: readonly RegExp[] = [],
    opening?: number,
  ): Promise<string[]> {
    const engine = this.runtime.dialogue;
    const say = async (spoken: SpokenInfo): Promise<void> => {
      await this.#stepUntil(engine.runFragment(spoken.info, 'begin', actor));
      engine.said(spoken.info);
      await this.#stepUntil(engine.runFragment(spoken.info, 'end', actor));
    };
    // An info, then the infos Invisible Continue says after it; the choices it leaves.
    const goOn = async (first: SpokenInfo | undefined): Promise<readonly number[] | undefined> => {
      let current = first;
      for (let step = 0; current && step < 16; step++) {
        await say(current);
        // Invisible Continue, or choices the menu could list none of (goesOnUnlisted).
        if (
          afterInfo(current.info) !== 'continue' &&
          !(await engine.goesOnUnlisted(current, actor))
        )
          return current.info.choices;
        current = await engine.continueAfter(current, actor);
      }
      return undefined;
    };
    this.runtime.state.actor(actor).talkedToPlayer = true;
    this.runtime.dialogueSpeaker = actor;
    try {
      let offered = await goOn(
        opening === undefined
          ? await engine.greeting(actor)
          : await engine.topicLine(opening, actor),
      );
      let listed = (await engine.topics(actor, offered)).filter((choice) => !choice.hidden);
      for (const pattern of choose) {
        const choice = listed.find((topic) => pattern.test(topic.text));
        if (!choice) break;
        offered = await goOn(await engine.choose(choice, actor));
        listed = (await engine.topics(actor, offered)).filter((topic) => !topic.hidden);
      }
      return listed.map((choice) => choice.text);
    } finally {
      this.runtime.dialogueSpeaker = undefined;
    }
  }

  /**
   * Steps the world until work is done (a fragment may wait for frames: Utility.Wait), at most
   * `seconds`.
   */
  async #stepUntil(work: Promise<unknown>, seconds = 30): Promise<void> {
    let done = false;
    const settled = work.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    if (await this.world.until(() => done, seconds)) await settled;
    await this.world.settle();
  }

  /**
   * Calls a native on an object as a script does, the world stepping meanwhile: a native whose
   * work the original queues for a point of the frame (src/scripting/latent-queues.ts) returns
   * once a frame has done it. Its result (None if it never returned within 30 s).
   */
  async native(target: ObjectHandle, script: string, fn: string, args: Value[]): Promise<Value> {
    const native = this.runtime.native(script.toLowerCase(), fn.toLowerCase());
    if (!native) throw new Error(`No native ${script}.${fn}`);
    let result: Value = null;
    const work = Promise.resolve(
      native({
        vm: this.runtime.vm,
        self: target,
        args,
        name: `${script}.${fn}`.toLowerCase(),
        latent: (promise) => promise,
        where: () => '',
      }),
    ).then((value) => {
      result = value;
    });
    await this.#stepUntil(work);
    return result;
  }

  /** The player equips an item (Actor.EquipItem). */
  async equip(item: number): Promise<boolean> {
    const done = await this.runtime.equipment.equip(PLAYER_REF, item);
    await this.world.settle();
    return done;
  }

  /** The player casts a spell at a target (a scripted cast: Spell.Cast). */
  async cast(spell: number, target?: number): Promise<boolean> {
    const cast = this.world.stage.launchSpell(spell, PLAYER_REF, target, PLAYER_REF);
    await this.world.settle();
    return cast;
  }

  /**
   * The player uses their right hand (a spell equipped there, a bow): drawn if it is not, the
   * attack button held `seconds` (a concentration spell's stream, a bow's draw) and let go.
   */
  async attack(seconds: number): Promise<void> {
    if (this.world.stage.combat.weaponState(PLAYER_REF) !== WeaponState.drawn) {
      this.press(READY_WEAPON, true);
      await this.step(SIM_STEP);
      this.press(READY_WEAPON, false);
      await this.step(DRAW_WAIT);
    }
    this.press(RIGHT_ATTACK, true);
    await this.step(seconds);
    this.press(RIGHT_ATTACK, false);
    await this.step(BREAK_PAUSE);
  }

  /**
   * The player swings their drawn weapon at an actor by real input: turned to it, stepping up
   * until it is within `within` units, the attack button tapped, then waiting out the swing. What
   * came of it: whether the swing began, and whether a blow of theirs fell on the actor.
   */
  async swingAt(
    actor: number,
    within: number,
    seconds = 1.2,
  ): Promise<{ readonly began: boolean; readonly landed: boolean }> {
    const combat = this.world.stage.combat;
    const facing = async (): Promise<number> => {
      const at = await this.position(actor);
      if (!at) return Infinity;
      this.look([at[0], at[1], at[2] + EYE_HEIGHT]);
      const [x, y] = this.world.player.feet;
      return Math.hypot(at[0] - x, at[1] - y);
    };
    this.press('Forward', true);
    for (let t = 0; t < 3 && (await facing()) > within; t += SIM_STEP) await this.step(SIM_STEP);
    this.press('Forward', false);
    await facing();
    const before = this.events('hit').filter(
      (hit) => hit.aggressor === PLAYER_REF && hit.target === actor,
    ).length;
    this.press(RIGHT_ATTACK, true);
    await this.step(SIM_STEP);
    this.press(RIGHT_ATTACK, false);
    await this.step(SIM_STEP);
    const began = combat.state(PLAYER_REF)?.attacking === true;
    for (let t = 0; t < seconds; t += SIM_STEP) {
      await facing();
      await this.step(SIM_STEP);
    }
    const landed =
      this.events('hit').filter((hit) => hit.aggressor === PLAYER_REF && hit.target === actor)
        .length > before;
    return { began, landed };
  }

  /** The player turns to look at a point (from their eyes). */
  look(at: Vec3): void {
    const [x, y, z] = this.world.player.feet;
    const dx = at[0] - x;
    const dy = at[1] - y;
    this.world.look(Math.atan2(dx, dy), Math.atan2(at[2] - (z + EYE_HEIGHT), Math.hypot(dx, dy)));
  }

  /**
   * The player takes hold of a loose object before them (Activate held past fZKeyDelay), holds
   * it `seconds` and lets it go.
   */
  async grab(reference: number, seconds: number): Promise<void> {
    const at = await this.position(reference);
    if (at) this.look(at);
    await this.step(SIM_STEP);
    this.press('Activate', true);
    await this.step(seconds);
    this.press('Activate', false);
    await this.step(SIM_STEP);
    this.world.look(this.world.player.yaw);
  }

  /**
   * The player reads a book (the book menu as it opens a book: src/shell/book-reading.ts; the
   * simulation shows nothing and closes it at once). A reference read lying in the world, else
   * the book from the inventory. Whether it opened.
   */
  async read(book: number, reference?: number): Promise<boolean> {
    let opened = false;
    await this.#stepUntil(
      openBookUnseen(this.runtime, { book, ...(reference !== undefined && { reference }) }).then(
        (open) => {
          opened = open;
        },
      ),
    );
    return opened;
  }

  /**
   * The player reads a book from their inventory through the inventory menu's model (ItemSelect
   * on its entry: scripts hear it as equipped, OnEquipped; an Elder Scroll's script takes it from
   * there). False if they have none.
   */
  async readFromInventory(book: number): Promise<boolean> {
    const model = inventoryModel(this.world.session, this.world.terminal, async (read) => {
      await openBookUnseen(this.runtime, { book: read });
    });
    const entry = (await model.view()).entries.find((candidate) => candidate.formId === book);
    if (!entry) return false;
    await this.#stepUntil(model.select(entry, 0));
    return true;
  }

  /**
   * The player takes an item out of a corpse or a container through the container menu's model
   * (its entry, moved to them). False if it holds none of it.
   */
  async take(holder: number, item: number, count = 1): Promise<boolean> {
    const inventory = inventoryModel(this.world.session, this.world.terminal, () =>
      Promise.resolve(),
    );
    const model = containerModel(this.world.session, holder, inventory);
    const entry = (await model.view()).entries.find(
      (candidate) => candidate.formId === item && candidate.container === true,
    );
    if (!entry || !model.transfer) return false;
    await this.#stepUntil(Promise.resolve(model.transfer(entry, count, true)));
    return true;
  }

  /**
   * The player sells items to a merchant through the barter menu's model (bartermenu.swf's
   * ItemSelect on one of the player's entries: src/shell/barter-menu.ts), at the price it shows.
   * False if the merchant does not buy it.
   */
  async sell(vendor: number, item: number, count = 1): Promise<boolean> {
    const model = await barterModel(this.world.session, this.world.terminal, vendor);
    const view = await model.view();
    const index = view.entries.findIndex((entry) => entry.formId === item && !entry.container);
    const entry = view.entries[index];
    if (!entry || !model.trade) return false;
    const price = view.cards[index]?.value;
    await this.#stepUntil(
      model.trade(entry, [count, typeof price === 'number' ? price : 0, false]),
    );
    return true;
  }

  /**
   * The player sleeps or waits some hours (the sleep and wait menu's OK: src/shell/
   * sleep-wait-menu.ts passHours), the world stepping meanwhile.
   */
  async rest(hours: number, sleeping: boolean): Promise<void> {
    await this.#stepUntil(passHours(this.world.session, hours, sleeping), 120);
  }

  /**
   * The player buys one of a merchant's goods through the barter menu's model (ItemSelect on a
   * vendor's entry), at the price it shows. False if the merchant does not have it.
   */
  async buy(vendor: number, item: number): Promise<boolean> {
    const model = await barterModel(this.world.session, this.world.terminal, vendor);
    const view = await model.view();
    const index = view.entries.findIndex((entry) => entry.formId === item && entry.container);
    const entry = view.entries[index];
    if (!entry || !model.trade) return false;
    const price = view.cards[index]?.value;
    await this.#stepUntil(model.trade(entry, [1, typeof price === 'number' ? price : 0, true]));
    return true;
  }

  /**
   * The player makes an item at a workbench through the crafting menu's model (craftingmenu.swf's
   * ChooseItem on the recipe's entry: src/shell/crafting-models.ts); a smithing bench improves
   * the item. Message boxes are answered Yes. False if the bench lists no entry of it.
   */
  async craft(bench: number, item: number): Promise<boolean> {
    const { session, terminal } = this.world;
    const runtime = this.runtime;
    const base = await runtime.baseOf(bench);
    const found = base === undefined ? undefined : await workbenchOf(runtime, base);
    if (!found) return false;
    const settings = await session.settings();
    const model = await craftingModel(found.type, {
      log: (message) => {
        terminal.log('ui', message, 'warn');
      },
      session,
      runtime,
      settings,
      text: (label) => settings.string(label) ?? label,
      game: {
        confirm: () => Promise.resolve(0),
        notify: (text) => {
          session.hud.notification(text);
        },
      },
      bench: found.bench,
      reference: bench,
    });
    const entry = (await model.entries()).find(
      (candidate) => candidate.formId === item && candidate.enabled !== false,
    );
    if (!entry) return false;
    const view = { slider: () => undefined, rename: () => undefined };
    await this.#stepUntil(model.choose(entry, view));
    return true;
  }

  /**
   * The player picks a lock as the lockpicking menu has it (src/shell/lock-picking.ts): the pick
   * swept to the middle of the sweet spot, the rotate keys held until the lock opens, the world
   * stepping meanwhile. The attempt's outcome: 'opened', or why it was not picked ('open',
   * 'key', a refusal's message setting).
   */
  async pickLock(reference: number, seconds = 10): Promise<string> {
    const { session } = this.world;
    const runtime = this.runtime;
    const attempt = await tryLock(runtime, reference, session.crimeWatch?.pursued === true);
    if (attempt.kind !== 'pick') return attempt.kind === 'refused' ? attempt.setting : attempt.kind;
    const setup = await pickSetup(runtime, await session.settings(), reference);
    if (!setup) return 'sImpossibleLock';
    const lock = new LockPick(setup);
    lock.sweep(setup.shape.center);
    const speed = session.ini.number('Interface', 'fLockRotationSpeed');
    for (let time = 0; time < seconds; time += SIM_STEP) {
      const step = lock.step(SIM_STEP, true, speed);
      if (step === 'opened') {
        await this.#stepUntil(lockOpened(runtime, setup));
        return 'opened';
      }
      if (step === 'broken') await this.#stepUntil(pickBroke(runtime, setup));
      await this.step(SIM_STEP);
    }
    return 'held';
  }

  /** The merchant's goods as the barter menu lists them (their form ids). */
  async goods(vendor: number): Promise<number[]> {
    const model = await barterModel(this.world.session, this.world.terminal, vendor);
    return (await model.view()).entries
      .filter((entry) => entry.container)
      .map((entry) => entry.formId);
  }

  /**
   * The player drops items from the inventory menu (its Drop); `stack`: the row of an improved
   * stack of them (the crafting engine's index), else the first. False if they have none.
   */
  async drop(item: number, count = 1, stack?: number): Promise<boolean> {
    const model = inventoryModel(this.world.session, this.world.terminal, async (book) => {
      await openBookUnseen(this.runtime, { book });
    });
    const entry = (await model.view()).entries.find(
      (candidate) =>
        candidate.formId === item && (stack === undefined || candidate.stack === stack),
    );
    if (!entry || !model.drop) return false;
    await this.#stepUntil(model.drop(entry, count));
    return true;
  }

  /**
   * The player gives an item to an actor through the gift menu's model (Actor.ShowGiftMenu with
   * favor points: ItemSelect on one of the player's entries). False if it cannot be given.
   */
  async gift(actor: number, item: number): Promise<boolean> {
    const model = await giftModel(this.world.session, actor, {
      giving: true,
      filter: undefined,
      useFavorPoints: true,
    });
    const entry = (await model.view()).entries.find(
      (candidate) => candidate.formId === item && !candidate.container,
    );
    if (!entry || !model.trade) return false;
    await this.#stepUntil(model.trade(entry, [1]));
    return true;
  }

  // --- Conversations (the dialogue menu's rules, src/shell/dialogue-menu.ts, headless) -------

  /**
   * The player talks to an actor: activates it (as through the crosshair), and once its
   * dialogue menu opens hears the greeting; the topics listed (their texts), or undefined if no
   * conversation opened within the seconds (blocked activation, a greeting said in passing).
   */
  async talk(actor: number, seconds = 5): Promise<string[] | undefined> {
    if (!this.activate(actor)) return undefined;
    return this.listen(actor, seconds);
  }

  /**
   * Waits for a conversation an actor starts (a force greet, a scene's, or the player's
   * activation): its greeting (or opening topic) is heard; the topics listed, or undefined.
   */
  async listen(actor?: number, seconds = 30): Promise<string[] | undefined> {
    let opened: Extract<SimRecord, { readonly kind: 'menu' }> | undefined;
    await this.until(() => {
      const menus = this.menus();
      for (; this.#menusSeen < menus.length && !opened; this.#menusSeen++) {
        const menu = menus[this.#menusSeen];
        if (menu?.menu === 'Dialogue Menu' && (actor === undefined || menu.reference === actor))
          opened = menu;
      }
      return opened !== undefined;
    }, seconds);
    const speaker = opened?.reference;
    if (speaker === undefined) return undefined;
    const engine = this.runtime.dialogue;
    // In dialogue from before the greeting is chosen (src/shell/dialogue-menu.ts).
    this.runtime.dialogueSpeaker = speaker;
    const greeting = await this.#drive(
      opened?.opening === undefined
        ? engine.greeting(speaker)
        : engine.topicLine(opened.opening, speaker),
    );
    this.runtime.state.actor(speaker).talkedToPlayer = true;
    this.#conversation = { speaker, choices: [] };
    if (greeting) await this.#say(greeting, speaker);
    return this.#goOn(greeting, speaker);
  }

  /** The topics listed in the conversation now (their texts). */
  get topics(): string[] {
    return this.#conversation?.choices.map((choice) => choice.text) ?? [];
  }

  /**
   * The player chooses a listed topic (the first whose text matches): the actor says its
   * info, then the topics show again; the topics listed (none: the conversation ended).
   */
  async choose(topic: string | RegExp): Promise<string[]> {
    const conversation = this.#conversation;
    if (!conversation) throw new Error('No conversation');
    const choice = conversation.choices.find((each) =>
      typeof topic === 'string' ? each.text.includes(topic) : topic.test(each.text),
    );
    if (!choice) {
      throw new Error(`No topic ${String(topic)} among: ${this.topics.join(' | ')}`);
    }
    const spoken = await this.#drive(this.runtime.dialogue.choose(choice, conversation.speaker));
    if (!spoken) return this.goodbye();
    await this.#say(spoken, conversation.speaker);
    return this.#goOn(spoken, conversation.speaker);
  }

  /** The player leaves the conversation (Tab). */
  goodbye(): [] {
    this.#conversation = undefined;
    this.runtime.dialogueSpeaker = undefined;
    return [];
  }

  /** Waits for a conversation's step while the world runs (its fragments may wait for it). */
  async #drive<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const result = work.finally(() => {
      done = true;
    });
    await this.until(() => done, LINE_SECONDS);
    return result;
  }

  /** The actor says an info: its begin fragment, its responses, its end fragment. */
  async #say(spoken: SpokenInfo, speaker: number): Promise<void> {
    const engine = this.runtime.dialogue;
    await this.#drive(engine.runFragment(spoken.info, 'begin', speaker));
    engine.said(spoken.info);
    await this.#drive(engine.runFragment(spoken.info, 'end', speaker));
  }

  /** After an info: its Invisible Continues, then Goodbye ends it, else the topics show. */
  async #goOn(spoken: SpokenInfo | undefined, speaker: number): Promise<string[]> {
    const engine = this.runtime.dialogue;
    let current = spoken;
    let offered = spoken?.info.choices;
    for (let step = 0; current && step < MAX_CONTINUES; step++) {
      if (
        afterInfo(current.info) !== 'continue' &&
        !(await this.#drive(engine.goesOnUnlisted(current, speaker)))
      )
        break;
      const next = await this.#drive(engine.continueAfter(current, speaker));
      if (!next) {
        offered = undefined;
        break;
      }
      await this.#say(next, speaker);
      current = next;
      offered = next.info.choices;
    }
    if (current && (current.info.flags & InfoFlag.goodbye) !== 0) return this.goodbye();
    const choices = await this.#drive(engine.topics(speaker, offered));
    const listed = choices.filter((choice) => choice.hidden !== true);
    if (listed.length === 0 || !this.#conversation) return this.goodbye();
    this.#conversation.choices = listed;
    return this.topics;
  }

  /** Presses or lets go of one of the player's user events ("Activate", "Jump", ...). */
  press(event: string, down: boolean): void {
    this.world.press(event, down);
  }

  // --- What happened ------------------------------------------------------------------------

  /** Every record, or those from a time on (see `time`). */
  records(since = 0): readonly SimRecord[] {
    return since === 0 ? this.world.log.records : this.world.log.since(since);
  }

  /** Events sent to scripts, by event name and target. */
  scriptEvents(
    filter: { readonly event?: string; readonly target?: number; readonly since?: number } = {},
  ): Extract<SimRecord, { readonly kind: 'script' }>[] {
    return this.world.log
      .of('script')
      .filter(
        (record) =>
          (filter.event === undefined ||
            record.event.toLowerCase() === filter.event.toLowerCase()) &&
          (filter.target === undefined || record.target === filter.target) &&
          record.at >= (filter.since ?? 0),
      );
  }

  /** The game events of a kind (the event hub's), as told. */
  events<K extends keyof GameEvents>(type: K): GameEvents[K][] {
    return this.world.log.game(type);
  }

  /** Stages set, of a quest or all. */
  stagesSet(quest?: number): GameEvents['questStage'][] {
    return this.events('questStage').filter(
      (event) => quest === undefined || event.quest === quest,
    );
  }

  /** Quests started (and stopped: `started` false). */
  questsStarted(): number[] {
    return this.events('questStartStop')
      .filter((event) => event.started)
      .map((event) => event.quest);
  }

  /** The packages actors started, changed and ended (TESPackageEvent), of an actor or all. */
  packages(actor?: number): GameEvents['package'][] {
    return this.events('package').filter((event) => actor === undefined || event.actor === actor);
  }

  /** Deaths (TESDeathEvent, the dead ones). */
  deaths(): GameEvents['death'][] {
    return this.events('death').filter((event) => event.dead);
  }

  /** The HUD's notifications. */
  notices(): string[] {
    return this.world.log
      .of('hud')
      .filter((record) => record.type === 'notification')
      .map((record) => record.text);
  }

  /** The sounds asked for (descriptors and sounds by editor id). */
  sounds(): Extract<SimRecord, { readonly kind: 'sound' }>[] {
    return this.world.log.of('sound');
  }

  /** Items moved between containers and the world (TESContainerChangedEvent). */
  itemsMoved(): GameEvents['containerChanged'][] {
    return this.events('containerChanged');
  }

  /** The story manager's events, of a type ("CLOC", "SCPT", ...) or all. */
  storyEvents(type?: string): Extract<SimRecord, { readonly kind: 'story' }>[] {
    return this.world.log
      .of('story')
      .filter((record) => type === undefined || record.type === type);
  }

  /** The menus the game opened. */
  menus(): Extract<SimRecord, { readonly kind: 'menu' }>[] {
    return this.world.log.of('menu');
  }

  /** The engine's warnings and errors so far. */
  problems(): readonly { readonly tag: string; readonly text: string }[] {
    return this.world.terminal.problems;
  }

  /** Ends the simulation (the page's clock and dice come back) and closes the game data. */
  async close(): Promise<void> {
    if (!openSims.delete(this)) return;
    this.world.dispose();
    await this.db.close();
    await this.#vfs.close();
  }
}
