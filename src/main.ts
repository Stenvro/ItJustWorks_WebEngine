import './style.css';
import { GpuUnavailableError, initGpu, trackCanvasSize, type GpuContext } from './render/gpu.ts';
import { Renderer } from './render/renderer.ts';
import { findCustomBackdrop } from './shell/custom-backdrop.ts';
import { Terminal } from './shell/terminal.ts';
import { BrowserGameFolder } from './vfs/browser/browser-game-folder.ts';
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
  fatal: byId('fatal', HTMLDivElement),
};

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

// --- Render-loop ----------------------------------------------------------

function startRenderLoop(renderer: Renderer): void {
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

// --- Skyrim-map kiezen en VFS opbouwen ------------------------------------

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

  const start = performance.now();
  // TODO(M2): VFS in een worker-pool draaien zodra er assets geladen worden, zodat
  // decompressie en parsing niet op de main thread gebeuren.
  const vfs = await Vfs.mount(new BrowserGameFolder(resolved.data, resolved.root));
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
      ? 'Ready. Next milestone: rendering models and textures (M2).'
      : 'Select the install folder (the one containing Data) to load Creation Club content as well.',
    'pick',
  );
  ui.pick.textContent = 'change folder';
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

// --- Opstarten ------------------------------------------------------------

async function main(): Promise<void> {
  terminal.log('sys', 'skyrim web engine · booting');
  terminal.log(
    'sys',
    `${crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'} · ${navigator.hardwareConcurrency} threads`,
  );

  const gpu = await initGpu(ui.canvas);
  // TODO(M13): device opnieuw aanmaken na verlies (driver-reset) in plaats van stoppen.
  gpu.device.lost
    .then((info) => {
      if (info.reason !== 'destroyed') showFatal(new Error(`GPU device lost: ${info.message}`));
    })
    .catch(showFatal);
  ui.statGpu.textContent = describeGpu(gpu);
  terminal.log('gpu', `webgpu · ${describeGpu(gpu)} · ${gpu.format} · bc-textures ok`, 'ok');

  trackCanvasSize(ui.canvas, gpu.device);
  startRenderLoop(new Renderer(gpu));

  const backdrop = await findCustomBackdrop();
  if (backdrop) {
    ui.backdrop.style.backgroundImage = `url("${backdrop}")`;
    ui.backdrop.hidden = false;
    terminal.log('sys', `custom backdrop: ${backdrop}`);
  }

  await setupGameFolder();
}

main().catch(showFatal);
