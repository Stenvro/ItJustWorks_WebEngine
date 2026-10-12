// Viewer for the game's content: single meshes (orbit camera, studio light) and complete
// interior cells (free camera, the cell's own lighting). Also shows the main menu logo as
// the shell's backdrop.

import { OrbitCamera, type OrbitView } from '../render/camera.ts';
import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuModel, GpuScene, ModelInstance } from '../render/scene-renderer.ts';
import { studioLighting } from '../render/studio-lighting.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { cellSceneLighting } from '../world/cell-lighting.ts';
import { loadCellData } from '../world/cell-loader.ts';
import { RecordDatabase, type InteriorCell } from '../world/record-db.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
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
  readonly #device: GPUDevice;
  readonly #renderer: Renderer;
  readonly #canvas: HTMLElement;
  readonly #terminal: Terminal;
  readonly #ui: ViewerElements;
  readonly #orbit = new OrbitCamera();
  readonly #fly = new FlyCamera();
  #detachControls: (() => void) | undefined;
  #loader: AssetLoader | undefined;
  #textures: TextureCache | undefined;
  #db: RecordDatabase | undefined;
  #meshes: string[] = [];
  #cells: InteriorCell[] = [];
  /** Models of cells, shared between cells and kept until the VFS changes. */
  readonly #cellModels = new Map<string, Promise<GpuModel | undefined>>();
  /** The single mesh shown in mesh mode (not cached). */
  #meshModel: GpuModel | undefined;
  #scene: GpuScene | undefined;
  /** Guards against a slow load finishing after a newer one. */
  #loadToken = 0;

  constructor(
    device: GPUDevice,
    renderer: Renderer,
    canvas: HTMLElement,
    terminal: Terminal,
    ui: ViewerElements,
  ) {
    this.#device = device;
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

  /** Centres the image in the part of the screen the shell does not cover. */
  set lensShift(shift: number) {
    this.#orbit.lensShift = shift;
    this.#fly.lensShift = shift;
  }

  /** Every mesh path in the VFS (for tools and dev checks). */
  get meshes(): readonly string[] {
    return this.#meshes;
  }

  get cells(): readonly InteriorCell[] {
    return this.#cells;
  }

  /** Starts using a (new) VFS: fresh workers, caches and record database, then the logo. */
  async connect(vfs: Vfs): Promise<void> {
    this.#reset();
    const loader = new AssetLoader(vfs);
    this.#loader = loader;
    this.#textures = new TextureCache(this.#device, (path) => loader.loadTexture(path));
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

    // TODO(M4): index plugins in a worker; the main thread only does async I/O here, but
    // splitting ~1.2 million record headers still takes a moment.
    const start = performance.now();
    const db = await RecordDatabase.open(vfs);
    this.#db = db;
    for (const problem of db.problems) this.#terminal.log('esm', problem, 'warn');
    const records = db.plugins.reduce((sum, plugin) => sum + plugin.index.recordCount, 0);
    this.#terminal.log(
      'esm',
      `${numberFormat.format(records)} records indexed in ${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    this.#cells = await db.interiorCells();
    this.#terminal.log('esm', `${numberFormat.format(this.#cells.length)} interior cells`);
    this.#ui.cells.panel.hidden = false;
    this.#ui.cells.count.textContent = `${numberFormat.format(this.#cells.length)} cells`;
    this.#showCellResults();
    await logoShown;
  }

  /** Loads a mesh and shows it on its own. */
  async showMesh(path: string, view: OrbitView): Promise<void> {
    const loader = this.#loader;
    const textures = this.#textures;
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
    this.#terminal.log(
      'cell',
      `${label} ${hex(formId)} · ${data.objects.length} objects · ${data.lights.length} lights`,
    );
    for (const skipped of data.skipped) this.#terminal.log('cell', skipped, 'warn');

    const paths = [...new Set(data.objects.map((object) => object.model))];
    const models = new Map(
      await Promise.all(paths.map(async (path) => [path, await this.#cellModel(path)] as const)),
    );
    if (token !== this.#loadToken) return;
    for (const failure of this.#textures?.takeFailures() ?? [])
      this.#terminal.log('dds', failure, 'warn');

    const instances: ModelInstance[] = [];
    for (const object of data.objects) {
      const model = models.get(object.model);
      if (model) instances.push({ model, world: object.world });
    }
    const scene = this.#renderer.scene.createScene(instances);
    const draws = scene.draws.length;
    this.#terminal.log(
      'cell',
      `${label} · ${instances.length} instances of ${models.size} models · ${numberFormat.format(draws)} draws · ` +
        `${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );

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
    const lighting = cellSceneLighting(data);
    this.#present(scene, undefined, { camera: 'fly', lighting });
    this.#terminal.log(
      'cell',
      'click the scene to look around · WASD to move · shift to run · esc to release',
    );
  }

  /** A cell model from the cache; undefined for editor markers and broken files. */
  #cellModel(path: string): Promise<GpuModel | undefined> {
    let entry = this.#cellModels.get(path);
    if (!entry) {
      const loader = this.#loader;
      const textures = this.#textures;
      if (!loader || !textures) return Promise.resolve(undefined);
      entry = loader.loadModel(path).then(
        async (loaded) => {
          if (loaded.model.editorMarker || loaded.model.parts.length === 0) return undefined;
          return this.#renderer.scene.createModel(loaded.model, textures);
        },
        (error: unknown) => {
          this.#terminal.log('nif', describe(error), 'warn');
          return undefined;
        },
      );
      this.#cellModels.set(path, entry);
    }
    return entry;
  }

  #present(
    scene: GpuScene,
    meshModel: GpuModel | undefined,
    view: { camera: 'orbit' } | { camera: 'fly'; lighting: ReturnType<typeof cellSceneLighting> },
  ): void {
    const previousScene = this.#scene;
    const previousMesh = this.#meshModel;
    this.#scene = scene;
    this.#meshModel = meshModel;
    this.#detachControls?.();
    if (view.camera === 'orbit') {
      this.#detachControls = this.#orbit.attach(this.#canvas);
      this.#renderer.setView({
        scene,
        camera: this.#orbit,
        lighting: () => studioLighting(this.#orbit),
        backdrop: true,
      });
    } else {
      this.#detachControls = this.#fly.attach(this.#canvas);
      const { lighting } = view;
      this.#renderer.setView({
        scene,
        camera: this.#fly,
        lighting: () => lighting,
        backdrop: false,
      });
    }
    previousScene?.destroy();
    if (previousMesh !== meshModel) previousMesh?.destroy();
    document.body.classList.add('has-scene');
  }

  #reset(): void {
    this.#loadToken++;
    this.#renderer.setView(undefined);
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#meshModel?.destroy();
    this.#meshModel = undefined;
    for (const entry of this.#cellModels.values()) {
      void entry.then((model) => model?.destroy());
    }
    this.#cellModels.clear();
    this.#loader?.dispose();
    void this.#db?.close();
    this.#db = undefined;
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
