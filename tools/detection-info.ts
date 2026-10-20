// Detection against the real files (docs/ai.md, "Detection"): the game settings detection reads
// (the load order's, else the engine's built-in values), the sound levels the records give
// (IPCT impacts and the footsteps' impacts, WEAP VNAM, MGEF casting), the override package lists
// (NPC_ and quest aliases' SPOR, OCOR, GWOR) and the packages' interrupt overrides, and the
// formula for a case.
//
//   node tools/detection-info.ts --settings     every setting: its value and where it is from
//   node tools/detection-info.ts --records      sound levels, override lists, interrupt overrides
//   node tools/detection-info.ts --level sneak=15 light=40 distance=500 [observer=25]
//        [armour=20] [moving] [running] [standing] [exterior] [unseen] [behind]
//                                               the detection level of one case, term by term

import {
  detectionLevel,
  detectionReach,
  detectionSettingNames,
  readDetectionSettings,
  sightReach,
  SoundLevel,
} from '../src/ai/detection.ts';
import {
  aliasOverrideLists,
  castingSoundLevel,
  weaponSoundLevel,
} from '../src/ai/detection-records.ts';
import { parsePackage } from '../src/ai/package-records.ts';
import { parseNpcCombat } from '../src/ai/race-combat-records.ts';
import { parseImpact, parseImpactDataSet } from '../src/world/impact-records.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const LEVELS = ['loud', 'normal', 'silent', 'very loud'];
const num = (value: number): string => String(Number(value.toPrecision(5)));
const count = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const levels = (map: Map<number, number>): string =>
  [...map]
    .sort(([a], [b]) => a - b)
    .map(([level, n]) => `${LEVELS[level] ?? String(level)} ${String(n)}`)
    .join(', ');

if (args.includes('--level')) {
  const value = (name: string, fallback: number): number => {
    const arg = args.find((entry) => entry.startsWith(`${name}=`));
    return arg === undefined ? fallback : Number(arg.slice(name.length + 1));
  };
  const flag = (name: string): boolean => args.includes(name);
  const vfs = await Vfs.mount(openGameFolder());
  const settings = readDetectionSettings(await GameSettings.read(await RecordDatabase.open(vfs)));
  const exterior = flag('exterior');
  const reach = detectionReach(settings, exterior);
  const distance = value('distance', 500);
  const seen =
    !flag('unseen') &&
    distance < sightReach(settings, flag('behind') ? Math.PI : 0, reach, exterior);
  const result = detectionLevel(settings, {
    observer: {
      skill: value('observer', 25),
      sleeping: false,
      alerted: false,
      combatTarget: false,
      blindness: 0,
      nightEye: false,
    },
    target: {
      moving: flag('moving') || flag('running'),
      running: flag('running'),
      sneaking: !flag('standing'),
      inCombat: false,
      swimming: false,
      skill: value('sneak', 15),
      armourWeight: value('armour', 0),
      noiseMult: 1,
      actionSound: 0,
      light: value('light', 40),
      size: 1,
      invisible: false,
    },
    distance,
    reach,
    exterior,
    lineOfSight: !flag('unseen'),
    seen,
  });
  const state =
    result.level > 0 ? 'detected' : result.level > settings.noticeMin ? 'noticed' : 'unseen';
  console.log(
    `reach ${num(reach)} · attenuation ${result.attenuation.toFixed(3)} · sound ${result.sound.toFixed(2)} · ` +
      `visual ${result.visual.toFixed(2)} · skills ${result.skill.toFixed(2)}`,
  );
  console.log(`level ${result.level.toFixed(2)}: ${state}`);
} else if (args.includes('--settings')) {
  const vfs = await Vfs.mount(openGameFolder());
  const settings = await GameSettings.read(await RecordDatabase.open(vfs));
  for (const [gmst, builtIn] of detectionSettingNames()) {
    const stored = settings.number(gmst);
    console.log(
      `  ${gmst.padEnd(42)} ${num(stored ?? builtIn).padStart(8)}  ${stored === undefined ? 'built in' : `load order (built in ${String(builtIn)})`}`,
    );
  }
} else if (args.includes('--records')) {
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  // Impacts, and those the footsteps sound.
  const impactLevels = new Map<number, number>();
  const impactLevel = new Map<number, number>();
  for (const formId of db.formIdsOfType('IPCT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const { soundLevel } = parseImpact(record);
    impactLevel.set(formId, soundLevel);
    impactLevels.set(soundLevel, (impactLevels.get(soundLevel) ?? 0) + 1);
  }
  console.log(`IPCT sound levels: ${levels(impactLevels)}`);
  const footsteps = new Map<number, number>();
  for (const formId of db.formIdsOfType('FSTP')) {
    const record = await db.get(formId);
    const data = record?.fields.first('DATA');
    if (!record || !data || data.length < 4) continue;
    const set = await db.get(record.formIdAt(data, 0));
    if (!set) continue;
    for (const impact of parseImpactDataSet(set).impacts.values()) {
      const level = impactLevel.get(impact) ?? SoundLevel.normal;
      footsteps.set(level, (footsteps.get(level) ?? 0) + 1);
    }
  }
  console.log(`footsteps' impacts: ${levels(footsteps)}`);
  const weapons = new Map<number, number>();
  for (const formId of db.formIdsOfType('WEAP')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const level = weaponSoundLevel(record);
    weapons.set(level, (weapons.get(level) ?? 0) + 1);
  }
  console.log(`WEAP VNAM: ${levels(weapons)}`);
  const effects = new Map<number, number>();
  for (const formId of db.formIdsOfType('MGEF')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const level = castingSoundLevel(record);
    effects.set(level, (effects.get(level) ?? 0) + 1);
  }
  console.log(`MGEF casting: ${levels(effects)}`);
  // Override package lists.
  const lists = new Map<string, number>();
  const named: string[] = [];
  for (const formId of db.formIdsOfType('NPC_')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const { overridePackages } = parseNpcCombat(record);
    for (const [kind, list] of Object.entries(overridePackages) as [string, number | undefined][]) {
      if (list === undefined) continue;
      count(lists, `NPC_ ${kind}`);
      if (kind !== 'combat')
        named.push(`${record.editorId ?? '?'} ${kind}: ${(await db.get(list))?.editorId ?? '?'}`);
    }
  }
  for (const formId of db.formIdsOfType('QUST')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    for (const [alias, aliasLists] of aliasOverrideLists(record)) {
      for (const [kind, list] of Object.entries(aliasLists) as [string, number | undefined][]) {
        if (list === undefined) continue;
        count(lists, `alias ${kind}`);
        if (kind !== 'combat') {
          named.push(
            `${record.editorId ?? '?'} alias ${String(alias)} ${kind}: ${(await db.get(list))?.editorId ?? '?'}`,
          );
        }
      }
    }
  }
  console.log(`override lists: ${[...lists].map(([key, n]) => `${key} ${String(n)}`).join(', ')}`);
  for (const line of named) console.log(`  ${line}`);
  const overrides = new Map<string, number>();
  for (const formId of db.formIdsOfType('PACK')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const pack = parsePackage(record);
    if (pack.interruptOverride !== 0) count(overrides, String(pack.interruptOverride));
  }
  console.log(
    `packages by interrupt override (1 spectator, 2 observe dead, 3 guard warn, 4 combat): ` +
      [...overrides].map(([key, n]) => `${key}: ${String(n)}`).join(', '),
  );
} else {
  console.log('usage: node tools/detection-info.ts --settings | --records | --level [...]');
}
