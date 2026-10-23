// The fliers against the real files (docs/ai.md, "Flying combat"): the races that fly (RACE
// DATA Flies) with their movement types and flying speeds (FLMV), flight radius and attacks;
// the flight game settings; a combat style's flight section (CSFL) with the times it gives and
// how often each maneuver comes up (src/ai/flight.ts); an actor's shouts (its breath) and how
// far they reach; the dragon perches (furniture whose interaction keyword a flier's race has).
//
//   node tools/flight-info.ts                          the fliers and the flight settings
//   node tools/flight-info.ts csDragon EncDragon01Fire a combat style, or an actor base's
//                                                      (its style through its templates, shouts)
//   node tools/flight-info.ts --perches                the perch furniture (the idle tree's
//                                                      ActionFlyStop targets) and its keyword

import {
  chooseFlightManeuver,
  fliesByRace,
  maneuverSeconds,
  readFlightSettings,
  type FlightManeuver,
} from '../src/ai/flight.ts';
import { parseCombatStyle, type CombatStyleFlight } from '../src/ai/combat-style-records.ts';
import { DEFAULT_COMBAT_STYLE } from '../src/ai/combat-profile.ts';
import { readIdleTree } from '../src/ai/idle-records.ts';
import { parseNpcCombat, parseRaceCombat } from '../src/ai/race-combat-records.ts';
import { view } from '../src/formats/esm/fields.ts';
import { parseFurniture } from '../src/world/furniture-records.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { parseMovementType } from '../src/world/movement.ts';
import { parseProjectile } from '../src/world/projectile-data.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { parseMagicEffect } from '../src/world/magic-effects.ts';
import { parseShout, parseSpell } from '../src/world/spell-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const name = async (id: number | undefined): Promise<string> =>
  id === undefined ? '-' : ((await db.get(id))?.editorId ?? hex(id));
const settings = readFlightSettings(
  (
    (game) => (n: string) =>
      game.number(n)
  )(await GameSettings.read(db)),
);

/** A record by editor id (of the given types) or form id (hex). */
async function find(text: string, types: readonly string[]): Promise<GameRecord | undefined> {
  if (/^[0-9a-f]{1,8}$/i.test(text)) {
    const record = await db.get(Number.parseInt(text, 16));
    if (record) return record;
  }
  for (const type of types) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record?.editorId?.toLowerCase() === text.toLowerCase()) return record;
    }
  }
  return undefined;
}

/** The keywords a record lists (KWDA). */
function keywordsOf(record: GameRecord): number[] {
  const data = record.fields.first('KWDA');
  if (!data) return [];
  return Array.from({ length: Math.floor(data.length / 4) }, (_, i) =>
    record.formIdAt(data, i * 4),
  );
}

/** The races that fly, by form id. */
async function fliers(): Promise<GameRecord[]> {
  const found: GameRecord[] = [];
  for (const formId of db.formIdsOfType('RACE')) {
    const record = await db.get(formId);
    const data = record?.fields.first('DATA');
    if (!record || !data || data.length < 36) continue;
    if (fliesByRace(view(data).getUint32(32, true))) found.push(record);
  }
  return found;
}

function describeFlight(flight: CombatStyleFlight): void {
  const n = (v: number): string => v.toFixed(2);
  console.log(
    `  flight: hover ${n(flight.hoverChance)} (time ${n(flight.hoverTime)}), dive bomb ` +
      `${n(flight.diveBombChance)}, ground attack ${n(flight.groundAttackChance)} (time ` +
      `${n(flight.groundAttackTime)}), perch attack ${n(flight.perchAttackChance)} (time ` +
      `${n(flight.perchAttackTime)}), flying attack ${n(flight.flyingAttackChance)}`,
  );
  // The longest of each (a roll of 1: the style's time on its settings' scale).
  const longest = (): number => 1;
  console.log(
    `  hovers up to ${maneuverSeconds('hover', flight, settings, longest).toFixed(1)} s, ` +
      `perches up to ${maneuverSeconds('perch', flight, settings, longest).toFixed(1)} s, ` +
      `fights on the ground up to ${maneuverSeconds('ground', flight, settings, longest).toFixed(1)} s`,
  );
  // How often each maneuver comes up as an orbit ends (a perch and a landing place near).
  let seed = 12345;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const counts = new Map<FlightManeuver, number>();
  const rolls = 10000;
  for (let i = 0; i < rolls; i++) {
    const maneuver = chooseFlightManeuver(flight, { canLand: true, perch: true }, random, settings);
    counts.set(maneuver, (counts.get(maneuver) ?? 0) + 1);
  }
  console.log(
    '  next maneuver: ' +
      [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([maneuver, count]) => `${maneuver} ${((count / rolls) * 100).toFixed(1)}%`)
        .join(', '),
  );
}

/** A shout's last word's spell, its projectile and reach. */
async function describeShout(formId: number): Promise<string> {
  const record = await db.get(formId);
  if (record?.type !== 'SHOU') return `${await name(formId)}: not a shout`;
  const shout = parseShout(record);
  const word = shout.words.at(-1);
  const spellRecord = word ? await db.get(word.spell) : undefined;
  const spell = spellRecord?.type === 'SPEL' ? parseSpell(spellRecord) : undefined;
  const effectRecord = spell?.effects[0] ? await db.get(spell.effects[0].effect) : undefined;
  const effect = effectRecord?.type === 'MGEF' ? parseMagicEffect(effectRecord) : undefined;
  const projectileRecord =
    effect?.projectile === undefined ? undefined : await db.get(effect.projectile);
  const projectile =
    projectileRecord?.type === 'PROJ' ? parseProjectile(projectileRecord) : undefined;
  return (
    `${shout.editorId} "${shout.name}": ${shout.words.length} words, ` +
    `${spell?.editorId ?? '-'} (cast type ${String(spell?.castType ?? '-')}), ` +
    (projectile
      ? `${projectile.editorId}: speed ${projectile.speed.toFixed(0)}, range ${projectile.range.toFixed(0)}`
      : 'no projectile')
  );
}

if (args.includes('--perches')) {
  // The furniture the idle tree's ActionFlyStop lands on (GetIsID run on the action's target),
  // and whether a flying race may use it (its interaction keyword).
  const keywords = new Set<number>();
  for (const race of await fliers()) for (const keyword of keywordsOf(race)) keywords.add(keyword);
  const tree = await readIdleTree(db);
  const perches = new Map<number, string>();
  const walk = (parent: number, depth: number): void => {
    for (const idle of tree.children(parent)) {
      for (const condition of idle.conditions) {
        if (condition.function === 72 && condition.runOn === 1) {
          perches.set(condition.form, idle.editorId);
        }
      }
      if (depth < 16) walk(idle.formId, depth + 1);
    }
  };
  const action = tree.action('ActionFlyStop');
  if (action) walk(action.formId, 0);
  for (const [formId, idle] of perches) {
    const record = await db.get(formId);
    const keyword = record?.type === 'FURN' ? parseFurniture(record).interactionKeyword : undefined;
    console.log(
      `${record?.editorId ?? hex(formId)} [${hex(formId)}] (${idle}): keyword ` +
        `${await name(keyword)}${keyword !== undefined && keywords.has(keyword) ? ', a flier’s' : ''}`,
    );
  }
  await vfs.close();
  process.exit(0);
}

const names = args.filter((arg) => !arg.startsWith('--'));
if (names.length === 0) {
  console.log('The races that fly (RACE DATA Flies):');
  for (const record of await fliers()) {
    const race = parseRaceCombat(record);
    const fly = race.movementTypes.fly;
    const movt = fly === undefined ? undefined : await db.get(fly);
    const type = movt?.type === 'MOVT' ? parseMovementType(movt) : undefined;
    console.log(
      `${race.editorId} [${hex(race.formId)}]: walks ${await name(race.movementTypes.walk)}, ` +
        `runs ${await name(race.movementTypes.run)}, flies ${await name(fly)}` +
        (type
          ? ` (forward ${type.walk.forward.toFixed(0)} walking, ${type.run.forward.toFixed(0)} ` +
            `running, turning ${((type.rotateWhileMoving * 180) / Math.PI).toFixed(0)}°/s)`
          : '') +
        `, flight radius ${race.flightRadius.toFixed(0)}, injured below ` +
        `${(race.injuredHealthPct * 100).toFixed(0)}% health`,
    );
    console.log(`  attacks: ${race.attacks.map((attack) => attack.event).join(', ')}`);
  }
  console.log('\nThe flight settings (src/ai/flight.ts; unnamed ones are ours):');
  for (const [key, value] of Object.entries(settings)) console.log(`  ${key} ${String(value)}`);
}

for (const text of names) {
  const record = await find(text, ['CSTY', 'NPC_']);
  if (!record) {
    console.log(`\nno combat style or actor ${text}`);
    continue;
  }
  console.log(`\n${record.editorId ?? hex(record.formId)} [${hex(record.formId)}]`);
  let style = record.type === 'CSTY' ? record : undefined;
  if (record.type === 'NPC_') {
    // Its combat style: its own ZNAM, else its templates' (the AI data's).
    let npc: GameRecord | undefined = record;
    for (let depth = 0; npc && !style && depth < 8; depth++) {
      const znam = parseNpcCombat(npc).combatStyle;
      if (znam !== undefined) {
        const found = await db.get(znam);
        if (found?.type === 'CSTY') style = found;
        break;
      }
      const template: Uint8Array | undefined = npc.fields.first('TPLT');
      const next: GameRecord | undefined = template
        ? await db.get(npc.formIdAt(template, 0))
        : undefined;
      npc = next?.type === 'NPC_' ? next : undefined;
    }
    style ??= await db.get(DEFAULT_COMBAT_STYLE);
    const shouts: number[] = [];
    for (const data of record.fields.all('SPLO')) {
      const spell = await db.get(record.formIdAt(data, 0));
      if (spell?.type === 'SHOU') shouts.push(spell.formId);
    }
    for (const shout of shouts) console.log(`  shout ${await describeShout(shout)}`);
  }
  if (style?.type !== 'CSTY') continue;
  console.log(`  style ${style.editorId ?? hex(style.formId)}`);
  describeFlight(parseCombatStyle(style).flight);
}
await vfs.close();
