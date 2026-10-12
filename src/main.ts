import './style.css';
import { GpuUnavailableError, initGpu, trackCanvasSize, type GpuContext } from './render/gpu.ts';
import { Renderer } from './render/renderer.ts';
import { findCustomBackdrop } from './shell/custom-backdrop.ts';
import { GameSession, MEMORY_BUDGET } from './shell/game-session.ts';
import { ModelViewer } from './shell/model-viewer.ts';
import { WorldViewer } from './shell/world-viewer.ts';
import { setupHideShortcut, setupPanels } from './shell/panels.ts';
import { Terminal } from './shell/terminal.ts';
import { BrowserGameFolder } from './vfs/browser/browser-game-folder.ts';
import { HttpGameFolder } from './vfs/browser/http-game-folder.ts';
import type { GameFolder } from './vfs/game-folder.ts';
import {
  forgetGameFolder,
  getStoredGameFolder,
  isFileSystemAccessSupported,
  pickGameFolder,
  rememberGameFolder,
  requestFolderAccess,
  resolveGameFolder,
} from './vfs/browser/data-folder.ts';
import { formatModIndex } from './vfs/load-order.ts';
import { Vfs } from './vfs/vfs.ts';

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Element #${id} is missing from index.html`);
  return element;
}

const ui = {
  canvas: byId('viewport', HTMLCanvasElement),
  backdrop: byId('backdrop', HTMLDivElement),
  statFps: byId('stat-fps', HTMLElement),
  statFrame: byId('stat-frame', HTMLElement),
  statGpu: byId('stat-gpu', HTMLElement),
  statMemory: byId('stat-memory', HTMLElement),
  statVfs: byId('stat-vfs', HTMLElement),
  status: byId('console-status', HTMLElement),
  log: byId('log', HTMLOListElement),
  message: byId('prompt-message', HTMLParagraphElement),
  resume: byId('resume-folder', HTMLButtonElement),
  pick: byId('pick-folder', HTMLButtonElement),
  summary: byId('vfs-summary', HTMLElement),
  loadOrderTitle: byId('load-order-title', HTMLElement),
  loadOrder: byId('load-order-list', HTMLOListElement),
  archiveTitle: byId('archive-title', HTMLElement),
  archives: byId('archive-list', HTMLOListElement),
  shell: byId('shell', HTMLElement),
  viewer: {
    meshes: {
      panel: byId('viewer', HTMLElement),
      search: byId('model-search', HTMLInputElement),
      results: byId('model-results', HTMLOListElement),
      count: byId('viewer-count', HTMLElement),
    },
    cells: {
      panel: byId('cell-viewer', HTMLElement),
      search: byId('cell-search', HTMLInputElement),
      results: byId('cell-results', HTMLOListElement),
      count: byId('cell-count', HTMLElement),
    },
    upgrades: byId('cell-upgrades', HTMLElement),
  },
  world: {
    panel: byId('world-viewer', HTMLElement),
    search: byId('world-search', HTMLInputElement),
    results: byId('world-results', HTMLOListElement),
    count: byId('world-count', HTMLElement),
    status: byId('world-status', HTMLElement),
    sky: byId('world-sky', HTMLElement),
    time: byId('world-time', HTMLInputElement),
    timeLabel: byId('world-time-label', HTMLOutputElement),
    timeFlows: byId('world-time-flows', HTMLInputElement),
    weather: byId('world-weather', HTMLSelectElement),
  },
  fatal: byId('fatal', HTMLDivElement),
};

/** Starts a game session for a mounted VFS (set up once the GPU is ready). */
let connectSession: ((vfs: Vfs) => Promise<void>) | undefined;

const terminal = new Terminal(ui.log);
const numberFormat = new Intl.NumberFormat('en-US');

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showFatal(error: unknown): void {
  console.error(error);
  const message =
    error instanceof GpuUnavailableError
      ? error.message
      : `Something went wrong during startup:\n${describeError(error)}`;
  terminal.log('err', message.replaceAll('\n', ' '), 'error');
  ui.status.textContent = 'halted';
  ui.fatal.textContent = message;
  ui.fatal.hidden = false;
}

// --- Render loop ----------------------------------------------------------

/** `memory`: GPU bytes of the session's models and textures (none without a session). */
function startRenderLoop(renderer: Renderer, memory: () => number | undefined): void {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frames = 0;
  let windowStart = performance.now();

  const frame = (now: number): void => {
    renderer.render(reducedMotion ? 30 : now / 1000, devicePixelRatio);

    frames++;
    const elapsed = now - windowStart;
    if (elapsed >= 500) {
      ui.statFps.textContent = ((frames * 1000) / elapsed).toFixed(0);
      ui.statFrame.textContent = `${(elapsed / frames).toFixed(2)} ms`;
      const used = memory();
      ui.statMemory.textContent =
        used === undefined
          ? '—'
          : `${(used / 1048576).toFixed(0)} / ${(MEMORY_BUDGET / 1048576).toFixed(0)} MB`;
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function describeGpu(gpu: GpuContext): string {
  const { vendor, architecture } = gpu.adapter.info;
  return [vendor, architecture].filter((part) => part !== '').join(' ') || 'unknown';
}

// --- Pick the Skyrim folder and build the VFS -----------------------------

type PromptAction = 'pick' | 'resume' | 'none';

let currentVfs: Vfs | undefined;

function prompt(message: string, action: PromptAction): void {
  ui.message.textContent = message;
  ui.pick.hidden = action === 'none';
  ui.resume.hidden = action !== 'resume';
}

function fillTable(list: HTMLElement, rows: readonly [string, string, string][]): void {
  list.replaceChildren(
    ...rows.map(([key, value, meta]) => {
      const li = document.createElement('li');
      for (const [className, text] of [
        ['key', key],
        ['value', value],
        ['meta', meta],
      ] as const) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        li.append(span);
      }
      return li;
    }),
  );
}

function showSummary(vfs: Vfs): void {
  ui.loadOrderTitle.textContent = `load order · ${vfs.loadOrder.length} plugins`;
  fillTable(
    ui.loadOrder,
    vfs.loadOrder.map((entry) => [formatModIndex(entry), entry.name, entry.source]),
  );
  ui.archiveTitle.textContent = `archives · ${vfs.archives.length} · low → high`;
  fillTable(
    ui.archives,
    vfs.archives.map((mounted, i) => [
      String(i).padStart(2, '0'),
      mounted.name,
      numberFormat.format(mounted.archive.entries.length),
    ]),
  );
  ui.summary.hidden = false;
}

async function useFolder(handle: FileSystemDirectoryHandle, isNewChoice: boolean): Promise<void> {
  prompt(`checking folder: ${handle.name}`, 'none');
  ui.status.textContent = 'mounting';
  const resolved = await resolveGameFolder(handle);
  if (!resolved.report.ok) {
    if (!isNewChoice) await forgetGameFolder();
    terminal.log('vfs', `${handle.name}: missing ${resolved.report.missing.join(', ')}`, 'error');
    prompt('This is not a Skyrim Special Edition installation or Data folder.', 'pick');
    ui.status.textContent = 'awaiting folder';
    return;
  }
  if (isNewChoice) await rememberGameFolder(handle);
  terminal.log(
    'vfs',
    resolved.root
      ? `install folder ${handle.name} · data folder found`
      : `data folder ${handle.name} (without install folder)`,
  );
  await mountGame(new BrowserGameFolder(resolved.data, resolved.root));
}

/** Builds the VFS from a game folder, reports it and hands it to the model viewer. */
async function mountGame(folder: GameFolder): Promise<void> {
  ui.status.textContent = 'mounting';
  const start = performance.now();
  const vfs = await Vfs.mount(folder);
  const elapsed = performance.now() - start;
  await currentVfs?.close();
  currentVfs = vfs;

  for (const entry of vfs.loadOrder) {
    terminal.log('esm', `${formatModIndex(entry).padEnd(6)} ${entry.name}`);
  }
  for (const mounted of vfs.archives) {
    const count = numberFormat.format(mounted.archive.entries.length);
    terminal.log('bsa', `${mounted.name.padEnd(30)} ${count.padStart(7)} files`);
  }
  for (const problem of vfs.problems) {
    terminal.log('warn', `${problem.source}: ${problem.message}`, 'warn');
  }
  terminal.log(
    'vfs',
    `${numberFormat.format(vfs.fileCount)} paths indexed in ${elapsed.toFixed(0)} ms`,
    'ok',
  );

  ui.statVfs.textContent = `${numberFormat.format(vfs.fileCount)} files`;
  ui.status.textContent = 'ready';
  showSummary(vfs);
  prompt(
    vfs.hasCreationClubList
      ? 'Ready. Search the model viewer for any mesh in the game.'
      : 'Select the install folder (the one containing Data) to load Creation Club content as well.',
    'pick',
  );
  ui.pick.textContent = 'change folder';
  await connectSession?.(vfs);
}

function run(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    console.error(error);
    terminal.log('err', describeError(error), 'error');
    prompt('Something went wrong. Please select the folder again.', 'pick');
    ui.status.textContent = 'error';
  });
}

function onClick(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    run(action);
  });
}

async function setupGameFolder(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    terminal.log('vfs', 'File System Access API unavailable', 'error');
    prompt('This browser cannot read local folders. Use Chrome or Edge.', 'none');
    return;
  }

  onClick(ui.pick, async () => {
    const handle = await pickGameFolder();
    if (handle) await useFolder(handle, true);
  });

  // Development: `?devdata` mounts the game data served by the Vite dev server.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has('devdata') &&
    (await HttpGameFolder.available())
  ) {
    terminal.log('vfs', 'dev game data from the Vite dev server');
    run(() => mountGame(new HttpGameFolder()));
    return;
  }

  const stored = await getStoredGameFolder();
  switch (stored.status) {
    case 'granted':
      terminal.log('vfs', `stored folder: ${stored.handle.name}`);
      run(() => useFolder(stored.handle, false));
      break;
    case 'needs-permission':
      onClick(ui.resume, async () => {
        if (await requestFolderAccess(stored.handle)) {
          await useFolder(stored.handle, false);
        } else {
          terminal.log('vfs', 'access denied', 'warn');
          prompt('Access was denied. Please select the folder again.', 'pick');
        }
      });
      ui.resume.textContent = `resume ${stored.handle.name}`;
      ui.status.textContent = 'awaiting permission';
      prompt('The browser needs permission again to read your Skyrim folder.', 'resume');
      break;
    case 'none':
      ui.status.textContent = 'awaiting folder';
      prompt(
        'Select your Skyrim Special Edition install folder (the one containing "Data").\n' +
          'Everything stays on your own computer.',
        'pick',
      );
      break;
  }
}

// --- Startup --------------------------------------------------------------

async function main(): Promise<void> {
  terminal.log('sys', 'skyrim web engine · booting');
  terminal.log(
    'sys',
    `${crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'} · ${navigator.hardwareConcurrency} threads`,
  );

  const gpu = await initGpu(ui.canvas);
  // TODO(M13): recreate the device after loss (driver reset) instead of halting.
  gpu.device.lost
    .then((info) => {
      if (info.reason !== 'destroyed') showFatal(new Error(`GPU device lost: ${info.message}`));
    })
    .catch(showFatal);
  ui.statGpu.textContent = describeGpu(gpu);
  terminal.log('gpu', `webgpu · ${describeGpu(gpu)} · ${gpu.format} · bc-textures ok`, 'ok');

  trackCanvasSize(ui.canvas, gpu.device);
  const renderer = new Renderer(gpu);
  const modelViewer = new ModelViewer(renderer, ui.canvas, terminal, ui.viewer);
  const worldViewer = new WorldViewer(renderer, ui.canvas, terminal, ui.world, () => {
    modelViewer.deactivate();
  });
  modelViewer.onActivate = () => {
    worldViewer.deactivate();
  };
  let session: GameSession | undefined;
  connectSession = async (vfs: Vfs): Promise<void> => {
    session?.dispose();
    session = new GameSession(gpu.device, renderer, vfs, terminal);
    await Promise.all([modelViewer.connect(session), worldViewer.connect(session)]);
  };
  // Centre the scene in the part of the screen the shell column does not cover.
  const updateLensShift = (): void => {
    const visibleColumn =
      window.innerWidth >= 1000 &&
      document.body.classList.contains('has-scene') &&
      !ui.shell.classList.contains('shell-hidden');
    const shift = visibleColumn ? ui.shell.getBoundingClientRect().width / window.innerWidth : 0;
    modelViewer.lensShift = shift;
    worldViewer.lensShift = shift;
  };
  new ResizeObserver(updateLensShift).observe(ui.shell);
  new MutationObserver(updateLensShift).observe(document.body, { attributes: true });
  new MutationObserver(updateLensShift).observe(ui.shell, { attributes: true });
  setupPanels(document);
  setupHideShortcut(ui.shell);
  if (import.meta.env.DEV) {
    window.skyrimDev = {
      viewer: modelViewer,
      world: worldViewer,
      renderer,
      device: gpu.device,
      session: () => session,
    };
  }
  startRenderLoop(renderer, () => session?.memory);

  const backdrop = await findCustomBackdrop();
  if (backdrop) {
    ui.backdrop.style.backgroundImage = `url("${backdrop}")`;
    ui.backdrop.hidden = false;
    terminal.log('sys', `custom backdrop: ${backdrop}`);
  }

  await setupGameFolder();
}

main().catch(showFatal);
