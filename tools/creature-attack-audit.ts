// How the actors of every race fight in melee, against the real files (docs/ai.md, "Combat
// AI": which attack): each race with a behavior graph and attack data, what its idle tree's
// ActionRightAttack and ActionRightPowerAttack can give its graph (attack events, or idles that
// are no attack: the frostbite spider's combatStanceStart), how many of its attack data its
// graph declares, and whether its graph has an equip clip (WeapEquip_Out: drawn at its end)
// or is drawn as it takes its draw idle (creatures).
//
//   node tools/creature-attack-audit.ts            one line per race, then counts
//   node tools/creature-attack-audit.ts --summary  counts only

import { parseRaceCombat, type AttackData } from '../src/ai/race-combat-records.ts';
import { behaviorGraphKey, readIdleTree, type IdleTree } from '../src/ai/idle-records.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../src/formats/hkx/behavior.ts';
import { parseRace } from '../src/world/actor-records.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const summary = process.argv.includes('--summary');
const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const db = await RecordDatabase.open(vfs);
const tree = await readIdleTree(db);

/** Every event an action's subtree can give a graph (its leaves' and inner idles'). */
function treeEvents(idles: IdleTree, action: string, graph: string): Set<string> {
  const events = new Set<string>();
  const root = idles.action(action);
  if (!root) return events;
  const visit = (parent: number, depth: number): void => {
    if (depth > 32) return;
    for (const idle of idles.children(parent, graph)) {
      if (idle.event) events.add(idle.event);
      visit(idle.formId, depth + 1);
    }
  };
  visit(root.formId, 0);
  return events;
}

const isAttack = (event: string, attacks: readonly AttackData[]): boolean => {
  const lower = event.toLowerCase();
  return (
    attacks.some((attack) => attack.event.toLowerCase() === lower) ||
    lower.startsWith('pa_') ||
    lower === 'weapequip' ||
    lower === 'blockstart' ||
    lower.includes('attack') ||
    lower.includes('bash')
  );
};

const races: GameRecord[] = [];
await db.scan(
  ['RACE'],
  () => true,
  (record) => races.push(record.detached()),
);
const counts = new Map<string, number>();
const add = (key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
const graphs = new Map<string, Promise<{ key: string; events: Set<string> } | undefined>>();
const graphOf = (project: string): Promise<{ key: string; events: Set<string> } | undefined> => {
  let entry = graphs.get(project);
  if (!entry) {
    entry = (async () => {
      const character = await loadCharacterInfo(project, read);
      if (!character.behavior) return undefined;
      const { files } = await loadBehaviorFiles(project, character.behavior, read);
      const events = new Set<string>();
      for (const file of files.values())
        for (const event of file.events) events.add(event.toLowerCase());
      return { key: behaviorGraphKey(character.behavior), events };
    })().catch(() => undefined);
    graphs.set(project, entry);
  }
  return entry;
};

for (const record of races) {
  const race = parseRace(record);
  const combat = parseRaceCombat(record);
  const project = race.behavior[0];
  if (!project) continue;
  // A race fights with its attack race's data where it names one (ATKR).
  let attacks = combat.attacks;
  if (combat.attackRace !== undefined) {
    const other = await db.get(combat.attackRace);
    if (other) attacks = parseRaceCombat(other).attacks;
  }
  if (attacks.length === 0) continue;
  const graph = await graphOf(meshPath(project));
  if (!graph) {
    add('races whose graph does not load');
    continue;
  }
  add('races with attack data and a graph');
  const declared = attacks.filter((attack) => graph.events.has(attack.event.toLowerCase()));
  const given = [
    ...treeEvents(tree, 'ActionRightAttack', graph.key),
    ...treeEvents(tree, 'ActionRightPowerAttack', graph.key),
  ];
  const nonAttacks = given.filter((event) => !isAttack(event, attacks));
  const creature = !graph.events.has('weapequip_out');
  if (creature) add('races drawn as their graph takes the draw (no WeapEquip_Out)');
  if (given.length === 0) add('races whose attack trees give nothing (attack data alone)');
  if (nonAttacks.length > 0 && creature)
    add('creature races whose attack trees give an idle that is no attack (stalled before)');
  if (declared.length === 0) add('races whose graph declares none of their attack data');
  if (summary) continue;
  console.log(
    `${race.editorId.padEnd(36)} attacks ${String(declared.length).padStart(2)}/${String(attacks.length).padEnd(2)} tree ${String(given.length).padStart(3)}${nonAttacks.length > 0 ? ` no attack: ${nonAttacks.join(',')}` : ''}${creature ? ' (drawn on its draw idle)' : ''}`,
  );
}
console.log();
for (const [key, value] of [...counts].sort()) console.log(`  ${key.padEnd(64)} ${String(value)}`);
await vfs.close();
