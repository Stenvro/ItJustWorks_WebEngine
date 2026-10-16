// Game settings (GMST) of the load order with their values (src/world/game-settings.ts): by
// editor id prefix, or the families the AI reads (combat, sneaking, detection, ...). Settings
// the load order does not have keep the engine's built-in values and are not listed.
//
//   node tools/gmst-info.ts --prefix fCombat     every setting whose editor id starts so
//                                                (case-insensitive), its value and plugin
//   node tools/gmst-info.ts --ai [--counts]      the AI families of number settings (fCombat*,
//                                                iCombat*, fSneak*, fAI*, ...): counts, then
//                                                each setting (not with --counts)

import { gameSettingValue } from '../src/world/game-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

/**
 * The AI's families: a number setting belongs to one when its editor id continues its type
 * letter with the family's stem as a word (fCombatDistance, iCombatDismemberPartChance:
 * Combat; not fActorsX for Actor).
 */
const AI_FAMILIES = [
  'Combat',
  'Sneak',
  'Detection',
  'PlayerDetection',
  'AI',
  'Avoid',
  'Block',
  'Stagger',
  'PowerAttack',
  'Stamina',
  'Shield',
  'Bow',
  'Bleedout',
  'Knockback',
  'Knockdown',
  'Death',
  'Flee',
  'Confidence',
  'Guard',
  'Bump',
  'Follow',
  'Summoned',
  'Sandbox',
  'Furniture',
  'HeadTrack',
  'Actor',
  'Move',
] as const;

interface Setting {
  readonly editorId: string;
  readonly value: number | string;
  readonly plugin: string;
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const settings: Setting[] = [];
await db.scan(
  ['GMST'],
  () => true,
  (record) => {
    const value = record.deleted ? undefined : gameSettingValue(record);
    if (record.editorId && value !== undefined)
      settings.push({ editorId: record.editorId, value, plugin: record.plugin.entry.name });
  },
);
settings.sort((a, b) => a.editorId.localeCompare(b.editorId, 'en'));

const show = (value: number | string): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(Number(value.toPrecision(7)));
const line = (setting: Setting): string =>
  `  ${setting.editorId.padEnd(44)} ${show(setting.value).padStart(12)}` +
  (setting.plugin === 'Skyrim.esm' ? '' : `  (${setting.plugin})`);

const prefix = option('--prefix');
if (prefix !== undefined) {
  const wanted = prefix.toLowerCase();
  const found = settings.filter((setting) => setting.editorId.toLowerCase().startsWith(wanted));
  console.log(`${String(found.length)} settings start with ${prefix}`);
  for (const setting of found) console.log(line(setting));
} else if (args.includes('--ai')) {
  const family = (editorId: string): string | undefined =>
    AI_FAMILIES.find((stem) => {
      const rest = editorId.slice(1);
      const next = rest[stem.length];
      return rest.startsWith(stem) && (next === undefined || !/[a-z]/.test(next));
    });
  const byFamily = new Map<string, Setting[]>();
  for (const setting of settings) {
    if (typeof setting.value === 'string') continue;
    const stem = family(setting.editorId);
    if (stem !== undefined) byFamily.set(stem, [...(byFamily.get(stem) ?? []), setting]);
  }
  let total = 0;
  for (const stem of AI_FAMILIES) {
    const list = byFamily.get(stem) ?? [];
    total += list.length;
    const types = new Map<string, number>();
    for (const setting of list) {
      const type = setting.editorId[0] ?? '?';
      types.set(type, (types.get(type) ?? 0) + 1);
    }
    console.log(
      `${stem.padEnd(16)} ${String(list.length).padStart(4)}  ${[...types]
        .map(([type, count]) => `${type}${stem} ${String(count)}`)
        .join(', ')}`,
    );
  }
  const numbers = settings.filter((setting) => typeof setting.value === 'number').length;
  console.log(
    `${String(total)} of the load order's ${String(numbers)} number settings ` +
      `(${String(settings.length)} with strings) in the AI families`,
  );
  if (!args.includes('--counts')) {
    for (const stem of AI_FAMILIES) {
      const list = byFamily.get(stem) ?? [];
      if (list.length === 0) continue;
      console.log(`\n${stem}:`);
      for (const setting of list) console.log(line(setting));
    }
  }
} else {
  console.log('usage: node tools/gmst-info.ts --prefix <editor id start> | --ai [--counts]');
}
await db.close();
await vfs.close();
