// The AI and combat areas' completeness sweep (docs/completeness/ai.md, combat.md): what the load
// order's records use of the AI and of combat, each against the engine code that reads it.
//
// AI: the packages (their procedures, PKDT flags, interrupt flags and overrides, the procedure
// trees' branch types, the package data's value types, location and target types, schedules,
// conditions, idles, events), the NPCs' AI data (AIDT) and override package lists, the races' AI
// flags, the idle markers, the furniture markers, the navmeshes (triangle flags, edge link
// types, doors, cover) and the AI's game settings.
// Combat: the combat styles' fields (CSTY), the attack data (ATKD / ATKE on races and NPCs), the
// races' combat fields and flags, the combat behaviour tree's actions and the combat game
// settings.
//
// An item is done when the engine reads it: a field or flag is referenced by name outside the
// file that parses it (that file is where it lives), a procedure has a runner, a condition
// function is valued (tests/condition-audit.int.test.ts), a game setting is read by one of the
// settings readers or named in the code, or INERT says why the original reads nothing there
// either. The counts are the records (or triangles, or attacks) that use the item.
//
//   node tools/ai-combat-completeness.ts           the counts and every open item
//   node tools/ai-combat-completeness.ts --all     every item with its status (the docs' tables)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readAiSettings } from '../src/ai/ai-settings.ts';
import { readAmbientIdleSettings } from '../src/ai/ambient-idles.ts';
import { readCombatAiSettings } from '../src/ai/combat-ai.ts';
import { readCombatDialogueSettings } from '../src/ai/combat-dialogue.ts';
import { readCombatGroupSettings } from '../src/ai/combat-groups.ts';
import { readCombatMovementSettings } from '../src/ai/combat-movement.ts';
import { CombatStyleFlag, parseCombatStyle } from '../src/ai/combat-style-records.ts';
import { readCombatSubtreeSettings } from '../src/ai/combat-subtrees.ts';
import { COMBAT_ACTIONS } from '../src/ai/combat-tree.ts';
import { readDetectionSettings } from '../src/ai/detection.ts';
import { readFlightSettings } from '../src/ai/flight.ts';
import { IdleCollectionFlag, parseIdleMarker } from '../src/ai/idle-records.ts';
import {
  InterruptFlag,
  LocationType,
  PackageFlag,
  parsePackage,
  TargetType,
  type PackageRecord,
} from '../src/ai/package-records.ts';
import { PROCEDURES } from '../src/ai/procedure-runs.ts';
import {
  AttackFlag,
  parseNpcCombat,
  parseRaceCombat,
  RaceAiFlag,
  RaceFlag2,
  type AttackData,
} from '../src/ai/race-combat-records.ts';
import { talkSettings } from '../src/ai/talk.ts';
import { readCombatMusicSettings } from '../src/audio/combat-music.ts';
import { readCombatSettings } from '../src/gameplay/combat/combat-settings.ts';
import { readPlayerDeathSettings } from '../src/gameplay/combat/player-death.ts';
import { readCrimeSettings } from '../src/gameplay/crime.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { parseNpcStats } from '../src/world/actor-stats-records.ts';
import {
  FurnitureEntry,
  FurnitureFlag,
  FurnitureMarkerFlag,
  FurnitureMarkerType,
  parseFurniture,
} from '../src/world/furniture-records.ts';
import { NavmeshFlag, NavmeshLinkType, parseNavmesh } from '../src/world/navmesh.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { conditionUsage, NOT_YET } from './condition-usage.ts';
import { openGameFolder } from './gamedata-path.ts';
import { packageCensus } from './package-census.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export type Area = 'ai' | 'combat';

export interface CompletenessItem {
  readonly area: Area;
  /** The checklist's section ("Procedures", "Combat style", ...). */
  readonly part: string;
  readonly name: string;
  /** Records (triangles, attacks) of the load order using it. */
  readonly uses: number;
  readonly done: boolean;
  /** Where the engine reads it (a source file), or why it is open or inert. */
  readonly where: string;
}

/**
 * Game settings the plugins define that the original reads nothing from either (docs/ai.md,
 * "The engine's built-in game settings"; the earlier games' leftovers), with the reason.
 */
export const INERT: ReadonlyMap<string, string> = new Map([
  ['fCombatItemRestoreTimer', 'never read: restoring follows the style (docs/ai.md)'],
  ['iAICombatRestoreHealthPercentage', 'never read: restoring follows the style (docs/ai.md)'],
  ['fCombatSpeakAttackChance', 'never read: the combat dialogue chances are its own'],
  ['fCombatTeammateFollowRadiusMult', 'never read (docs/ai.md)'],
  ['fProjectileInventoryGrenadeFreakoutTime', "an earlier game's grenades; no grenades here"],
  ['fProjectileInventoryGrenadeTimer', "an earlier game's grenades; no grenades here"],
  ['iProjectileMineShooterCanTrigger', "an earlier game's mines; no mines here"],
]);

/**
 * Items the engine reads under another name than the parser's (a second record reader, a
 * runtime field), by "part|name": the pattern that finds the reading code.
 */
const ALIASES: ReadonlyMap<string, RegExp> = new Map([
  ['NPC package lists|defaultPackageList', /\.defaultPackages\b/],
  ['Race AI flags (DATA)|notPushable', /\bRaceFlag\.notPushable\b/],
  ['Race combat (DATA, ATKR)|noKnockdowns', /\bRaceFlag\.noKnockdowns\b/],
  ['Navmesh triangles (NVNM)|door', /\bdoorSpots\(|\.doors\b/],
  ['Navmesh links (NVNM)|cover triangles', /\.cover\s*[!=]==?\s*0|\.cover\s*>>/],
]);

/**
 * Items whose field name is too common to find by itself, by "part|name": the pattern of the
 * code that reads that field and no other of its name.
 */
const PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ['Furniture (FURN)|keyword', /\bmarker\w*\.keyword\b/],
  ['Attack data (ATKD, ATKE)|spell', /\bdata\.spell\b|\battack\.spell\b/],
]);

/** Items done without a reader of their own, by "part|name": why nothing more reads them. */
const EXPLAINED: ReadonlyMap<string, string> = new Map([
  ...(
    [
      ['Package flags (PKDT)', 'legacyLockDoorsAtEnd'],
      ['Package flags (PKDT)', 'legacyLockDoorsAtLocation'],
      ['Package flags (PKDT)', 'legacyUnlockDoorsAtLocation'],
      ['Interrupt flags (PKDT)', 'legacyAvoidRadiation'],
    ] as const
  ).map(([part, name]): [string, string] => [
    `${part}|${name}`,
    "inert: an earlier game's flag kept in the records (src/ai/package-records.ts); this game's references name none there",
  ]),
  [
    'Combat style (CSTY)|dueling',
    'src/shell/actor-combat-ai.ts: the style chooses dueling or flanking (169 styles duel, 19 flank, none both, 9 neither); the tree as observed in the original runs Close Movement (circle, fall back: CSCR) for every style without Flanking, so Dueling is read as not Flanking',
  ],
  [
    'Interrupt override (PKDT)|none',
    'src/shell/actor-senses.ts: the actor runs an override package from the list its situation names (SPOR, OCOR, GWOR, ECOR); the byte only sorts the package into such lists',
  ],
  [
    'Interrupt override (PKDT)|combat',
    'src/shell/actor-combat-ai.ts: the combat override list (ECOR) keeps a fighter to its package place',
  ],
  [
    'Attack data (ATKD, ATKE)|overrideData',
    "src/shell/actor-combat.ts: set on every NPC_ attack (124) and on no race's (2155): it marks an NPC's own attack, which replaces its race's for the event (AttackSet)",
  ],
]);

/** The game setting name patterns of each area (the load order's GMSTs matching them). */
const AI_SETTINGS =
  /^[fiub](AI(?!Shout|UseWeapon|Combat)|Sandbox|Sneak(?!Attack)|Detection|Crime|Guard|Bump|Comment|FurnitureMarker|Track|IdleChatter|RandomScene|Follow|Warning|Jog|ActorDefault|FlyingActor|Evaluate|Escort)/;
const COMBAT_SETTINGS =
  /^[fiub](Combat|AIShout|AIUseWeapon|AICombat|Stagger|Block|Shield|WeaponBash|PowerAttack|Knock|KillCam|Bleedout|Confidence|Flee|Friend|DamageSneak|DeathForce|DeathDrop|Bow|Projectile|Arrow|Mounted|Essential|Concussion)/;

interface Source {
  readonly file: string;
  readonly text: string;
}

/**
 * The engine's sources (src/, without the tests), relative paths with forward slashes, their
 * comments left out (a setting named in a comment is not read); the AI's and the stage's first,
 * so an item is told where those read it before another reader of a field of the same name.
 */
function readSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        out.push({
          file: path.relative(ROOT, full).replaceAll('\\', '/'),
          text: readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        });
    }
  };
  walk(path.join(ROOT, 'src'));
  const rank = (file: string): number =>
    ['src/ai/', 'src/shell/', 'src/gameplay/', 'src/world/'].findIndex((dir) =>
      file.startsWith(dir),
    ) >>> 0;
  return out.sort((a, b) => rank(a.file) - rank(b.file));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The settings the engine's settings readers ask for by name. */
function settingsRead(): Set<string> {
  const names = new Set<string>();
  const record = (name: string): undefined => {
    names.add(name);
    return undefined;
  };
  readAiSettings(record);
  readAmbientIdleSettings(record);
  readCombatAiSettings(record);
  readCombatDialogueSettings(record);
  readCombatGroupSettings(record);
  readCombatMovementSettings(record);
  readCombatSubtreeSettings(record);
  readDetectionSettings({ number: record });
  readFlightSettings(record);
  talkSettings(record);
  readCombatMusicSettings(record);
  readCombatSettings(record);
  readPlayerDeathSettings(record, () => undefined);
  readCrimeSettings({ number: record });
  return names;
}

const flagName = (table: Readonly<Record<string, number>>, bit: number): string | undefined =>
  Object.entries(table).find(([, value]) => value >>> 0 === bit >>> 0)?.[0];

const eachBit = (value: number, use: (bit: number) => void): void => {
  for (let i = 0; i < 32; i++) if ((value & (1 << i)) !== 0) use((1 << i) >>> 0);
};

const add = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

/** Sweeps the load order. `navmeshes`: also read every NAVM (slow: about a minute). */
export async function aiCombatCompleteness(
  db: RecordDatabase,
  navmeshes = true,
): Promise<CompletenessItem[]> {
  const sources = readSources();
  const items: CompletenessItem[] = [];
  /** The first source outside `declaredIn` matching the pattern. */
  const readIn = (pattern: RegExp, declaredIn: readonly string[]): string | undefined =>
    sources.find((s) => !declaredIn.includes(s.file) && pattern.test(s.text))?.file;
  const push = (
    area: Area,
    part: string,
    name: string,
    uses: number,
    where: string | undefined,
    open = 'not read',
  ): void => {
    const alias = ALIASES.get(`${part}|${name}`);
    const found =
      where ??
      (alias && readIn(alias, [])) ??
      (EXPLAINED.has(`${part}|${name}`) ? EXPLAINED.get(`${part}|${name}`) : undefined);
    items.push({ area, part, name, uses, done: found !== undefined, where: found ?? open });
  };
  /** A flag table's bits as the data uses them, each read as Table.name outside its parser. */
  const flags = (
    area: Area,
    part: string,
    tableName: string,
    table: Readonly<Record<string, number>>,
    counts: ReadonlyMap<number, number>,
    declaredIn: readonly string[],
  ): void => {
    for (const [bit, uses] of [...counts].sort((a, b) => a[0] - b[0])) {
      const name = flagName(table, bit);
      if (name === undefined) {
        push(area, part, `bit 0x${bit.toString(16)}`, uses, undefined, 'no name (unknown bit)');
        continue;
      }
      push(area, part, name, uses, readIn(new RegExp(`\\b${tableName}\\.${name}\\b`), declaredIn));
    }
  };
  /** A record field read as `.property` outside its parser. */
  const field = (
    area: Area,
    part: string,
    property: string,
    uses: number,
    declaredIn: readonly string[],
    label = property,
  ): void => {
    const pattern = PATTERNS.get(`${part}|${label}`) ?? new RegExp(`\\.${escape(property)}\\b`);
    push(area, part, label, uses, readIn(pattern, declaredIn));
  };

  // ---- Packages
  const PACKAGE_FILES = ['src/ai/package-records.ts'];
  const census = await packageCensus(db);
  for (const [name, uses] of [...census.procedures].sort((a, b) => b[1] - a[1]))
    push(
      'ai',
      'Procedures',
      name,
      uses,
      name.toLowerCase() in PROCEDURES ? 'src/ai/procedure-runs.ts' : undefined,
      'no runner',
    );
  flags('ai', 'Package flags (PKDT)', 'PackageFlag', PackageFlag, census.flags, PACKAGE_FILES);
  flags(
    'ai',
    'Interrupt flags (PKDT)',
    'InterruptFlag',
    InterruptFlag,
    census.interrupts,
    PACKAGE_FILES,
  );
  const overrideNames = ['none', 'spectator', 'observe dead', 'guard warn', 'combat'];
  for (const [value, uses] of [...census.interruptOverrides].sort((a, b) => a[0] - b[0]))
    push(
      'ai',
      'Interrupt override (PKDT)',
      overrideNames[value] ?? `value ${value}`,
      uses,
      readIn(/\.interruptOverride\b/, PACKAGE_FILES),
    );
  for (const [type, uses] of census.branchTypes)
    push(
      'ai',
      'Procedure tree branches',
      type,
      uses,
      readIn(new RegExp(`case '${type.toLowerCase()}'`), PACKAGE_FILES),
    );
  push(
    'ai',
    'Procedure tree branches',
    'flag overrides (PFO2 / PFOR)',
    [...census.overrides.values()].reduce((a, b) => a + b, 0),
    readIn(/\.flagOverride\b/, PACKAGE_FILES),
  );

  const packs: PackageRecord[] = [];
  for (const formId of db.formIdsOfType('PACK')) {
    const record = await db.get(formId);
    if (record && !record.deleted) packs.push(parsePackage(record));
  }
  const values = new Map<string, number>();
  const locations = new Map<number, number>();
  const targets = new Map<number, number>();
  const schedule = new Map<string, number>();
  let idles = 0;
  let events = 0;
  let combatStyles = 0;
  for (const pack of packs) {
    for (const input of pack.inputs) {
      const value = input.value;
      if (!value) continue;
      add(values, value.kind);
      if (value.kind === 'location') add(locations, value.location.type);
      if (value.kind === 'singleRef' || value.kind === 'targetSelector')
        add(targets, value.target.type);
    }
    const s = pack.schedule;
    if (s) {
      if (s.month >= 0) add(schedule, 'month');
      if (s.dayOfWeek >= 0) add(schedule, 'dayOfWeek');
      if (s.date > 0) add(schedule, 'date');
      if (s.hour >= 0) add(schedule, 'hour');
      if (s.minute > 0) add(schedule, 'minute');
      if (s.duration > 0) add(schedule, 'duration');
    }
    if (pack.idles) idles++;
    for (const event of [pack.onBegin, pack.onEnd, pack.onChange])
      if (event.idle !== undefined || event.topic !== undefined) events++;
    if (pack.combatStyle !== undefined) combatStyles++;
  }
  const VALUE_READERS: Readonly<Record<string, RegExp>> = {
    bool: /kind === 'bool'|\.bool\(/,
    int: /kind === 'int'|\.int\(/,
    float: /kind === 'float'|\.float\(/,
    objectList: /kind === 'objectList'|\.objectList\(/,
    location: /kind === 'location'|\.location\(/,
    singleRef: /kind === 'singleRef'|\.singleRef\(/,
    targetSelector: /kind === 'targetSelector'|\.targetSelector\(/,
    topic: /kind === 'topic'|\.topic\(/,
  };
  for (const [kind, uses] of values)
    push(
      'ai',
      'Package data (PLDT, PTDA, ...)',
      kind,
      uses,
      readIn(VALUE_READERS[kind] ?? /$^/, PACKAGE_FILES),
    );
  flags('ai', 'Package locations (PLDT)', 'LocationType', LocationType, locations, PACKAGE_FILES);
  flags('ai', 'Package targets (PTDA)', 'TargetType', TargetType, targets, PACKAGE_FILES);
  for (const [name, uses] of schedule) field('ai', 'Schedule (PSDT)', name, uses, PACKAGE_FILES);
  field(
    'ai',
    'Package idles and events',
    'idles',
    idles,
    PACKAGE_FILES,
    'idles (IDLF, IDLT, IDLA)',
  );
  field(
    'ai',
    'Package idles and events',
    'onBegin',
    events,
    PACKAGE_FILES,
    'begin, end, change events (POBA, POEA, POCA)',
  );
  field(
    'ai',
    'Package idles and events',
    'combatStyle',
    combatStyles,
    [...PACKAGE_FILES, 'src/ai/race-combat-records.ts', 'src/world/actor-stats-records.ts'],
    'package combat style (CNAM)',
  );

  // Package conditions: every function is valued by the condition evaluators (the audit test).
  const usage = await conditionUsage(db);
  for (const fn of [...usage.values()].sort(
    (a, b) => (b.records.get('PACK') ?? 0) - (a.records.get('PACK') ?? 0),
  )) {
    const uses = fn.records.get('PACK') ?? 0;
    if (uses === 0) continue;
    const held = NOT_YET.get(fn.function);
    push(
      'ai',
      'Package conditions',
      conditionFunctionName(fn.function),
      uses,
      held === undefined ? 'src/scripting/runtime/condition-values.ts' : undefined,
      held,
    );
  }

  // ---- NPCs and races
  const STATS_FILES = ['src/world/actor-stats-records.ts', 'src/world/actor-values.ts'];
  const COMBAT_FILES = ['src/ai/race-combat-records.ts'];
  const aiData = new Map<string, number>();
  const npcLists = new Map<string, number>();
  const attacks: AttackData[] = [];
  let npcAttackRaces = 0;
  for (const formId of db.formIdsOfType('NPC_')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const ai = parseNpcStats(record).aiData;
    if (ai.aggression !== 0) add(aiData, 'aggression');
    if (ai.confidence !== 2) add(aiData, 'confidence');
    if (ai.energy !== 50) add(aiData, 'energy');
    if (ai.morality !== 3) add(aiData, 'morality');
    if (ai.mood !== 0) add(aiData, 'mood');
    if (ai.assistance !== 0) add(aiData, 'assistance');
    if (ai.aggroRadius) add(aiData, 'aggroRadius');
    const combat = parseNpcCombat(record);
    if (combat.attackRace !== undefined) npcAttackRaces++;
    attacks.push(...combat.attacks);
    const lists = combat.overridePackages;
    if (lists.spectator !== undefined) add(npcLists, 'spectator');
    if (lists.observeCorpse !== undefined) add(npcLists, 'observeCorpse');
    if (lists.guardWarn !== undefined) add(npcLists, 'guardWarn');
    if (lists.combat !== undefined) add(npcLists, 'combat');
    if (combat.defaultPackageList !== undefined) add(npcLists, 'defaultPackageList');
  }
  for (const [name, uses] of aiData) field('ai', 'AI data (AIDT)', name, uses, STATS_FILES);
  for (const [name, uses] of npcLists)
    field('ai', 'NPC package lists', name, uses, [...COMBAT_FILES, ...STATS_FILES]);

  const raceFlags = new Map<number, number>();
  const raceFlags2 = new Map<number, number>();
  const raceFields = new Map<string, number>();
  let raceAttackRaces = 0;
  for (const formId of db.formIdsOfType('RACE')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const race = parseRaceCombat(record);
    eachBit(race.flags, (bit) => {
      if (flagName(RaceAiFlag, bit) !== undefined) add(raceFlags, bit);
    });
    eachBit(race.flags2, (bit) => {
      add(raceFlags2, bit);
    });
    for (const name of [
      'accelerationRate',
      'decelerationRate',
      'injuredHealthPct',
      'aimAngleTolerance',
      'flightRadius',
      'angularAccelerationRate',
      'angularTolerance',
    ] as const)
      if (race[name] !== 0) add(raceFields, name);
    if (race.attackRace !== undefined) raceAttackRaces++;
    attacks.push(...race.attacks);
  }
  const COMBAT_RACE_FLAGS = new Set<number>([
    RaceAiFlag.noCombatInWater,
    RaceAiFlag.regenHpInCombat,
    RaceAiFlag.noKnockdowns,
    RaceAiFlag.canDualWield,
  ]);
  const split = (combat: boolean): Map<number, number> =>
    new Map([...raceFlags].filter(([bit]) => COMBAT_RACE_FLAGS.has(bit) === combat));
  flags('ai', 'Race AI flags (DATA)', 'RaceAiFlag', RaceAiFlag, split(false), COMBAT_FILES);
  flags('combat', 'Race combat (DATA, ATKR)', 'RaceAiFlag', RaceAiFlag, split(true), COMBAT_FILES);
  flags('combat', 'Race combat (DATA, ATKR)', 'RaceFlag2', RaceFlag2, raceFlags2, COMBAT_FILES);
  for (const [name, uses] of raceFields)
    field('combat', 'Race combat (DATA, ATKR)', name, uses, COMBAT_FILES);
  field(
    'combat',
    'Race combat (DATA, ATKR)',
    'attackRace',
    raceAttackRaces + npcAttackRaces,
    COMBAT_FILES,
    'attack race (ATKR)',
  );

  // ---- Attack data
  const attackFields = new Map<string, number>();
  const attackFlags = new Map<number, number>();
  const ATTACK_FILES = [...COMBAT_FILES];
  for (const attack of attacks) {
    eachBit(attack.flags, (bit) => {
      add(attackFlags, bit);
    });
    if (attack.damageMult !== 0) add(attackFields, 'damageMult');
    if (attack.attackChance !== 0) add(attackFields, 'attackChance');
    if (attack.spell !== undefined) add(attackFields, 'spell');
    if (attack.attackAngle !== 0) add(attackFields, 'attackAngle');
    if (attack.strikeAngle !== 0) add(attackFields, 'strikeAngle');
    if (attack.stagger !== 0) add(attackFields, 'stagger');
    if (attack.attackType !== undefined) add(attackFields, 'attackType');
    if (attack.knockdown !== 0) add(attackFields, 'knockdown');
    if (attack.recoveryTime !== 0) add(attackFields, 'recoveryTime');
    if (attack.staminaMult !== 0) add(attackFields, 'staminaMult');
    add(attackFields, 'event');
  }
  for (const [name, uses] of attackFields)
    field('combat', 'Attack data (ATKD, ATKE)', name, uses, ATTACK_FILES);
  flags('combat', 'Attack data (ATKD, ATKE)', 'AttackFlag', AttackFlag, attackFlags, ATTACK_FILES);

  // ---- Combat styles
  const STYLE_FILES = ['src/ai/combat-style-records.ts'];
  const styleFields = new Map<string, number>();
  const styleFlags = new Map<number, number>();
  let styleRecordDual = 0;
  for (const formId of db.formIdsOfType('CSTY')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const style = parseCombatStyle(record);
    const parts = {
      general: { ...style.general, ...style.general.equipmentScoreMult },
      melee: style.melee,
      closeRange: style.closeRange,
      longRange: style.longRange,
      flight: style.flight,
    };
    for (const [part, values] of Object.entries(parts))
      for (const [name, value] of Object.entries(values))
        if (typeof value === 'number') add(styleFields, `${part}.${name}`, value !== 0 ? 1 : 0);
    eachBit(style.flags, (bit) => {
      add(styleFlags, bit);
    });
    if ((style.recordFlags & 0x80000) !== 0) styleRecordDual++;
  }
  const SCORE_KINDS = new Set(['melee', 'magic', 'ranged', 'shout', 'unarmed', 'staff']);
  for (const [key, uses] of styleFields) {
    const [part = '', name = ''] = key.split('.');
    const property =
      part === 'general' && SCORE_KINDS.has(name) ? `equipmentScoreMult.${name}` : name;
    // A score mult is read through its kind: `equipmentScoreMult[kind]` or `.equipmentScoreMult.melee`.
    const where =
      readIn(new RegExp(`\\.${part}\\.${escape(property)}\\b`), STYLE_FILES) ??
      readIn(new RegExp(`\\.${escape(property)}\\b`), STYLE_FILES) ??
      (property.startsWith('equipmentScoreMult')
        ? readIn(/equipmentScoreMult\[/, STYLE_FILES)
        : undefined);
    push('combat', 'Combat style (CSTY)', key, uses, where);
  }
  flags(
    'combat',
    'Combat style (CSTY)',
    'CombatStyleFlag',
    CombatStyleFlag,
    styleFlags,
    STYLE_FILES,
  );
  push(
    'combat',
    'Combat style (CSTY)',
    'record flag allow dual wielding',
    styleRecordDual,
    readIn(/CombatStyleRecordFlag\.allowDualWielding\b/, STYLE_FILES),
  );

  // ---- Combat behaviours: the tree's actions, each run by the stage's registry.
  const registry = sources.find((s) => s.file === 'src/shell/actor-combat-ai.ts');
  for (const action of COMBAT_ACTIONS)
    push(
      'combat',
      'Combat behaviour tree actions',
      action,
      0,
      registry && new RegExp(`\\b${action}\\s*[:(]`).test(registry.text)
        ? registry.file
        : undefined,
      'no action in the registry',
    );

  // ---- Idle markers and furniture
  const IDLE_FILES = ['src/ai/idle-records.ts'];
  const idleFlags = new Map<number, number>();
  const idleFields = new Map<string, number>();
  for (const formId of db.formIdsOfType('IDLM')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const marker = parseIdleMarker(record);
    eachBit(marker.flags, (bit) => {
      add(idleFlags, bit);
    });
    if (marker.timer > 0) add(idleFields, 'timer');
    if (marker.idles.length > 0) add(idleFields, 'idles');
    if (marker.childCanUse) add(idleFields, 'childCanUse');
  }
  flags(
    'ai',
    'Idle markers (IDLM)',
    'IdleCollectionFlag',
    IdleCollectionFlag,
    idleFlags,
    IDLE_FILES,
  );
  for (const [name, uses] of idleFields)
    field('ai', 'Idle markers (IDLM)', name, uses, [...IDLE_FILES, ...PACKAGE_FILES]);

  const FURN_FILES = ['src/world/furniture-records.ts'];
  const furnFlags = new Map<number, number>();
  const markerFlags = new Map<number, number>();
  const markerTypes = new Map<number, number>();
  const entries = new Map<number, number>();
  const furnFields = new Map<string, number>();
  for (const formId of db.formIdsOfType('FURN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const furn = parseFurniture(record);
    eachBit(furn.flags, (bit) => {
      add(furnFlags, bit);
    });
    eachBit((furn.markerFlags ?? 0) & ~FurnitureMarkerFlag.activeMarkers, (bit) => {
      add(markerFlags, bit);
    });
    for (const entry of furn.entryPoints) {
      add(markerTypes, entry.type);
      eachBit(entry.entries, (bit) => {
        add(entries, bit);
      });
    }
    if (furn.markers.some((m) => m.disabledEntries !== 0)) add(furnFields, 'disabledEntries');
    if (furn.markers.some((m) => m.keyword !== undefined)) add(furnFields, 'keyword');
    if (furn.interactionKeyword !== undefined) add(furnFields, 'interactionKeyword');
    if (furn.associatedSpell !== undefined) add(furnFields, 'associatedSpell');
  }
  flags('ai', 'Furniture (FURN)', 'FurnitureFlag', FurnitureFlag, furnFlags, FURN_FILES);
  flags(
    'ai',
    'Furniture (FURN)',
    'FurnitureMarkerFlag',
    FurnitureMarkerFlag,
    markerFlags,
    FURN_FILES,
  );
  flags(
    'ai',
    'Furniture (FURN)',
    'FurnitureMarkerType',
    FurnitureMarkerType,
    markerTypes,
    FURN_FILES,
  );
  flags('ai', 'Furniture (FURN)', 'FurnitureEntry', FurnitureEntry, entries, FURN_FILES);
  for (const [name, uses] of furnFields) field('ai', 'Furniture (FURN)', name, uses, FURN_FILES);

  // ---- Navmeshes
  if (navmeshes) {
    const NAVMESH_FILES = ['src/world/navmesh.ts'];
    const triangleFlags = new Map<number, number>();
    const linkTypes = new Map<number, number>();
    let doors = 0;
    let cover = 0;
    for (const formId of db.formIdsOfType('NAVM')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const navmesh = parseNavmesh(record);
      if (!navmesh) continue;
      for (const triangle of navmesh.triangles)
        eachBit(triangle.flags, (bit) => {
          add(triangleFlags, bit);
        });
      for (const link of navmesh.links) add(linkTypes, link.type);
      doors += navmesh.doors.length;
      cover += navmesh.coverTriangles.length;
    }
    // The edge link bits are read by triangleNeighbour itself (navmesh.ts), every path's step.
    const EDGE_BITS = new Set<number>([
      NavmeshFlag.edge01Link,
      NavmeshFlag.edge12Link,
      NavmeshFlag.edge20Link,
    ]);
    for (const [bit, uses] of [...triangleFlags].sort((a, b) => a[0] - b[0])) {
      const name = flagName(NavmeshFlag, bit);
      push(
        'ai',
        'Navmesh triangles (NVNM)',
        name ?? `bit 0x${bit.toString(16)}`,
        uses,
        EDGE_BITS.has(bit)
          ? 'src/world/navmesh.ts (triangleNeighbour)'
          : name === undefined
            ? undefined
            : readIn(new RegExp(`\\bNavmeshFlag\\.${name}\\b`), NAVMESH_FILES),
        name === undefined ? 'no name (unknown bit)' : 'not read',
      );
    }
    flags(
      'ai',
      'Navmesh links (NVNM)',
      'NavmeshLinkType',
      NavmeshLinkType,
      linkTypes,
      NAVMESH_FILES,
    );
    field('ai', 'Navmesh links (NVNM)', 'doors', doors, NAVMESH_FILES, 'door triangles');
    field('ai', 'Navmesh links (NVNM)', 'coverTriangles', cover, NAVMESH_FILES, 'cover triangles');
  }

  // ---- Game settings
  const read = settingsRead();
  for (const formId of db.formIdsOfType('GMST')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const name = record.editorId;
    if (name === undefined) continue;
    const area: Area | undefined = COMBAT_SETTINGS.test(name)
      ? 'combat'
      : AI_SETTINGS.test(name)
        ? 'ai'
        : undefined;
    if (!area) continue;
    const inert = INERT.get(name);
    const where = read.has(name)
      ? 'a settings reader'
      : (readIn(new RegExp(`\\b${name}\\b`), []) ??
        (inert === undefined ? undefined : `inert: ${inert}`));
    push(area, 'Game settings (GMST)', name, 1, where);
  }
  // The engine's built-in settings the readers ask for that no plugin defines: read with the
  // original's defaults.
  for (const name of read) {
    if (items.some((item) => item.name === name)) continue;
    const area: Area | undefined = COMBAT_SETTINGS.test(name)
      ? 'combat'
      : AI_SETTINGS.test(name)
        ? 'ai'
        : undefined;
    if (area) push(area, 'Game settings (built-in)', name, 0, 'a settings reader');
  }
  return items;
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  const items = await aiCombatCompleteness(db, !process.argv.includes('--no-navmesh'));
  for (const area of ['ai', 'combat'] as const) {
    const mine = items.filter((item) => item.area === area);
    console.log(`\n== ${area}: ${mine.filter((i) => i.done).length} of ${mine.length} done`);
    const parts = [...new Set(mine.map((item) => item.part))];
    for (const part of parts) {
      const list = mine.filter((item) => item.part === part);
      const open = list.filter((item) => !item.done);
      console.log(`  ${part}: ${list.length - open.length}/${list.length}`);
      for (const item of all ? list : open)
        console.log(`    [${item.done ? 'x' : ' '}] ${item.name} (${item.uses}): ${item.where}`);
    }
  }
  await db.close();
  await vfs.close();
}
