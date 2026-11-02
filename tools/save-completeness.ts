// The saves' completeness sweep (docs/completeness/saves.md): what the original's saves hold
// against what the import applies, and what the running game holds against what our own save
// keeps.
//
// The .ess part reads every original save in Documents\My Games\Skyrim Special Edition\Saves
// (none is in the repo; the part is skipped without them or without game data) and imports
// each: every change form type and change flag the saves use is done when no save's import
// lists it as not imported; every global data table by the import's own list of what it
// applies (GLOBAL_DATA below says what each table does, and the import must not skip it).
//
// The own-save part reads the runtime's stateful classes (src/scripting/runtime): every
// private field that is not a record cache (a Promise of a record, settings read once) is done
// when its class's save method names it, or when FIELDS says why it need not be kept (derived
// from what is saved, or gone within a frame); else open. Every GameState field is saved
// (gameStateData writes them all), and the runtime's public switches by SAVED_RUNTIME_FIELDS.
//
//   node tools/save-completeness.ts           the counts and every open item
//   node tools/save-completeness.ts --all     every item with its status

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readChangeForm } from '../src/formats/ess/change-forms.ts';
import { changeFormTypeName, readEss } from '../src/formats/ess/ess.ts';
import { GLOBAL_DATA_TYPES, refIdResolver } from '../src/formats/ess/global-data.ts';
import { essWorld, flagName, importEss } from '../src/save/ess-import.ts';
import { SAVED_RUNTIME_FIELDS } from '../src/scripting/runtime/runtime-save.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const all = process.argv.includes('--all');
const SAVES = path.join(homedir(), 'Documents', 'My Games', 'Skyrim Special Edition', 'Saves');
const ROOT = path.join(import.meta.dirname, '..');

interface Item {
  readonly part: string;
  readonly name: string;
  readonly done: boolean;
  readonly note: string;
}
const items: Item[] = [];
const add = (part: string, name: string, done: boolean, note: string): void => {
  items.push({ part, name, done, note });
};

/**
 * The global data tables: whether the import applies each, and what of it (an item is done
 * only when all it holds that the game uses is applied).
 */
const GLOBAL_DATA: Readonly<Record<number, readonly [boolean, string]>> = {
  0: [true, 'misc stats into the runtime stats'],
  1: [true, "the player's place when their change form has none"],
  2: [
    true,
    'TES: the dead counts by actor base (GetDeadCount); its cell table and last list empty in every save read',
  ],
  3: [true, 'global variables, GameDaysPassed sets the clock'],
  4: [false, 'created objects: made potions, poisons, enchantments (none in the saves read)'],
  5: [true, 'effects: image space modifiers running: empty in every save read'],
  6: [true, 'weather: the current, outgoing, override and default weathers, when it came'],
  7: [
    true,
    'audio: the music types in play (the location type follows from the place; no track kept)',
  ],
  8: [false, 'sky cells (not applied)'],
  100: [false, 'process lists: crimes being reported (not applied)'],
  101: [
    true,
    "combat: each group member's fight (its target); a group's search is logged (none read)",
  ],
  102: [
    false,
    'interface: help events done, last used applied; the help messages shown (meaning: TODO(M13))',
  ],
  103: [true, "actor causes: the actor each reference's ActorCause extra blames"],
  104: [false, 'unknown 104'],
  105: [false, 'detection manager (not applied)'],
  106: [false, 'location metadata (not applied)'],
  107: [
    true,
    'quest static data: the quests running (as their QUST change forms); run data lists logged',
  ],
  108: [false, 'story teller (not applied)'],
  109: [true, 'magic favorites and their hotkeys'],
  110: [false, "player controls: the controls' state (its fields not known)"],
  111: [true, 'the story event manager: events waiting, told again'],
  112: [true, "ingredient shared: the ingredients' known effects: empty in every save read"],
  113: [false, 'menu controls (not applied)'],
  114: [false, 'menu topic manager (not applied)'],
  1000: [
    true,
    'temp effects: the decals on the world into the decal store (typed effects: none read, logged)',
  ],
  1001: [
    true,
    'Papyrus: instances, stacks, messages, waits, suspended calls, registrations (LOS: none read)',
  ],
  1002: [true, 'anim objects: what actors hold, put on as each is placed'],
  1003: [false, 'timer (not applied)'],
  1004: [true, 'synchronized animations: paired animations under way: empty in every save read'],
  1005: [true, 'main: empty in every save read'],
};

async function essPart(): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(SAVES).filter((name) => name.toLowerCase().endsWith('.ess'));
  } catch {
    // no saves folder
  }
  if (names.length === 0) {
    console.log(`No .ess saves in ${SAVES}: the .ess part is skipped.`);
    return;
  }
  const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()), 'english');
  /** Seen change form types and flags ("REFR: moved"), with counts; what any import skipped. */
  const seen = new Map<string, number>();
  const skipped = new Set<string>();
  const tables = new Set<number>();
  try {
    for (const name of names) {
      const ess = readEss(new Uint8Array(readFileSync(path.join(SAVES, name))));
      const resolve = refIdResolver(ess.formIds);
      for (const table of [ess.globalData1, ess.globalData2, ess.globalData3]) {
        for (const entry of table) tables.add(entry.type);
      }
      for (const entry of ess.changeForms) {
        const type = changeFormTypeName(entry.type);
        const flags = readChangeForm(entry, resolve).changeFlags;
        for (let bit = 0; bit < 32; bit++) {
          if (flags & ((1 << bit) >>> 0)) {
            const key = `${type}: bit ${String(bit)}`;
            seen.set(key, (seen.get(key) ?? 0) + 1);
          }
        }
      }
      const imported = importEss(ess, await essWorld(db, ess), { name, number: 1, now: 0 });
      for (const line of imported.skipped) skipped.add(line.replace(/ x \d+$/, ''));
    }
  } finally {
    await db.close();
  }
  add('ess header', 'header (name, level, race, location, date)', true, 'our save header');
  add(
    'ess header',
    'screenshot',
    true,
    "the import's thumbnail (save-screenshot.ts essScreenshot)",
  );
  add('ess header', 'plugins', true, 'form ids moved to our load order by name');
  add('ess header', 'light plugins', true, 'form ids moved to our load order by name');
  for (const [type, name] of Object.entries(GLOBAL_DATA_TYPES)) {
    const id = Number(type);
    const [done, note] = GLOBAL_DATA[id] ?? [false, 'not listed'];
    const skippedHere = skipped.has(`global data ${type}`);
    const inSaves = tables.has(id) ? '' : ' (not in the saves read)';
    add('ess global data', `${type} ${name}`, done && !skippedHere, note + inSaves);
  }
  // The change forms: each type's flags by the names the import logs them by.
  for (const [key, count] of [...seen].sort()) {
    const [type = '', bit = ''] = key.split(': bit ');
    const line = `${type}: ${flagName(type, (1 << Number(bit)) >>> 0)}`;
    add('ess change forms', line, !skipped.has(line), `${String(count)} forms`);
  }
  for (const line of skipped) {
    if (
      line.includes('TODO') ||
      line.startsWith('papyrus') ||
      line.includes('unreadable') ||
      line.includes(' not applied')
    ) {
      add('ess other', line, false, 'listed by the import');
    }
  }
}

/**
 * The runtime's fields that need no save, or that are open, with why. Record caches (a Promise
 * of a record, the settings) are found by their types and need no entry.
 */
const FIELDS: Readonly<Record<string, readonly ['derived' | 'transient' | 'open', string]>> = {
  'actor-engine#deferred': ['transient', 'a kill decided within the frame'],
  'actor-engine#relationRecords': ['derived', 'relationship records read'],
  'actor-engine#aliasFactionSets': ['derived', "aliases' faction lists read"],
  'actor-locations#tracked': ['derived', 'tracked again as actors load'],
  'alias-fill#reserved': ['derived', "from the quests' alias fills on load"],
  'casting-engine#readyAtOnce': ['transient', 'told the next frame'],
  'casting-engine#wards': ['transient', 'a ward hit lasts a second'],
  'casting-engine#clock': ['transient', 'the wards clock'],
  'casting-engine#absorbShown': ['transient', "Spell Absorption's art"],
  'casting-engine#toldCasts': ['transient', 'told this frame'],
  'casting-engine#casting': ['derived', 'settings read'],
  'cell-reset#told': ['transient', 'told as their cells attach'],
  'crafting-engine#defaults': ['derived', 'default objects read'],
  'crime-engine#listeners': ['transient', 'code'],
  'crime-engine#names': ['derived', 'names read'],
  'destruction-engine#selfDamaging': ['derived', 'found again as objects load'],
  'destruction-engine#restored': ['transient', 'the load itself'],
  'dialogue-engine#bySubtype': ['derived', 'the dialogue index'],
  'dialogue-engine#voiceLists': ['derived', 'voice type lists read'],
  'equipment-engine#described': ['derived', 'items read'],
  'equipment-engine#items': ['derived', 'items read'],
  'equipment-engine#races': ['derived', 'races read'],
  'equipment-engine#describe': ['derived', 'code'],
  'equipment-engine#replaced': ['transient', 'an equip under way'],
  'event-hub#listeners': ['transient', 'code'],
  'forms#createdRecords': ['derived', "from GameState's created forms"],
  'harvest-engine#sinceSweep': ['transient', 'a sweep timer'],
  'harvest-engine#sweeping': ['transient', 'a sweep under way'],
  'hazard-engine#hitting': ['transient', 'within the frame'],
  'magic-engine#effects': ['derived', 'effects read'],
  'magic-engine#prepared': ['derived', 'prepared again as actors load'],
  'magic-engine#finishing': ['transient', "OnEffectFinish's scripts running"],
  'magic-engine#scripts': ['transient', 'script work in order'],
  'magic-engine#ending': ['transient', 'within the frame'],
  'magic-engine#changes': ['transient', 'within the frame'],
  'magic-engine#pulseWait': ['transient', 'the second between pulses'],
  'magic-engine#pulsing': ['transient', 'within the frame'],
  'magic-engine#appearing': ['transient', 'a summon taken by the stage as it is first shown'],
  'magic-engine#cloakWait': ['transient', 'the cloak interval'],
  'magic-engine#cloaking': ['transient', 'within the frame'],
  'magic-engine#settingsRead': ['derived', 'settings read'],
  'progression-engine#autoCalc': ['derived', 'computed from records'],
  'progression-engine#seen': ['derived', 'the damage last seen'],
  'progression-engine#stamina': ['derived', 'read again'],
  'progression-engine#pending': ['transient', 'within the frame'],
  'progression-engine#busy': ['transient', 'within the frame'],
  'progression-engine#weight': ['derived', 'computed again'],
  'runtime#natives': ['derived', 'code'],
  'runtime#aliasesOf': ['derived', "from the quests' alias fills on load"],
  'runtime#holding': ['derived', "from the quests' alias fills on load"],
  'runtime#updates': ['derived', 'from the update registrations'],
  'runtime#updateToken': ['derived', 'from the update registrations'],
  'runtime#aliasNames': ['derived', 'alias names read'],
  'runtime#animationWaiters': ['transient', "threads waiting (saved as the threads' waits)"],
  'runtime#clockGlobals': ['derived', 'found on load'],
  'runtime#index': ['derived', 'the persistent index'],
  'runtime#keywordCache': ['derived', 'keywords read'],
  'runtime#activateChildren': ['derived', 'records read'],
  'runtime#playerActed': ['transient', "the player's last action, for reactions this second"],
  'runtime#dialogue': ['derived', 'made on load (its saveData is kept)'],
  'runtime#warn': ['transient', 'code'],
  'runtime#gameLog': ['transient', 'code'],
  'scene-host#looking': ['derived', 'scenes turn heads again as they go on'],
  'scene-host#again': ['derived', 'settings read'],
  'scene-host#linger': ['derived', 'settings read'],
  'story-manager#restored': ['transient', 'the load itself'],
  'story-manager#processing': ['transient', 'within the frame'],
  'story-manager#queue': ['transient', 'within the frame'],
  'trigger-volumes#volumes': ['derived', 'rebuilt as cells load (who is inside: entered again)'],
  'warmth-engine#keywords': ['derived', 'keywords read'],
};

/** The runtime's public switches a save need not keep, with why. */
const PUBLIC_FIELDS: Readonly<Record<string, string>> = {
  gridsToLoad: 'INI setting',
  startingNewGame: 'the new game itself',
  clockChanged: 'within the frame',
  world: 'code',
  retired: 'the session',
  inMenuMode: 'menus are closed as a save loads',
  menuOpen: 'code',
  dialogueSpeaker: 'no conversation goes on across a load',
  frameRate: 'measured',
  log: 'code',
  sunGazeModifier: 'set again by the effect that sets it',
  cloakInterval: 'INI setting',
  delayMs: 'game setting',
};

function ownPart(): void {
  const dir = path.join(ROOT, 'src', 'scripting', 'runtime');
  const field = /^ {2}(readonly )?#([a-zA-Z]+)(?:: ([^=;]+))?(?: = (.*)|;)/;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const text = readFileSync(path.join(dir, file), 'utf8');
    const base = file.replace(/\.ts$/, '');
    // The save methods' text: saveData, save, saveThreads (what they name is kept).
    const saves = [
      ...text.matchAll(/\n {2}(?:async )?(saveData|save)\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/g),
    ]
      .map((match) => match[2] ?? '')
      .join('\n');
    for (const line of text.split('\n')) {
      const match = field.exec(line);
      if (!match) continue;
      const name = match[2] ?? '';
      const type = `${match[3] ?? ''} ${match[4] ?? ''}`;
      if (name === 'runtime' || name === 'events' || name === 'now') continue;
      const key = `${base}#${name}`;
      if (saves.includes(`#${name}`)) {
        add('own runtime', key, true, 'its save method keeps it');
        continue;
      }
      if (/Promise<|Record\b|Settings|settings/.test(type) && !FIELDS[key]) {
        add('own runtime', key, true, 'a record or settings cache (read again)');
        continue;
      }
      const known = FIELDS[key];
      if (!known) add('own runtime', key, false, 'not classified');
      else add('own runtime', key, known[0] !== 'open', `${known[0]}: ${known[1]}`);
    }
    if (base !== 'runtime') continue;
    // ScriptRuntime's public fields that are not readonly.
    const saved = new Set<string>(SAVED_RUNTIME_FIELDS);
    for (const match of text.matchAll(/\n {2}([a-zA-Z]+)(?:: [^=;\n]+)? = [^\n]+;/g)) {
      const name = match[1] ?? '';
      if (saved.has(name)) add('own runtime', `runtime.${name}`, true, 'SAVED_RUNTIME_FIELDS');
      else if (PUBLIC_FIELDS[name])
        add('own runtime', `runtime.${name}`, true, PUBLIC_FIELDS[name]);
      else add('own runtime', `runtime.${name}`, false, 'not classified');
    }
  }
}

await essPart();
ownPart();

const parts = [...new Set(items.map((item) => item.part))];
console.log('| Part | Items | Done | Open |');
console.log('| ---- | ----: | ---: | ---: |');
let total = 0;
let done = 0;
for (const part of parts) {
  const these = items.filter((item) => item.part === part);
  const n = these.filter((item) => item.done).length;
  total += these.length;
  done += n;
  console.log(`| ${part} | ${String(these.length)} | ${String(n)} | ${String(these.length - n)} |`);
}
console.log(`| Total | ${String(total)} | ${String(done)} | ${String(total - done)} |`);
console.log('');
for (const item of items) {
  if (all || !item.done) {
    console.log(`${item.done ? 'done' : 'open'}  ${item.part}: ${item.name} (${item.note})`);
  }
}
