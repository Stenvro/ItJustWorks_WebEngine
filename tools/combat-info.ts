// Combat data against the real files: combat styles (CSTY, src/ai/combat-style-records.ts),
// races' attack data, movement types and the DATA fields of movement and AI, NPC_ attack data,
// override package lists and default package lists (src/ai/race-combat-records.ts).
//
//   node tools/combat-info.ts --csty            every combat style: its values, short fields,
//                                               flags and the NPC_ that name it (ZNAM)
//   node tools/combat-info.ts --race NordRace   one race: DATA fields, movement types, attacks
//   node tools/combat-info.ts --audit           every RACE, NPC_ and CSTY parsed; events,
//                                               flags, overrides and package list usage

import {
  CombatStyleFlag,
  CombatStyleRecordFlag,
  parseCombatStyle,
  storedFloats,
  type CombatStyle,
} from '../src/ai/combat-style-records.ts';
import {
  AttackFlag,
  EquipmentFlag,
  parseNpcCombat,
  parseRaceCombat,
  RaceAiFlag,
  RaceFlag2,
  RaceRecordFlag,
  RaceSize,
  type AttackData,
  type NpcCombat,
  type RaceMovementTypes,
} from '../src/ai/race-combat-records.ts';
import { TemplateFlag } from '../src/world/actor-records.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const num = (value: number): string => String(Number(value.toPrecision(5)));

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const editorIds = new Map<number, { editorId: string; type: string } | undefined>();
async function describe(formId: number | undefined): Promise<string> {
  if (formId === undefined) return '-';
  if (!editorIds.has(formId)) {
    const record = await db.get(formId);
    editorIds.set(formId, record && { editorId: record.editorId ?? '', type: record.type });
  }
  const known = editorIds.get(formId);
  return known ? `${known.editorId || '?'} [${known.type}]` : `missing ${hex(formId)}`;
}
async function typeOf(formId: number): Promise<string | undefined> {
  await describe(formId);
  return editorIds.get(formId)?.type;
}

const flagNames = (flags: number, names: Readonly<Record<string, number>>): string => {
  const set = Object.entries(names)
    .filter(([, bit]) => (flags & bit) >>> 0 === bit)
    .map(([name]) => name);
  const known = Object.values(names).reduce((all, bit) => (all | bit) >>> 0, 0);
  const rest = (flags & ~known) >>> 0;
  if (rest !== 0) set.push(`0x${rest.toString(16)}`);
  return set.length > 0 ? set.join(' ') : 'none';
};
const movementWays = (types: RaceMovementTypes): [string, number | undefined][] => [
  ['walk', types.walk],
  ['run', types.run],
  ['swim', types.swim],
  ['fly', types.fly],
  ['sneak', types.sneak],
  ['sprint', types.sprint],
];
const count = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};
const sortedCounts = <K>(map: Map<K, number>): [K, number][] =>
  [...map].sort((a, b) => b[1] - a[1]);

async function scan(type: string): Promise<GameRecord[]> {
  const records: GameRecord[] = [];
  await db.scan(
    [type],
    () => true,
    (record) => {
      if (!record.deleted) records.push(record.detached());
    },
  );
  return records;
}

interface NpcEntry {
  readonly record: GameRecord;
  readonly combat: NpcCombat;
  readonly templateFlags: number;
  readonly hasTemplate: boolean;
}
async function npcs(): Promise<NpcEntry[]> {
  return (await scan('NPC_')).map((record) => {
    const acbs = record.fields.first('ACBS');
    return {
      record,
      combat: parseNpcCombat(record),
      templateFlags:
        acbs && acbs.length >= 20
          ? new DataView(acbs.buffer, acbs.byteOffset, acbs.byteLength).getUint16(18, true)
          : 0,
      hasTemplate: record.fields.has('TPLT'),
    };
  });
}

function styleLines(style: CombatStyle, record: GameRecord): string[] {
  const g = style.general;
  const e = g.equipmentScoreMult;
  const m = style.melee;
  const c = style.closeRange;
  const f = style.flight;
  const short = (
    [
      ['CSGD', 10],
      ['CSME', 8],
      ['CSCR', 4],
      ['CSLR', 1],
      ['CSFL', 8],
    ] as const
  )
    .filter(([type, full]) => storedFloats(record, type) < full)
    .map(([type, full]) => `${type} ${String(storedFloats(record, type))}/${String(full)}`);
  return [
    `  general  offensive ${num(g.offensiveMult)} defensive ${num(g.defensiveMult)} group ${num(g.groupOffensiveMult)}` +
      ` | equipment melee ${num(e.melee)} magic ${num(e.magic)} ranged ${num(e.ranged)} shout ${num(e.shout)}` +
      ` unarmed ${num(e.unarmed)} staff ${num(e.staff)} | avoid threat ${num(g.avoidThreatChance)}`,
    `  melee    staggered ${num(m.attackStaggeredMult)} power staggered ${num(m.powerAttackStaggeredMult)}` +
      ` power blocking ${num(m.powerAttackBlockingMult)} bash ${num(m.bashMult)} recoil ${num(m.bashRecoilMult)}` +
      ` bash attack ${num(m.bashAttackMult)} bash power ${num(m.bashPowerAttackMult)} special ${num(m.specialAttackMult)}`,
    `  close    circle ${num(c.circleMult)} fallback ${num(c.fallbackMult)} flank distance ${num(c.flankDistance)}` +
      ` stalk time ${num(c.stalkTime)} | long range strafe ${num(style.longRange.strafeMult)}`,
    `  flight   hover ${num(f.hoverChance)} dive bomb ${num(f.diveBombChance)} ground attack ${num(f.groundAttackChance)}` +
      ` hover time ${num(f.hoverTime)} ground time ${num(f.groundAttackTime)} perch ${num(f.perchAttackChance)}` +
      ` perch time ${num(f.perchAttackTime)} flying attack ${num(f.flyingAttackChance)}`,
    ...(short.length > 0 || !record.fields.has('DATA') || record.fields.has('CSMD')
      ? [
          `  stored   ${[
            ...short,
            ...(record.fields.has('DATA') ? [] : ['no DATA']),
            ...(record.fields.has('CSMD') ? ['CSMD'] : []),
          ].join(', ')} (the rest: defaults)`,
        ]
      : []),
  ];
}

async function showStyles(): Promise<void> {
  const records = (await scan('CSTY')).sort((a, b) =>
    (a.editorId ?? '').localeCompare(b.editorId ?? '', 'en'),
  );
  const users = new Map<number, string[]>();
  for (const npc of await npcs()) {
    const style = npc.combat.combatStyle;
    if (style !== undefined)
      users.set(style, [
        ...(users.get(style) ?? []),
        npc.record.editorId ?? hex(npc.record.formId),
      ]);
  }
  const flagValues = new Map<string, number>();
  let recordFlag = 0;
  let both = 0;
  for (const record of records) {
    const style = parseCombatStyle(record);
    const dual = (style.recordFlags & CombatStyleRecordFlag.allowDualWielding) !== 0;
    count(
      flagValues,
      record.fields.has('DATA') ? flagNames(style.flags, CombatStyleFlag) : '(no DATA)',
    );
    if (dual) recordFlag++;
    if (dual && (style.flags & CombatStyleFlag.allowDualWielding) !== 0) both++;
    const named = users.get(style.formId) ?? [];
    console.log(
      `${style.editorId} [${hex(style.formId)}] ${flagNames(style.flags, CombatStyleFlag)}` +
        `${dual ? ', record flag 19' : ''}; ${String(named.length)} NPC_` +
        (named.length > 0
          ? `: ${named.slice(0, 6).join(', ')}${named.length > 6 ? ', ...' : ''}`
          : ''),
    );
    for (const line of styleLines(style, record)) console.log(line);
  }
  console.log(`\n${String(records.length)} combat styles; DATA flags:`);
  for (const [flags, n] of sortedCounts(flagValues))
    console.log(`  ${flags.padEnd(36)} ${String(n)}`);
  console.log(
    `record flag 19 (allow dual wielding) on ${String(recordFlag)}, with DATA 0x4 on ${String(both)}`,
  );
  const used = records.filter((record) => users.has(record.formId)).length;
  console.log(`${String(used)} named by an NPC_ (ZNAM), ${String(records.length - used)} by none`);
}

async function attackLines(attacks: readonly AttackData[]): Promise<string[]> {
  const lines: string[] = [];
  for (const attack of attacks) {
    lines.push(
      `  ${attack.event.padEnd(30)} ${flagNames(attack.flags, AttackFlag).padEnd(26)}` +
        ` damage ${num(attack.damageMult)} chance ${num(attack.attackChance)}` +
        ` angles ${num(attack.attackAngle)}/${num(attack.strikeAngle)} stagger ${num(attack.stagger)}` +
        ` knockdown ${num(attack.knockdown)} recovery ${num(attack.recoveryTime)} stamina ${num(attack.staminaMult)}` +
        ` type ${await describe(attack.attackType)}` +
        (attack.spell === undefined ? '' : ` spell ${await describe(attack.spell)}`),
    );
  }
  return lines;
}

async function showRace(editorId: string): Promise<void> {
  const record = (await scan('RACE')).find(
    (race) => race.editorId?.toLowerCase() === editorId.toLowerCase(),
  );
  if (!record) {
    console.log(`${editorId}: no such race`);
    return;
  }
  const race = parseRaceCombat(record);
  const m = race.mount;
  const sizeName = Object.entries(RaceSize).find(([, value]) => value === race.size)?.[0];
  console.log(
    `${race.editorId} [${hex(race.formId)}] DATA ${String(record.fields.first('DATA')?.length ?? 0)} bytes`,
  );
  console.log(
    `  flags ${flagNames(race.flags, RaceAiFlag)} (AI's; raw 0x${race.flags.toString(16)})`,
  );
  console.log(
    `  record flags 0x${race.recordFlags.toString(16)}${(race.recordFlags & RaceRecordFlag.critter) !== 0 ? ' (critter)' : ''}` +
      `, flags 2 ${flagNames(race.flags2, RaceFlag2)}, size ${sizeName ?? String(race.size)}`,
  );
  console.log(
    `  acceleration ${num(race.accelerationRate)} deceleration ${num(race.decelerationRate)}` +
      ` angular acceleration ${num(race.angularAccelerationRate)} angular tolerance ${num(race.angularTolerance)}` +
      ` aim angle tolerance ${num(race.aimAngleTolerance)} flight radius ${num(race.flightRadius)}`,
  );
  const slot = (value: number | undefined): string => (value === undefined ? '-' : String(value));
  console.log(
    `  injured below ${num(race.injuredHealthPct)} health; biped slots head ${slot(race.headBipedObject)}` +
      ` hair ${slot(race.hairBipedObject)} shield ${slot(race.shieldBipedObject)} body ${slot(race.bodyBipedObject)}`,
  );
  console.log(
    `  mount offset ${m.mountOffset.map(num).join(', ')}; dismount ${m.dismountOffset.map(num).join(', ')}` +
      `; camera ${m.mountCameraOffset.map(num).join(', ')}`,
  );
  console.log(`  equipment ${flagNames(race.equipment, EquipmentFlag)}`);
  for (const [way, movt] of movementWays(race.movementTypes))
    console.log(`  movement ${way.padEnd(7)} ${await describe(movt)}`);
  for (const override of race.movementOverrides) {
    const s = override.speeds;
    console.log(
      `  override ${await describe(override.movementType)}: walk ${num(s.walk.forward)} run ${num(s.run.forward)}` +
        ` back ${num(s.walk.back)}/${num(s.run.back)} sides ${num(s.walk.left)}/${num(s.run.left)}` +
        ` rotate ${num(s.rotateInPlace.walk)}/${num(s.rotateInPlace.run)}/${num(s.rotateWhileMoving)}`,
    );
  }
  console.log(
    `  attack race ${await describe(race.attackRace)}; ${String(race.attacks.length)} attacks`,
  );
  for (const line of await attackLines(race.attacks)) console.log(line);
}

async function audit(): Promise<void> {
  // Races.
  const races = (await scan('RACE')).map((record) => ({ record, race: parseRaceCombat(record) }));
  const dataSizes = new Map<number, number>();
  const events = new Map<string, number>();
  const attackFlags = new Map<string, number>();
  const ways = new Map<string, number>();
  const sizes = new Map<number, number>();
  const flags2 = new Map<string, number>();
  const problems: string[] = [];
  let attacks = 0;
  let spells = 0;
  let typed = 0;
  let noAttacks = 0;
  for (const { record, race } of races) {
    count(dataSizes, record.fields.first('DATA')?.length ?? 0);
    count(sizes, race.size);
    count(flags2, flagNames(race.flags2, RaceFlag2));
    if (race.attacks.length === 0) noAttacks++;
    const atkd = record.fields.all('ATKD').length;
    if (atkd !== race.attacks.length || record.fields.all('ATKE').length !== atkd)
      problems.push(`${race.editorId}: ${String(atkd)} ATKD, ${String(race.attacks.length)} read`);
    for (const attack of race.attacks) {
      attacks++;
      count(events, attack.event);
      count(attackFlags, flagNames(attack.flags, AttackFlag));
      if (attack.spell !== undefined) spells++;
      if (attack.attackType !== undefined) {
        typed++;
        if ((await typeOf(attack.attackType)) !== 'KYWD')
          problems.push(`${race.editorId} ${attack.event}: attack type is no KYWD`);
      }
      if (attack.event === '') problems.push(`${race.editorId}: an attack without its event`);
    }
    for (const [way, movt] of movementWays(race.movementTypes)) {
      if (movt === undefined) continue;
      count(ways, way);
      if ((await typeOf(movt)) !== 'MOVT') problems.push(`${race.editorId} ${way}: no MOVT`);
    }
    for (const override of race.movementOverrides)
      if ((await typeOf(override.movementType)) !== 'MOVT')
        problems.push(`${race.editorId}: movement override is no MOVT`);
    if (race.attackRace !== undefined && (await typeOf(race.attackRace)) !== 'RACE')
      problems.push(`${race.editorId}: attack race is no RACE`);
  }
  console.log(
    `${String(races.length)} RACE: DATA ${sortedCounts(dataSizes)
      .map(([size, n]) => `${String(size)} bytes ×${String(n)}`)
      .join(', ')}; size ${sortedCounts(sizes)
      .map(([size, n]) => `${String(size)} ×${String(n)}`)
      .join(', ')}; flags 2 ${sortedCounts(flags2)
      .map(([name, n]) => `${name} ×${String(n)}`)
      .join(', ')}`,
  );
  console.log(
    `  attacks: ${String(attacks)} on ${String(races.length - noAttacks)} races (${String(noAttacks)} without),` +
      ` ${String(events.size)} distinct events, ${String(typed)} with an attack type, ${String(spells)} with a spell`,
  );
  console.log(
    `  attack flags: ${sortedCounts(attackFlags)
      .map(([name, n]) => `${name} ×${String(n)}`)
      .join(', ')}`,
  );
  console.log(
    `  events: ${sortedCounts(events)
      .map(([event, n]) => `${event} ${String(n)}`)
      .join(', ')}`,
  );
  console.log(
    `  movement types: ${[...ways].map(([way, n]) => `${way} ${String(n)}`).join(', ')};` +
      ` ${String(races.reduce((all, { race }) => all + race.movementOverrides.length, 0))} overrides` +
      ` (MTYP + SPED) on ${String(races.filter(({ race }) => race.movementOverrides.length > 0).length)} races`,
  );
  const attackRaces = races.filter(({ race }) => race.attackRace !== undefined);
  for (const { race } of attackRaces)
    console.log(`  ${race.editorId}: attack race ${await describe(race.attackRace)}`);

  // NPC_.
  const list = await npcs();
  const npcEvents = new Map<string, number>();
  const npcFlags = new Map<string, number>();
  const attackRaceTargets = new Map<string, number>();
  const lists = { spectator: 0, observeCorpse: 0, guardWarn: 0, combat: 0, default: 0 };
  const listForms = new Map<string, Map<string, number>>();
  let withAttackRace = 0;
  let ownRace = 0;
  let withAttacks = 0;
  let npcAttacks = 0;
  let notOwnRace = 0;
  let inheritedAttack = 0;
  let inheritedPackages = 0;
  let inheritedStyle = 0;
  let styles = 0;
  const raceEvents = new Map<number, Set<string>>(
    races.map(({ race }) => [race.formId, new Set(race.attacks.map((attack) => attack.event))]),
  );
  for (const { record, combat, templateFlags, hasTemplate } of list) {
    const editorId = record.editorId ?? hex(record.formId);
    const usesTemplate = (flag: number): boolean => hasTemplate && (templateFlags & flag) !== 0;
    if (combat.attackRace !== undefined) {
      withAttackRace++;
      if (combat.attackRace === record.formIdField('RNAM')) ownRace++;
      count(attackRaceTargets, await describe(combat.attackRace));
      if ((await typeOf(combat.attackRace)) !== 'RACE')
        problems.push(`${editorId}: attack race is no RACE`);
    }
    if (combat.attacks.length > 0) {
      withAttacks++;
      npcAttacks += combat.attacks.length;
      const race = record.formIdField('RNAM');
      const own = raceEvents.get(combat.attackRace ?? race ?? 0);
      for (const attack of combat.attacks) {
        count(npcEvents, attack.event);
        count(
          npcFlags,
          `${flagNames(attack.flags, AttackFlag)} damage ${num(attack.damageMult)}` +
            ` chance ${num(attack.attackChance)} stagger ${num(attack.stagger)}`,
        );
        if (own && !own.has(attack.event)) notOwnRace++;
      }
    }
    if (
      usesTemplate(TemplateFlag.attackData) &&
      (combat.attackRace !== undefined || combat.attacks.length > 0)
    )
      inheritedAttack++;
    const packages = combat.overridePackages;
    const named: [keyof typeof lists, number | undefined][] = [
      ['spectator', packages.spectator],
      ['observeCorpse', packages.observeCorpse],
      ['guardWarn', packages.guardWarn],
      ['combat', packages.combat],
      ['default', combat.defaultPackageList],
    ];
    let anyList = false;
    for (const [kind, form] of named) {
      if (form === undefined) continue;
      anyList = true;
      lists[kind]++;
      const forms = listForms.get(kind) ?? new Map<string, number>();
      count(forms, await describe(form));
      listForms.set(kind, forms);
      if ((await typeOf(form)) !== 'FLST') problems.push(`${editorId} ${kind}: no FLST`);
    }
    if (anyList && usesTemplate(TemplateFlag.defaultPackages)) inheritedPackages++;
    if (combat.combatStyle !== undefined) {
      styles++;
      if ((await typeOf(combat.combatStyle)) !== 'CSTY')
        problems.push(`${editorId}: combat style is no CSTY`);
      if (usesTemplate(TemplateFlag.aiData)) inheritedStyle++;
    }
  }
  console.log(`\n${String(list.length)} NPC_:`);
  console.log(
    `  attack race (ATKR) on ${String(withAttackRace)} (${String(ownRace)} their own race): ${sortedCounts(
      attackRaceTargets,
    )
      .slice(0, 8)
      .map(([race, n]) => `${race} ×${String(n)}`)
      .join(', ')}${attackRaceTargets.size > 8 ? ', ...' : ''}`,
  );
  console.log(
    `  attack data on ${String(withAttacks)} (${String(npcAttacks)} entries; ${String(notOwnRace)} with an event` +
      ` their attack race lacks): ${sortedCounts(npcEvents)
        .map(([event, n]) => `${event} ${String(n)}`)
        .join(', ')}`,
  );
  console.log(
    `  their values: ${sortedCounts(npcFlags)
      .map(([name, n]) => `${name} ×${String(n)}`)
      .join(', ')}`,
  );
  console.log(
    `  package lists: spectator (SPOR) ${String(lists.spectator)}, observe corpse (OCOR) ${String(lists.observeCorpse)},` +
      ` guard warn (GWOR) ${String(lists.guardWarn)}, combat (ECOR) ${String(lists.combat)},` +
      ` default (DPLT) ${String(lists.default)}`,
  );
  for (const [kind, forms] of listForms) {
    console.log(
      `    ${kind}: ${String(forms.size)} lists; ${sortedCounts(forms)
        .slice(0, 6)
        .map(([form, n]) => `${form} ×${String(n)}`)
        .join(', ')}${forms.size > 6 ? ', ...' : ''}`,
    );
  }
  console.log(
    `  combat style (ZNAM) on ${String(styles)}; set but taken from the template: attack data ${String(inheritedAttack)},` +
      ` package lists ${String(inheritedPackages)}, combat style ${String(inheritedStyle)}`,
  );

  // Combat styles.
  const csty = await scan('CSTY');
  const short = new Map<string, number>();
  for (const record of csty) {
    parseCombatStyle(record);
    for (const [type, full] of [
      ['CSGD', 10],
      ['CSME', 8],
      ['CSCR', 4],
      ['CSLR', 1],
      ['CSFL', 8],
    ] as const) {
      const stored = storedFloats(record, type);
      if (stored < full) count(short, `${type} ${String(stored)}/${String(full)}`);
    }
    if (!record.fields.has('DATA')) count(short, 'no DATA');
  }
  console.log(
    `\n${String(csty.length)} CSTY; short or missing fields: ${sortedCounts(short)
      .map(([what, n]) => `${what} ×${String(n)}`)
      .join(', ')}`,
  );
  console.log(problems.length === 0 ? '\nno problems' : `\n${String(problems.length)} problems:`);
  for (const problem of problems.slice(0, 40)) console.log(`  ${problem}`);
}

if (args.includes('--csty')) await showStyles();
else if (option('--race') !== undefined) await showRace(option('--race') ?? '');
else if (args.includes('--audit')) await audit();
else console.log('usage: node tools/combat-info.ts --csty | --race <editor id> | --audit');
await db.close();
await vfs.close();
