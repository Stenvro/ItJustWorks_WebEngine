// The menus' completeness sweep: every movie in the interface folder (the base game's, the
// DLCs' and the Creation Club's, as the load order mounts them), what each asks of the engine
// (GameDelegate.call), what the engine may call in it (GameDelegate.addCallBack), and whether our
// shell answers or pushes each name; then every menu name the original opens against our menu
// stack. The result is the checklist in docs/completeness/menus.md.
//
//   node tools/menu-inventory.ts               summary, then each name still open
//   node tools/menu-inventory.ts --markdown    the checklist's tables
//
// A name counts as done when it appears in the code (comments stripped) of the files that open
// the movie, the menu files they import, or the handlers every menu shares. That is a static
// match, not a run: docs/completeness/menus.md says what was checked by hand. Names the PC game
// never sends or answers are "n/a" with the reason (NOT_ON_PC).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readSwf } from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';
import { delegateCalls } from './swf-calls.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const MARKDOWN = process.argv.includes('--markdown');

const CONSOLE = 'consoles only (PlayStation, Xbox, Switch)';
const ONLINE = 'an online service (Bethesda.net): never reached from localhost (hard rule 4)';
const UNSENT = 'the original engine has no such name: it never sends it';
const NO_MENU = 'no menu of the original is made under this name (it is only looked up)';
const SAFE_ZONE = "the consoles' safe-zone setting: the PC's display page has none";

/** Names the PC game never sends or answers, and why. */
const NOT_ON_PC: ReadonlyMap<string, string> = new Map([
  ['ORBISDeleteSave', CONSOLE],
  ['OpenKinectTuner', CONSOLE],
  ['ActivateJoyConStrapInstruction', CONSOLE],
  ['ExitJoyConStrapInstructionScreen', CONSOLE],
  ['FirstTimeOunceDataTransferCheck', CONSOLE],
  ['OnOunceDataTransfer', CONSOLE],
  ['OnPS5DataTransfer', CONSOLE],
  ['ChangeUser', CONSOLE],
  ['onProfileChange', CONSOLE],
  ['ShowGamerTagAndIcon', CONSOLE],
  ['ShowVirtualKeyboard', CONSOLE],
  ['SetRemoteDevice', CONSOLE],
  ['UpdatePermissions', CONSOLE],
  ['OnSaveDataEventLoadCANCEL', CONSOLE],
  ['OnSaveDataEventLoadSUCCESS', CONSOLE],
  ['OnSaveDataEventSaveCANCEL', CONSOLE],
  ['OnSaveDataEventSaveSUCCESS', CONSOLE],
  ['GetMouseButtonForSetDestination', 'the Switch with a mouse only (PLATFORM_NX_MOUSE)'],
  ['UpdateLockPickingButtonPrompt', 'the Switch only (its NXArt)'],
  ['CreationClub', ONLINE],
  ['DownloadAll', ONLINE],
  ['OpenMarketplace', ONLINE],
  ['MOD', ONLINE],
  ['ModManager', ONLINE],
  ['PopulateCreationClubTopics', ONLINE],
  ['RequestCreationClubText', ONLINE],
  ['Sky10DLCPressed', ONLINE],
  ['LoadDLC', ONLINE],
  ['DoLoadDLCPlugins', ONLINE],
  ['StartLoadingDLC', ONLINE],
  ['DoneLoadingDLC', ONLINE],
  ['ToggleDebugMode', UNSENT],
  ['UpdateTurnPagesButton', UNSENT],
  ['PopulateItems', UNSENT],
  ['SetPerkCount', UNSENT],
  ['moveCategoriesUp', UNSENT],
  ['AdjustForPALSD', UNSENT],
]);

/** Callbacks the host sends every movie that registers them (SetButtonMapping). */
const GENERIC = ['src/ui/menu-host.ts'];

/** Names our code builds (no literal to match), checked by hand: where they are sent. */
const BY_HAND: ReadonlyMap<string, string> = new Map([
  ['hudmenu.swf:SetHealthMeterPercent', 'src/shell/hud-controller.ts (SetMeterPercent)'],
  ['hudmenu.swf:SetMagickaMeterPercent', 'src/shell/hud-controller.ts (SetMeterPercent)'],
  ['hudmenu.swf:SetStaminaMeterPercent', 'src/shell/hud-controller.ts (SetMeterPercent)'],
]);

/** Movies the PC game never opens, and why. */
const MOVIES_NOT_ON_PC: ReadonlyMap<string, string> = new Map([
  ['bethesdanetlogin.swf', ONLINE],
  ['logindialog.swf', ONLINE],
  ['modmanager.swf', ONLINE],
  ['creationclubmenu.swf', ONLINE],
  ['kinectmenu.swf', CONSOLE],
  ['streaminginstall.swf', CONSOLE],
  ['safezone.swf', SAFE_ZONE],
]);

/** Our menu code: src/ui and the shell's files (comments stripped). */
const sources = new Map<string, string>();
for (const folder of ['src/ui', 'src/shell', 'src/gameplay']) {
  for (const file of readdirSync(path.join(REPO, folder))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    // Of the gameplay systems only those a menu's handlers are named in.
    if (folder === 'src/gameplay' && !file.startsWith('chargen')) continue;
    const text = readFileSync(path.join(REPO, folder, file), 'utf8');
    sources.set(`${folder}/${file}`, stripComments(text));
  }
}

/** The files that answer every menu (play-mode.ts's common handlers, the host itself). */
const COMMON = ['src/shell/play-mode.ts', 'src/ui/menu-host.ts', 'src/ui/menu-bridge.ts'];

/** Menu files a file imports (one level): the shared item menu, the save list, src/ui. */
function menuImports(file: string): string[] {
  const text = sources.get(file) ?? '';
  const found: string[] = [];
  for (const match of text.matchAll(/from '(\.\.?\/[^']+\.ts)'/g)) {
    const spec = match[1] ?? '';
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (!sources.has(target)) continue;
    const base = path.posix.basename(target);
    if (
      target.startsWith('src/ui/') ||
      /menu|hud-|journal-|item-|map-|local-map|save-list|chargen/.test(base)
    ) {
      found.push(target);
    }
  }
  return found;
}

/** The files that open a movie (name it), with the menu files they import. */
function filesFor(movie: string, importers: readonly string[]): string[] {
  const base = movie.split('\\').pop()?.toLowerCase() ?? movie;
  const files = new Set<string>();
  for (const [file, text] of sources) {
    if (text.toLowerCase().includes(base)) files.add(file);
  }
  // A component movie (Inventory Components\ItemCard.swf) is answered by the menus loading it.
  for (const importer of importers) for (const file of filesFor(importer, [])) files.add(file);
  for (const file of [...files]) for (const target of menuImports(file)) files.add(target);
  return [...files].sort();
}

/** Who opens a movie, for the checklist: the files naming it, else the movies loading it. */
function openedBy(movie: string, importers: readonly string[]): string {
  const base = movie.split('\\').pop()?.toLowerCase() ?? movie;
  const direct = [...sources].filter(([, text]) => text.toLowerCase().includes(base));
  if (direct.length > 0 && direct.length <= 3) return direct.map(([file]) => file).join(', ');
  return `loaded by ${importers.slice(0, 4).join(', ')}${importers.length > 4 ? ', ...' : ''}`;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function mentions(files: readonly string[], name: string): string | undefined {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_]|$)`);
  for (const file of files) if (pattern.test(sources.get(file) ?? '')) return file;
  return undefined;
}

const vfs = await Vfs.mount(openGameFolder());
const movies = vfs
  .list('interface')
  .filter((file) => /\.(swf|gfx)$/i.test(file) && !/\\fonts_|gfxfontlib/i.test(file))
  .map((file) => file.slice('interface\\'.length));

type Status = 'done' | 'open' | 'n/a';
interface Row {
  movie: string;
  kind: 'call' | 'callback';
  name: string;
  status: Status;
  where: string;
}
const rows: Row[] = [];
const opened = new Map<string, { files: string[]; status: Status; where: string }>();
const parsed = new Map<string, ReturnType<typeof readSwf>>();
const texts = new Map<string, string>();
for (const movie of movies) {
  const swf = readSwf(await vfs.read(`interface\\${movie}`));
  parsed.set(movie, swf);
  texts.set(movie, new TextDecoder('latin1').decode(swf.bytes).toLowerCase());
}
await vfs.close();

for (const movie of movies) {
  const swf = parsed.get(movie);
  if (!swf) continue;
  const base = movie.split('\\').pop()?.toLowerCase() ?? movie;
  // A menu's exported .gfx is read only where its .swf is missing (interface-files.ts).
  const shadowed = /^exported\\(.+)\.gfx$/.exec(movie)?.[1];
  const importers = movies.filter((other) => other !== movie && texts.get(other)?.includes(base));
  const files = filesFor(movie, importers);
  const away = MOVIES_NOT_ON_PC.get(movie);
  const movieStatus: { status: Status; where: string } =
    shadowed !== undefined && movies.includes(`${shadowed}.swf`)
      ? { status: 'n/a', where: `read only without interface\\${shadowed}.swf, which ships` }
      : away
        ? { status: 'n/a', where: away }
        : files.length > 0
          ? { status: 'done', where: openedBy(movie, importers) }
          : { status: 'open', where: '' };
  opened.set(movie, { files, ...movieStatus });
  if (movieStatus.status === 'n/a') continue;
  const found = delegateCalls(swf);
  const all = [...files, ...COMMON];
  const row = (kind: Row['kind'], name: string, where: string | undefined): Row => {
    const reason = NOT_ON_PC.get(name);
    if (where) return { movie, kind, name, status: 'done', where };
    if (reason) return { movie, kind, name, status: 'n/a', where: reason };
    return { movie, kind, name, status: 'open', where: '' };
  };
  for (const name of [...found.calls].sort()) rows.push(row('call', name, mentions(all, name)));
  for (const name of [...found.callbacks].sort()) {
    const where = mentions([...files, ...GENERIC], name) ?? BY_HAND.get(`${movie}:${name}`);
    rows.push(row('callback', name, where));
  }
}

/** The menus the original opens by name (its interface strings, CommonLibSSE's list). */
const ORIGINAL_MENUS: readonly (readonly [string, string?])[] = [
  ['BarterMenu'],
  ['Book Menu'],
  ['Console'],
  ['Console Native UI Menu', CONSOLE],
  ['ContainerMenu'],
  ['Crafting Menu'],
  ['Creation Club Menu', ONLINE],
  ['Credits Menu'],
  ['Cursor Menu'],
  ['Debug Text Menu'],
  ['Dialogue Menu'],
  ['Fader Menu'],
  ['FavoritesMenu'],
  ['GiftMenu'],
  ['HUD Menu'],
  ['InventoryMenu'],
  ['Journal Menu'],
  ['Kinect Menu', CONSOLE],
  ['LevelUp Menu'],
  ['Loading Menu'],
  ['LoadWaitSpinner'],
  ['Lockpicking Menu'],
  ['MagicMenu'],
  ['Main Menu'],
  ['MapMenu'],
  ['MessageBoxMenu'],
  ['Mist Menu'],
  ['Mod Manager Menu', ONLINE],
  ['Overlay Interaction Menu', NO_MENU],
  ['Overlay Menu', NO_MENU],
  ['Quantity Menu', NO_MENU],
  ['RaceSex Menu'],
  ['SafeZoneMenu', SAFE_ZONE],
  ['Sleep/Wait Menu'],
  ['StatsMenu'],
  ['StreamingInstallMenu', CONSOLE],
  ['TitleSequence Menu'],
  ['Top Menu', NO_MENU],
  ['Training Menu'],
  ['Tutorial Menu'],
  ['TweenMenu'],
];
const stack = sources.get('src/ui/menu-stack.ts') ?? '';
const menuRows = ORIGINAL_MENUS.map(
  ([name, away]): { name: string; status: Status; where: string } => ({
    name,
    status: stack.includes(`'${name}'`) ? 'done' : away ? 'n/a' : 'open',
    where: away ?? '',
  }),
);

const count = (list: readonly { status: Status }[], status: Status): number =>
  list.filter((entry) => entry.status === status).length;
const movieRows = [...opened.values()];
if (MARKDOWN) {
  console.log('| Movie | Status | Opened by / reason |');
  console.log('| ----- | ------ | ------------------ |');
  for (const movie of movies) {
    const entry = opened.get(movie);
    if (!entry) continue;
    console.log(`| ${movie} | ${entry.status} | ${entry.where.replaceAll('|', '/')} |`);
  }
  console.log('\n### Menu names\n');
  console.log('| Menu | Status | Reason |');
  console.log('| ---- | ------ | ------ |');
  for (const row of menuRows) console.log(`| ${row.name} | ${row.status} | ${row.where} |`);
  for (const movie of movies) {
    const own = rows.filter((row) => row.movie === movie);
    if (own.length === 0) continue;
    console.log(`\n### ${movie}\n`);
    console.log('| Kind | Name | Status | Where / reason |');
    console.log('| ---- | ---- | ------ | -------------- |');
    for (const row of own) {
      console.log(`| ${row.kind} | ${row.name} | ${row.status} | ${row.where} |`);
    }
  }
} else {
  const line = (label: string, list: readonly { status: Status }[]): void => {
    console.log(
      `${label}: ${String(list.length)} (done ${String(count(list, 'done'))}, open ${String(count(list, 'open'))}, n/a ${String(count(list, 'n/a'))})`,
    );
  };
  line('movies', movieRows);
  line('calls and callbacks', rows);
  line('menu names', menuRows);
  for (const movie of movies) {
    if (opened.get(movie)?.status === 'open') console.log(`${movie}: opened by no file`);
    const open = rows.filter((row) => row.movie === movie && row.status === 'open');
    if (open.length > 0) {
      console.log(`${movie}: ${open.map((row) => `${row.kind} ${row.name}`).join(', ')}`);
    }
  }
  const missing = menuRows.filter((row) => row.status === 'open').map((row) => row.name);
  console.log(`menu names not in the stack: ${missing.join(', ')}`);
}
