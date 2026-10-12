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
  if (!(element instanceof type)) throw new Error(`Element #${id} ontbreekt in index.html`);
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
const numberFormat = new Intl.NumberFormat('nl-NL');

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showFatal(error: unknown): void {
  console.error(error);
  const message =
    error instanceof GpuUnavailableError
      ? error.message
      : `Er ging iets mis bij het starten:\n${describeError(error)}`;
  terminal.log('fout', message.replaceAll('\n', ' '), 'error');
  ui.status.textContent = 'gestopt';
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
  return [vendor, architecture].filter((part) => part !== '').join(' ') || 'onbekend';
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
  ui.loadOrderTitle.textContent = `laadvolgorde · ${vfs.loadOrder.length} plugins`;
  fillTable(
    ui.loadOrder,
    vfs.loadOrder.map((entry) => [formatModIndex(entry), entry.name, entry.source]),
  );
  ui.archiveTitle.textContent = `archieven · ${vfs.archives.length} · laag → hoog`;
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
  prompt(`map controleren: ${handle.name}`, 'none');
  ui.status.textContent = 'koppelen';
  const resolved = await resolveGameFolder(handle);
  if (!resolved.report.ok) {
    if (!isNewChoice) await forgetGameFolder();
    terminal.log('vfs', `${handle.name}: ontbreekt ${resolved.report.missing.join(', ')}`, 'error');
    prompt('Dit is geen Skyrim Special Edition-installatie of Data-map.', 'pick');
    ui.status.textContent = 'wacht op map';
    return;
  }
  if (isNewChoice) await rememberGameFolder(handle);
  terminal.log(
    'vfs',
    resolved.root
      ? `installatiemap ${handle.name} · data-map gevonden`
      : `data-map ${handle.name} (zonder installatiemap)`,
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
    terminal.log('bsa', `${mounted.name.padEnd(30)} ${count.padStart(7)} bestanden`);
  }
  for (const problem of vfs.problems) {
    terminal.log('let op', `${problem.source}: ${problem.message}`, 'warn');
  }
  terminal.log(
    'vfs',
    `${numberFormat.format(vfs.fileCount)} paden geïndexeerd in ${elapsed.toFixed(0)} ms`,
    'ok',
  );

  ui.statVfs.textContent = `${numberFormat.format(vfs.fileCount)} bestanden`;
  ui.status.textContent = 'gereed';
  showSummary(vfs);
  prompt(
    vfs.hasCreationClubList
      ? 'Gereed. Volgende mijlpaal: modellen en textures renderen (M2).'
      : 'Kies de installatiemap (waar Data in staat) om ook Creation Club-content te laden.',
    'pick',
  );
  ui.pick.textContent = 'andere map';
}

function run(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    console.error(error);
    terminal.log('fout', describeError(error), 'error');
    prompt('Er ging iets mis. Kies de map opnieuw.', 'pick');
    ui.status.textContent = 'fout';
  });
}

function onClick(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    run(action);
  });
}

async function setupGameFolder(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    terminal.log('vfs', 'File System Access API ontbreekt', 'error');
    prompt('Deze browser kan geen lokale mappen lezen. Gebruik Chrome of Edge.', 'none');
    return;
  }

  onClick(ui.pick, async () => {
    const handle = await pickGameFolder();
    if (handle) await useFolder(handle, true);
  });

  const stored = await getStoredGameFolder();
  switch (stored.status) {
    case 'granted':
      terminal.log('vfs', `opgeslagen map: ${stored.handle.name}`);
      run(() => useFolder(stored.handle, false));
      break;
    case 'needs-permission':
      onClick(ui.resume, async () => {
        if (await requestFolderAccess(stored.handle)) {
          await useFolder(stored.handle, false);
        } else {
          terminal.log('vfs', 'geen toegang gekregen', 'warn');
          prompt('Geen toegang gekregen. Kies de map opnieuw.', 'pick');
        }
      });
      ui.resume.textContent = `toegang ${stored.handle.name}`;
      ui.status.textContent = 'wacht op toestemming';
      prompt('De browser vraagt opnieuw toestemming om je Skyrim-map te lezen.', 'resume');
      break;
    case 'none':
      ui.status.textContent = 'wacht op map';
      prompt(
        'Kies je Skyrim Special Edition-installatiemap (de map waar "Data" in staat).\n' +
          'Alles blijft op je eigen computer.',
        'pick',
      );
      break;
  }
}

// --- Opstarten ------------------------------------------------------------

async function main(): Promise<void> {
  terminal.log('sys', 'skyrim web engine · opstarten');
  terminal.log(
    'sys',
    `${crossOriginIsolated ? 'cross-origin isolated' : 'niet isolated'} · ${navigator.hardwareConcurrency} threads`,
  );

  const gpu = await initGpu(ui.canvas);
  // TODO(M13): device opnieuw aanmaken na verlies (driver-reset) in plaats van stoppen.
  gpu.device.lost
    .then((info) => {
      if (info.reason !== 'destroyed') showFatal(new Error(`GPU-device verloren: ${info.message}`));
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
    terminal.log('sys', `eigen achtergrond: ${backdrop}`);
  }

  await setupGameFolder();
}

main().catch(showFatal);
