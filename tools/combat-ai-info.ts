// The combat AI's view of actors against the real files (docs/ai.md, "Combat AI"): each actor's
// AI values, aggro radius, combat style, guard flag and what it may fight with (and what its
// style chooses at a few distances, src/ai/combat-tactics.ts), the share of health it flees
// at; between the actors (and the player): how each regards the other (src/ai/combat-
// reactions.ts) and whether it attacks it on sight (GetShouldAttack).
//
//   node tools/combat-ai-info.ts WhiterunGuard... BanditREF   by editor id (reference or base) or form id
//   node tools/combat-ai-info.ts --new-game <actors>          after a new game (quests running)

import {
  attacksOnSight,
  COMBAT_AI_DEFAULTS,
  fleeHealth,
  readCombatAiSettings,
} from '../src/ai/combat-ai.ts';
import { CombatProfiles } from '../src/ai/combat-profile.ts';
import { fightReaction, reactionsOf } from '../src/ai/combat-reactions.ts';
import { chooseEquipment } from '../src/ai/combat-tactics.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const newGame = args.includes('--new-game');
const names = args.filter((arg) => !arg.startsWith('--'));
if (names.length === 0) {
  console.log('usage: node tools/combat-ai-info.ts [--new-game] <actor> [<actor> ...]');
  process.exit(1);
}

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library);
if (newGame) {
  const started = performance.now();
  await runtime.newGame(() => undefined);
  console.log(`new game started in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
const gameSettings = await GameSettings.read(db);
const settings = readCombatAiSettings((name) => gameSettings.number(name));
if (settings.fleeHealthAverage === COMBAT_AI_DEFAULTS.fleeHealthAverage) {
  console.log('(fConfidenceAverage as the engine has it)');
}

/** A reference by its form id (hex) or editor id. */
async function reference(name: string): Promise<number | undefined> {
  const id = Number.parseInt(name, 16);
  if (/^[0-9a-f]+$/i.test(name) && db.locate(id)) return id;
  for (const formId of db.formIdsOfType('ACHR')) {
    if ((await db.get(formId))?.editorId?.toLowerCase() === name.toLowerCase()) return formId;
  }
  // An actor base's editor id: its first placed reference.
  for (const formId of db.formIdsOfType('ACHR')) {
    const base = await runtime.baseOf(formId);
    if (base !== undefined && (await db.get(base))?.editorId?.toLowerCase() === name.toLowerCase())
      return formId;
  }
  return undefined;
}

const editorId = async (formId: number | undefined): Promise<string> =>
  formId === undefined ? '-' : ((await db.get(formId))?.editorId ?? hex(formId));

const AGGRESSION = ['unaggressive', 'aggressive', 'very aggressive', 'frenzied'];
const CONFIDENCE = ['cowardly', 'cautious', 'average', 'brave', 'foolhardy'];
const ASSISTANCE = ['helps nobody', 'helps allies', 'helps friends and allies'];

const actors: { name: string; reference: number }[] = [];
for (const name of names) {
  const found = await reference(name);
  if (found === undefined) console.log(`no actor ${name}`);
  else actors.push({ name, reference: found });
}

const profiles = new CombatProfiles();
for (const { name, reference: actor } of actors) {
  const profile = await profiles.read(runtime, actor);
  const style = profile.style;
  console.log(`\n${name} [${hex(actor)}]`);
  console.log(
    `  ${AGGRESSION[profile.aggression] ?? String(profile.aggression)}, ` +
      `${CONFIDENCE[profile.confidence] ?? String(profile.confidence)} (flees below ` +
      `${(fleeHealth(profile.confidence, settings) * 100).toFixed(1)}% health), ` +
      (ASSISTANCE[profile.assistance] ?? String(profile.assistance)) +
      (profile.guard ? ', a guard' : '') +
      (profile.aggroRadius ? `; aggro radius ${profile.aggroRadius.join(' / ')}` : ''),
  );
  const mults = style.general.equipmentScoreMult;
  console.log(
    `  style ${style.editorId || hex(style.formId)}: offensive ${style.general.offensiveMult.toFixed(2)}, ` +
      `defensive ${style.general.defensiveMult.toFixed(2)}; melee ${mults.melee.toFixed(2)}, ` +
      `ranged ${mults.ranged.toFixed(2)}, magic ${mults.magic.toFixed(2)}, unarmed ${mults.unarmed.toFixed(2)}`,
  );
  for (const option of profile.options) {
    console.log(
      `  ${option.kind} ${await editorId(option.id)}: damage ${option.damage.toFixed(1)}, ` +
        `range ${option.range.toFixed(0)}`,
    );
  }
  const choices: string[] = [];
  for (const distance of [100, 400, 1500]) {
    const best = chooseEquipment(profile.options, distance, style, settings);
    choices.push(`${String(distance)}: ${best ? `${best.kind} ${await editorId(best.id)}` : '-'}`);
  }
  console.log(`  fights with (by distance) ${choices.join(', ')}`);
}

console.log('');
const reactions = reactionsOf(runtime);
const everyone = [...actors, { name: 'the player', reference: PLAYER_REF }];
for (const { name, reference: actor } of actors) {
  const profile = await profiles.read(runtime, actor);
  for (const other of everyone) {
    if (other.reference === actor) continue;
    const reaction = await reactions.reaction(actor, other.reference);
    const onSight = attacksOnSight(profile.aggression, fightReaction(reaction));
    console.log(`${name} → ${other.name}: ${reaction}` + (onSight ? ', attacks on sight' : ''));
  }
}
await vfs.close();
