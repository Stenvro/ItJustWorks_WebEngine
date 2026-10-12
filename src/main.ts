import './style.css';
import { GpuUnavailableError, initGpu, trackCanvasSize } from './render/gpu.ts';
import { Renderer } from './render/renderer.ts';
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
import type { DataFolderReport } from './vfs/data-folder-check.ts';
import { formatModIndex } from './vfs/load-order.ts';
import { Vfs } from './vfs/vfs.ts';

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Element #${id} ontbreekt in index.html`);
  return element;
}

const ui = {
  canvas: byId('viewport', HTMLCanvasElement),
  fps: byId('fps', HTMLDivElement),
  setup: byId('setup', HTMLElement),
  message: byId('setup-message', HTMLParagraphElement),
  resume: byId('resume-folder', HTMLButtonElement),
  pick: byId('pick-folder', HTMLButtonElement),
  summary: byId('vfs-summary', HTMLElement),
  problems: byId('problem-list', HTMLUListElement),
  loadOrderTitle: byId('load-order-title', HTMLElement),
  loadOrder: byId('load-order-list', HTMLOListElement),
  archiveTitle: byId('archive-title', HTMLElement),
  archives: byId('archive-list', HTMLOListElement),
  fatal: byId('fatal', HTMLDivElement),
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showFatal(error: unknown): void {
  console.error(error);
  ui.setup.hidden = true;
  ui.fatal.textContent =
    error instanceof GpuUnavailableError
      ? error.message
      : `Er ging iets mis bij het starten:\n${describeError(error)}`;
  ui.fatal.hidden = false;
}

// --- Render-loop ----------------------------------------------------------

function startRenderLoop(renderer: Renderer): void {
  let frames = 0;
  let windowStart = performance.now();

  const frame = (now: number): void => {
    renderer.render(now / 1000);

    frames++;
    const elapsed = now - windowStart;
    if (elapsed >= 500) {
      const fps = (frames * 1000) / elapsed;
      ui.fps.textContent = `${fps.toFixed(0)} fps · ${(elapsed / frames).toFixed(2)} ms`;
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// --- Skyrim-map kiezen en VFS opbouwen ------------------------------------

type SetupAction = 'pick' | 'resume' | 'none';

let currentVfs: Vfs | undefined;

function fillList(list: HTMLElement, items: readonly string[]): void {
  list.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

function showSetup(message: string, action: SetupAction, vfs?: Vfs): void {
  ui.message.textContent = message;
  ui.pick.hidden = action === 'none';
  ui.resume.hidden = action !== 'resume';
  ui.summary.hidden = vfs === undefined;
  if (vfs) {
    ui.loadOrderTitle.textContent = `Laadvolgorde (${vfs.loadOrder.length} plugins)`;
    fillList(
      ui.loadOrder,
      vfs.loadOrder.map((entry) => `${formatModIndex(entry).padEnd(8)}${entry.name}`),
    );
    ui.archiveTitle.textContent = `Archieven (${vfs.archives.length}, laag → hoog)`;
    fillList(
      ui.archives,
      vfs.archives.map((a) => `${a.name}  (${a.archive.entries.length.toLocaleString('nl-NL')})`),
    );
    fillList(
      ui.problems,
      vfs.problems.map((problem) => `${problem.source}: ${problem.message}`),
    );
  }
  ui.setup.hidden = false;
}

function folderProblem(report: DataFolderReport): string {
  return `Dit is geen Skyrim Special Edition-installatie of Data-map.\nOntbreekt: ${report.missing.join(', ')}`;
}

async function useFolder(handle: FileSystemDirectoryHandle, isNewChoice: boolean): Promise<void> {
  showSetup(`Map controleren: ${handle.name}…`, 'none');
  const resolved = await resolveGameFolder(handle);
  if (!resolved.report.ok) {
    if (!isNewChoice) await forgetGameFolder();
    showSetup(folderProblem(resolved.report), 'pick');
    return;
  }
  if (isNewChoice) await rememberGameFolder(handle);

  showSetup(`Bestanden indexeren in ${handle.name}…`, 'none');
  const start = performance.now();
  // TODO(M2): VFS in een worker-pool draaien zodra er assets geladen worden, zodat
  // decompressie en parsing niet op de main thread gebeuren.
  const vfs = await Vfs.mount(new BrowserGameFolder(resolved.data, resolved.root));
  const elapsed = performance.now() - start;
  await currentVfs?.close();
  currentVfs = vfs;

  const lines = [
    `Gekoppeld: ${handle.name}`,
    `${vfs.fileCount.toLocaleString('nl-NL')} bestanden uit ${vfs.archives.length} archieven, ` +
      `geïndexeerd in ${elapsed.toFixed(0)} ms.`,
  ];
  if (!vfs.hasCreationClubList) {
    lines.push(
      'Kies de installatiemap (de map waar Data in staat) om ook Creation Club-content te laden.',
    );
  }
  showSetup(lines.join('\n'), 'pick', vfs);
  ui.pick.textContent = 'Andere map kiezen';
}

function run(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    console.error(error);
    showSetup(`Fout: ${describeError(error)}`, 'pick');
  });
}

function onClick(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    run(action);
  });
}

async function setupGameFolder(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    showSetup(
      'Deze browser ondersteunt de File System Access API niet.\nGebruik Chrome of Edge.',
      'none',
    );
    return;
  }

  onClick(ui.pick, async () => {
    const handle = await pickGameFolder();
    if (handle) await useFolder(handle, true);
  });

  const stored = await getStoredGameFolder();
  switch (stored.status) {
    case 'granted':
      run(() => useFolder(stored.handle, false));
      break;
    case 'needs-permission':
      onClick(ui.resume, async () => {
        if (await requestFolderAccess(stored.handle)) {
          await useFolder(stored.handle, false);
        } else {
          showSetup('Geen toegang gekregen. Kies de map opnieuw.', 'pick');
        }
      });
      ui.resume.textContent = `Toegang tot "${stored.handle.name}" hervatten`;
      showSetup('De browser vraagt opnieuw toestemming om je Skyrim-map te lezen.', 'resume');
      break;
    case 'none':
      showSetup(
        'Kies je Skyrim Special Edition-installatiemap (de map waar "Data" in staat).\n' +
          'De bestanden blijven op je eigen computer.',
        'pick',
      );
      break;
  }
}

// --- Opstarten ------------------------------------------------------------

async function main(): Promise<void> {
  const gpu = await initGpu(ui.canvas);
  // TODO(M13): device opnieuw aanmaken na verlies (driver-reset) in plaats van stoppen.
  gpu.device.lost
    .then((info) => {
      if (info.reason !== 'destroyed') showFatal(new Error(`GPU-device verloren: ${info.message}`));
    })
    .catch(showFatal);

  trackCanvasSize(ui.canvas, gpu.device);
  startRenderLoop(new Renderer(gpu));
  await setupGameFolder();
}

main().catch(showFatal);
