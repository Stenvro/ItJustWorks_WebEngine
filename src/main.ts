import './style.css';
import { GpuUnavailableError, initGpu, trackCanvasSize } from './render/gpu.ts';
import { Renderer } from './render/renderer.ts';
import type { DataFolderReport } from './vfs/data-folder-check.ts';
import {
  forgetDataFolder,
  getStoredDataFolder,
  inspectDataFolder,
  isFileSystemAccessSupported,
  pickDataFolder,
  rememberDataFolder,
  requestDataFolderAccess,
} from './vfs/data-folder.ts';

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
  details: byId('folder-details', HTMLDetailsElement),
  plugins: byId('plugin-list', HTMLUListElement),
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

// --- Data-map kiezen ------------------------------------------------------

type SetupAction = 'pick' | 'resume' | 'none';

function showSetup(message: string, action: SetupAction, report?: DataFolderReport): void {
  ui.message.textContent = message;
  ui.pick.hidden = action === 'none';
  ui.resume.hidden = action !== 'resume';
  ui.plugins.replaceChildren(
    ...(report?.plugins ?? []).map((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      return li;
    }),
  );
  ui.details.hidden = !report?.ok;
  ui.setup.hidden = false;
}

function reportProblem(report: DataFolderReport): string {
  if (report.looksLikeGameRoot) {
    return 'Dit is de installatiemap van Skyrim. Kies de map "Data" die erin staat.';
  }
  return `Dit is geen complete Skyrim Special Edition Data-map.\nOntbreekt: ${report.missing.join(', ')}`;
}

async function useFolder(handle: FileSystemDirectoryHandle, isNewChoice: boolean): Promise<void> {
  const report = await inspectDataFolder(handle);
  if (!report.ok) {
    if (!isNewChoice) await forgetDataFolder();
    showSetup(reportProblem(report), 'pick');
    return;
  }
  if (isNewChoice) await rememberDataFolder(handle);
  // TODO(M1): VFS opbouwen uit deze map (BSA's + loose files, laadvolgorde).
  showSetup(
    `Data-map gekoppeld: ${handle.name}\n${report.plugins.length} plugins, ${report.archives.length} archieven.`,
    'pick',
    report,
  );
  ui.pick.textContent = 'Andere map kiezen';
}

function onClick(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    action().catch((error: unknown) => {
      console.error(error);
      showSetup(`Fout: ${describeError(error)}`, 'pick');
    });
  });
}

async function setupDataFolder(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    showSetup(
      'Deze browser ondersteunt de File System Access API niet.\nGebruik Chrome of Edge.',
      'none',
    );
    return;
  }

  onClick(ui.pick, async () => {
    const handle = await pickDataFolder();
    if (handle) await useFolder(handle, true);
  });

  const stored = await getStoredDataFolder();
  switch (stored.status) {
    case 'granted':
      await useFolder(stored.handle, false);
      break;
    case 'needs-permission':
      onClick(ui.resume, async () => {
        if (await requestDataFolderAccess(stored.handle)) {
          await useFolder(stored.handle, false);
        } else {
          showSetup('Geen toegang gekregen. Kies de Data-map opnieuw.', 'pick');
        }
      });
      ui.resume.textContent = `Toegang tot "${stored.handle.name}" hervatten`;
      showSetup('De browser vraagt opnieuw toestemming om je Data-map te lezen.', 'resume');
      break;
    case 'none':
      showSetup(
        'Kies de map "Data" van je Skyrim Special Edition-installatie.\nDe bestanden blijven op je eigen computer.',
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
  await setupDataFolder();
}

main().catch(showFatal);
