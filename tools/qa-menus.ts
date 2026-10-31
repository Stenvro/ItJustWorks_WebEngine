// The menu tour (docs/qa.md): drives its own headless, muted Chrome over CDP through every
// original menu in a running game, one after the other, and takes a screenshot of each with the
// movies open, the menu stack and the page's errors, to a folder OUTSIDE the repository
// (screenshots show the game's content). What each screenshot should show is the movie's own
// layout with its translated strings; docs/completeness/menus.md ("On screen") keeps the result.
//
//   node tools/qa-menus.ts --out <folder> [--vite-port 5192] [--chrome-port 9352]
//                          [--url http://localhost:5192] [--cell Riverwood] [--only a,b,...]
//                          [--keep]
//
// --cell new: a new game (the opening's cart) in place of coc.
// --keep: the browser and the game stay up after the tour (until the runner is stopped), for
// looking further over CDP on the same port.
//
// The game is reached as the QA runner does (?devdata, Play, the main menu, coc). The menus are
// opened the way the game opens them: their keys where the player has one (Tab, I, P, J, M, Q, T,
// the console's ~), the engine's own paths otherwise (an actor activated for dialogue, a
// workbench for crafting, a locked chest for lockpicking, a script's ShowRaceMenu, ...).

import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Cdp, Page, sleep, startChrome, startVite, stopProcess, waitFor } from './qa-cdp.ts';

const root = path.resolve(import.meta.dirname, '..');
const WIDTH = 1280;
const HEIGHT = 720;

/** Forms the tour places or reads (Skyrim.esm). */
const FORMS = {
  /** Alvor: a blacksmith (a merchant) and a Smithing trainer. */
  alvor: 0x13475,
  /** Faendal: an Archery trainer. */
  faendal: 0x13480,
  forge: 0xbf9e1,
  enchanter: 0xbad0d,
  alchemyLab: 0xbad0c,
  chest: 0x20673,
  book: 0x1acef,
  ironSword: 0x12eb7,
  flames: 0x12fcd,
} as const;

interface Options {
  readonly out: string;
  readonly url: string | undefined;
  readonly vitePort: number;
  readonly chromePort: number;
  readonly cell: string;
  readonly only: ReadonlySet<string> | undefined;
  readonly keep: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let out: string | undefined;
  let url: string | undefined;
  let vitePort = 5192;
  let chromePort = 9352;
  let cell = 'Riverwood';
  let only: Set<string> | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = (): string => argv[++i] ?? '';
    if (arg === '--out') out = value();
    else if (arg === '--url') url = value();
    else if (arg === '--vite-port') vitePort = Number(value());
    else if (arg === '--chrome-port') chromePort = Number(value());
    else if (arg === '--cell') cell = value();
    else if (arg === '--only') only = new Set(value().split(','));
    else if (arg === '--keep') keep = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!out) throw new Error('--out <folder> is required (outside the repository)');
  const resolved = path.resolve(out);
  if (resolved.toLowerCase().startsWith(root.toLowerCase()))
    throw new Error(`--out must lie outside the repository: ${resolved}`);
  return { out: resolved, url, vitePort, chromePort, cell, only, keep };
}

/** What a step saw: the movies open, the menu stack, the errors and warnings meanwhile. */
interface StepResult {
  readonly name: string;
  readonly shot: string | undefined;
  readonly movies: readonly string[];
  readonly stack: readonly string[];
  readonly facts: unknown;
  readonly problems: readonly string[];
}

class Tour {
  readonly page: Page;
  readonly out: string;
  readonly results: StepResult[] = [];
  #problems: string[] = [];
  #index = 0;

  constructor(page: Page, out: string) {
    this.page = page;
    this.out = out;
    page.on('Runtime.consoleAPICalled', (params) => {
      const type = String(params.type);
      if (type !== 'error' && type !== 'warning') return;
      const args = params.args as readonly { value?: unknown; description?: string }[];
      const text = args
        .map((arg) =>
          typeof arg.value === 'string' || typeof arg.value === 'number'
            ? String(arg.value)
            : (arg.description ?? ''),
        )
        .join(' ');
      this.#problems.push(`${type}: ${text}`.slice(0, 400));
    });
    page.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as { exception?: { description?: string } };
      this.#problems.push(`exception: ${details.exception?.description ?? ''}`.slice(0, 400));
    });
  }

  /** Runs page code at the top level (private fields readable), returns its value. */
  repl<T = unknown>(code: string, timeoutMs = 60000): Promise<T> {
    return this.page.eval<T>(code, timeoutMs, true);
  }

  eval<T = unknown>(code: string, timeoutMs = 60000): Promise<T> {
    return this.page.eval<T>(code, timeoutMs);
  }

  movies(): Promise<string[]> {
    return this.eval<string[]>(`[...engineDev.play().host.menus].map((m) => m.movie)`);
  }

  /** Waits until a movie is open (and its frames run). */
  async opened(movie: string, timeoutMs = 30000): Promise<boolean> {
    const open = await waitFor(
      () =>
        this.eval<boolean | undefined>(
          `[...engineDev.play().host.menus].some((m) => m.movie === ${JSON.stringify(movie)}) || undefined`,
        ),
      timeoutMs,
      300,
    );
    return open === true;
  }

  async closed(movie: string, timeoutMs = 15000): Promise<boolean> {
    const gone = await waitFor(
      () =>
        this.eval<boolean | undefined>(
          `[...engineDev.play().host.menus].some((m) => m.movie === ${JSON.stringify(movie)}) ? undefined : true`,
        ),
      timeoutMs,
      300,
    );
    return gone === true;
  }

  /** A screenshot and what is open now, as a step's result. */
  async shot(name: string, facts?: unknown): Promise<void> {
    const file = `${String(++this.#index).padStart(2, '0')}-${name}.jpg`;
    let shot: string | undefined = file;
    await this.page.screenshot(path.join(this.out, file), 80).catch(() => {
      shot = undefined;
    });
    const movies = await this.movies().catch(() => []);
    const stack = await this.eval<string[]>(`[...engineDev.play().session.menuStack.names]`).catch(
      () => [],
    );
    this.results.push({ name, shot, movies, stack, facts, problems: this.#problems });
    console.log(
      `  ${name}: ${movies.join(', ')}${this.#problems.length > 0 ? ` (${this.#problems.length} problems)` : ''}`,
    );
    this.#problems = [];
  }

  /** Dismisses a tutorial that came up over a menu (screenshot first). */
  async tutorials(after: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (!(await this.movies()).includes('tutorialmenu.swf')) return;
      await sleep(1500);
      await this.shot(`${after}-tutorial`);
      await this.page.key('Enter');
      await this.closed('tutorialmenu.swf', 5000);
      await sleep(500);
    }
  }

  /** Closes the menu on top: Escape (its key), the engine's close if it stays. */
  async escape(movie: string): Promise<void> {
    // A menu that never opened is not closed (Escape would open the pause menu).
    if (!(await this.movies()).includes(movie)) return;
    await this.page.key('Escape');
    if (await this.closed(movie, 6000)) return;
    this.#problems.push(`${movie} did not close with Escape`);
    await this.repl(`engineDev.play().#menus.close(); true`).catch(() => undefined);
    await this.closed(movie, 6000);
  }
}

/** The page: the play card, the launcher, the main menu with its entries. */
async function toMainMenu(tour: Tour, base: string): Promise<void> {
  await tour.page.navigate(`${base}/?devdata`);
  const card = await waitFor(
    () =>
      tour.eval<string>(
        `(() => { const card = document.getElementById('menu-play'); if (!card || card.disabled || !/ready/i.test(document.getElementById('console-status')?.textContent ?? '')) return undefined; card.click(); return 'card'; })()`,
        10000,
      ),
    120000,
  );
  if (!card) throw new Error('the shell never became ready (game data?)');
  await sleep(1500);
  await tour.eval(`(document.getElementById('launcher-play')?.click(), true)`);
  const menu = await waitFor(
    () =>
      tour.eval<number | undefined>(
        `(() => { const m = engineDev.play()?.startMenu; const n = m?.get('_root.MenuHolder.Menu_mc.MainList.entryList.length') ?? 0; return n >= 5 ? n : undefined; })()`,
        10000,
      ),
    120000,
  );
  if (!menu) throw new Error('the main menu did not open');
}

/** Answers the Survival Mode offer No, until no box comes for a while. */
async function answerBoxes(tour: Tour): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await sleep(2000);
    const answered = await tour.eval<boolean>(
      `(() => { const box = [...engineDev.play().host.menus].find((m) => m.movie === 'messagebox.swf'); if (!box) return false; box.received('buttonPress', [1, 1]); return true; })()`,
    );
    quiet = answered ? 0 : quiet + 1;
  }
}

/** Page code: places a form at the player, `distance` units ahead; its reference. */
function placeAhead(form: number, distance: number, side = 0): string {
  return `
var rt = engineDev.play().session.scriptsReady;
var nat = (name, self, args) => { const dot = name.indexOf('.'); return rt.native(name.slice(0, dot), name.slice(dot + 1))({ vm: rt.vm, self: self === undefined ? null : rt.referenceHandle(self), args, name, latent: (w) => w, where: () => 'menu tour' }); };
var view = (engineDev.world.play ?? engineDev.viewer.play).player.forward;
var flat = Math.hypot(view[0], view[1]) || 1;
var fx = view[0] / flat, fy = view[1] / flat;
var placed = await nat('objectreference.placeatme', 0x14, [rt.formHandle(${form}), 1]);
await nat('objectreference.moveto', placed.formId, [rt.referenceHandle(0x14), fx * ${distance} + fy * ${side}, fy * ${distance} - fx * ${side}, 0]);
await nat('objectreference.setangle', placed.formId, [0, 0, (Math.atan2(-fx, -fy) * 180) / Math.PI]);
placed.formId;
`;
}

/** Page code: moves a reference to `distance` units ahead of the player, facing them. */
function moveAhead(reference: number, distance: number): string {
  return `
var rt = engineDev.play().session.scriptsReady;
var nat = (name, self, args) => { const dot = name.indexOf('.'); return rt.native(name.slice(0, dot), name.slice(dot + 1))({ vm: rt.vm, self: self === undefined ? null : rt.referenceHandle(self), args, name, latent: (w) => w, where: () => 'menu tour' }); };
var view = (engineDev.world.play ?? engineDev.viewer.play).player.forward;
var flat = Math.hypot(view[0], view[1]) || 1;
var fx = view[0] / flat, fy = view[1] / flat;
await nat('objectreference.moveto', ${reference}, [rt.referenceHandle(0x14), fx * ${distance}, fy * ${distance}, 0]);
await nat('objectreference.setangle', ${reference}, [0, 0, (Math.atan2(-fx, -fy) * 180) / Math.PI]);
true;
`;
}

/** Page code: turns the player's view to a reference, `height` units over its feet. */
function lookAtReference(reference: number, height: number): string {
  return `
var rt = engineDev.play().session.scriptsReady;
var nat = (name, self, args) => { const dot = name.indexOf('.'); return rt.native(name.slice(0, dot), name.slice(dot + 1))({ vm: rt.vm, self: self === undefined ? null : rt.referenceHandle(self), args, name, latent: (w) => w, where: () => 'menu tour' }); };
var player = (engineDev.world.play ?? engineDev.viewer.play).player;
var at = [await nat('objectreference.getpositionx', ${reference}, []), await nat('objectreference.getpositiony', ${reference}, []), (await nat('objectreference.getpositionz', ${reference}, [])) + ${height}];
var dx = at[0] - player.position[0], dy = at[1] - player.position[1], dz = at[2] - player.position[2];
player.yaw = Math.atan2(dx, dy);
player.pitch = Math.atan2(dz, Math.hypot(dx, dy));
true;
`;
}

/** Page code: a conversation with a placed actor, as the player's activation starts one. */
function talkTo(reference: number): string {
  return `
var placed = [...(engineDev.world.play ? engineDev.world : engineDev.viewer).readyActors()].find((p) => p.actor.reference === ${reference});
if (placed) engineDev.play().session.hud.menus.talk(placed);
placed !== undefined;
`;
}

type Step = (tour: Tour, context: Record<string, number>) => Promise<void>;

/** The menus in the order the tour opens them (after the main menu and the loading screen). */
const STEPS: readonly (readonly [string, Step])[] = [
  [
    'hud',
    async (tour) => {
      // The meters fade out once full (a while after arriving).
      await sleep(8000);
      await tour.shot('hud', await hudFacts(tour));
    },
  ],
  [
    'hud-activate',
    async (tour, context) => {
      context.alvor = await tour.repl<number>(placeAhead(FORMS.alvor, 140));
      await sleep(4000);
      // His package walks him off: brought back ahead and the view turned to his head, until
      // the crosshair's prompt names him.
      for (let i = 0; i < 6; i++) {
        await tour.repl(moveAhead(context.alvor, 110));
        await tour.repl(lookAtReference(context.alvor, 100));
        await sleep(700);
        const facts = (await hudFacts(tour)) as { activate?: string };
        if ((facts.activate ?? '').includes('Alvor')) break;
      }
      await tour.shot('hud-activate', await hudFacts(tour));
    },
  ],
  [
    'tween',
    async (tour) => {
      await tour.page.key('Tab');
      await tour.opened('tweenmenu.swf');
      await sleep(1500);
      await tour.shot('tween');
      await tour.page.key('Tab');
      await tour.closed('tweenmenu.swf');
    },
  ],
  [
    'inventory',
    async (tour) => {
      await tour.repl(
        `var rt = engineDev.play().session.scriptsReady; await rt.addItem(0x14, rt.formHandle(${FORMS.ironSword}), 1, true); await rt.addItem(0x14, rt.formHandle(${FORMS.book}), 1, true); true`,
      );
      await tour.page.key('KeyI');
      await tour.opened('inventorymenu.swf');
      await sleep(2500);
      await tour.tutorials('inventory');
      await tour.shot('inventory-categories');
      // Into the category: its items list slides in (the movie's two panels), the first one's
      // card and 3D.
      await tour.page.key('Enter');
      await sleep(2500);
      await tour.shot('inventory');
      await tour.escape('inventorymenu.swf');
    },
  ],
  [
    'magic',
    async (tour) => {
      await tour.page.key('KeyP');
      await tour.opened('magicmenu.swf');
      await sleep(2500);
      await tour.tutorials('magic');
      await tour.page.key('ArrowDown');
      await tour.page.key('Enter');
      await sleep(2500);
      await tour.shot('magic');
      await tour.escape('magicmenu.swf');
    },
  ],
  [
    'favorites',
    async (tour) => {
      await tour.repl(
        `var rt = engineDev.play().session.scriptsReady; rt.state.favorites.add(${FORMS.flames}); rt.state.favorites.add(${FORMS.ironSword}); true`,
      );
      await tour.page.key('KeyQ');
      await tour.opened('favoritesmenu.swf');
      await sleep(1500);
      await tour.shot('favorites');
      await tour.escape('favoritesmenu.swf');
    },
  ],
  [
    'journal',
    async (tour) => {
      await tour.page.key('KeyJ');
      await tour.opened('quest_journal.swf');
      await sleep(2500);
      await tour.tutorials('journal');
      await tour.shot('journal-quests');
      // The tabs, clicked (at 1280 x 720).
      await tour.page.click(642, 70);
      await sleep(1500);
      await tour.shot('journal-stats');
      await tour.page.click(906, 70);
      await sleep(1500);
      await tour.shot('journal-system');
      await tour.escape('quest_journal.swf');
    },
  ],
  [
    'map',
    async (tour) => {
      await tour.page.key('KeyM');
      await tour.opened('map.swf');
      await sleep(12000);
      await tour.tutorials('map');
      await tour.shot('map-world');
      await tour.page.key('KeyL');
      await sleep(4000);
      await tour.shot('map-local');
      await tour.page.key('KeyL');
      await sleep(1000);
      await tour.escape('map.swf');
    },
  ],
  [
    'skills',
    async (tour) => {
      await tour.repl(`engineDev.play().session.hud.menus.userEvent('Quick Stats'); true`);
      await tour.opened('statsmenu.swf');
      await sleep(6000);
      await tour.tutorials('skills');
      await tour.shot('skills');
      await tour.page.key('ArrowUp');
      await sleep(3000);
      await tour.shot('skills-perks');
      // Up the tree: the camera goes to the next star's camera point.
      await tour.page.key('ArrowUp');
      await sleep(2000);
      await tour.shot('skills-perks-up');
      await tour.escape('statsmenu.swf');
      await sleep(1500);
    },
  ],
  [
    'levelup',
    async (tour) => {
      await tour.eval(`engineDev.play().runConsole('player.advlevel')`);
      await sleep(1500);
      await tour.repl(`engineDev.play().session.hud.menus.userEvent('Quick Stats'); true`);
      await tour.opened('statsmenu.swf');
      await sleep(5000);
      await tour.tutorials('levelup');
      await tour.shot('levelup', {
        levelup: await tour.movies().then((movies) => movies.includes('levelupmenu.swf')),
      });
      await tour.escape('levelupmenu.swf');
      await sleep(500);
      if ((await tour.movies()).includes('statsmenu.swf')) await tour.escape('statsmenu.swf');
      await sleep(1500);
    },
  ],
  [
    'wait',
    async (tour) => {
      await tour.page.key('KeyT');
      await tour.opened('sleepwaitmenu.swf');
      await sleep(1500);
      await tour.shot('wait');
      await tour.escape('sleepwaitmenu.swf');
    },
  ],
  [
    'sleep',
    async (tour) => {
      await tour.repl(`engineDev.play().#menus.sleep(); true`);
      await tour.opened('sleepwaitmenu.swf');
      await sleep(1500);
      await tour.shot('sleep');
      await tour.escape('sleepwaitmenu.swf');
    },
  ],
  [
    'dialogue',
    async (tour, context) => {
      if (!context.alvor) return;
      await tour.repl(talkTo(context.alvor));
      await tour.opened('dialoguemenu.swf');
      await sleep(5000);
      await tour.shot('dialogue');
      // Esc skips the line being spoken first, then leaves the conversation.
      await tour.page.key('Escape');
      await sleep(1500);
      await tour.escape('dialoguemenu.swf');
      await sleep(2000);
    },
  ],
  [
    'barter',
    async (tour, context) => {
      if (!context.alvor) return;
      await tour.repl(
        `engineDev.play().session.hud.menus.open({ name: 'Barter Menu', actor: ${context.alvor} }); true`,
      );
      // The merchant's chest is read first (a while).
      await tour.opened('bartermenu.swf', 90000);
      await sleep(3000);
      await tour.tutorials('barter');
      await tour.page.key('ArrowDown');
      await sleep(1000);
      await tour.shot('barter');
      await tour.escape('bartermenu.swf');
    },
  ],
  [
    'gift',
    async (tour, context) => {
      if (!context.alvor) return;
      await tour.repl(
        `engineDev.play().session.hud.menus.open({ name: 'Gift Menu', actor: ${context.alvor}, giving: true, filter: undefined, showStolen: false, useFavorPoints: false }); true`,
      );
      await tour.opened('giftmenu.swf');
      await sleep(2500);
      await tour.shot('gift');
      await tour.escape('giftmenu.swf');
    },
  ],
  [
    'training',
    async (tour, context) => {
      // A trainer of his class (Archery); Alvor's class teaches nothing.
      context.trainer = await tour.repl<number>(placeAhead(FORMS.faendal, 160, 80));
      await sleep(3000);
      await tour.repl(
        `engineDev.play().session.hud.menus.open({ name: 'Training Menu', actor: ${context.trainer} }); true`,
      );
      await tour.opened('trainingmenu.swf');
      await sleep(2500);
      await tour.shot('training');
      await tour.escape('trainingmenu.swf');
    },
  ],
  [
    'container',
    async (tour, context) => {
      context.chest = await tour.repl<number>(placeAhead(FORMS.chest, 120, 120));
      await sleep(2000);
      await tour.repl(
        `engineDev.play().session.hud.menus.container(${context.chest}, () => undefined); true`,
      );
      await tour.opened('containermenu.swf');
      await sleep(2500);
      await tour.tutorials('container');
      await tour.shot('container');
      await tour.escape('containermenu.swf');
    },
  ],
  [
    'lockpicking',
    async (tour, context) => {
      if (!context.chest) return;
      await tour.eval(`engineDev.play().runConsole('${context.chest.toString(16)}.lock 50')`);
      await tour.eval(`engineDev.play().runConsole('player.additem a 5')`);
      await tour.repl(`engineDev.play().#menus.pickLock(${context.chest}); true`);
      await tour.opened('lockpickingmenu.swf');
      await sleep(4000);
      await tour.tutorials('lockpicking');
      await tour.shot('lockpicking');
      await tour.escape('lockpickingmenu.swf');
      await sleep(1000);
    },
  ],
  [
    'book',
    async (tour) => {
      await tour.repl(`engineDev.play().#menus.readBook({ book: ${FORMS.book} }); true`);
      await tour.opened('book.swf');
      await sleep(4000);
      await tour.shot('book');
      await tour.escape('book.swf');
      await sleep(1000);
    },
  ],
  ...(
    [
      ['forge', FORMS.forge],
      ['enchanting', FORMS.enchanter],
      ['alchemy', FORMS.alchemyLab],
    ] as const
  ).map(([name, form]): readonly [string, Step] => [
    name,
    async (tour) => {
      const bench = await tour.repl<number>(placeAhead(form, 150, -150));
      await sleep(2500);
      await tour.repl(`engineDev.play().#menus.craft(${bench}, ${form}); true`);
      await tour.opened('craftingmenu.swf');
      await sleep(4000);
      await tour.tutorials(name);
      await tour.shot(name);
      await tour.escape('craftingmenu.swf');
      await sleep(1500);
    },
  ]),
  [
    'message-box',
    async (tour) => {
      await tour.repl(
        `void engineDev.play().session.hud.menus.messageBox('A message box of the menu tour.', ['Yes', 'No']); true`,
      );
      await tour.opened('messagebox.swf');
      await sleep(1500);
      await tour.shot('message-box');
      await tour.eval(
        `([...engineDev.play().host.menus].find((m) => m.movie === 'messagebox.swf')?.received('buttonPress', [1, 1]), true)`,
      );
      await tour.closed('messagebox.swf');
    },
  ],
  [
    'console',
    async (tour) => {
      await tour.page.key('Backquote');
      await tour.opened('console.swf');
      await sleep(1000);
      for (const ch of 'getlevel') await tour.page.key(`Key${ch.toUpperCase()}`);
      await tour.page.key('Enter');
      await sleep(1000);
      await tour.shot('console');
      await tour.page.key('Backquote');
      await tour.closed('console.swf');
    },
  ],
  [
    'controls-disabled',
    async (tour) => {
      await tour.eval(`engineDev.play().runConsole('disableplayercontrols')`);
      await sleep(500);
      const before = await tour.repl(`engineDev.world.#play?.player?.pov ?? 'none'`);
      await tour.page.key('KeyF');
      await sleep(800);
      const after = await tour.repl(`engineDev.world.#play?.player?.pov ?? 'none'`);
      await tour.page.key('Tab');
      await sleep(1500);
      const tween = (await tour.movies()).includes('tweenmenu.swf');
      await tour.shot('controls-disabled', { povBefore: before, povAfterF: after, tween });
      if (tween) await tour.page.key('Tab');
      await tour.eval(`engineDev.play().runConsole('enableplayercontrols')`);
      await sleep(800);
    },
  ],
  [
    'race-menu',
    async (tour) => {
      await tour.repl(
        `void engineDev.play().session.hud.menus.open({ name: 'RaceSex Menu', limited: false }); true`,
      );
      await tour.opened('racesex_menu.swf');
      await sleep(8000);
      await tour.shot('race-menu');
      // The page losing focus (another tab, another window) and coming back.
      await tour.page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await tour.eval(`(window.dispatchEvent(new Event('blur')), true)`);
      await sleep(3000);
      await tour.page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await tour.eval(`(window.dispatchEvent(new Event('focus')), true)`);
      await sleep(3000);
      await tour.shot('race-menu-after-blur');
      await tour.repl(`engineDev.play().#menus.close(); true`);
      await sleep(3000);
    },
  ],
  [
    'pause',
    async (tour) => {
      await tour.page.key('Escape');
      await tour.opened('quest_journal.swf');
      await sleep(2500);
      await tour.shot('pause');
      await tour.escape('quest_journal.swf');
    },
  ],
];

/** The HUD's activate prompt and compass, as the movie holds them. */
function hudFacts(tour: Tour): Promise<unknown> {
  return tour.eval(`(() => {
    const hud = [...engineDev.play().host.menus].find((m) => m.movie === 'hudmenu.swf');
    if (!hud) return { hud: false };
    const read = (p) => { try { return hud.get(p); } catch { return undefined; } };
    return {
      hud: true,
      shown: read('_root.HUDMovieBaseInstance._visible'),
      activate: read('_root.HUDMovieBaseInstance.RolloverText.htmlText'),
      activateInfo: read('_root.HUDMovieBaseInstance.RolloverInfoText.htmlText'),
      rolloverAlpha: read('_root.HUDMovieBaseInstance.RolloverText._alpha'),
      compass: read('_root.HUDMovieBaseInstance.CompassShoutMeterHolder._visible'),
      compassAlpha: read('_root.HUDMovieBaseInstance.CompassShoutMeterHolder._alpha'),
      mode: read('_root.HUDMovieBaseInstance.HUDModes'),
    };
  })()`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  let vite: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const base = options.url ?? `http://localhost:${options.vitePort}`;
    if (!options.url) {
      console.log(`starting Vite on ${options.vitePort}...`);
      vite = await startVite(root, options.vitePort);
    }
    console.log(`starting Chrome on ${options.chromePort}...`);
    chrome = await startChrome({
      port: options.chromePort,
      profile: path.join(options.out, '.chrome-profile'),
      width: WIDTH,
      height: HEIGHT,
    });
    cdp = await Cdp.connect(options.chromePort);
    const page = await Page.open(cdp, WIDTH, HEIGHT);
    const tour = new Tour(page, options.out);
    const wanted = (name: string): boolean => !options.only || options.only.has(name);
    await toMainMenu(tour, base);
    await sleep(2500);
    if (wanted('main-menu')) await tour.shot('main-menu');
    if (wanted('credits')) {
      // The CREDITS entry clicked: the menu fades out, then the credits open.
      await tour.page.click(1188, 574);
      await tour.opened('creditsmenu.swf');
      await sleep(5000);
      await tour.shot('credits');
      await tour.escape('creditsmenu.swf');
      await sleep(3000);
    }
    void tour.eval(
      options.cell === 'new'
        ? `(engineDev.play().startMenu.received('NEW', []), true)`
        : `engineDev.play().runConsole(${JSON.stringify(`coc ${options.cell}`)})`,
      120000,
    );
    // NEW asks first ("Start a new game?"): Enter answers Yes.
    if (options.cell === 'new' && !(await tour.opened('loadingmenu.swf', 3000)))
      await page.key('Enter');
    if (await tour.opened('loadingmenu.swf', 20000)) {
      await sleep(2500);
      if (wanted('loading')) await tour.shot('loading');
      // The loading screen's model and text come once the game's scripts have chosen it.
      await sleep(8000);
      if (wanted('loading') && (await tour.movies()).includes('loadingmenu.swf'))
        await tour.shot('loading-screen');
    }
    const inWorld = await waitFor(
      () =>
        tour.eval<boolean | undefined>(
          `(() => { const p = engineDev.play(); const hud = [...p.host.menus].some(x => x.movie === 'hudmenu.swf'); return hud && !p.session.loading && engineDev.world.loading === undefined && engineDev.viewer.loading === undefined ? true : undefined; })()`,
          10000,
        ),
      300000,
      2000,
    );
    if (!inWorld) throw new Error('the game never got into the world');
    await answerBoxes(tour);
    await sleep(3000);
    const context: Record<string, number> = {};
    for (const [name, step] of STEPS) {
      if (!wanted(name)) continue;
      console.log(`step ${name}`);
      await step(tour, context).catch(async (error: unknown) => {
        console.log(`  ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        await tour.shot(`${name}-failed`).catch(() => undefined);
        await tour.repl(`engineDev.play().#menus.close(); true`).catch(() => undefined);
      });
      await answerBoxes(tour).catch(() => undefined);
    }
    fs.writeFileSync(path.join(options.out, 'tour.json'), JSON.stringify(tour.results, null, 1));
    console.log(`screenshots and tour.json in ${options.out}`);
    if (options.keep) {
      console.log('kept running (stop the runner to end it)');
      await new Promise(() => undefined);
    }
  } finally {
    cdp?.close();
    stopProcess(chrome);
    stopProcess(vite);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
