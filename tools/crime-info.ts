// Crime against the real files (docs/gameplay.md, "Crime and factions"): the crime factions
// (FACT with Track Crime or a jail): their values (CRVA, or the defaults), jails (the exterior
// jail marker, the interior prison marker the crime engine finds, the follower wait marker),
// evidence and stolen goods chests, jail outfits and shared crime groups; the game settings
// crime reads; a pickpocket chance table; the fences (vendors that buy stolen items) and the
// guards' crime dialogue.
//
//   node tools/crime-info.ts                   the holds' crime factions (those with a jail)
//   node tools/crime-info.ts --all             every crime faction
//   node tools/crime-info.ts --settings        the game settings crime reads
//   node tools/crime-info.ts --pickpocket      the pickpocket chance by skill, weight and value
//   node tools/crime-info.ts --fences          the vendor factions that buy stolen items
//   node tools/crime-info.ts --guards          guard classes and IsGuardFaction's members count

import {
  CrimeFlag,
  crimeSettingNames,
  crimeValues,
  pickpocketChance,
  readCrimeSettings,
  type CrimeValues,
} from '../src/gameplay/crime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { parseFaction, parseNpcStats } from '../src/world/actor-stats-records.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const gmst = await GameSettings.read(db);
const settings = readCrimeSettings(gmst);
const args = process.argv.slice(2);
const hex = (id: number | undefined): string =>
  id === undefined ? '-' : id.toString(16).toUpperCase().padStart(8, '0');
const name = async (id: number | undefined): Promise<string> => {
  if (id === undefined) return '-';
  const record = await db.get(id);
  return `${record?.editorId ?? '?'} [${hex(id)}]`;
};
const cellName = async (reference: number | undefined): Promise<string> => {
  const cell = reference === undefined ? undefined : db.cellOfReference(reference);
  return cell === undefined ? '-' : name(cell);
};

function newRuntime(): ScriptRuntime {
  const library = new ScriptLibrary(async (script) => {
    const path = `scripts\\${script}.pex`;
    return vfs.has(path) ? vfs.read(path) : undefined;
  });
  return new ScriptRuntime(db, library);
}

const describeValues = (values: CrimeValues): string =>
  [
    values.arrest ? 'arrest' : 'no arrest',
    values.attackOnSight ? 'attack on sight' : 'no attack on sight',
    `murder ${String(values.murder)}`,
    `assault ${String(values.assault)}`,
    `trespass ${String(values.trespass)}`,
    `pickpocket ${String(values.pickpocket)}`,
    `steal ×${String(values.stealMult)}`,
    `escape ${String(values.escape)}`,
    `werewolf ${String(values.werewolf)}`,
  ].join(', ');

async function factions(all: boolean): Promise<void> {
  const runtime = newRuntime();
  let count = 0;
  let jails = 0;
  let found = 0;
  for (const formId of db.formIdsOfType('FACT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const faction = parseFaction(record);
    const crime = faction.crime;
    if (!crime && (faction.flags & CrimeFlag.trackCrime) === 0) continue;
    if (!all && crime?.exteriorJailMarker === undefined) continue;
    count++;
    const values = crimeValues(faction.flags, crime, settings);
    const flags = Object.entries(CrimeFlag)
      .filter(([, bit]) => (faction.flags & bit) !== 0)
      .map(([flag]) => flag);
    console.log(`${record.editorId ?? '?'} [${hex(formId)}] "${record.text('FULL') ?? ''}"`);
    console.log(`  flags: ${flags.join(' ') || 'none'}`);
    console.log(`  ${describeValues(values)}`);
    if (!crime) continue;
    if (crime.exteriorJailMarker !== undefined) jails++;
    const marker = await runtime.crime.jailMarker(formId);
    if (marker !== undefined) found++;
    console.log(
      `  exterior jail marker ${await name(crime.exteriorJailMarker)} in ${await cellName(crime.exteriorJailMarker)}`,
    );
    console.log(`  prison marker (jail) ${await name(marker)} in ${await cellName(marker)}`);
    console.log(
      `  follower wait marker ${await name(crime.followerWaitMarker)}; evidence chest ${await name(crime.playerInventoryContainer)} in ${await cellName(crime.playerInventoryContainer)}; stolen goods ${await name(crime.stolenGoodsContainer)} in ${await cellName(crime.stolenGoodsContainer)}`,
    );
    const group =
      crime.sharedCrimeFactions === undefined
        ? []
        : await runtime.formList(crime.sharedCrimeFactions);
    console.log(
      `  jail outfit ${await name(crime.jailOutfit)}; shared crime group ${await name(crime.sharedCrimeFactions)} (${String(group.length)} factions)`,
    );
  }
  console.log(
    `\n${String(count)} crime factions; ${String(jails)} with an exterior jail marker, ${String(found)} with a prison marker found`,
  );
}

function settingsTable(): void {
  for (const [setting, builtIn] of crimeSettingNames()) {
    const stored = gmst.number(setting);
    console.log(
      `  ${setting.padEnd(30)} ${stored === undefined ? `${String(builtIn)} (engine)` : `${String(Number(stored.toPrecision(6)))} (load order)`}`,
    );
  }
}

function pickpocketTable(): void {
  const skills = [15, 25, 50, 75, 100];
  const items: [string, number, number][] = [
    ['a coin (1 gold, 0)', 0, 1],
    ['50 gold', 0, 50],
    ['a sweetroll (2 gold, 0.5)', 0.5, 2],
    ['a soul gem (60 gold, 0.5)', 0.5, 60],
    ['an amulet (200 gold, 1)', 1, 200],
    ['an iron sword (25 gold, 9)', 9, 25],
    ['a key (0 gold, 0)', 0, 0],
  ];
  console.log(`Pickpocket chance (%) against a target of Pickpocket 15:\n`);
  console.log(
    `  ${'item'.padEnd(30)}${skills.map((skill) => `skill ${String(skill)}`.padStart(10)).join('')}`,
  );
  for (const [label, weight, value] of items) {
    const row = skills.map((skill) =>
      String(pickpocketChance({ skill, targetSkill: 15, weight, value }, settings)).padStart(10),
    );
    console.log(`  ${label.padEnd(30)}${row.join('')}`);
  }
}

async function fences(): Promise<void> {
  for (const formId of db.formIdsOfType('FACT')) {
    const record = await db.get(formId);
    const vendor = record && parseFaction(record).vendor;
    if (!record || !vendor?.onlyStolen) continue;
    const members: string[] = [];
    for (const npc of db.formIdsOfType('NPC_')) {
      const stats = await db.get(npc);
      if (stats && parseNpcStats(stats).factions.has(formId))
        members.push(stats.editorId ?? hex(npc));
    }
    console.log(
      `${record.editorId ?? '?'} [${hex(formId)}]: chest ${await name(vendor.chest)}, hours ${String(vendor.startHour)}-${String(vendor.endHour)}; ${members.join(', ') || 'no NPC_ in it'}`,
    );
  }
}

async function guards(): Promise<void> {
  const classes: string[] = [];
  for (const formId of db.formIdsOfType('CLAS')) {
    const data = (await db.get(formId))?.fields.first('DATA');
    if (data && data.length >= 36 && ((data[35] ?? 0) & 0x1) !== 0)
      classes.push((await db.get(formId))?.editorId ?? hex(formId));
  }
  console.log(`Guard classes (CLAS DATA flag Guard): ${classes.join(', ') || 'none'}`);
  const isGuard = db.formIdOf('Skyrim.esm', 0x86eee);
  let members = 0;
  for (const npc of db.formIdsOfType('NPC_')) {
    const record = await db.get(npc);
    if (record && isGuard !== undefined && parseNpcStats(record).factions.has(isGuard)) members++;
  }
  console.log(`IsGuardFaction's NPC_ members: ${String(members)}`);
}

if (args.includes('--settings')) settingsTable();
else if (args.includes('--pickpocket')) pickpocketTable();
else if (args.includes('--fences')) await fences();
else if (args.includes('--guards')) await guards();
else await factions(args.includes('--all'));
