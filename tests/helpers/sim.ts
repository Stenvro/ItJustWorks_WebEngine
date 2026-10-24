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

import type { GameEvents } from '../../src/scripting/runtime/event-hub.ts';
import { PLAYER_REF } from '../../src/scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../../src/scripting/runtime/runtime.ts';
import type { StagedActor } from '../../src/shell/actor-stage.ts';
import type { SimRecord } from '../../src/sim/sim-log.ts';
import { SIM_STEP, SimWorld } from '../../src/sim/sim-world.ts';
import { Vfs } from '../../src/vfs/vfs.ts';
import type { RecordDatabase } from '../../src/world/record-db.ts';
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
}

/** A package an actor runs now. */
export interface RunningPackage {
  readonly id: number;
  readonly procedure: string | undefined;
}

/** The global GameHour (Skyrim.esm): the clock, as scripts set it. */
const GAME_HOUR = 0x38;
/** The global GameDaysPassed (Skyrim.esm). */
const GAME_DAYS_PASSED = 0x39;

/** Opens the simulation: a new game, then the place (if given). Close it when done. */
export async function openSim(options: OpenOptions = {}): Promise<Sim> {
  const folder = openGameFolder();
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

export class Sim {
  readonly world: SimWorld;
  readonly db: RecordDatabase;
  readonly #vfs: Vfs;
  /** Editor ids by record type, read once per type (lookups by name). */
  readonly #editorIds = new Map<string, Map<string, number>>();

  constructor(world: SimWorld, vfs: Vfs, db: RecordDatabase) {
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

  // --- Places and time ----------------------------------------------------------------------

  openInterior(cell: number, arrival?: Arrival): Promise<void> {
    return this.world.openInterior(cell, arrival);
  }

  openExterior(world: number, cell: readonly [number, number]): Promise<void> {
    return this.world.openExterior(world, { cell });
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
    this.runtime.world.created?.(reference);
    await this.world.settle();
    return reference;
  }

  /** Kills an actor (Actor.Kill) by a killer. */
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
    this.world.dispose();
    await this.db.close();
    await this.#vfs.close();
  }
}
