// Viewer for the game's content: single meshes (orbit camera, studio light) and complete
// interior cells (free camera, the cell's own lighting). Also shows the main menu logo as
// the shell's backdrop.

import { OrbitCamera, type OrbitView } from '../render/camera.ts';
import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuModel, GpuScene, GpuWaterType, ModelInstance } from '../render/scene-renderer.ts';
import { studioLighting } from '../render/studio-lighting.ts';
import { cellSceneLighting, pointLights } from '../world/cell-lighting.ts';
import { loadCellData, type CellData, type CellLight } from '../world/cell-loader.ts';
import { cellWater, DEFAULT_WATER } from '../world/water.ts';
import { waterPlane } from '../render/water-data.ts';
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
import type { GameSession } from './game-session.ts';
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
}

/** The main menu logo meshes (Anniversary Edition first); they face along the Y axis. */
const LOGO_PATHS = ['meshes\\interface\\logo\\logo01ae.nif', 'meshes\\interface\\logo\\logo.nif'];
// The logo is a front-facing shell (the main menu only ever shows it head-on), so keep
// the camera in front of it.
const LOGO_VIEW: OrbitView = {
  up: 'z',
  yaw: Math.PI,
  pitch: 0.05,
  idleSway: 6,
  yawLimit: 20,
  pitchLimit: 12,
};
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
  readonly label: string;
  /** The cell's imagespace (XCIM, else the default interior one). */
  readonly imageSpace: ImageSpace | undefined;
  /** Water types of water activators, by WATR form id. */
  readonly waterTypes: ReadonlyMap<number, GpuWaterType | undefined>;
  /** The cell's water level (XCLW), drawn as a plane under everything, with its type. */
  readonly waterPlane: { model: GpuModel; type: GpuWaterType | undefined } | undefined;
}

/** Half the width of an interior's water plane: it lies under the whole cell. */
const INTERIOR_WATER_EXTENT = 50_000;

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
  }

  /** Called when the viewer takes the screen (another viewer then steps back). */
  onActivate: (() => void) | undefined;

  /** Centres the image in the part of the screen the shell does not cover. */
  set lensShift(shift: number) {
    this.#orbit.lensShift = shift;
    this.#fly.lensShift = shift;
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

  /** Starts using a (new) game session: lists its meshes and cells, then shows the logo. */
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

    const logo = LOGO_PATHS.find((path) => vfs.has(path));
    const logoShown = logo ? this.showMesh(logo, LOGO_VIEW) : Promise.resolve();

    const db = await session.db;
    this.#db = db;
    this.#cells = await db.interiorCells();
    this.#terminal.log('esm', `${numberFormat.format(this.#cells.length)} interior cells`);
    this.#ui.cells.panel.hidden = false;
    this.#ui.cells.count.textContent = `${numberFormat.format(this.#cells.length)} cells`;
    this.#showCellResults();
    await logoShown;
  }

  /** Loads a mesh and shows it on its own. */
  async showMesh(path: string, view: OrbitView): Promise<void> {
    const loader = this.#session?.loader;
    const textures = this.#session?.textures;
    if (!loader || !textures) return;
    const token = ++this.#loadToken;
    const start = performance.now();
    this.#terminal.log('nif', `loading ${path}`);

    const loaded = await loader.loadModel(path);
    const model = await this.#renderer.scene.createModel(loaded.model, textures);
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
    this.#orbit.fit(model.center, model.radius);
    this.#present(this.#renderer.scene.createScene([{ model, world: identity() }]), model, {
      camera: 'orbit',
    });
  }

  /** Opens a mesh with the regular model view. */
  showModel(path: string): Promise<void> {
    return this.showMesh(path, MODEL_VIEW);
  }

  /** Loads an interior cell with all its objects and lights. */
  async showCell(formId: number): Promise<void> {
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
    const water = cellWater(data.cell);
    const [models, actions, imageSpace, waterTypes, waterPlaneType] = await Promise.all([
      Promise.all(paths.map(async (path) => [path, await this.#cellModel(path)] as const)).then(
        (entries) => new Map(entries),
      ),
      this.#homeActions(data),
      db
        .get(data.cell.imageSpace ?? DEFAULT_INTERIOR_IMAGE_SPACE)
        .then((record) => (record?.type === 'IMGS' ? parseImageSpace(record) : undefined)),
      Promise.all(waterIds.map(async (id) => [id, await session?.waterType(id)] as const)).then(
        (entries) => new Map(entries),
      ),
      water ? session?.waterType(water.type ?? DEFAULT_WATER) : undefined,
      session?.waterType(DEFAULT_WATER).then((type) => {
        this.#renderer.scene.defaultWater = type;
      }),
    ]);
    let waterPlaneModel: GpuModel | undefined;
    if (water && session) {
      const [x, y] = data.entrance;
      waterPlaneModel = await this.#renderer.scene.createModel(
        waterPlane(
          x - INTERIOR_WATER_EXTENT,
          y - INTERIOR_WATER_EXTENT,
          x + INTERIOR_WATER_EXTENT,
          y + INTERIOR_WATER_EXTENT,
          water.height,
        ),
        session.textures,
      );
    }
    if (token !== this.#loadToken) return;
    for (const failure of this.#session?.textures.takeFailures() ?? []) {
      this.#terminal.log('dds', failure, 'warn');
    }

    const toggles = findToggles(data, actions.controlled);
    // Homes open furnished; "new game" shows them as bought.
    const choices = fullyUpgraded(actions, NEW_GAME);
    const scripted = await this.#playActions(actions, choices);
    if (token !== this.#loadToken) return;
    const previousWater = this.#cell?.waterPlane?.model;
    this.#cell = {
      data,
      toggles,
      selection: gameStartSelection(toggles),
      actions,
      choices,
      scripted,
      models,
      label,
      imageSpace,
      waterTypes,
      waterPlane: waterPlaneModel && { model: waterPlaneModel, type: waterPlaneType },
    };
    const [x, y, z] = data.entrance;
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

    this.#renderUpgrades();
    const visible = this.#applyCellSelection();
    previousWater?.destroy();
    const what = [
      actions.purchases.length > 0 ? `${String(actions.purchases.length)} purchases` : '',
      actions.house ? 'HearthFire house' : '',
      toggles.length > 0 ? `${String(toggles.length)} quest states` : '',
    ].filter(Boolean);
    this.#terminal.log(
      'cell',
      `${label} ${hex(formId)} · ${visible} of ${data.objects.length} objects shown · ` +
        `${models.size} models${what.length > 0 ? ` · ${what.join(' · ')}` : ''} · ` +
        `${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    this.#terminal.log(
      'cell',
      'click the scene to look around · WASD to move · shift to run · esc to release',
    );
  }

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
    const instances: ModelInstance[] = [];
    for (const object of cell.data.objects) {
      if (!isEnabled(object.reference)) continue;
      if (this.#hidden?.test(object.model)) continue;
      const model = cell.models.get(object.model);
      const water = object.water === undefined ? undefined : cell.waterTypes.get(object.water);
      if (model) instances.push({ model, world: object.world, ...(water && { water }) });
    }
    if (cell.waterPlane) {
      const { model, type } = cell.waterPlane;
      instances.push({ model, world: identity(), ...(type && { water: type }) });
    }
    const scene = this.#renderer.scene.createScene(instances);
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
    });
    return instances.length;
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
    const checkbox = (
      text: string,
      checked: boolean,
      onChange: (on: boolean) => void,
      title = '',
    ): HTMLLIElement => {
      const item = document.createElement('li');
      const labelElement = document.createElement('label');
      labelElement.className = 'toggle';
      labelElement.title = title;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => {
        onChange(input.checked);
      });
      labelElement.append(input, text);
      item.append(labelElement);
      return item;
    };
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
      const details = document.createElement('details');
      details.className = 'cell-states';
      details.open = this.#statesOpen;
      details.addEventListener('toggle', () => {
        this.#statesOpen = details.open;
      });
      const summary = document.createElement('summary');
      summary.textContent = `quest & scene states (${String(cell.toggles.length)})`;
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent =
        'Set by quests and scenes, not by the player. Shown as a new game has them.';
      const list = document.createElement('ul');
      list.className = 'upgrade-list';
      for (const toggle of cell.toggles) {
        list.append(
          checkbox(
            toggle.label,
            cell.selection.has(toggle.formId),
            (on) => {
              const selection = new Set(cell.selection);
              if (on) selection.add(toggle.formId);
              else selection.delete(toggle.formId);
              cell.selection = selection;
              this.#applyCellSelection();
            },
            toggle.editorId,
          ),
        );
      }
      details.append(summary, note, list);
      parts.push(details);
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
      });
    } else {
      this.#detachControls = this.#fly.attach(this.#canvas);
      const { lighting, imageSpace, lights } = view;
      this.#renderer.setView({
        scenes: () => [scene],
        camera: this.#fly,
        lighting: () => ({ ...lighting, lights: pointLights(lights, performance.now() / 1000) }),
        imageSpace: () => imageSpace,
        backdrop: false,
      });
    }
    previousScene?.destroy();
    if (previousMesh !== meshModel) previousMesh?.destroy();
    document.body.classList.add('has-scene');
  }

  /** Forgets the shown cell and frees what was made for it. */
  #releaseCell(): void {
    const plane = this.#cell?.waterPlane?.model;
    this.#cell = undefined;
    plane?.destroy();
  }

  #reset(): void {
    this.#loadToken++;
    this.#renderer.setView(undefined);
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
    this.#detachControls?.();
    this.#detachControls = undefined;
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
