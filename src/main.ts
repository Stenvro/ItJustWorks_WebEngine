import './style.css';
import { GpuUnavailableError, initGpu, trackCanvasSize, type GpuContext } from './render/gpu.ts';
import { Renderer } from './render/renderer.ts';
import { findCustomBackdrop } from './shell/custom-backdrop.ts';
import { GameSession, MEMORY_BUDGET } from './shell/game-session.ts';
import { ModelViewer } from './shell/model-viewer.ts';
import { WorldViewer } from './shell/world-viewer.ts';
import { showClockSpeed } from './shell/world-sky.ts';
import { nextClockSpeed } from './world/game-time.ts';
import { forgetPanels, setupHideShortcut, setupPanels } from './shell/panels.ts';
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
import { doorDestination, type Teleport } from './world/cell-loader.ts';
import { CELL_SIZE } from './world/land.ts';
import { Vfs } from './vfs/vfs.ts';
import type { Placement } from './scripting/runtime/runtime.ts';
import { PLAYER_REF } from './scripting/runtime/forms.ts';
import { QuestPanel } from './shell/quest-panel.ts';
import { PlayMode, type PlayWorld } from './shell/play-mode.ts';
import { Launcher } from './shell/launcher.ts';

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
  menu: byId('main-menu', HTMLElement),
  menuSandbox: byId('menu-sandbox', HTMLButtonElement),
  menuPlay: byId('menu-play', HTMLButtonElement),
  uiLayer: byId('ui-layer', HTMLDivElement),
  launcher: byId('launcher', HTMLElement),
  sandbox: byId('sandbox', HTMLElement),
  brand: byId('brand', HTMLButtonElement),
  finders: [
    byId('viewer', HTMLDetailsElement),
    byId('cell-viewer', HTMLDetailsElement),
    byId('world-viewer', HTMLDetailsElement),
    byId('quest-viewer', HTMLDetailsElement),
  ],
  devSettings: byId('dev-settings', HTMLDetailsElement),
  loadingScreen: byId('loading-screen', HTMLElement),
  loadingWhat: byId('loading-what', HTMLElement),
  devPanel: byId('dev-panel', HTMLElement),
  systemLog: byId('system-log', HTMLDetailsElement),
  loadOrderPanel: byId('load-order', HTMLDetailsElement),
  archivesPanel: byId('archives', HTMLDetailsElement),
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
    upgrades: byId('scene-states', HTMLElement),
    play: byId('scene-play', HTMLElement),
    freeCamera: byId('free-camera', HTMLInputElement),
    status: byId('scene-status', HTMLElement),
    sky: {
      sky: byId('scene-sky', HTMLElement),
      time: byId('scene-time', HTMLInputElement),
      timeLabel: byId('scene-time-label', HTMLOutputElement),
      timeSpeed: byId('scene-time-speed', HTMLButtonElement),
      timeScale: byId('scene-time-scale', HTMLElement),
      weather: byId('scene-weather', HTMLSelectElement),
    },
    prompt: byId('activate-prompt', HTMLDivElement),
  },
  world: {
    panel: byId('world-viewer', HTMLElement),
    search: byId('world-search', HTMLInputElement),
    results: byId('world-results', HTMLOListElement),
    count: byId('world-count', HTMLElement),
    status: byId('scene-status', HTMLElement),
    play: byId('scene-play', HTMLElement),
    freeCamera: byId('free-camera', HTMLInputElement),
    states: byId('scene-states', HTMLElement),
    prompt: byId('activate-prompt', HTMLDivElement),
    notice: byId('hud-notice', HTMLDivElement),
    sky: byId('scene-sky', HTMLElement),
    time: byId('scene-time', HTMLInputElement),
    timeLabel: byId('scene-time-label', HTMLOutputElement),
    timeSpeed: byId('scene-time-speed', HTMLButtonElement),
    timeScale: byId('scene-time-scale', HTMLElement),
    weather: byId('scene-weather', HTMLSelectElement),
  },
  quests: {
    panel: byId('quest-viewer', HTMLDetailsElement),
    search: byId('quest-search', HTMLInputElement),
    results: byId('quest-results', HTMLOListElement),
    count: byId('quest-count', HTMLElement),
    detail: byId('quest-detail', HTMLElement),
  },
  fatal: byId('fatal', HTMLDivElement),
};

/** Starts a game session for a mounted VFS (set up once the GPU is ready). */
let connectSession: ((vfs: Vfs) => Promise<void>) | undefined;

const terminal = new Terminal(ui.log);
const hexId = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
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

/** The Keyboard Lock API (Chromium; not in TypeScript's DOM types). */
interface KeyboardLock {
  lock?(keyCodes?: readonly string[]): Promise<void>;
  unlock?(): void;
}

/**
 * The keys the page keeps in full screen (Keyboard Lock): the game's, so that the browser's
 * shortcuts on them do not act (Ctrl+W, sneaking forward, closed the tab; F5, Quicksave,
 * reloaded it). Tab and F11 are left to the system and the browser (Alt+Tab, leaving full
 * screen; held down, Esc leaves it too).
 */
const LOCKED_KEYS: readonly string[] = [
  'Escape',
  'Backquote',
  'Space',
  'Enter',
  'Backspace',
  'CapsLock',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Insert',
  'Delete',
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${String(i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${String(i)}`),
  ...Array.from({ length: 10 }, (_, i) => `F${String(i + 1)}`),
  'F12',
];

/** `memory`: GPU bytes of the session's models and textures (none without a session). */

/** The game's clock moves at most this much from one frame to the next (seconds). */
const MAX_FRAME_SECONDS = 0.25;
/** A loading screen waits this long at most for the player's body and the actors around them (ms). */
const POPULATE_MS = 20000;

function startRenderLoop(
  renderer: Renderer,
  memory: () => number | undefined,
  everyFrame: () => void,
  paused: () => boolean,
): void {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frames = 0;
  let windowStart = performance.now();

  // The game's clock: it stands still while the game is in a menu (the player, animations,
  // particles and the sky's hour stop with it).
  let gameTime = 0;
  let last: number | undefined;
  const frame = (now: number): void => {
    // A hidden tab draws no frames: back, the game goes on where it was (the time away is not
    // played at once; the scripts' clock is held the same way).
    if (last !== undefined && !paused())
      gameTime += Math.min(MAX_FRAME_SECONDS, (now - last) / 1000);
    last = now;
    renderer.render(reducedMotion ? 30 : gameTime, devicePixelRatio);
    everyFrame();

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

// --- Screens ---------------------------------------------------------------

/**
 * What the shell shows: the start (choosing the game folder), the main menu (the log, the load
 * order and what to load) or the sandbox (loading any model, interior cell or worldspace).
 * The sandbox has the running game's quests one at a time (src/shell/quest-panel.ts).
 * Play is the game from its own main menu (src/shell/play-mode.ts).
 */
type Screen = 'start' | 'menu' | 'sandbox' | 'launcher' | 'play';

function showScreen(screen: Screen): void {
  document.body.dataset.screen = screen;
  ui.menu.hidden = screen !== 'menu';
  ui.summary.hidden = screen !== 'menu' || currentVfs === undefined;
  ui.sandbox.hidden = screen !== 'sandbox';
  ui.uiLayer.hidden = screen !== 'play';
  ui.launcher.hidden = screen !== 'launcher';
  // The main menu shows what was loaded (log, load order, archives); the sandbox keeps the
  // log folded away above its finders.
  if (screen === 'menu') {
    ui.systemLog.open = true;
    ui.loadOrderPanel.open = true;
    ui.archivesPanel.open = true;
  } else if (screen === 'sandbox') {
    // The finders start folded, the development settings open.
    ui.systemLog.open = false;
    for (const finder of ui.finders) finder.open = false;
    ui.devSettings.open = true;
  }
}

// --- Pick the game folder and build the VFS --------------------------------

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
}

async function useFolder(handle: FileSystemDirectoryHandle, isNewChoice: boolean): Promise<void> {
  prompt(`checking folder: ${handle.name}`, 'none');
  ui.status.textContent = 'mounting';
  const resolved = await resolveGameFolder(handle);
  if (!resolved.report.ok) {
    if (!isNewChoice) await forgetGameFolder();
    terminal.log('vfs', `${handle.name}: missing ${resolved.report.missing.join(', ')}`, 'error');
    prompt("This is not the game's installation folder or its Data folder.", 'pick');
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
      ? 'Ready. Choose what to load.'
      : 'Select the install folder (the one containing Data) to load Creation Club content as well.',
    'pick',
  );
  ui.pick.textContent = 'change folder';
  showScreen('menu');
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

  // `?reset`: a first visit again (the stored folder and the panels' layout are forgotten).
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) {
    await forgetGameFolder();
    forgetPanels();
    params.delete('reset');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
    terminal.log('sys', 'reset: the stored folder and the panel layout are forgotten');
  }

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
      prompt('The browser needs permission again to read your game folder.', 'resume');
      break;
    case 'none':
      ui.status.textContent = 'awaiting folder';
      prompt(
        'Select the install folder of your own copy of TES V, Special Edition (the one containing "Data").\n' +
          'Everything stays on your own computer.',
        'pick',
      );
      break;
  }
}

// --- Startup --------------------------------------------------------------

async function main(): Promise<void> {
  terminal.log('sys', 'itjustworks webengine · booting');
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
  // The dev panel's fast-forward of the game clock: off (the game's pace), 2×, 5×, 10×, 20×.
  ui.viewer.sky.timeSpeed.addEventListener('click', () => {
    if (!session) return;
    session.timeSpeed = nextClockSpeed(session.timeSpeed);
    showClockSpeed(ui.viewer.sky, session.timeScale, session.timeSpeed);
  });
  // Load doors: the player goes to the door on the other side, inside or out (in Play behind a
  // loading screen).
  const travel = async (teleport: Teleport): Promise<void> => {
    const db = await session?.db;
    if (!db) return;
    const destination = await doorDestination(db, teleport);
    if (!destination) {
      terminal.log('door', 'the door leads nowhere', 'warn');
      return;
    }
    const arrival = { position: teleport.position, heading: teleport.rotation[2] };
    // The player's followers come through the door with them.
    await (worldViewer.playing ? worldViewer : modelViewer).bringFollowers(
      {
        position: [...teleport.position],
        rotation: [...teleport.rotation],
        cell: destination.world === undefined ? destination.cell : undefined,
        world: destination.world,
        scale: 1,
      },
      false,
    );
    terminal.log('door', `to ${destination.name || hexId(destination.cell)}`);
    if (destination.world === undefined) {
      await modelViewer.showCell(destination.cell, arrival);
    } else {
      const cell: [number, number] = [
        Math.floor(teleport.position[0] / CELL_SIZE),
        Math.floor(teleport.position[1] / CELL_SIZE),
      ];
      await worldViewer.open(destination.world, cell, arrival);
    }
  };
  // A load door: its prompt stays on the HUD while the place loads (SetLoadDoorInfo).
  const onTravel = (teleport: Teleport): void => {
    (play ? play.loadingScreen(() => travel(teleport)) : travel(teleport))
      .catch((error: unknown) => {
        terminal.log('door', describeError(error), 'error');
      })
      .finally(() => {
        session?.hud.loadDoor(undefined);
      });
  };
  modelViewer.onTravel = onTravel;
  worldViewer.onTravel = onTravel;
  // The quest panel's go to: a journey to the cell or worldspace of the place, as a door's.
  const journeyTo = (at: Placement): void => {
    const arrival = { position: at.position, heading: at.rotation[2] };
    const going =
      at.world !== undefined
        ? worldViewer.open(
            at.world,
            [Math.floor(at.position[0] / CELL_SIZE), Math.floor(at.position[1] / CELL_SIZE)],
            arrival,
          )
        : at.cell !== undefined
          ? modelViewer.showCell(at.cell, arrival)
          : Promise.resolve();
    going.catch((error: unknown) => {
      terminal.log('papyrus', `the player cannot go there: ${describeError(error)}`, 'error');
    });
  };
  /** Resolves once neither viewer is loading (the player stands in the place). */
  const settled = async (): Promise<void> => {
    while (worldViewer.loading !== undefined || modelViewer.loading !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Then the player's body and the actors around them, for a while at most (an actor whose
    // model never loads does not hold the game).
    const until = performance.now() + POPULATE_MS;
    while ((worldViewer.populating || modelViewer.populating) && performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  // "Click to look around": the browser wants a click to give the mouse back to the game.
  const pointerHint = document.createElement('div');
  pointerHint.className = 'pointer-hint';
  pointerHint.textContent = 'Click to look around';
  pointerHint.hidden = true;
  document.body.append(pointerHint);
  /** Whether the game wants the mouse now (a menu may have opened before the browser said no). */
  let pointerWanted = false;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) pointerHint.hidden = true;
  });
  // Play's 3D view: a journey into the world that resolves once it has loaded, and the
  // scripts' MoveTo of the player followed (the sandbox never follows them).
  const playWorld: PlayWorld = {
    enter: async (at) => {
      const arrival = { position: at.position, heading: at.rotation[2] };
      // Fast travel and journeys: the followers, and the player's horse, come along.
      await (worldViewer.playing ? worldViewer : modelViewer).bringFollowers(at, true);
      if (at.world !== undefined) {
        await worldViewer.open(
          at.world,
          [Math.floor(at.position[0] / CELL_SIZE), Math.floor(at.position[1] / CELL_SIZE)],
          arrival,
        );
      } else if (at.cell !== undefined) {
        await modelViewer.showCell(at.cell, arrival);
      }
      await settled();
    },
    settled: () => settled(),
    heading: () => (worldViewer.player ?? modelViewer.player)?.yaw,
    localMap: () =>
      worldViewer.player ? worldViewer.localMapContent() : modelViewer.localMapContent(),
    tweenCamera: () => (worldViewer.player ?? modelViewer.player)?.tween,
    player: () => worldViewer.playerView ?? modelViewer.playerView,
    inAir: () => {
      const player = worldViewer.player ?? modelViewer.player;
      return player !== undefined && !player.character.grounded && !player.character.swimming;
    },
    leave: () => {
      modelViewer.deactivate();
      worldViewer.deactivate();
    },
    capturePointer: (on) => {
      pointerWanted = on;
      if (!on) {
        pointerHint.hidden = true;
        if (document.pointerLockElement) document.exitPointerLock();
        return;
      }
      // Back from a menu: the mouse looks again. The browser gives it back only after a click
      // once the player let go of it with Esc: then a hint says so until it has it.
      ui.canvas.requestPointerLock().catch(() => {
        if (pointerWanted && !document.pointerLockElement) pointerHint.hidden = false;
      });
    },
    follow: (on) => {
      modelViewer.followsScripts = on;
      worldViewer.followsScripts = on;
      modelViewer.onPlayerSent = on ? journeyTo : undefined;
      worldViewer.onPlayerSent = on ? journeyTo : undefined;
    },
  };
  // The quests one at a time (a debug tool, as the console); going to a target moves the
  // player there.
  const questPanel = new QuestPanel(ui.quests, terminal);
  // Reset states: everything the scripts and the panels changed goes (a new game's state);
  // the scene on screen loads again, the player where they stood.
  const resetStates = async (): Promise<void> => {
    const current = session;
    if (!current) return;
    const player = current.scriptWorld.livePlacement(PLAYER_REF);
    const world = worldViewer.shownWorld;
    const cell = modelViewer.shownCell;
    terminal.log('papyrus', 'reset states: the running game starts over');
    const runtime = current.resetStates();
    void runtime.catch((error: unknown) => {
      terminal.log('papyrus', `scripts not running: ${describeError(error)}`, 'error');
    });
    void questPanel.connect(current, runtime).catch(() => undefined);
    const arrival = player && {
      position: player.position,
      heading: player.rotation?.[2] ?? 0,
    };
    if (world !== undefined) {
      const at = player?.position;
      await worldViewer.open(
        world,
        at && [Math.floor(at[0] / CELL_SIZE), Math.floor(at[1] / CELL_SIZE)],
        arrival,
      );
    } else if (cell !== undefined) {
      await modelViewer.showCell(cell, arrival);
    }
  };
  byId('reset-states', HTMLButtonElement).addEventListener('click', () => {
    resetStates().catch((error: unknown) => {
      terminal.log('papyrus', describeError(error), 'error');
    });
  });
  questPanel.onGoTo = (at) => {
    // The scripts know where the player is going; the view takes them there.
    session?.scriptsReady?.move(PLAYER_REF, at.position, at.rotation, at.cell, at.world);
    if (!modelViewer.sendPlayer(at) && !worldViewer.sendPlayer(at)) journeyTo(at);
  };
  /** The session whose scripts the sandbox started (see startSandboxScripts). */
  let sandboxScripts: GameSession | undefined;
  // Sandbox and Play open once the session is ready (its records indexed, the finders
  // filled).
  const setEntriesReady = (ready: boolean): void => {
    ui.menuSandbox.disabled = !ready;
    ui.menuPlay.disabled = !ready;
  };
  connectSession = async (vfs: Vfs): Promise<void> => {
    setEntriesReady(false);
    session?.dispose();
    sandboxScripts = undefined;
    session = new GameSession(gpu.device, renderer, vfs, terminal);
    session.placedActor = (reference) =>
      worldViewer.placedActor(reference) ?? modelViewer.placedActor(reference);
    session.actorAction = (reference, action) =>
      worldViewer.actorStage?.act(reference, action) === true ||
      modelViewer.actorStage?.act(reference, action) === true;
    await Promise.all([modelViewer.connect(session), worldViewer.connect(session)]);
    setEntriesReady(true);
  };
  // Centre the scene in the part of the screen the shell column does not cover.
  const updateLensShift = (): void => {
    const visibleColumn =
      window.innerWidth >= 1000 &&
      document.body.dataset.screen !== 'sandbox' &&
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
  setupHideShortcut([ui.shell, ui.devPanel]);
  showScreen('start');
  ui.menuSandbox.addEventListener('click', () => {
    showScreen('sandbox');
    startSandboxScripts();
  });
  // The sandbox's game state: its scripts start a new game the first time the sandbox opens
  // (not before: the home page and Play need none of it).
  const startSandboxScripts = (): void => {
    const current = session;
    if (!current || sandboxScripts === current) return;
    sandboxScripts = current;
    const runtime = current.runtime();
    void runtime.catch((error: unknown) => {
      terminal.log('papyrus', `scripts not running: ${describeError(error)}`, 'error');
    });
    void questPanel.connect(current, runtime).catch(() => undefined);
  };
  // Play: the game from its own main menu.
  let play: PlayMode | undefined;
  const leavePlay = (): void => {
    play?.stop();
    play = undefined;
    pointerWanted = false;
    pointerHint.hidden = true;
    ui.brand.tabIndex = 0;
    showScreen('menu');
  };
  // Play: the launcher first, as the game starts; its Play opens the game's main menu.
  const launcher = new Launcher(
    {
      panel: ui.launcher,
      play: byId('launcher-play', HTMLButtonElement),
      options: byId('launcher-options', HTMLButtonElement),
      exit: byId('launcher-exit', HTMLButtonElement),
      dialog: byId('launcher-options-dialog', HTMLDialogElement),
      windowed: byId('launcher-windowed', HTMLInputElement),
      detail: byId('launcher-detail', HTMLElement),
      adapter: byId('launcher-adapter', HTMLElement),
      ok: byId('launcher-ok', HTMLButtonElement),
      cancel: byId('launcher-cancel', HTMLButtonElement),
    },
    describeGpu(gpu),
  );
  ui.menuPlay.addEventListener('click', () => {
    if (!session || play) return;
    showScreen('launcher');
    launcher.show();
  });
  launcher.onExit = () => {
    launcher.hide();
    showScreen('menu');
  };
  launcher.onPlay = (prefs) => {
    if (!session || play) return;
    launcher.hide();
    // Full screen unless the Options chose a window (asked for in the click itself).
    if (!prefs.windowed && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((error: unknown) => {
        terminal.log('sys', `full screen: ${describeError(error)}`, 'warn');
      });
    }
    showScreen('play');
    play = new PlayMode(session, renderer, playWorld, ui.uiLayer, terminal);
    // The way back stays for the mouse; keys belong to the game's menus.
    ui.brand.tabIndex = -1;
    ui.brand.blur();
    play.onQuit = leavePlay;
    play.start().catch((error: unknown) => {
      terminal.log('ui', `the main menu does not open: ${describeError(error)}`, 'error');
      leavePlay();
    });
  };
  // The brand in the corner leads back to the main menu (from the sandbox).
  ui.brand.addEventListener('click', () => {
    if (document.body.dataset.screen === 'play') {
      // In a game it asks first, as the game's Quit to Desktop does.
      if (play) play.quitFromShell();
      else leavePlay();
      return;
    }
    if (document.body.dataset.screen === 'launcher') {
      launcher.hide();
      showScreen('menu');
      return;
    }
    if (document.body.dataset.screen !== 'sandbox') return;
    // Back on the main menu, nothing stays loaded.
    modelViewer.deactivate();
    worldViewer.deactivate();
    document.body.classList.remove('has-scene', 'content-scene');
    showScreen('menu');
  });
  if (import.meta.env.DEV) {
    window.engineDev = {
      viewer: modelViewer,
      world: worldViewer,
      renderer,
      device: gpu.device,
      session: () => session,
      play: () => play,
    };
  }
  let lastScriptTick = performance.now() / 1000;
  // Sounds follow the camera; browsers start audio only after a user gesture.
  startRenderLoop(
    renderer,
    () => session?.memory,
    () => {
      // The scripts' clocks move on (their waits and updates run as the game's time passes).
      const now = performance.now() / 1000;
      session?.tickScripts(Math.min(0.25, now - lastScriptTick));
      // The settings Grass Fade and Brightness.
      if (session) {
        renderer.grass.fadeStart = session.ini.number('Grass', 'fGrassStartFadeDistance');
        renderer.post.gamma = session.ini.number('Display', 'fGamma');
      }
      lastScriptTick = now;
      session?.soundSystem?.update(renderer.view?.camera);
      // The loading screen while a cell or worldspace loads, until the player stands in it.
      const loading = worldViewer.loading ?? modelViewer.loading;
      ui.loadingScreen.classList.toggle('visible', loading !== undefined);
      if (loading !== undefined) ui.loadingWhat.textContent = loading;
    },
    () => session?.menuMode === true,
  );
  const resumeAudio = (): void => {
    void session?.sounds().then((sounds) => sounds.engine.resume());
  };
  window.addEventListener('pointerdown', resumeAudio);
  window.addEventListener('keydown', resumeAudio);
  // F11: full screen, taken before a menu's Flash player (which keeps the keys it is given) and
  // done by the page, so it works the same whichever part has focus.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'F11') return;
      event.preventDefault();
      event.stopPropagation();
      const done = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen();
      done.catch((error: unknown) => {
        terminal.log('sys', `full screen: ${describeError(error)}`, 'warn');
      });
    },
    { capture: true },
  );

  // In full screen the page keeps the game's keys (Keyboard Lock, Chromium; LOCKED_KEYS): Esc is
  // the game's Pause, not the browser's way out (held down, Esc still leaves full screen), and
  // the browser's shortcuts do not act on them. Outside full screen the browser frees the mouse
  // on Esc, which Play takes as Pause.
  document.addEventListener('fullscreenchange', () => {
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
    if (document.fullscreenElement) keyboard?.lock?.(LOCKED_KEYS).catch(() => undefined);
    else keyboard?.unlock?.();
  });

  const backdrop = await findCustomBackdrop();
  if (backdrop) {
    ui.backdrop.style.backgroundImage = `url("${backdrop}")`;
    ui.backdrop.hidden = false;
    terminal.log('sys', `custom backdrop: ${backdrop}`);
  }

  await setupGameFolder();
}

main().catch(showFatal);
