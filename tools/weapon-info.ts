// What combat reads of the records, against the real files (src/gameplay/combat/
// combat-records.ts): every weapon (WEAP DNAM, CRDT, impact data sets, sounds), ammunition
// (AMMO), projectile (PROJ), race's hit data (RACE NAM4, NAM5, unarmed damage and reach, mass)
// and kill camera (CPTH, CAMS).
//
//   node tools/weapon-info.ts                 counts and odd values of every record
//   node tools/weapon-info.ts IronSword       those whose editor id contains the text

import {
  AmmoFlag,
  parseAmmo,
  parseCameraPath,
  parseCameraShot,
  parseProjectile,
  parseRaceHits,
  parseWeaponCombat,
  ProjectileType,
} from '../src/gameplay/combat/combat-records.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const filter = process.argv[2]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const num = (value: number): string => String(Number(value.toPrecision(4)));
const name = async (formId: number | undefined): Promise<string> =>
  formId === undefined ? '-' : ((await db.get(formId))?.editorId ?? formId.toString(16));
const shown = (record: GameRecord): boolean =>
  filter !== undefined && (record.editorId ?? '').toLowerCase().includes(filter);
async function* records(type: string): AsyncIterable<GameRecord> {
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    if (record && !record.deleted) yield record;
  }
}

const counts = new Map<string, number>();
const count = (what: string): void => {
  counts.set(what, (counts.get(what) ?? 0) + 1);
};
const problems: string[] = [];

for await (const record of records('WEAP')) {
  const weapon = parseWeaponCombat(record);
  count('WEAP');
  if (weapon.sounds.swing !== undefined) count('WEAP with a swing sound');
  if (weapon.impactDataSet !== undefined) count('WEAP with an impact data set');
  if (weapon.animType > 9)
    problems.push(`${weapon.editorId}: animation type ${String(weapon.animType)}`);
  if (!(weapon.speed >= 0) || !(weapon.reach >= 0))
    problems.push(`${weapon.editorId}: speed or reach`);
  if (!shown(record)) continue;
  console.log(
    `WEAP ${weapon.editorId}: type ${String(weapon.animType)}, damage ${String(weapon.damage)}, ` +
      `speed ${num(weapon.speed)}, reach ${num(weapon.reach)}, stagger ${num(weapon.stagger)}, ` +
      `critical ${String(weapon.critDamage)} × ${num(weapon.critPercentMult)}, skill ${String(weapon.skill)}`,
  );
  console.log(
    `  impacts ${await name(weapon.impactDataSet)}, blocks and bashes ${await name(weapon.blockBashImpactDataSet)}, ` +
      `swing ${await name(weapon.sounds.swing)}, shot ${await name(weapon.sounds.attack)}, ` +
      `draw ${await name(weapon.sounds.equip)}, sheathe ${await name(weapon.sounds.unequip)}, model ${weapon.model ?? '-'}`,
  );
}

for await (const record of records('AMMO')) {
  const ammo = parseAmmo(record);
  count('AMMO');
  if (ammo.projectile === undefined) problems.push(`${ammo.editorId}: no projectile`);
  if (!shown(record)) continue;
  console.log(
    `AMMO ${ammo.editorId}: ${(ammo.flags & AmmoFlag.nonBolt) !== 0 ? 'arrow' : 'bolt'}, damage ${num(ammo.damage)}, ` +
      `weight ${num(ammo.weight)}, projectile ${await name(ammo.projectile)}, model ${ammo.model ?? '-'}`,
  );
}

for await (const record of records('PROJ')) {
  const projectile = parseProjectile(record);
  count('PROJ');
  if (projectile.type === ProjectileType.arrow) {
    count('PROJ arrows');
    if (!(projectile.speed > 0)) problems.push(`${projectile.editorId}: an arrow without speed`);
  }
  if (!shown(record)) continue;
  console.log(
    `PROJ ${projectile.editorId}: type 0x${projectile.type.toString(16)}, speed ${num(projectile.speed)}, ` +
      `gravity ${num(projectile.gravity)}, range ${num(projectile.range)}, radius ${num(projectile.collisionRadius)}, ` +
      `model ${projectile.model ?? '-'}`,
  );
}

for await (const record of records('RACE')) {
  const hits = parseRaceHits(record);
  count('RACE');
  if (hits.material === undefined) count('RACE without a material');
  if (!shown(record)) continue;
  console.log(
    `RACE ${record.editorId ?? ''}: mass ${num(hits.mass)}, unarmed ${num(hits.unarmedDamage)} at ${num(hits.unarmedReach)}, ` +
      `material ${await name(hits.material)}, unarmed impacts ${await name(hits.impactDataSet)}`,
  );
}

for await (const record of records('CAMS')) {
  const shot = parseCameraShot(record);
  count('CAMS');
  if (!shown(record)) continue;
  console.log(
    `CAMS ${shot.editorId}: location ${String(shot.location)}, target ${String(shot.target)}, ` +
      `${num(shot.minTime)}..${num(shot.maxTime)} s, global time × ${num(shot.globalTimeMult)}, model ${shot.model ?? '-'}`,
  );
}

for await (const record of records('CPTH')) {
  const path = parseCameraPath(record);
  count('CPTH');
  if (path.parent !== undefined && !(await db.get(path.parent)))
    problems.push(`${path.editorId}: no parent`);
  if (!shown(record)) continue;
  console.log(
    `CPTH ${path.editorId}: under ${await name(path.parent)}, ${String(path.conditions.length)} conditions, ` +
      `shots ${(await Promise.all(path.shots.map((shot) => name(shot)))).join(', ') || '-'}`,
  );
}

console.log([...counts].map(([what, n]) => `${String(n)} ${what}`).join(', '));
console.log(problems.length === 0 ? 'no problems' : `${String(problems.length)} problems:`);
for (const problem of problems.slice(0, 40)) console.log(`  ${problem}`);
await db.close();
await vfs.close();
