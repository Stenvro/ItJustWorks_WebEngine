// Model viewer: loads NIFs through the asset workers, uploads them and lets the user
// browse every mesh in the VFS. Also shows the main menu logo as the shell's backdrop.

import type { OrbitCamera, OrbitView } from '../render/camera.ts';
import type { Renderer } from '../render/renderer.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
import type { Terminal } from './terminal.ts';

export interface ViewerElements {
  readonly panel: HTMLElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
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

const numberFormat = new Intl.NumberFormat('en-US');

export class ModelViewer {
  readonly #device: GPUDevice;
  readonly #renderer: Renderer;
  readonly #camera: OrbitCamera;
  readonly #terminal: Terminal;
  readonly #ui: ViewerElements;
  #loader: AssetLoader | undefined;
  #textures: TextureCache | undefined;
  #meshes: string[] = [];
  /** Guards against a slow load finishing after a newer one. */
  #loadToken = 0;

  constructor(
    device: GPUDevice,
    renderer: Renderer,
    camera: OrbitCamera,
    terminal: Terminal,
    ui: ViewerElements,
  ) {
    this.#device = device;
    this.#renderer = renderer;
    this.#camera = camera;
    this.#terminal = terminal;
    this.#ui = ui;

    ui.search.addEventListener('input', () => {
      this.#showResults(ui.search.value);
    });
    ui.search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const first = this.#matches(ui.search.value)[0];
      if (first) this.#open(first);
    });
  }

  /** Starts using a (new) VFS: fresh workers and texture cache, then shows the logo. */
  async connect(vfs: Vfs): Promise<void> {
    this.#loader?.dispose();
    const loader = new AssetLoader(vfs);
    this.#loader = loader;
    this.#textures = new TextureCache(this.#device, (path) => loader.loadTexture(path));
    this.#meshes = vfs.list('meshes').filter((path) => path.endsWith('.nif'));
    this.#terminal.log(
      'sys',
      `${loader.workerCount} asset workers · ${numberFormat.format(this.#meshes.length)} meshes`,
    );

    this.#ui.panel.hidden = false;
    this.#ui.count.textContent = `${numberFormat.format(this.#meshes.length)} meshes`;
    this.#showResults('');

    const logo = LOGO_PATHS.find((path) => vfs.has(path));
    if (logo) await this.show(logo, LOGO_VIEW);
  }

  /** Loads a mesh and makes it the scene. */
  async show(path: string, view: OrbitView): Promise<void> {
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

    this.#camera.setView(view);
    this.#camera.fit(model.center, model.radius);
    this.#renderer.setScene([model], this.#camera);
    document.body.classList.add('has-scene');
  }

  #open(path: string): void {
    this.show(path, MODEL_VIEW).catch((error: unknown) => {
      this.#terminal.log('nif', error instanceof Error ? error.message : String(error), 'error');
    });
  }

  #matches(query: string): string[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== '');
    const matches: string[] = [];
    for (const path of this.#meshes) {
      if (terms.every((term) => path.includes(term))) {
        matches.push(path);
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    return matches;
  }

  /** Every mesh path in the VFS (for tools and dev checks). */
  get meshes(): readonly string[] {
    return this.#meshes;
  }

  /** Opens a mesh with the regular model view. */
  showModel(path: string): Promise<void> {
    return this.show(path, MODEL_VIEW);
  }

  #showResults(query: string): void {
    const matches = this.#matches(query);
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'no-results';
      empty.textContent = 'no matching meshes';
      this.#ui.results.replaceChildren(empty);
      return;
    }
    this.#ui.results.replaceChildren(
      ...matches.map((path) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'result';
        button.textContent = path.replace(/^meshes\\/, '');
        button.title = path;
        button.addEventListener('click', () => {
          this.#open(path);
        });
        item.append(button);
        return item;
      }),
    );
  }
}
