// Scenes (SCEN) against the real files (src/ai/scene-records.ts): one scene's phases, actors
// and actions (and what each phase waits for), a quest's scenes, every scene parsed with a
// summary, or a scene played by the scene runtime (src/ai/scene-runtime.ts) on a clock.
//
//   node tools/scene-info.ts MQ101Scene1        one scene (editor id or hex form id)
//   node tools/scene-info.ts --quest MQ101      the scenes of a quest
//   node tools/scene-info.ts --parse            every SCEN: counts, flags, fragments
//   node tools/scene-info.ts --play MS13LucanCamillaSceneView [--package-seconds 5]
//       the scene as it plays: its phases, lines (the topic's first info, as long as its text
//       takes), looks, timers and packages (one that can complete does after the seconds
//       given) in time; conditions other than the scene's own (IsSceneActionComplete,
//       IsScenePlaying) are taken to hold, and listed

import { parseArgs } from 'node:util';
import { PhaseFragmentFlag } from '../src/formats/esm/vmad.ts';
import { parsePackage, type ProcedureBranch } from '../src/ai/package-records.ts';
import {
  parseScene,
  SceneActionFlag,
  SceneActorBehaviour,
  SceneActorFlag,
  SceneFlag,
  type SceneAction,
  type SceneRecord,
} from '../src/ai/scene-records.ts';
import { SceneDirector, type SceneHost } from '../src/ai/scene-runtime.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ConditionRunOn, type Condition } from '../src/scripting/conditions.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { DialogueIndex } from '../src/world/dialogue.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { parseQuest, type QuestRecord } from '../src/world/quest-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const editorIds = new Map<number, string>();
const editorId = async (formId: number | undefined): Promise<string> => {
  if (formId === undefined || formId === 0) return 'none';
  let id = editorIds.get(formId);
  if (id === undefined) {
    const own = (await db.get(formId))?.editorId ?? '';
    id = own === '' ? hex(formId) : own;
    editorIds.set(formId, id);
  }
  return id;
};
/** "EditorId [form id]", or "[form id]" for a form without an editor id. */
const named = async (formId: number): Promise<string> => {
  const id = (await db.get(formId))?.editorId;
  return id ? `${id} [${hex(formId)}]` : `[${hex(formId)}]`;
};
const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];
/** The names of a value's set flags. */
const flagNames = (value: number, flags: Readonly<Record<string, number>>): string => {
  const names = Object.entries(flags)
    .filter(([, bit]) => (value & bit) !== 0)
    .map(([name]) => name);
  const known = Object.values(flags).reduce((all, bit) => all | bit, 0);
  if ((value & ~known) !== 0) names.push(`0x${(value & ~known).toString(16)}`);
  return names.join(' ');
};

const whenText = (when: number): string =>
  when === PhaseFragmentFlag.onStart
    ? 'on start'
    : when === PhaseFragmentFlag.onCompletion
      ? 'on completion'
      : `when ${String(when)}`;

async function conditionText(condition: Condition, alias: (id: number) => string): Promise<string> {
  const comparand =
    typeof condition.comparand === 'number'
      ? String(condition.comparand)
      : await editorId(condition.comparand.global);
  const on =
    condition.runOn === ConditionRunOn.reference
      ? `${await editorId(condition.reference)}.`
      : condition.runOn === ConditionRunOn.questAlias
        ? `${alias(condition.param3)}.`
        : condition.runOn === ConditionRunOn.subject
          ? ''
          : `runOn${String(condition.runOn)}.`;
  const args = condition.form ? await editorId(condition.form) : '';
  const param2 = condition.param2 !== 0 ? `, ${String(condition.param2)}` : '';
  return `${on}${conditionFunctionName(condition.function)}(${args}${param2}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}${condition.or ? ' OR' : ''}`;
}

async function allScenes(): Promise<SceneRecord[]> {
  const scenes: SceneRecord[] = [];
  for (const formId of db.formIdsOfType('SCEN')) {
    const record = await db.get(formId);
    if (record && !record.deleted) scenes.push(parseScene(record));
  }
  return scenes;
}

async function actionText(action: SceneAction, alias: (id: number) => string): Promise<string> {
  const phases =
    action.startPhase === action.endPhase
      ? `phase ${String(action.startPhase)}`
      : `phases ${String(action.startPhase)}-${String(action.endPhase)}`;
  const flags = action.flags !== 0 ? ` [${flagNames(action.flags, SceneActionFlag)}]` : '';
  const head = `#${String(action.index)} ${phases} ${action.type}${action.name ? ` "${action.name}"` : ''} ${alias(action.alias)}${flags}`;
  switch (action.type) {
    case 'dialogue': {
      const looping =
        (action.flags & SceneActionFlag.looping) !== 0
          ? ` every ${String(action.loopingMin)}-${String(action.loopingMax)} s`
          : '';
      const look = action.headtrackAlias >= 0 ? ` looking at ${alias(action.headtrackAlias)}` : '';
      const emotion = action.emotion !== 0 || action.emotionValue !== 0;
      return `${head}: ${action.topic === undefined ? 'no topic' : `topic ${await named(action.topic)}`}${look}${looping}${emotion ? ` emotion ${String(action.emotion)}/${String(action.emotionValue)}` : ''}`;
    }
    case 'package': {
      const packages = await Promise.all(action.packages.map((id) => editorId(id)));
      return `${head}: ${packages.join(', ') || 'no packages'}`;
    }
    case 'timer':
      return `${head}: ${String(action.seconds)} s`;
  }
}

async function show(scene: SceneRecord, quest: QuestRecord | undefined): Promise<void> {
  const names = new Map(quest?.aliases.map((entry) => [entry.id, entry.name]) ?? []);
  const alias = (id: number): string =>
    id < 0 ? '-' : `${names.get(id) ?? 'alias'}(${String(id)})`;
  console.log(
    `${scene.editorId} [${hex(scene.formId)}] of ${await editorId(scene.quest)}: ${flagNames(scene.flags, SceneFlag) || 'no flags'}`,
  );
  if (scene.conditions.length > 0) {
    for (const condition of scene.conditions) {
      console.log(`  condition ${await conditionText(condition, alias)}`);
    }
  }
  const fragments = scene.scripts?.fragments ?? [];
  for (const fragment of fragments) {
    console.log(`  on ${String(fragment.stage)}: ${fragment.script}.${fragment.function}`);
  }
  for (const actor of scene.actors) {
    const flags = flagNames(actor.flags, SceneActorFlag);
    console.log(
      `  actor ${alias(actor.alias)}${flags ? ` [${flags}]` : ''} behaviour ${flagNames(actor.behaviour, SceneActorBehaviour) || 'none'}`,
    );
  }
  for (const [index, phase] of scene.phases.entries()) {
    console.log(`  phase ${String(index)}${phase.name ? ` "${phase.name}"` : ''}`);
    for (const condition of phase.startConditions) {
      console.log(`    starts if ${await conditionText(condition, alias)}`);
    }
    for (const condition of phase.completionConditions) {
      console.log(`    completes if ${await conditionText(condition, alias)}`);
    }
    for (const fragment of scene.scripts?.phaseFragments ?? []) {
      if (fragment.phase !== index) continue;
      console.log(`    ${whenText(fragment.when)}: ${fragment.script}.${fragment.function}`);
    }
    for (const action of scene.actions) {
      if (action.startPhase !== index) continue;
      console.log(`    ${await actionText(action, alias)}`);
    }
    const ending = scene.actions.filter(
      (action) => action.startPhase < index && action.endPhase === index,
    );
    if (ending.length > 0) {
      console.log(`    ends ${ending.map((action) => `#${String(action.index)}`).join(', ')}`);
    }
    console.log(`    ${waitsFor(scene, index)}`);
  }
}

/** What a phase waits for as the scene runtime plays it (src/ai/scene-runtime.ts). */
function waitsFor(scene: SceneRecord, index: number): string {
  const phase = scene.phases[index];
  if (!phase) return '';
  if (phase.completionConditions.length > 0) return '-> completes when its conditions hold';
  const waits = scene.actions.filter(
    (action) =>
      Math.max(action.startPhase, action.endPhase) === index &&
      !(action.type === 'dialogue' && action.topic === undefined),
  );
  if (waits.length === 0) return '-> completes at once';
  const what = (action: SceneAction): string =>
    action.type === 'dialogue'
      ? (action.flags & SceneActionFlag.looping) !== 0
        ? 'its first line'
        : 'line'
      : action.type;
  return `-> completes when ${waits.map((action) => `#${String(action.index)} (${what(action)})`).join(', ')} done`;
}

/**
 * The tool's game for --play: aliases hold placeholders named by the alias, conditions other
 * than the scenes' own hold, lines last as long as their text takes, packages that can
 * complete (a procedure whose success completes it) do after `packageSeconds`.
 */
async function play(scene: SceneRecord, quest: QuestRecord | undefined): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      play: { type: 'boolean', default: false },
      'package-seconds': { type: 'string', default: '5' },
    },
    allowPositionals: true,
  });
  const packageSeconds = Number(values['package-seconds']);
  const index = new DialogueIndex(db);
  await index.build();
  const settings = await GameSettings.read(db);
  const perCharacter = settings.number('fAIDefaultSpeechMult') ?? 0.15;
  /** Placeholder references: 0x7f000000 + the alias. */
  const PLACEHOLDER = 0x7f000000;
  const aliasNames = new Map(quest?.aliases.map((entry) => [entry.id, entry.name]) ?? []);
  const who = (reference: number | undefined): string =>
    reference === undefined
      ? 'nobody'
      : reference === PLAYER_REF
        ? 'the player'
        : reference >= PLACEHOLDER
          ? (aliasNames.get(reference - PLACEHOLDER) ?? `alias ${String(reference - PLACEHOLDER)}`)
          : hex(reference);
  let clock = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const after = (seconds: number): Promise<void> =>
    new Promise((resolve) => timers.push({ at: clock + seconds, resolve }));
  const assumed = new Set<string>();
  const running = new Map<number, number>();
  const completes = new Map<number, boolean>();
  /** Whether a package can complete: a procedure of its tree whose success completes it. */
  const canComplete = async (pack: number): Promise<boolean> => {
    let known = completes.get(pack);
    if (known !== undefined) return known;
    const record = await db.get(pack);
    const parsed = record && parsePackage(record);
    const template = parsed?.template === undefined ? undefined : await db.get(parsed.template);
    const tree = parsed?.tree ?? (template ? parsePackage(template).tree : undefined);
    const any = (branch: ProcedureBranch | undefined): boolean =>
      branch !== undefined && ((branch.flags & 0x1) !== 0 || branch.children.some(any));
    known = any(tree);
    completes.set(pack, known);
    return known;
  };
  const log = (text: string): void => {
    console.log(`${clock.toFixed(1).padStart(6)} s  ${text}`);
  };
  const made: { director?: SceneDirector } = {};
  const host: SceneHost = {
    scene: async (formId) => {
      const record = await db.get(formId);
      return record?.type === 'SCEN' ? parseScene(record) : undefined;
    },
    scenesOf: () => Promise.resolve([]),
    questRunning: () => true,
    aliasReference: (_quest, alias) => PLACEHOLDER + alias,
    // Every alias is filled here (with a placeholder), so none is left out as optional.
    aliasOptional: () => Promise.resolve(false),
    actor: () => ({ dead: false, combat: false, observingCombat: false, talking: false }),
    alive: () => Promise.resolve(true),
    conditionsHold: async (conditions) => {
      for (const condition of conditions) {
        const name = conditionFunctionName(condition.function);
        const director = made.director;
        if (name === 'IsSceneActionComplete' && director) {
          if (!director.actionComplete(condition.form, condition.param2)) return false;
        } else if (name === 'IsScenePlaying' && director) {
          if (!director.isPlaying(condition.form)) return false;
        } else {
          const text = await conditionText(condition, (id) => aliasNames.get(id) ?? String(id));
          if (!assumed.has(text)) log(`  (assumed to hold: ${text})`);
          assumed.add(text);
        }
      }
      return true;
    },
    fragment: () => Promise.resolve(),
    say: async (line) => {
      const topic = await index.topic(line.topic);
      const infos = await index.infos(line.topic);
      const info = infos[0];
      if (!topic || !info) {
        log(`${who(line.speaker)}: nothing to say (${hex(line.topic)})`);
        return;
      }
      for (const response of info.responses) {
        log(`${who(line.speaker)} to ${who(line.target)}: "${response.text}"`);
        await after(Math.max(1, response.text.length * perCharacter));
      }
      if (info.responses.length === 0) log(`${who(line.speaker)}: (a shared info's lines)`);
    },
    look: (actor, look) => {
      log(
        look?.target === undefined
          ? `${who(actor)} looks ahead`
          : `${who(actor)} ${look.face ? 'turns to' : 'looks at'} ${who(look.target)}`,
      );
    },
    packagesChanged: (actor) => {
      void (async () => {
        const director = made.director;
        const pack = director?.packagesOf(actor)?.[0];
        if (pack === undefined) {
          if (running.delete(actor)) log(`${who(actor)} runs its own packages again`);
          return;
        }
        if (running.get(actor) === pack) return;
        running.set(actor, pack);
        const completing = await canComplete(pack);
        log(
          `${who(actor)} runs ${await editorId(pack)}${completing ? '' : ' (it does not complete)'}`,
        );
        if (!completing) return;
        await after(packageSeconds);
        if (running.get(actor) !== pack) return;
        running.delete(actor);
        director?.packageEnded(actor, pack);
      })();
    },
    currentPackage: (actor) => running.get(actor),
    // Their conditions taken to hold, as the scene's other conditions are.
    packagesRunnable: () => Promise.resolve(true),
    stopQuest: (formId) => {
      log(`its quest ${hex(formId)} stops`);
    },
    random: () => 0.5,
    warn: (message) => {
      log(`warning: ${message}`);
    },
    trace: (text) => {
      // The placeholders by their aliases' names.
      log(
        text
          .slice(text.indexOf(':') + 2)
          .replace(/\b7f([0-9a-f]{6})\b/g, (_all, alias: string) =>
            who(PLACEHOLDER + parseInt(alias, 16)),
          ),
      );
    },
  };
  const director = new SceneDirector(host);
  made.director = director;
  director.start(scene.formId);
  const step = 0.1;
  for (let ticks = 0; ticks < 36_000 && director.isPlaying(scene.formId); ticks++) {
    clock += step;
    const due = timers.filter((timer) => timer.at <= clock);
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.resolve();
    director.update(step);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (director.isPlaying(scene.formId)) log('still playing after an hour: stopped');
  director.stop(scene.formId);
}

async function questOf(scene: SceneRecord): Promise<QuestRecord | undefined> {
  const record = scene.quest === undefined ? undefined : await db.get(scene.quest);
  return record?.type === 'QUST' ? parseQuest(record) : undefined;
}

/** "key count, key count, ..." by count, the largest first. */
const list = (map: Map<string, number>, limit = Infinity): string =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(', ');
const count = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

async function parseAll(): Promise<void> {
  const scenes = await allScenes();
  const actionTypes = new Map<string, number>();
  const sceneFlags = new Map<string, number>();
  const actorFlags = new Map<string, number>();
  const behaviours = new Map<string, number>();
  const actionFlags = new Map<string, number>();
  const perQuest = new Map<string, number>();
  const fragments = new Map<string, number>();
  const odd = new Map<string, number>();
  let phases = 0;
  let actors = 0;
  let startConditions = 0;
  let completionConditions = 0;
  let withConditions = 0;
  let withScript = 0;
  let lookOnly = 0;
  let severalPackages = 0;
  for (const scene of scenes) {
    phases += scene.phases.length;
    actors += scene.actors.length;
    count(perQuest, await editorId(scene.quest));
    for (const name of flagNames(scene.flags, SceneFlag).split(' ')) {
      if (name) count(sceneFlags, name);
    }
    if (scene.conditions.length > 0) withConditions++;
    for (const phase of scene.phases) {
      if (phase.startConditions.length > 0) startConditions++;
      if (phase.completionConditions.length > 0) completionConditions++;
    }
    const aliases = new Set(scene.actors.map((actor) => actor.alias));
    for (const actor of scene.actors) {
      for (const name of flagNames(actor.flags, SceneActorFlag).split(' ')) {
        if (name) count(actorFlags, name);
      }
      for (const name of flagNames(actor.behaviour, SceneActorBehaviour).split(' ')) {
        if (name) count(behaviours, name);
      }
    }
    for (const action of scene.actions) {
      count(actionTypes, action.type);
      for (const name of flagNames(action.flags, SceneActionFlag).split(' ')) {
        if (name) count(actionFlags, name);
      }
      if (action.unknown !== undefined) count(odd, `action LNAM ${String(action.unknown)}`);
      if (action.endPhase < action.startPhase) count(odd, 'action ends before it starts');
      if (action.endPhase >= scene.phases.length) count(odd, 'action ends after the last phase');
      if (action.type !== 'timer' && !aliases.has(action.alias)) {
        count(odd, 'action for an actor not in the scene');
      }
      if (action.type === 'dialogue' && action.topic === undefined) lookOnly++;
      if (action.type === 'package' && action.packages.length > 1) severalPackages++;
    }
    const scripts = scene.scripts;
    if (scripts?.fragmentScript) withScript++;
    for (const fragment of scripts?.fragments ?? []) count(fragments, `scene ${fragment.stage}`);
    for (const fragment of scripts?.phaseFragments ?? []) {
      count(fragments, `phase ${whenText(fragment.when)}`);
      if (fragment.phase >= scene.phases.length) count(odd, 'phase fragment past the last phase');
    }
  }
  console.log(
    `${String(scenes.length)} scenes of ${String(perQuest.size)} quests, ${String(phases)} phases (${String(startConditions)} with start conditions, ${String(completionConditions)} with completion conditions), ${String(actors)} actors, ${String(scenes.reduce((n, s) => n + s.actions.length, 0))} actions`,
  );
  console.log(
    `actions: ${list(actionTypes)}; ${String(lookOnly)} lines without a topic (the actor only looks), ${String(severalPackages)} with more than one package`,
  );
  console.log(`scene flags: ${list(sceneFlags)}; ${String(withConditions)} scenes with conditions`);
  console.log(`actor flags: ${list(actorFlags)}`);
  console.log(`actor behaviour: ${list(behaviours)}`);
  console.log(`action flags: ${list(actionFlags)}`);
  console.log(`fragments: ${String(withScript)} scenes with a fragment script; ${list(fragments)}`);
  console.log(`most scenes: ${list(perQuest, 12)}`);
  console.log(`odd: ${list(odd) || 'none'}`);
}

const args = process.argv.slice(2);
/** Whether an argument names a form: its editor id, or its form id in hex. */
const names = (arg: string, formId: number, own: string): boolean =>
  arg.toLowerCase() === own.toLowerCase() ||
  (/^(0x)?[0-9a-f]+$/i.test(arg) && parseInt(arg, 16) === formId);
if (args[0] === '--parse') {
  await parseAll();
} else if (args[0] === '--play') {
  const wanted = args[1] ?? '';
  let found: SceneRecord | undefined;
  for (const formId of db.formIdsOfType('SCEN')) {
    const record = await db.get(formId);
    if (record && !record.deleted && names(wanted, formId, record.editorId ?? '')) {
      found = parseScene(record);
    }
  }
  if (found) {
    await show(found, await questOf(found));
    console.log('');
    await play(found, await questOf(found));
  } else {
    console.log(`no scene ${wanted}`);
  }
} else if (args[0] === '--quest') {
  const wanted = args[1] ?? '';
  const ofQuest: SceneRecord[] = [];
  for (const scene of await allScenes()) {
    if (scene.quest === undefined) continue;
    if (names(wanted, scene.quest, await editorId(scene.quest))) ofQuest.push(scene);
  }
  console.log(`${String(ofQuest.length)} scenes`);
  for (const scene of ofQuest) {
    const types = new Map<string, number>();
    for (const action of scene.actions) count(types, action.type);
    const fragments =
      (scene.scripts?.fragments.length ?? 0) + (scene.scripts?.phaseFragments.length ?? 0);
    console.log(
      `  ${scene.editorId}: ${String(scene.phases.length)} phases, ${String(scene.actors.length)} actors, ${String(scene.actions.length)} actions (${list(types)}), ${String(fragments)} fragments`,
    );
  }
  for (const scene of ofQuest) await show(scene, await questOf(scene));
} else {
  for (const formId of db.formIdsOfType('SCEN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    if (!args.some((arg) => names(arg, formId, record.editorId ?? ''))) continue;
    const scene = parseScene(record);
    await show(scene, await questOf(scene));
  }
}
await vfs.close();
