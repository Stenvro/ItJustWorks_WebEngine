// The actors of the loaded area, as the viewers show them (docs/m10-plan.md, 1.1): each is
// drawn in a scene of its own and belongs to the loaded cell it stands in now, not to the cell
// it was placed in, so it can walk or be moved out of that cell. A cell that loads brings the
// actors that are in it now: its own references that are not elsewhere (a script's MoveTo,
// a package that has them in another cell), those moved into it, and the actors the scripts
// created there. The game state says where an actor is when no loaded cell shows it, and
// whether it is dead (the dead lie as ragdolls when their cell loads again).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { animateSkeletons, animationInterval } from '../animation/animated-skeleton.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceVisibility } from '../render/scene-renderer.ts';
import { referenceMatrix, type CellActor } from '../world/cell-loader.ts';
import { linkedReferences, parseReference } from '../world/cell-records.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { soundPlacedActors, type SoundingWorld } from './actor-sounds.ts';
import { groundActor, moveActor, ragdollsOf, type PlacedActor } from './actors.ts';
import { createdEnabled } from './created-objects.ts';
import type { GameSession } from './game-session.ts';
import type { CellRagdoll } from './play-session.ts';
import type { Terminal } from './terminal.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import { ActorAi } from './actor-ai.ts';
import { ActorSearch } from './actor-search.ts';
import { ActorsAway, type AwayPlace } from './actors-away.ts';
import type { RouteDoor } from '../ai/routes.ts';
import { ActorBodies } from './actor-bodies.ts';
import { ActorDoors, type DoorObject } from './actor-doors.ts';
import { ActorFurniture, type FurnitureUser, type StageObject } from './actor-furniture.ts';
import { ActorMovers } from './actor-movers.ts';
import { ActorSenses, type SensesWorld } from './actor-senses.ts';
import type { LightProbe } from '../ai/light-level.ts';

/** Where something is: its position, and the cell and worldspace the game state gives it. */
export interface StagePlace {
  readonly position: Vec3;
  readonly cell?: number | undefined;
  readonly world?: number | undefined;
}

/** An actor of the loaded area. */
export interface StagedActor {
  readonly reference: number;
  /** Its look, pose and graph (made again when its race changes). */
  placed: PlacedActor;
  /** Its own draws. */
  scene: GpuScene | undefined;
  readonly visibility: InstanceVisibility;
  /** The loaded cell it stands in now (see ActorStageOptions.cellOf). */
  cell: string;
  /** Where its feet are and which way it faces (radians about z). */
  position: Vec3;
  heading: number;
  /** Whether it is enabled now (its cell's enable state, or the scripts'). */
  readonly enabled: (reference: number) => boolean;
  /** Set on the ground under it since it was placed or moved. */
  grounded: boolean;
  /** It died while on the stage: its ragdoll lies where it fell (src/shell/actor-bodies.ts). */
  dead: boolean;
}

export interface ActorStageOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly sounding: SoundingWorld;
  /**
   * The key of the cell of this view a place is in (an exterior's grid cell, an interior), or
   * undefined if the view does not hold it (another worldspace or interior).
   */
  readonly cellOf: (at: StagePlace) => string | undefined;
  /** Whether a loaded cell is shown yet (its actors appear with it); all are without. */
  readonly cellShown?: (cell: string) => boolean;
  /**
   * Whether the view's cell of a key has its collision all in place (undefined: the view does
   * not hold or load that cell). Without it, the cells of the stage tell.
   */
  readonly collided?: (cell: string) => boolean | undefined;
  /** Where the player is (the actors near it move by themselves: src/shell/actor-movers.ts). */
  readonly focus?: () => Vec3 | undefined;
  /** An actor walked into (true) or out of a trigger volume of a reference. */
  readonly onTrigger?: (trigger: number, actor: number, entered: boolean) => void;
  /** The navigation meshes of the loaded area (actors' paths). */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** A door of the loaded area by its reference, for the actors going through it. */
  readonly door?: (reference: number) => DoorObject | undefined;
  /** The enabled objects and markers of the loaded area (what actors use and search for). */
  readonly objects?: () => Iterable<StageObject>;
  /** The view's lighting near a place (the light on actors: src/shell/actor-senses.ts). */
  readonly light?: (at: Vec3) => LightProbe | undefined;
  /** The view shows an interior (detection's reach and light inside). */
  readonly interior?: boolean;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** An actor put at a reference off the navmesh moves this far at most to stand on it. */
const SNAP_REACH = 512;
/** The collision this near an actor (its cell and the neighbours there) must be in place to set it down (units). */
const GROUND_REACH = 1024;

/** A loaded cell as the stage knows it. */
interface StageCell {
  /** Bumped when it goes: actors still being placed for it are dropped. */
  readonly generation: number;
  readonly enabled: (reference: number) => boolean;
  /**
   * Its collision is all in place (ground ran): actors coming into it are set down at once;
   * before, they wait for it (its objects' floors may still be missing over its landscape).
   */
  grounded: boolean;
}

export class ActorStage {
  readonly #options: ActorStageOptions;
  readonly #actors = new Map<number, StagedActor>();
  readonly #cells = new Map<string, StageCell>();
  /** References being placed now (not placed twice when two cells ask at once). */
  readonly #placing = new Set<number>();
  #generation = 0;

  /** The actors that move by themselves: their character controllers and movement. */
  readonly movers: ActorMovers;
  /** The living actors' bodies (their ragdolls, keyframed to their pose) and the dead's. */
  readonly bodies: ActorBodies;
  /** The actors' AI: their packages. */
  readonly ai: ActorAi;
  /** The furniture the actors use (chairs, beds, leans). */
  readonly furniture: ActorFurniture;
  /** What the actors' packages search the loaded area for. */
  readonly search: ActorSearch;
  /** The actors away: the low process (src/shell/actors-away.ts). */
  readonly away: ActorsAway;
  /** The doors the actors go through (src/shell/actor-doors.ts). */
  readonly doors: ActorDoors;
  /** What the actors notice: detection, their reactions (src/shell/actor-senses.ts). */
  readonly senses: ActorSenses;
  /** The renderer's clock at the last frame (seconds between frames, for the AI). */
  #clock: number | undefined;
  /** Each actor as a user of furniture. */
  readonly #users = new WeakMap<StagedActor, FurnitureUser>();

  constructor(options: ActorStageOptions) {
    this.#options = options;
    this.doors = new ActorDoors({
      session: options.session,
      find: (reference) => options.door?.(reference),
      unlocks: (actor) => this.ai.unlocksDoors(actor),
    });
    this.furniture = new ActorFurniture({
      session: options.session,
      terminal: options.terminal,
      release: (actor) => {
        this.movers.release(actor);
      },
      ...(options.objects && { objects: options.objects }),
    });
    this.movers = new ActorMovers({
      session: options.session,
      terminal: options.terminal,
      ...(options.onTrigger && { onTrigger: options.onTrigger }),
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      openDoor: (door, actor) => this.doors.passage(door, actor),
      shutTo: (actor) => this.doors.shutTo(actor),
      shutPlaces: (actor) => this.doors.shutPlaces(actor),
      held: (actor) => this.furniture.holds(actor),
      // The player walked into an actor: it flinches by where they came from (ActionBumpedInto's
      // idles by GetLastBumpDirection). TODO(M10) 4.3: its ActorCollidewithActor line.
      onBump: (actor) => {
        const staged = this.#actors.get(actor);
        if (staged) void this.furniture.playAction(this.userOf(staged), 'ActionBumpedInto');
      },
    });
    this.bodies = new ActorBodies(options.session);
    this.search = new ActorSearch({
      session: options.session,
      objects: () => options.objects?.() ?? [],
      actors: () => this.#searchActors(),
    });
    this.away = new ActorsAway({
      session: options.session,
      terminal: options.terminal,
      loaded: (place) => this.#loaded(place),
      staged: (actor) => this.#actors.has(actor),
      doors: this.doors,
    });
    this.ai = new ActorAi({
      session: options.session,
      movers: this.movers,
      furniture: this.furniture,
      search: this.search,
      userOf: (staged) => this.userOf(staged),
      leaveThrough: (staged, door, destination) => this.leaveThrough(staged, door, destination),
      doors: this.doors,
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      overrides: (actor) => this.senses.overridePackages(actor),
    });
    this.senses = new ActorSenses({
      session: options.session,
      movers: this.movers,
      furniture: this.furniture,
      ai: this.ai,
      actors: () => this.#actors.values(),
      get: (reference) => this.#actors.get(reference),
      interior: options.interior === true,
      ...(options.light && { light: options.light }),
      camera: () => options.renderer.view?.camera,
    });
  }

  /** An actor as a user of furniture: placed by it while it is in it (no controller). */
  userOf(staged: StagedActor): FurnitureUser {
    let user = this.#users.get(staged);
    if (!user) {
      user = {
        reference: staged.reference,
        get placed() {
          return staged.placed;
        },
        get position() {
          return staged.position;
        },
        get heading() {
          return staged.heading;
        },
        moveTo: (position, heading) => {
          staged.position = [...position];
          staged.heading = heading;
          const placed = staged.placed;
          const instance = placed.instances[0];
          if (!instance?.motion) return;
          instance.world.set(
            referenceMatrix({
              position,
              rotation: [0, 0, heading],
              scale: placed.actor.scale * placed.look.scale,
            }),
          );
          instance.motion.version++;
        },
        send: (event) => staged.placed.behavior?.sendEvent(event) ?? false,
      };
      this.#users.set(staged, user);
    }
    return user;
  }

  /** The enabled living actors as searches see them. */
  *#searchActors(): Iterable<{ reference: number; bases: readonly number[]; position: Vec3 }> {
    for (const staged of this.#actors.values()) {
      if (staged.visibility.hidden || staged.dead) continue;
      const { actor, look } = staged.placed;
      yield {
        reference: staged.reference,
        bases: [actor.base, look.npc],
        position: staged.position,
      };
    }
  }

  /** Whether a place is in a loaded cell of the view. */
  #loaded(place: AwayPlace): boolean {
    const at: StagePlace =
      place.space.kind === 'interior'
        ? { position: place.position, cell: place.space.cell }
        : { position: place.position, world: place.space.world };
    const key = this.#options.cellOf(at);
    return key !== undefined && this.#cells.has(key);
  }

  /**
   * An actor goes through a load door on its way to a place in another cell or worldspace: it
   * leaves the stage and comes out on the other side, on the stage again if that is loaded,
   * else away (the low process walks it on).
   */
  async leaveThrough(staged: StagedActor, door: RouteDoor, destination: AwayPlace): Promise<void> {
    const reference = staged.reference;
    if (this.#actors.get(reference) !== staged) return;
    this.#remove(staged);
    const arrival: AwayPlace = {
      space: door.arrivalSpace,
      position: door.arrival,
      heading: door.arrivalHeading,
    };
    if (this.#loaded(arrival)) this.doors.arrive(door.destination);
    else this.away.depart(reference, arrival, destination);
    await this.away.place(reference, arrival);
  }

  /** A staged actor by its reference. */
  get(reference: number): StagedActor | undefined {
    return this.#actors.get(reference);
  }

  /** Every actor of the loaded area, enabled or not. */
  all(): Iterable<StagedActor> {
    return this.#actors.values();
  }

  /** The enabled actors (what is drawn, animates, can be talked to). */
  *shown(): Iterable<PlacedActor> {
    for (const staged of this.#actors.values()) if (!staged.visibility.hidden) yield staged.placed;
  }

  /** The enabled actors that live (they animate). */
  *#living(): Iterable<PlacedActor> {
    for (const staged of this.#actors.values()) {
      if (!staged.visibility.hidden && !staged.dead) yield staged.placed;
    }
  }

  /** The physics world the actors move and are hit in (undefined: the play ended). */
  attachPlay(world: SensesWorld | undefined): void {
    this.movers.attach(world);
    this.bodies.attach(world?.physics);
    this.senses.attach(world);
  }

  /**
   * An actor died (Kill, killed in combat): it stops moving and acting, its ragdoll falls
   * from the pose it has. TODO(M10): bleedout first for essential and protected actors (5.1).
   */
  killed(reference: number): void {
    const staged = this.#actors.get(reference);
    if (!staged || staged.dead) return;
    staged.dead = true;
    this.ai.remove(reference);
    this.senses.killed(reference);
    this.furniture.remove(reference);
    this.movers.request(reference, undefined);
    this.movers.release(reference);
    staged.placed.face?.stopSpeaking();
    void this.bodies.kill(staged);
  }

  /** The references of the actors standing in a loaded cell (enabled or not). */
  referencesIn(cell: string): number[] {
    const found: number[] = [];
    for (const staged of this.#actors.values())
      if (staged.cell === cell) found.push(staged.reference);
    return found;
  }

  /** The enabled actors standing in a loaded cell. */
  shownIn(cell: string): PlacedActor[] {
    const found: PlacedActor[] = [];
    for (const staged of this.#actors.values()) {
      if (staged.cell === cell && !staged.visibility.hidden) found.push(staged.placed);
    }
    return found;
  }

  /** The scenes of the actors of the cells shown (a disabled actor's draws are hidden). */
  *scenes(): Iterable<GpuScene> {
    const shown = this.#options.cellShown;
    for (const staged of this.#actors.values()) {
      if (staged.scene && (!shown || shown(staged.cell))) yield staged.scene;
    }
  }

  /** Where a staged actor stands now (scripts' live placement). */
  livePlacement(
    reference: number,
  ): { position: [number, number, number]; rotation: [number, number, number] } | undefined {
    const staged = this.#actors.get(reference);
    if (!staged) return undefined;
    const [x, y, z] = staged.position;
    return { position: [x, y, z], rotation: [0, 0, staged.heading] };
  }

  /**
   * A cell of the view loaded: its actors that are in it now are placed (see the file's
   * comment). `actors` are its own references; `enabled` its enable state (read again on
   * refresh). Returns the ragdolls of the dead among them, which fall with the cell's
   * collision.
   */
  async attachCell(
    key: string,
    actors: readonly CellActor[],
    enabled: (reference: number) => boolean,
  ): Promise<CellRagdoll[]> {
    const cell: StageCell = { generation: ++this.#generation, enabled, grounded: false };
    this.#cells.set(key, cell);
    const runtime = this.#options.session.scriptsReady;
    const own = new Set(actors.map((actor) => actor.reference));
    const candidates: { actor: CellActor; here: boolean }[] = [];
    for (const actor of actors) {
      if (this.#actors.has(actor.reference) || this.#placing.has(actor.reference)) continue;
      const now = runtime ? await this.#movedPlace(runtime, actor.reference) : undefined;
      if (now === null) continue;
      if (now) {
        // Moved by a script: where it is now, if that is in this cell.
        if (this.#options.cellOf(now) !== key) continue;
        candidates.push({ actor: this.#at(actor, now, runtime), here: true });
      } else {
        candidates.push({ actor: this.#dead(actor, runtime), here: false });
      }
    }
    // Actors moved into this cell, and those the scripts created in it.
    if (runtime) {
      for (const [reference, state] of runtime.state.references) {
        if (!state.position || own.has(reference) || reference === PLAYER_REF) continue;
        if (this.#actors.has(reference) || this.#placing.has(reference)) continue;
        if (!(await this.#isActor(runtime, reference))) continue;
        const now = await this.#movedPlace(runtime, reference);
        if (!now || this.#options.cellOf(now) !== key) continue;
        const actor = await this.#cellActor(runtime, reference, now);
        if (actor) candidates.push({ actor: this.#dead(actor, runtime), here: true });
      }
    }
    if (this.#cells.get(key) !== cell) return [];
    const placed = await this.#place(candidates, key, cell, (reference) =>
      runtime?.state.created.has(reference) === true
        ? createdEnabled(runtime, reference)
        : cell.enabled(reference),
    );
    return ragdollsOf(
      placed.map((staged) => staged.placed),
      (path) => this.#options.session.collision(path),
    );
  }

  /** A loaded cell goes: the actors standing in it leave the stage. */
  detachCell(key: string): void {
    this.#cells.delete(key);
    for (const staged of [...this.#actors.values()]) {
      if (staged.cell === key) this.#remove(staged);
    }
  }

  /** Every cell goes (the view closes). */
  clear(): void {
    this.#cells.clear();
    for (const staged of [...this.#actors.values()]) this.#remove(staged);
  }

  /** The enable states changed: what is drawn follows. */
  refresh(): void {
    for (const staged of this.#actors.values()) {
      staged.visibility.hidden = !staged.enabled(staged.reference);
    }
  }

  /**
   * Sets the actors of a loaded cell on the ground once its collision is in place (those not
   * set yet: an actor that walked or was moved since stays where it is).
   */
  ground(key: string, physics: PhysicsWorld): void {
    const cell = this.#cells.get(key);
    if (cell) cell.grounded = true;
    // Those of this cell, and those near it that waited for it (a floor reaching over the
    // border: Whiterun's market stalls).
    for (const staged of this.#actors.values()) {
      if (staged.grounded || !this.#groundReady(staged)) continue;
      // Put at a reference its package names (not in its furniture): on the navmesh nearest it
      // (a sandbox's marker may lie in a hearth's fire). TODO(M13): the engine's own rule.
      const start = staged.placed.start;
      const snap = start?.kind === 'at' && !start.furniture ? start.radius : undefined;
      this.#settle(staged, physics, snap);
    }
  }

  /**
   * Whether the collision an actor stands on is all in place: its cell's, and that of the
   * loaded cells within GROUND_REACH of it (an object of the cell next door may reach over the
   * border under it; before it is there, the landscape under it would be found).
   */
  #groundReady(staged: StagedActor): boolean {
    if (this.#cells.get(staged.cell)?.grounded !== true) return false;
    const [x, y, z] = staged.position;
    for (const dx of [-GROUND_REACH, 0, GROUND_REACH]) {
      for (const dy of [-GROUND_REACH, 0, GROUND_REACH]) {
        const key = this.#options.cellOf({ position: [x + dx, y + dy, z] });
        if (key === undefined) continue;
        const collided = this.#options.collided
          ? this.#options.collided(key)
          : this.#cells.get(key)?.grounded;
        if (collided === false) return false;
      }
    }
    return true;
  }

  /**
   * An actor set down: on the navmesh near where it is (within `snap`, if given), then on the
   * ground under it.
   */
  #settle(staged: StagedActor, physics: PhysicsWorld, snap?: number): void {
    if (snap !== undefined) {
      const reach = Math.max(snap, SNAP_REACH);
      const on = this.#options.navmeshes?.()?.nearest?.(staged.position, reach);
      if (on) staged.position = [...on];
    }
    groundActor(staged.placed, staged.position, staged.heading, (from, length) => {
      const hit = physics.raycast(from, [0, 0, -1], length, Layer.charController);
      return hit && { point: hit.point, normal: hit.normal };
    });
    const world = staged.placed.instances[0]?.world;
    if (world) staged.position = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    staged.grounded = true;
  }

  /**
   * A script moved an actor: a staged one goes there (or leaves the stage, if there is not in
   * a loaded cell); one not staged comes onto the stage if there is.
   */
  async moved(reference: number, physics: PhysicsWorld | undefined): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const now = runtime && (await runtime.placement(reference, false));
    if (!runtime || !now) return;
    const key = this.#options.cellOf(now);
    const staged = this.#actors.get(reference);
    if (staged) {
      if (key === undefined || !this.#cells.has(key)) {
        this.#remove(staged);
        return;
      }
      // Moved out of the furniture it used (TODO(M13): the game's own state of it).
      this.furniture.remove(reference);
      staged.cell = key;
      staged.position = [...now.position];
      staged.heading = now.rotation[2];
      // Set on the ground there once the collision there is in place (else ground does it).
      const ready = this.#groundReady(staged);
      moveActor(staged.placed, staged.position, staged.heading, ready ? physics : undefined);
      this.movers.teleport(staged);
      const world = staged.placed.instances[0]?.world;
      if (world && ready) staged.position = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
      staged.grounded = physics !== undefined && ready;
      return;
    }
    const cell = key === undefined ? undefined : this.#cells.get(key);
    if (key === undefined || !cell || this.#placing.has(reference)) return;
    if (!(await this.#isActor(runtime, reference))) return;
    const actor = await this.#cellActor(runtime, reference, now);
    if (!actor) return;
    const placed = await this.#place(
      [{ actor: this.#dead(actor, runtime), here: true }],
      key,
      cell,
      (ref) => (runtime.state.created.has(ref) ? createdEnabled(runtime, ref) : cell.enabled(ref)),
    );
    // Its cell's collision in place: it is set down now (a living actor on the navmesh near
    // where it came: through a door, walking in from away); else once it is (ground).
    if (!physics) return;
    for (const staged of placed) {
      if (!this.#groundReady(staged)) continue;
      this.#settle(staged, physics, staged.dead || staged.placed.actor.startsDead ? undefined : 0);
    }
  }

  /** A script created a reference: an actor in a loaded cell comes onto the stage. */
  created(reference: number, physics: PhysicsWorld | undefined): Promise<void> {
    return this.moved(reference, physics);
  }

  /**
   * An actor's look changed (Actor.SetRace): it is made again in its new race where it
   * stands, its scene built again. TODO(M13): a dead actor's ragdoll keeps its old bodies.
   */
  async lookChanged(reference: number): Promise<void> {
    const staged = this.#actors.get(reference);
    if (!staged) return;
    const session = this.#options.session;
    const race = session.scriptsReady?.state.actors.get(reference)?.race;
    const placer = await session.actors();
    const old = staged.placed;
    const placed = await placer
      .place(
        { ...old.actor, position: staged.position, rotation: [0, 0, staged.heading] },
        undefined,
        race,
        { here: true },
      )
      .catch((error: unknown) => {
        this.#options.terminal.log('actor', `${old.actor.editorId}: ${describe(error)}`, 'warn');
        return undefined;
      });
    // It left meanwhile, or cannot be made in its new race.
    if (!placed || this.#actors.get(reference) !== staged || staged.placed !== old) return;
    const from = old.instances[0]?.world;
    const instance = placed.instances[0];
    if (from && instance) {
      instance.world.set(from);
      if (instance.motion) instance.motion.version++;
    }
    soundPlacedActors([placed], this.#options.sounding);
    staged.placed = placed;
    // Its controller is made again for its new body (its size, its graph).
    this.movers.release(reference);
    const previous = staged.scene;
    staged.scene = this.#scene(placed, staged.visibility);
    previous?.destroy();
  }

  /** Moves the enabled actors' skeletons; far or unseen ones less often (animationInterval). */
  animate(seconds: number): void {
    // Their AI first (what they want now), then their movement.
    const frame =
      this.#clock === undefined ? 0 : Math.min(0.25, Math.max(0, seconds - this.#clock));
    this.#clock = seconds;
    this.ai.frame(this.#actors.values(), frame, this.#options.focus?.());
    // What they notice (detection), and how they react.
    this.senses.frame(frame);
    this.away.frame(frame);
    this.movers.frame(this.#actors.values(), this.#options.focus?.());
    const times = new Map<StagedActor, number | undefined>();
    for (const staged of this.#actors.values()) times.set(staged, staged.placed.time);
    const camera = this.#options.renderer.view?.camera;
    animateSkeletons(
      this.#living(),
      seconds,
      camera &&
        ((animated) => {
          const world = (animated as PlacedActor).instances[0]?.world;
          return world
            ? animationInterval(
                [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
                camera.position,
                camera.forward,
              )
            : 0;
        }),
    );
    // Their bodies follow the poses (the dead's poses their bodies).
    this.bodies.frame(this.#actors.values(), this.#options.focus?.());
    // How their graphs moved them (root motion) moves them in the next physics steps; those
    // entering or leaving furniture it moves at once (they have no controller).
    for (const [staged, before] of times) {
      const after = staged.placed.time;
      if (before !== undefined && after !== undefined && after > before) {
        this.movers.animated(staged, after - before);
        this.furniture.animated(this.userOf(staged), after - before);
      }
    }
  }

  /** Places actors for a cell and puts them on the stage (unless the cell went meanwhile). */
  async #place(
    candidates: readonly { actor: CellActor; here: boolean }[],
    key: string,
    cell: StageCell,
    enabled: (reference: number) => boolean,
  ): Promise<StagedActor[]> {
    if (candidates.length === 0) return [];
    for (const { actor } of candidates) this.#placing.add(actor.reference);
    const { session, terminal, sounding } = this.#options;
    try {
      const placer = await session.actors();
      const placed = await Promise.all(
        candidates.map(({ actor, here }) =>
          placer.place(actor, undefined, undefined, { here }).catch((error: unknown) => {
            terminal.log(
              'actor',
              `${actor.editorId || actor.reference.toString(16)}: ${describe(error)}`,
              'warn',
            );
            return undefined;
          }),
        ),
      );
      // The cell went while they were made.
      if (this.#cells.get(key) !== cell) return [];
      const staged: StagedActor[] = [];
      for (const actor of placed) {
        if (!actor || this.#actors.has(actor.actor.reference)) continue;
        const reference = actor.actor.reference;
        const visibility: InstanceVisibility = { hidden: !enabled(reference) };
        const entry: StagedActor = {
          reference,
          placed: actor,
          scene: this.#scene(actor, visibility),
          visibility,
          cell: key,
          position: [...actor.actor.position],
          heading: actor.actor.rotation[2],
          enabled,
          grounded: false,
          dead: false,
        };
        this.#actors.set(reference, entry);
        staged.push(entry);
        this.away.arrived(reference);
        // Its abilities, diseases and worn enchantments act while it is here.
        const scripts = session.scriptsReady;
        if (scripts) scripts.detach(scripts.magic.prepare(reference));
        // Placed in the furniture its package uses: in it at once.
        const start = actor.start;
        if (actor.inFurniture && start?.kind === 'at') {
          void this.furniture.use(
            this.userOf(entry),
            start.reference,
            () => Promise.resolve(false),
            () => undefined,
            { quick: true },
          );
        }
      }
      soundPlacedActors(
        staged.map((entry) => entry.placed),
        sounding,
      );
      return staged;
    } finally {
      for (const { actor } of candidates) this.#placing.delete(actor.reference);
    }
  }

  #scene(placed: PlacedActor, visibility: InstanceVisibility): GpuScene | undefined {
    if (placed.instances.length === 0) return undefined;
    return this.#options.renderer.scene.createScene(
      placed.instances.map((instance) => ({ ...instance, visibility })),
    );
  }

  #remove(staged: StagedActor): void {
    this.#options.session.scriptsReady?.magic.unloaded(staged.reference);
    this.ai.remove(staged.reference);
    this.senses.remove(staged.reference);
    this.furniture.remove(staged.reference);
    this.movers.remove(staged.reference);
    this.bodies.remove(staged.reference);
    this.#actors.delete(staged.reference);
    staged.scene?.destroy();
    staged.scene = undefined;
  }

  /**
   * Where the game state has an actor a script moved or created (null: out of the world,
   * deleted or taken into a container), or undefined if it has none (it is where its cell
   * and its package have it).
   */
  async #movedPlace(
    runtime: ScriptRuntime,
    reference: number,
  ): Promise<{ position: Vec3; rotation: Vec3; cell?: number; world?: number } | null | undefined> {
    const state = runtime.state.references.get(reference);
    if (state?.deleted === true || state?.container !== undefined) return null;
    if (!state?.position) return undefined;
    const at = await runtime.placement(reference, false);
    return at
      ? { position: at.position, rotation: at.rotation, cell: at.cell, world: at.world }
      : null;
  }

  /** Whether a reference is an actor: a placed ACHR, or a created reference of an actor base. */
  async #isActor(runtime: ScriptRuntime, reference: number): Promise<boolean> {
    const db = runtime.forms.db;
    const created = runtime.state.created.get(reference);
    const formId = created ? created.base : reference;
    const location = db.locate(formId);
    if (!location) return false;
    const type = db.typeAt(location);
    if (created) return type === 'NPC_' || type === 'LVLN';
    if (type !== 'ACHR') return false;
    return (await runtime.baseOf(reference)) !== undefined;
  }

  /** An actor that is not one of the loaded cell's own references, as placed now. */
  async #cellActor(
    runtime: ScriptRuntime,
    reference: number,
    at: { position: Vec3; rotation: Vec3 },
  ): Promise<CellActor | undefined> {
    const created = runtime.state.created.get(reference);
    if (created) {
      return {
        reference,
        editorId: '',
        base: created.base,
        position: [...at.position],
        rotation: [0, 0, at.rotation[2]],
        scale: runtime.state.references.get(reference)?.scale ?? 1,
        links: new Map(),
        startsDead: false,
      };
    }
    const record = await runtime.forms.record(reference);
    if (record?.type !== 'ACHR') return undefined;
    const ref = parseReference(record);
    return {
      reference,
      editorId: ref.editorId,
      base: ref.base,
      position: [...at.position],
      rotation: [0, 0, at.rotation[2]],
      scale: ref.scale,
      links: linkedReferences(record),
      startsDead: (record.flags & RecordFlag.startsDead) !== 0,
    };
  }

  /** An actor where a script left it. */
  #at(
    actor: CellActor,
    at: { position: Vec3; rotation: Vec3 },
    runtime: ScriptRuntime | undefined,
  ): CellActor {
    return this.#dead(
      { ...actor, position: [...at.position], rotation: [0, 0, at.rotation[2]] },
      runtime,
    );
  }

  /** The dead stay dead: an actor the running game killed lies as a ragdoll. */
  #dead(actor: CellActor, runtime: ScriptRuntime | undefined): CellActor {
    const dead = runtime?.state.actors.get(actor.reference)?.dead === true;
    return dead && !actor.startsDead ? { ...actor, startsDead: true } : actor;
  }
}
