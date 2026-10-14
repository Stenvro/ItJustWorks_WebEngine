// Viewer for the game's content: single meshes (orbit camera, studio light) and complete
// interior cells (free camera, the cell's own lighting).

import { OrbitCamera, type OrbitView } from '../render/camera.ts';
import type { Rgb } from '../world/cell-records.ts';
import { cellStatesElement, checkboxRow } from './cell-states.ts';
import { InteriorSkyControls } from './interior-sky.ts';
import type { SkyElements } from './world-sky.ts';
import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import { articulatedPose } from '../physics/articulation.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import { Player } from './player.ts';
import {
  collisionGroup,
  objectActivation,
  openable,
  PlaySession,
  type Activatable,
  type CellRagdoll,
  type CollisionGroup,
} from './play-session.ts';
import { projectDecals } from '../render/decal-projection.ts';
import type { GpuDecals } from '../render/decals.ts';
import {
  placedParts,
  type GpuModel,
  type GpuScene,
  type GpuWaterType,
  type ModelInstance,
  type PlacedDirectional,
} from '../render/scene-renderer.ts';
import { studioLighting } from '../render/studio-lighting.ts';
import { cellSceneLighting, pointLights } from '../world/cell-lighting.ts';
import {
  cellArrival,
  doorDestination,
  loadCellData,
  type CellData,
  type CellLight,
  type CellWaterArea,
  type DoorDestination,
  type Teleport,
} from '../world/cell-loader.ts';
import type { Arrival } from '../world/worldspace.ts';
import { DEFAULT_WATER } from '../world/water.ts';
import { surfaceOver, waterVolumes, type WaterVolume } from '../world/water-volumes.ts';
import { cellNavmeshes, NAVMESH_TOLERANCE, NavmeshSurface } from '../world/navmesh.ts';
import { waterAreaHeight } from '../audio/water-audio.ts';
import {
  DEFAULT_INTERIOR_IMAGE_SPACE,
  parseImageSpace,
  type ImageSpace,
} from '../world/image-space.ts';
import {
  enabledReferences,
  findToggles,
  gameStartSelection,
  type CellToggle,
} from '../world/cell-upgrades.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
  type HomeActions,
  type HomeChoices,
  type HouseStage,
} from '../world/player-home.ts';
import type { InteriorCell, RecordDatabase } from '../world/record-db.ts';
import {
  animateSkeletons,
  animationInterval,
  type AnimatedSkeleton,
} from '../animation/animated-skeleton.ts';
import { groundActors, ragdollsOf, talkTargets, type PlacedActor } from './actors.ts';
import { PlayerAvatar } from './player-avatar.ts';
import { groundUnder, soundPlacedActors, type SoundingWorld } from './actor-sounds.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';

export interface SearchElements {
  readonly panel: HTMLElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
}

export interface ViewerElements {
  readonly meshes: SearchElements;
  readonly cells: SearchElements;
  /** Cells: container for the upgrade toggles of the cell on screen. */
  readonly upgrades: HTMLElement;
  /** Cells: play controls (the free camera). */
  readonly play: HTMLElement;
  readonly freeCamera: HTMLInputElement;
  /** Cells: what is on screen (the same line as the world's). */
  readonly status: HTMLElement;
  /** Cells: the clock and the weather outside (the same controls as the world's sky). */
  readonly sky: SkyElements;
  /** What the crosshair rests on. */
  readonly prompt: HTMLElement;
}

const MODEL_VIEW: OrbitView = { up: 'z', yaw: 0.6, pitch: 0.3, idleSpin: 10 };
const MAX_RESULTS = 80;
/** Camera height above the floor when entering a cell (≈ 1.7 m). */
const EYE_HEIGHT = 120;

interface CellView {
  readonly data: CellData;
  /** Quest and scene states, and which of them are on. */
  readonly toggles: readonly CellToggle[];
  selection: Set<number>;
  /** What the player can buy or build here, what they chose, and what the scripts did. */
  readonly actions: HomeActions;
  choices: HomeChoices;
  scripted: ReadonlyMap<number, boolean>;
  readonly models: ReadonlyMap<string, GpuModel | undefined>;
  /** The models' collision, by path. */
  readonly collisions: ReadonlyMap<string, CollisionData | undefined>;
  /** The dead actors' ragdolls (their skeletons' bodies). */
  readonly ragdolls: readonly CellRagdoll[];
  /** Statics' directional materials (snow, moss, ice) as placed, by reference. */
  readonly directionals: ReadonlyMap<number, PlacedDirectional>;
  readonly label: string;
  /** The cell's imagespace (XCIM, else the default interior one). */
  readonly imageSpace: ImageSpace | undefined;
  /** Water types of water activators, by WATR form id. */
  readonly waterTypes: ReadonlyMap<number, GpuWaterType | undefined>;
  /** Placed decals (blood, scorch marks, puddles), shown by the selection. */
  readonly decals: GpuDecals | undefined;
  /** Where actors walk (its navigation meshes): the player steps onto it off the stairs too. */
  readonly navmesh: NavmeshSurface;
  /** Every actor that can appear (shown by the selection). */
  readonly actors: readonly PlacedActor[];
}

const numberFormat = new Intl.NumberFormat('en-US');
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function matches<T>(items: readonly T[], text: (item: T) => string, query: string): T[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  const found: T[] = [];
  for (const item of items) {
    const haystack = text(item);
    if (terms.every((term) => haystack.includes(term))) {
      found.push(item);
      if (found.length >= MAX_RESULTS) break;
    }
  }
  return found;
}

function renderResults<T>(
  list: HTMLOListElement,
  items: readonly T[],
  label: (item: T) => string,
  open: (item: T) => void,
): void {
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'no-results';
    empty.textContent = 'no matches';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result';
      button.textContent = label(item);
      button.title = label(item);
      button.addEventListener('click', () => {
        open(item);
      });
      li.append(button);
      return li;
    }),
  );
}

export class ModelViewer {
  readonly #renderer: Renderer;
  readonly #canvas: HTMLElement;
  readonly #terminal: Terminal;
  readonly #ui: ViewerElements;
  readonly #orbit = new OrbitCamera();
  readonly #fly = new FlyCamera();
  #detachControls: (() => void) | undefined;
  #session: GameSession | undefined;
  #db: RecordDatabase | undefined;
  /** Guards against slow script runs finishing after newer choices. */
  #choiceToken = 0;
  #statesOpen = false;
  /** Dev checks: models not drawn. */
  #hidden: RegExp | undefined;
  #meshes: string[] = [];
  #cells: InteriorCell[] = [];
  /** The single mesh shown in mesh mode (not cached). */
  #meshModel: GpuModel | undefined;
  #scene: GpuScene | undefined;
  /** Guards against a slow load finishing after a newer one. */
  #loadToken = 0;
  /** The cell on screen, with everything needed to switch upgrades instantly. */
  #cell: CellView | undefined;
  /** The name of the interior cell being loaded, until the player stands in it. */
  #loading: string | undefined;
  /** The physics world and the player in the cell on screen. */
  #play: PlaySession | undefined;
  /** The collision of the objects shown. */
  #collision: CollisionGroup = collisionGroup();

  constructor(renderer: Renderer, canvas: HTMLElement, terminal: Terminal, ui: ViewerElements) {
    this.#renderer = renderer;
    this.#canvas = canvas;
    this.#terminal = terminal;
    this.#ui = ui;

    ui.meshes.search.addEventListener('input', () => {
      this.#showMeshResults();
    });
    ui.meshes.search.addEventListener('keydown', (event) => {
      const first = this.#meshMatches()[0];
      if (event.key === 'Enter' && first) this.#run(this.showMesh(first, MODEL_VIEW));
    });
    ui.cells.search.addEventListener('input', () => {
      this.#showCellResults();
    });
    ui.cells.search.addEventListener('keydown', (event) => {
      const first = this.#cellMatches()[0];
      if (event.key === 'Enter' && first) this.#run(this.showCell(first.formId));
    });
    ui.freeCamera.addEventListener('change', () => {
      this.#play?.setFreeCamera(ui.freeCamera.checked);
    });
  }

  /** The physics world and player of the cell on screen. */
  get play(): PlaySession | undefined {
    return this.#play;
  }

  /** The interior cell being loaded until the player stands in it (the loading screen). */
  get loading(): string | undefined {
    if (this.#loading === undefined) return undefined;
    if (this.#play?.spawned === true) this.#loading = undefined;
    return this.#loading;
  }

  /** Called when the player goes through a load door (the app takes them there). */
  onTravel: ((teleport: Teleport) => void) | undefined;
  /** Load door destinations by destination door. */
  readonly #destinations = new Map<number, DoorDestination | undefined>();

  /** What activating a reference does: load doors take the player to their destination. */
  #activatable(reference: number): Activatable | undefined {
    const object = this.#cell?.data.objects.find((candidate) => candidate.reference === reference);
    if (!object) return undefined;
    return objectActivation(
      object,
      this.#instances.get(reference),
      {
        name: (teleport) => this.#destinations.get(teleport.door)?.name ?? '',
        go: (teleport) => this.onTravel?.(teleport),
      },
      (descriptor, at) => void this.#session?.soundSystem?.play(descriptor, at),
    );
  }

  /** The drawn instances of the cell on screen, by reference. */
  #instances = new Map<number, ModelInstance>();
  /** The time and weather controls while a cell is shown. */
  #sky: InteriorSkyControls | undefined;
  /** The enabled water activators: their surfaces (heard) and volumes (entered). */
  #waterAreas: readonly CellWaterArea[] = [];
  #waterVolumes: readonly WaterVolume[] = [];
  /** The actors of the cell on screen (they animate every frame). */
  #actorsShown: readonly PlacedActor[] = [];
  /** The player's body while playing. */
  #avatar: PlayerAvatar | undefined;
  /** Shown objects whose behavior graph moves their skeleton. */
  #objectSkeletons: readonly AnimatedSkeleton[] = [];

  /** Starts playing the cell on screen: physics, and the player standing at `feet`. */
  async #startPlay(
    feet: readonly [number, number, number],
    yaw: number,
    /** The player arrives through a door: on the floor at its feet. */
    onFloor: boolean,
  ): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const token = this.#loadToken;
    const [matrix, playerData] = await Promise.all([
      session.collisionMatrix(),
      session.playerData(),
      initPhysics(),
    ]);
    if (token !== this.#loadToken) return;
    this.#stopPlay();
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.impactSpeed = playerData.ini.number('Audio', 'fMinSoundVel');
    physics.settleSeconds = playerData.ini.number('HAVOK', 'fWarmStartMaxTime');
    const player = new Player(
      { ...playerData, physics, waterHeight: (x, y, z) => this.#waterAt(x, y, z)?.height },
      feet,
      yaw,
    );
    player.character.walkable = (x, y, z) =>
      this.#cell?.navmesh.heightNear(x, y, z, NAVMESH_TOLERANCE) !== undefined;
    const play = new PlaySession({
      physics,
      player,
      camera: this.#fly,
      canvas: this.#canvas,
      groundReady: () => this.#collision.ready,
      // Arrival points lie on the floor; search a little above it (not up to a floor above).
      searchAbove: 64,
      arrivesOnFloor: onFloor,
      activatable: (reference) => this.#activatable(reference),
      actorAt: talkTargets(
        () => this.#actorsShown,
        () => this.#session,
        this.#terminal,
      ),
      prompt: this.#ui.prompt,
      onImpact: (impact) => {
        this.#session?.soundSystem?.impact(impact);
      },
    });
    play.lensShift = this.#fly.lensShift;
    play.onFreeCamera = (free) => {
      this.#ui.freeCamera.checked = free;
    };
    this.#play = play;
    this.#ui.freeCamera.checked = false;
    this.#ui.play.hidden = false;
    // The player's body (third person) and first-person camera animation.
    PlayerAvatar.create(session, this.#renderer, player, this.#soundingWorld).then(
      (avatar) => {
        if (this.#play === play) this.#avatar = avatar;
        else avatar?.destroy();
      },
      (error: unknown) => {
        this.#terminal.log('actor', `player: ${describe(error)}`, 'warn');
      },
    );
  }

  #stopPlay(): void {
    this.#avatar?.destroy();
    this.#avatar = undefined;
    this.#play?.dispose();
    this.#play = undefined;
    this.#collision = collisionGroup();
    this.#ui.play.hidden = true;
  }

  /** Called when the viewer takes the screen (another viewer then steps back). */
  onActivate: (() => void) | undefined;
  /** Whether the renderer shows this viewer's view. */
  #viewShown = false;
  /** Real seconds of the last clock tick (cells). */
  #lastClock: number | undefined;

  /** Centres the image in the part of the screen the shell does not cover. */
  set lensShift(shift: number) {
    this.#orbit.lensShift = shift;
    this.#fly.lensShift = shift;
    if (this.#play) this.#play.lensShift = shift;
  }

  /** Every mesh path in the VFS (for tools and dev checks). */
  get meshes(): readonly string[] {
    return this.#meshes;
  }

  /** The free camera used for cells (for dev checks). */
  get flyCamera(): FlyCamera {
    return this.#fly;
  }

  get cells(): readonly InteriorCell[] {
    return this.#cells;
  }

  /** Starts using a (new) game session: lists its meshes and cells. */
  async connect(session: GameSession): Promise<void> {
    this.#reset();
    this.#session = session;
    const { vfs, loader } = session;
    this.#meshes = vfs.list('meshes').filter((path) => path.endsWith('.nif'));
    this.#terminal.log(
      'sys',
      `${loader.workerCount} asset workers · ${numberFormat.format(this.#meshes.length)} meshes`,
    );
    this.#ui.meshes.panel.hidden = false;
    this.#ui.meshes.count.textContent = `${numberFormat.format(this.#meshes.length)} meshes`;
    this.#showMeshResults();

    const db = await session.db;
    this.#db = db;
    this.#cells = await db.interiorCells();
    this.#terminal.log('esm', `${numberFormat.format(this.#cells.length)} interior cells`);
    this.#ui.cells.panel.hidden = false;
    this.#ui.cells.count.textContent = `${numberFormat.format(this.#cells.length)} cells`;
    this.#showCellResults();
  }

  /** Loads a mesh and shows it on its own. */
  async showMesh(path: string, view: OrbitView): Promise<void> {
    const loader = this.#session?.loader;
    const textures = this.#session?.textures;
    if (!loader || !textures) return;
    // A single model has no sounds of its own (a cell shown before had).
    this.#session?.soundSystem?.stopAll();
    const token = ++this.#loadToken;
    const start = performance.now();
    this.#terminal.log('nif', `loading ${path}`);

    const loaded = await loader.loadModel(path);
    const model = await this.#renderer.scene.createModel(loaded.model, textures);
    model.addons = (await this.#session?.addons(loaded.model.addons)) ?? [];
    if (token !== this.#loadToken) {
      model.destroy();
      return;
    }
    for (const problem of loaded.problems) this.#terminal.log('nif', problem, 'warn');
    for (const skipped of loaded.model.skipped) this.#terminal.log('nif', skipped, 'warn');
    for (const failure of textures.takeFailures()) this.#terminal.log('dds', failure, 'warn');
    this.#releaseCell();
    this.#renderUpgrades();
    const triangles = loaded.model.parts.reduce((sum, part) => sum + part.indices.length / 3, 0);
    this.#terminal.log(
      'nif',
      `${path.replace(/^meshes\\/, '')} · ${loaded.model.parts.length} parts · ` +
        `${numberFormat.format(triangles)} triangles · ${(performance.now() - start).toFixed(0)} ms ` +
        `(worker ${loaded.workMs.toFixed(0)} ms)`,
      'ok',
    );

    this.#orbit.setView(view);
    // Particle-only models (master particle systems) have no shapes to measure.
    this.#orbit.fit(model.center, model.radius > 0 ? model.radius : 64);
    const graph = startObjectGraph(model, 0);
    const skeletal = startPlacedSkeleton(model, 0);
    const instance: ModelInstance = {
      model,
      world: identity(),
      ...(graph && { graph }),
      ...(skeletal && { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }),
    };
    this.#objectSkeletons = skeletal ? [skeletal.skeleton] : [];
    this.#present(this.#renderer.scene.createScene([instance]), model, { camera: 'orbit' });
  }

  /** Opens a mesh with the regular model view. */
  showModel(path: string): Promise<void> {
    return this.showMesh(path, MODEL_VIEW);
  }

  /**
   * Loads an interior cell with all its objects and lights. The player arrives at `arrival`
   * (a load door's destination), else as through the cell's own door.
   */
  async showCell(formId: number, arrival?: Arrival): Promise<void> {
    const info = this.#cells.find((cell) => cell.formId === formId);
    this.#loading = info ? (info.name !== '' ? info.name : info.editorId) : 'interior';
    try {
      await this.#showCell(formId, arrival);
    } catch (error) {
      this.#loading = undefined;
      throw error;
    }
  }

  async #showCell(formId: number, arrival: Arrival | undefined): Promise<void> {
    const db = this.#db;
    if (!db) return;
    const token = ++this.#loadToken;
    const start = performance.now();
    const data = await loadCellData(db, formId);
    const label = `${data.cell.editorId}${data.cell.name ? ` "${data.cell.name}"` : ''}`;
    for (const skipped of data.skipped) this.#terminal.log('cell', skipped, 'warn');

    // Load every model that can appear, so switching upgrades is instant, and find what the
    // player can buy or build here.
    const paths = [...new Set(data.objects.map((object) => object.model))];
    const session = this.#session;
    const waterIds = [
      ...new Set(
        data.objects.flatMap((object) => (object.water === undefined ? [] : [object.water])),
      ),
    ];
    const [models, collisions, directionals, actions, imageSpace, waterTypes, actors] =
      await Promise.all([
        Promise.all(paths.map(async (path) => [path, await this.#cellModel(path)] as const)).then(
          (entries) => new Map(entries),
        ),
        Promise.all(
          paths.map(async (path) => [path, await session?.collision(path)] as const),
        ).then((entries) => new Map(entries)),
        Promise.all(
          data.objects.map(
            async (object) =>
              [object.reference, await session?.directionalMaterial(object.directional)] as const,
          ),
        ).then(
          (entries) =>
            new Map(
              entries.flatMap(([reference, directional]) =>
                directional ? [[reference, directional] as const] : [],
              ),
            ),
        ),
        this.#homeActions(data),
        db
          .get(data.cell.imageSpace ?? DEFAULT_INTERIOR_IMAGE_SPACE)
          .then((record) => (record?.type === 'IMGS' ? parseImageSpace(record) : undefined)),
        Promise.all(waterIds.map(async (id) => [id, await session?.waterType(id)] as const)).then(
          (entries) => new Map(entries),
        ),
        this.#placeActors(data),
        session?.waterType(DEFAULT_WATER).then((type) => {
          this.#renderer.scene.defaultWater = type;
        }),
      ]);
    const toggles = findToggles(data, actions.controlled);
    // Homes open furnished; "new game" shows them as bought.
    const choices = fullyUpgraded(actions, NEW_GAME);
    const scripted = await this.#playActions(actions, choices);
    if (token !== this.#loadToken) return;

    // Decals land on the nearest surface along their projection (of the objects shown when
    // the cell opens).
    const opening = enabledReferences(data, toggles, gameStartSelection(toggles), scripted);
    const placed = data.objects.flatMap((object) => {
      const model = opening(object.reference) ? models.get(object.model) : undefined;
      return model ? [{ model, world: object.world }] : [];
    });
    const decals =
      session &&
      (await this.#renderer.decals.createDecals(
        projectDecals(data.decals, placedParts(placed)),
        session.textures,
      ));
    if (token !== this.#loadToken) {
      decals?.destroy();
      return;
    }
    for (const failure of this.#session?.textures.takeFailures() ?? []) {
      this.#terminal.log('dds', failure, 'warn');
    }
    const previousDecals = this.#cell?.decals;
    this.#cell = {
      data,
      toggles,
      selection: new Set(session?.cellSelections.get(formId) ?? gameStartSelection(toggles)),
      actions,
      choices,
      scripted,
      models,
      collisions,
      directionals,
      label,
      imageSpace,
      waterTypes,
      decals,
      navmesh: new NavmeshSurface(await cellNavmeshes(db, formId)),
      actors,
      ragdolls: session ? await ragdollsOf(actors, (path) => session.collision(path)) : [],
    };
    // The player arrives as through the cell's door; without one, at its middle.
    const comeIn = arrival ?? (await cellArrival(db, data));
    if (token !== this.#loadToken) return;
    // Load doors: where they lead (for the activation prompt).
    for (const object of data.objects) {
      if (object.teleport && !this.#destinations.has(object.teleport.door)) {
        this.#destinations.set(object.teleport.door, await doorDestination(db, object.teleport));
      }
    }
    const [x, y, z] = comeIn?.position ?? data.entrance;
    this.#fly.position = [x, y, z + EYE_HEIGHT];
    const centre = data.objects.reduce<[number, number, number]>(
      (sum, object) => [
        sum[0] + (object.world[12] ?? 0),
        sum[1] + (object.world[13] ?? 0),
        sum[2] + (object.world[14] ?? 0),
      ],
      [0, 0, 0],
    );
    const count = Math.max(1, data.objects.length);
    this.#fly.lookAtPoint([centre[0] / count, centre[1] / count, z + EYE_HEIGHT]);
    await this.#startPlay([x, y, z], comeIn ? comeIn.heading : this.#fly.yaw, comeIn !== undefined);
    if (token !== this.#loadToken) return;

    this.#renderUpgrades();
    const visible = this.#applyCellSelection();
    if (session) {
      this.#sky?.dispose();
      this.#sky = new InteriorSkyControls(session, this.#ui.sky);
    }
    this.#ui.status.hidden = false;
    this.#ui.status.textContent =
      `${label} · ${String(visible)} of ${String(data.objects.length)} objects · ` +
      `${String(this.#actorsShown.length)} of ${String(data.actors.length)} actors`;
    if (previousDecals !== decals) previousDecals?.destroy();
    const what = [
      actions.purchases.length > 0 ? `${String(actions.purchases.length)} purchases` : '',
      actions.house ? 'HearthFire house' : '',
      toggles.length > 0 ? `${String(toggles.length)} quest states` : '',
    ].filter(Boolean);
    this.#terminal.log(
      'cell',
      `${label} ${hex(formId)} · ${visible} of ${data.objects.length} objects shown · ` +
        `${this.#actorsShown.length} of ${data.actors.length} actors · ` +
        `${models.size} models${what.length > 0 ? ` · ${what.join(' · ')}` : ''} · ` +
        `${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    this.#terminal.log(
      'cell',
      'click the scene to look around · WASD to move · shift to run · esc to release',
    );
  }

  /** The cell's actors, ready to draw (those that cannot be made are left out, logged). */
  async #placeActors(data: CellData): Promise<PlacedActor[]> {
    const session = this.#session;
    if (!session || data.actors.length === 0) return [];
    const placer = await session.actors();
    const placed = await Promise.all(
      data.actors.map((actor) =>
        placer.place(actor).catch((error: unknown) => {
          this.#terminal.log(
            'actor',
            `${actor.editorId || hex(actor.reference)}: ${describe(error)}`,
            'warn',
          );
          return undefined;
        }),
      ),
    );
    const actors = placed.filter((actor): actor is PlacedActor => actor !== undefined);
    soundPlacedActors(actors, this.#soundingWorld);
    return actors;
  }

  /** What actors' animations sound with: the session's sounds, the play's collision. */
  readonly #soundingWorld: SoundingWorld = {
    sounds: () => this.#session?.soundSystem,
    ground: (at, exclude) => groundUnder(this.#play?.physics, at, exclude),
    water: (at) => this.#waterAt(at[0], at[1], at[2]),
  };

  #scriptEnvironment(): Promise<ScriptEnvironment> | undefined {
    return this.#session?.scripts();
  }

  async #homeActions(data: CellData): Promise<HomeActions> {
    const none: HomeActions = { purchases: [], house: undefined, controlled: new Set() };
    try {
      const env = await this.#scriptEnvironment();
      return env ? await findHomeActions(env, data) : none;
    } catch (error) {
      this.#terminal.log('papyrus', `player actions not available: ${describe(error)}`, 'warn');
      return none;
    }
  }

  /** Plays the player's actions in the Papyrus VM; returns the scripted enable states. */
  async #playActions(
    actions: HomeActions,
    choices: HomeChoices,
  ): Promise<ReadonlyMap<number, boolean>> {
    if (actions.purchases.length === 0 && !actions.house) return new Map();
    const env = await this.#scriptEnvironment();
    if (!env) return new Map();
    const result = await playHomeActions(env, actions, choices);
    for (const warning of result.warnings.slice(0, 3)) {
      this.#terminal.log('papyrus', warning, 'warn');
    }
    if (result.warnings.length > 3) {
      this.#terminal.log('papyrus', `… ${String(result.warnings.length - 3)} more script warnings`);
    }
    return result.enabled;
  }

  /** Rebuilds the cell scene for the current choices; returns the object count. */
  #applyCellSelection(): number {
    const cell = this.#cell;
    if (!cell) return 0;
    const isEnabled = enabledReferences(cell.data, cell.toggles, cell.selection, cell.scripted);
    const session = this.#session;
    const instances: ModelInstance[] = [];
    const placed = new Map<CellData['objects'][number], ModelInstance>();
    const articulatedPoses = new Map<CellData['objects'][number], ActorPose>();
    const shown = new Map<number, ModelInstance>();
    this.#instances = shown;
    this.#waterAreas = cell.data.waterAreas.filter((area) => isEnabled(area.reference));
    const volumes: WaterVolume[] = [];
    this.#waterVolumes = volumes;
    const skeletons: AnimatedSkeleton[] = [];
    for (const object of cell.data.objects) {
      if (!isEnabled(object.reference)) continue;
      const collision = cell.collisions.get(object.model);
      if (object.water !== undefined) {
        volumes.push(...waterVolumes(collision, object.world, object.water));
      }
      if (this.#hidden?.test(object.model)) continue;
      const model = cell.models.get(object.model);
      const water = object.water === undefined ? undefined : cell.waterTypes.get(object.water);
      const directional = cell.directionals.get(object.reference);
      if (model) {
        const graph = startObjectGraph(model, object.reference);
        const skeletal = startPlacedSkeleton(model, object.reference);
        if (skeletal) skeletons.push(skeletal.skeleton);
        // Bodies that move nodes one by one pose the model (ragdolls, hinged signs); objects
        // simulated as one body get a matrix of their own.
        const articulated = skeletal ? undefined : articulatedPose(model.nodes, collision);
        const moves =
          !articulated &&
          collision?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom) === true;
        const posed = skeletal
          ? { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }
          : articulated;
        if (articulated) articulatedPoses.set(object, articulated.pose);
        const instance: ModelInstance = {
          model,
          world: moves ? new Float32Array(object.world) : object.world,
          ...(moves && { motion: { version: 0 } }),
          ...(graph && { graph }),
          ...(posed && { pose: posed.pose, poseNodes: posed.poseNodes }),
          ...(this.#play && {
            playback: openable(object, model.sequences?.byName.has('open') === true),
          }),
          ...(water && { water }),
          ...(directional && { directional }),
          ...(object.leafAnimation && { leafAnimation: object.leafAnimation }),
          ...(session &&
            object.emittance !== undefined && { emittance: session.emittance(object.emittance) }),
        };
        instances.push(instance);
        placed.set(object, instance);
        shown.set(object.reference, instance);
      }
    }
    // Actors.
    const objectCount = instances.length;
    const actors = cell.actors.filter((actor) => isEnabled(actor.actor.reference));
    for (const actor of actors) instances.push(...actor.instances);
    this.#actorsShown = actors;
    this.#objectSkeletons = skeletons;
    // The collision of what is shown (rebuilt when the selection changes).
    const play = this.#play;
    if (play) {
      play.remove(this.#collision);
      this.#collision = collisionGroup();
      const actors = this.#actorsShown;
      play.add(this.#collision, {
        // Its actors stand on the ground once it is in place.
        whenComplete: () => {
          groundActors(actors, play.physics);
        },
        objects: cell.data.objects
          .filter((object) => isEnabled(object.reference))
          .map((object) => {
            const articulated = articulatedPoses.get(object);
            return {
              object,
              collision: cell.collisions.get(object.model),
              instance: placed.get(object),
              ...(articulated && { articulated }),
            };
          }),
        primitives: cell.data.primitives.filter((primitive) => isEnabled(primitive.reference)),
        ragdolls: cell.ragdolls.filter((ragdoll) => isEnabled(ragdoll.reference)),
      });
    }
    // The cell's sounds: its enabled loops, acoustic spaces and its own acoustic space.
    if (session) {
      const emitters = cell.data.emitters.filter((emitter) => isEnabled(emitter.reference));
      const areas = cell.data.acousticAreas.filter((area) => isEnabled(area.reference));
      const space = cell.data.cell.acousticSpace;
      void session.sounds().then((sounds) => {
        if (this.#cell !== cell) return;
        sounds.setEmitters(emitters);
        sounds.setAcousticAreas(areas);
        sounds.setCellAcousticSpace(space);
      });
    }
    const scene = this.#renderer.scene.createScene(instances);
    cell.decals?.select(isEnabled);
    const lighting = cellSceneLighting(cell.data, isEnabled);
    const lights = cell.data.lights.filter((light) => isEnabled(light.reference));
    // The imagespace's Sunlight Scale brightens the cell's directional light (HDR).
    const scale = cell.imageSpace?.hdr.sunlightScale ?? 1;
    this.#present(scene, undefined, {
      camera: 'fly',
      lighting: {
        ...lighting,
        sunColor: [
          lighting.sunColor[0] * scale,
          lighting.sunColor[1] * scale,
          lighting.sunColor[2] * scale,
        ],
      },
      imageSpace: cell.imageSpace,
      lights,
      decals: cell.decals,
    });
    return objectCount;
  }

  /** Plays new choices for the cell on screen and shows the result. */
  async #setChoices(choices: HomeChoices): Promise<void> {
    const cell = this.#cell;
    if (!cell) return;
    cell.choices = choices;
    const token = ++this.#choiceToken;
    const scripted = await this.#playActions(cell.actions, choices);
    if (token !== this.#choiceToken || this.#cell !== cell) return;
    cell.scripted = scripted;
    this.#renderUpgrades();
    this.#applyCellSelection();
  }

  /**
   * The cell's controls: what the player buys or builds (played with the game's scripts),
   * presets for a new game and a fully upgraded home, and, folded away, quest states.
   */
  #renderUpgrades(): void {
    const cell = this.#cell;
    const container = this.#ui.upgrades;
    const { actions, choices } = cell ?? {};
    if (!cell || !actions || !choices) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const hasActions = actions.purchases.length > 0 || actions.house !== undefined;
    if (!hasActions && cell.toggles.length === 0) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const button = (text: string, onClick: () => void): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'preset';
      element.textContent = text;
      element.addEventListener('click', onClick);
      return element;
    };
    const checkbox = checkboxRow;
    const select = (
      text: string,
      options: readonly (readonly [string, string])[],
      value: string,
      onChange: (value: string) => void,
    ): HTMLLIElement => {
      const item = document.createElement('li');
      const labelElement = document.createElement('label');
      labelElement.className = 'choice';
      const element = document.createElement('select');
      for (const [optionValue, optionText] of options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionText;
        element.append(option);
      }
      element.value = value;
      element.addEventListener('change', () => {
        onChange(element.value);
      });
      labelElement.append(text, element);
      item.append(labelElement);
      return item;
    };
    const update = (change: Partial<HomeChoices>): void => {
      this.#run(this.#setChoices({ ...choices, ...change }));
    };
    const parts: HTMLElement[] = [];

    if (hasActions) {
      const head = document.createElement('div');
      head.className = 'upgrades-head';
      const title = document.createElement('span');
      title.textContent = actions.house ? 'build' : 'purchases';
      head.append(
        title,
        button('new game', () => {
          this.#setCellPreset('new game');
        }),
        button('fully upgraded', () => {
          this.#setCellPreset('fully upgraded');
        }),
      );
      parts.push(head);
      const list = document.createElement('ul');
      list.className = 'upgrade-list';
      const { house } = actions;
      if (house) {
        list.append(
          select(
            'house',
            [
              ['plot', 'empty plot'],
              ['small house', 'small house'],
              ['full', 'main hall and wings'],
            ],
            choices.stage,
            (stage) => {
              update({ stage: stage as HouseStage });
            },
          ),
        );
        for (const wing of house.wings) {
          list.append(
            select(
              wing.name.toLowerCase(),
              [['', 'none'], ...wing.rooms.map((room) => [room, room] as const)],
              choices.wings.get(wing.name) ?? '',
              (room) => {
                const wings = new Map(choices.wings);
                wings.set(wing.name, room === '' ? undefined : room);
                update({ wings });
              },
            ),
          );
        }
        list.append(
          checkbox('furnish finished rooms', choices.furnished, (on) => {
            update({ furnished: on });
          }),
        );
      }
      for (const purchase of actions.purchases) {
        list.append(
          checkbox(
            purchase.label,
            choices.purchases.has(purchase.info),
            (on) => {
              const purchases = new Set(choices.purchases);
              if (on) purchases.add(purchase.info);
              else purchases.delete(purchase.info);
              update({ purchases });
            },
            `dialogue ${hex(purchase.info)}`,
          ),
        );
      }
      parts.push(list);
    }

    if (cell.toggles.length > 0) {
      parts.push(
        cellStatesElement(
          cell.toggles,
          cell.selection,
          (selection) => {
            cell.selection = selection;
            this.#session?.cellSelections.set(cell.data.cell.formId, selection);
            this.#applyCellSelection();
          },
          this.#statesOpen,
          (open) => {
            this.#statesOpen = open;
          },
        ),
      );
    }

    container.replaceChildren(...parts);
    container.hidden = false;
  }

  #setCellPreset(preset: 'new game' | 'fully upgraded'): void {
    const cell = this.#cell;
    if (!cell) return;
    cell.selection = gameStartSelection(cell.toggles);
    this.#run(
      this.#setChoices(
        preset === 'new game' ? NEW_GAME : fullyUpgraded(cell.actions, cell.choices),
      ),
    );
  }

  /** What the player can buy and build in the cell on screen (for dev checks). */
  get cellActions(): HomeActions | undefined {
    return this.#cell?.actions;
  }

  /** Quest states of the cell on screen (for dev checks). */
  get cellToggles(): readonly CellToggle[] {
    return this.#cell?.toggles ?? [];
  }

  /** Plays new choices for the cell on screen (for dev checks). */
  setCellChoices(choices: HomeChoices): Promise<void> {
    return this.#setChoices(choices);
  }

  /** Applies a preset to the cell on screen (for dev checks). */
  setCellPreset(preset: 'new game' | 'fully upgraded'): void {
    this.#setCellPreset(preset);
  }

  /** Objects of the cell on screen near a point, with their state (for dev checks). */
  cellObjectsNear(
    point: readonly [number, number, number],
    distance: number,
  ): { reference: string; model: string; enabled: boolean; loaded: boolean }[] {
    const cell = this.#cell;
    if (!cell) return [];
    const isEnabled = enabledReferences(cell.data, cell.toggles, cell.selection, cell.scripted);
    return cell.data.objects
      .filter(
        (o) =>
          Math.hypot(
            (o.world[12] ?? 0) - point[0],
            (o.world[13] ?? 0) - point[1],
            (o.world[14] ?? 0) - point[2],
          ) <= distance,
      )
      .map((o) => ({
        reference: hex(o.reference),
        model: o.model,
        enabled: isEnabled(o.reference),
        loaded: cell.models.get(o.model) !== undefined,
      }));
  }

  /** Hides objects whose model path matches (for dev checks); undefined shows all. */
  hideModels(pattern: RegExp | undefined): void {
    this.#hidden = pattern;
    this.#applyCellSelection();
  }

  /** The player's body while playing. */
  get avatar(): PlayerAvatar | undefined {
    return this.#avatar;
  }

  /** The player's body, in third person or seen from the free camera. */
  #avatarScenes(): GpuScene[] {
    const play = this.#play;
    const avatar = this.#avatar;
    if (!play || !avatar) return [];
    return play.freeCamera || play.player.pov === 'third' ? [avatar.scene] : [];
  }

  /** The actors shown in the cell on screen. */
  get actorsShown(): readonly PlacedActor[] {
    return this.#actorsShown;
  }

  /** Number of objects shown in the cell on screen (for dev checks). */
  get cellObjectsShown(): number {
    const cell = this.#cell;
    if (!cell) return 0;
    const isEnabled = enabledReferences(cell.data, cell.toggles, cell.selection, cell.scripted);
    return cell.data.objects.filter((object) => isEnabled(object.reference)).length;
  }

  /** A cell model from the session's cache; undefined for editor markers and broken files. */
  #cellModel(path: string): Promise<GpuModel | undefined> {
    return this.#session?.model(path) ?? Promise.resolve(undefined);
  }

  #present(
    scene: GpuScene,
    meshModel: GpuModel | undefined,
    view:
      | { camera: 'orbit' }
      | {
          camera: 'fly';
          lighting: ReturnType<typeof cellSceneLighting>;
          imageSpace: ImageSpace | undefined;
          /** Placed lights, flickering and pulsing per frame. */
          lights: readonly CellLight[];
          decals: GpuDecals | undefined;
        },
  ): void {
    this.onActivate?.();
    const previousScene = this.#scene;
    const previousMesh = this.#meshModel;
    this.#scene = scene;
    this.#meshModel = meshModel;
    this.#detachControls?.();
    if (view.camera === 'orbit') {
      this.#detachControls = this.#orbit.attach(this.#canvas);
      this.#renderer.setView({
        scenes: () => [scene],
        camera: this.#orbit,
        lighting: () => studioLighting(this.#orbit),
        backdrop: true,
        update: (seconds) => {
          animateSkeletons(this.#objectSkeletons, seconds);
        },
      });
    } else {
      // Playing: the player's camera (or the free camera); before that the free camera.
      const play = this.#play;
      const camera = play?.view ?? this.#fly;
      if (play) {
        play.attach();
        this.#detachControls = () => {
          play.detach();
        };
      } else {
        this.#detachControls = this.#fly.attach(this.#canvas);
      }
      const { lighting, imageSpace, lights, decals } = view;
      this.#renderer.setView({
        scenes: () => [scene, ...this.#avatarScenes()],
        camera,
        lighting: () => ({
          ...lighting,
          lights: pointLights(lights, this.#tickClock(), camera.position, (id) =>
            this.#emittanceRgb(id),
          ),
        }),
        imageSpace: () => imageSpace,
        decals: () => (decals ? [decals] : []),
        backdrop: false,
        update: (seconds) => {
          this.#avatar?.update(seconds);
          const camera = this.#renderer.view?.camera;
          animateSkeletons(
            this.#actorsShown,
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
          animateSkeletons(this.#objectSkeletons, seconds);
        },
      });
    }
    this.#viewShown = true;
    previousScene?.destroy();
    if (previousMesh !== meshModel) previousMesh?.destroy();
    document.body.classList.add('has-scene');
    // The CRT overlay belongs to the page background, never over a model, cell or world.
    document.body.classList.add('content-scene');
  }

  /** The water a point of the interior is in or over: a water activator's volume. */
  readonly #waterAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => surfaceOver(this.#waterVolumes, x, y, z);

  /** The water one hears around a point (height `z`): the water activators' surfaces. */
  readonly #waterSurfaceAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => {
    for (const area of this.#waterAreas) {
      const height = waterAreaHeight(area, x, y, z);
      if (height !== undefined) return { height, type: area.type };
    }
    return undefined;
  };

  /** Whether the camera is under the interior's water. */
  #underwater(): boolean {
    const camera = this.#renderer.view?.camera.position;
    if (!camera) return false;
    const water = this.#waterAt(camera[0], camera[1], camera[2]);
    return water !== undefined && camera[2] < water.height;
  }

  /**
   * Advances the session's game clock at the timescale (time passes indoors too) and moves the
   * emittance colours with it (sunlight bounce lights dark at night); returns real seconds.
   */
  #tickClock(): number {
    const now = performance.now() / 1000;
    const session = this.#session;
    if (session) {
      const delta = this.#lastClock === undefined ? 0 : Math.min(0.25, now - this.#lastClock);
      // At the TimeScale times the panel's fast-forward (the slider sets the hour).
      session.advanceClock((delta * session.clockRate) / 3600);
      this.#sky?.sync();
      session.updateEmittance(session.gameHour);
      // Indoors the sound system plays the region of the cell's acoustic space.
      session.soundSystem?.setAmbience(
        this.#cell && {
          regions: [],
          weather: undefined,
          previousWeather: undefined,
          transition: 1,
          hour: session.gameHour,
          interior: true,
          swimming: this.#play?.player.swimming ?? false,
          flash: undefined,
          cellMusic: this.#cell.data.cell.musicType,
          worldMusic: undefined,
          waterAt: this.#waterSurfaceAt,
          underwater: this.#underwater(),
        },
      );
    }
    this.#lastClock = now;
    return now;
  }

  #emittanceRgb(formId: number): Rgb {
    return this.#session?.emittance(formId).rgb ?? [0, 0, 0];
  }

  /** Forgets the shown cell and frees what was made for it. */
  #releaseCell(): void {
    this.#stopPlay();
    this.#sky?.dispose();
    this.#sky = undefined;
    this.#ui.status.hidden = true;
    const decals = this.#cell?.decals;
    this.#cell = undefined;
    this.#waterAreas = [];
    this.#waterVolumes = [];
    decals?.destroy();
  }

  #reset(): void {
    this.#loadToken++;
    this.#renderer.setView(undefined);
    this.#viewShown = false;
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#releaseCell();
    this.#meshModel?.destroy();
    this.#meshModel = undefined;
    this.#db = undefined;
  }

  /** Stops showing anything (another viewer takes the screen); the session stays. */
  deactivate(): void {
    this.#loadToken++;
    this.#loading = undefined;
    this.#session?.soundSystem?.stopAll();
    this.#detachControls?.();
    this.#detachControls = undefined;
    // The renderer must stop drawing the scene before it is freed (the other viewer may take
    // a while to show its own).
    if (this.#viewShown) this.#renderer.setView(undefined);
    this.#viewShown = false;
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#releaseCell();
    this.#meshModel?.destroy();
    this.#meshModel = undefined;
    this.#ui.upgrades.hidden = true;
  }

  #run(task: Promise<void>): void {
    task.catch((error: unknown) => {
      this.#terminal.log('err', describe(error), 'error');
    });
  }

  #meshMatches(): string[] {
    return matches(this.#meshes, (path) => path, this.#ui.meshes.search.value);
  }

  #cellMatches(): InteriorCell[] {
    return matches(
      this.#cells,
      (cell) => `${cell.editorId} ${cell.name}`.toLowerCase(),
      this.#ui.cells.search.value,
    );
  }

  #showMeshResults(): void {
    renderResults(
      this.#ui.meshes.results,
      this.#meshMatches(),
      (path) => path.replace(/^meshes\\/, ''),
      (path) => {
        this.#run(this.showMesh(path, MODEL_VIEW));
      },
    );
  }

  #showCellResults(): void {
    renderResults(
      this.#ui.cells.results,
      this.#cellMatches(),
      (cell) => (cell.name ? `${cell.editorId} · ${cell.name}` : cell.editorId),
      (cell) => {
        this.#run(this.showCell(cell.formId));
      },
    );
  }
}
