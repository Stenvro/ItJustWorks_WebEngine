// Scene fidelity check against the real files: what a scene's data says each of its actors does
// in each phase (its actions: packages with their procedures, targets, places and conditions;
// lines with their text; timers; the alias that casts it and the alias's own packages), and,
// given a trace recorded in the browser (src/shell/scene-trace.ts: `engineDev.sceneTrace`),
// where our actors did otherwise: a scene that did not start, a phase skipped, a package action
// whose actor ran another package (or fought, fled, stood) instead, a travel that did not arrive,
// a line not said, an actor that walked off while the scene had it stand.
//
//   node tools/scene-audit.ts MQ101TorriLedgeScene            one scene (editor id or hex id)
//   node tools/scene-audit.ts --quest MQ101                    every scene of a quest
//   node tools/scene-audit.ts --quest MQ101 --trace run.log    and the deviations of a trace
//   node tools/scene-audit.ts --trace run.log                  every scene the trace saw
//   node tools/scene-audit.ts --starts Riften                  how town scenes start: their
//       quests' start, the trigger boxes naming them, their first phases' waits ('.' for all)
//
// docs/ai.md ("Scenes", "Checking a scene against its data").

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mergedInputs } from '../src/ai/package-start.ts';
import {
  LocationType,
  PackageFlag,
  parsePackage,
  TargetType,
  type PackageInput,
  type PackageLocation,
  type PackageRecord,
  type PackageTarget,
  type ProcedureBranch,
} from '../src/ai/package-records.ts';
import {
  parseScene,
  SceneActorFlag,
  SceneFlag,
  type SceneAction,
  type SceneRecord,
} from '../src/ai/scene-records.ts';
import { parseVmad, referencedForms } from '../src/formats/esm/vmad.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ConditionRunOn, type Condition } from '../src/scripting/conditions.ts';
import { triggerEnterAsksForPlayer } from '../src/scripting/runtime/trigger-gates.ts';
import { parseReference } from '../src/world/cell-records.ts';
import { DialogueIndex } from '../src/world/dialogue.ts';
import {
  AliasFlag,
  parseQuest,
  QuestFlag,
  type QuestAlias,
  type QuestRecord,
} from '../src/world/quest-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { parseStoryNode, type StoryNode } from '../src/world/story-manager-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { quest: { type: 'string' }, trace: { type: 'string' }, starts: { type: 'string' } },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const dialogue = new DialogueIndex(db);
const hex = (id: number): string => (id >>> 0).toString(16).padStart(8, '0');
const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];
const SPEEDS = ['walk', 'jog', 'run', 'fast walk'];

const editorIds = new Map<number, string>();
async function editorId(formId: number | undefined): Promise<string> {
  if (formId === undefined || formId === 0) return 'none';
  let id = editorIds.get(formId);
  if (id === undefined) {
    const own = (await db.get(formId))?.editorId ?? '';
    id = own === '' ? `[${hex(formId)}]` : own;
    editorIds.set(formId, id);
  }
  return id;
}

/** A form by editor id or hex form id. */
async function find(name: string, type: string): Promise<number | undefined> {
  if (/^(0x)?[0-9a-f]{1,8}$/i.test(name)) {
    const id = parseInt(name, 16);
    if ((await db.get(id))?.type === type) return id;
  }
  for (const formId of db.formIdsOfType(type)) {
    if ((await db.get(formId))?.editorId?.toLowerCase() === name.toLowerCase()) return formId;
  }
  return undefined;
}

// --- What the data says -------------------------------------------------------------------

async function conditionText(
  condition: Condition,
  quest: QuestRecord | undefined,
): Promise<string> {
  const comparand =
    typeof condition.comparand === 'number'
      ? String(condition.comparand)
      : await editorId(condition.comparand.global);
  const alias = (id: number): string =>
    quest?.aliases.find((a) => a.id === id)?.name ?? `alias${String(id)}`;
  const on =
    condition.runOn === ConditionRunOn.reference
      ? `${await editorId(condition.reference)}.`
      : condition.runOn === ConditionRunOn.questAlias
        ? `${alias(condition.param3)}.`
        : condition.runOn === ConditionRunOn.subject
          ? ''
          : `runOn${String(condition.runOn)}.`;
  const name = conditionFunctionName(condition.function);
  const first =
    name === 'GetIsAliasRef' || name === 'GetIsAliasRef'.toLowerCase()
      ? alias(condition.form)
      : condition.form
        ? await editorId(condition.form)
        : '';
  // A Papyrus variable's name (GetVMQuestVariable's CIS2) where the function takes one.
  const param2 =
    condition.strings.length > 0
      ? `, ${condition.strings.join(', ')}`
      : condition.param2 !== 0
        ? `, ${String(condition.param2)}`
        : '';
  return `${on}${name}(${first}${param2}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}${condition.or ? ' OR' : ''}`;
}

async function conditionsText(
  conditions: readonly Condition[],
  quest: QuestRecord | undefined,
): Promise<string> {
  const parts: string[] = [];
  for (const condition of conditions) parts.push(await conditionText(condition, quest));
  return parts.join(' AND ').replaceAll(' OR AND ', ' OR ');
}

/** A reference with its base and where it is placed. */
async function referenceText(formId: number): Promise<string> {
  if (formId === 0x14) return 'the player';
  const record = await db.get(formId);
  if (!record) return `[${hex(formId)}] (missing)`;
  if (record.type !== 'REFR' && record.type !== 'ACHR')
    return `${await editorId(formId)} (${record.type})`;
  const placed = parseReference(record);
  const at = placed.position.map(Math.round).join(',');
  return `${await editorId(formId)} (${await editorId(placed.base)} at ${at})`;
}

async function locationText(
  location: PackageLocation,
  quest: QuestRecord | undefined,
): Promise<string> {
  const radius = location.radius > 0 ? ` r${String(location.radius)}` : '';
  const alias = (id: number): string =>
    quest?.aliases.find((a) => a.id === id)?.name ?? `alias${String(id)}`;
  switch (location.type) {
    case LocationType.nearReference:
      return `near ${await referenceText(location.form)}${radius}`;
    case LocationType.inCell:
      return `in cell ${await editorId(location.form)}`;
    case LocationType.nearPackageStart:
      return `near package start${radius}`;
    case LocationType.nearEditorLocation:
      return `near editor location${radius}`;
    case LocationType.objectId:
      return `object ${await editorId(location.form)}${radius}`;
    case LocationType.objectType:
      return `object type ${String(location.form)}${radius}`;
    case LocationType.nearLinkedReference:
      return `near linked ref ${location.form === 0 ? '' : await editorId(location.form)}${radius}`;
    case LocationType.atPackageLocation:
      return `at package location${radius}`;
    case LocationType.aliasReference:
      return `near alias ${alias(location.form)}${radius}`;
    case LocationType.aliasLocation:
      return `in alias location ${alias(location.form)}`;
    case LocationType.nearSelf:
      return `near self${radius}`;
    default:
      return `location type ${String(location.type)} ${hex(location.form)}${radius}`;
  }
}

async function targetText(target: PackageTarget, quest: QuestRecord | undefined): Promise<string> {
  const alias = (id: number): string =>
    quest?.aliases.find((a) => a.id === id)?.name ?? `alias${String(id)}`;
  switch (target.type) {
    case TargetType.specificReference:
      return await referenceText(target.value);
    case TargetType.objectId:
      return `object ${await editorId(target.value)}`;
    case TargetType.objectType:
      return `object type ${String(target.value)}`;
    case TargetType.linkedReference:
      return `linked ref ${target.value === 0 ? '' : await editorId(target.value)}`;
    case TargetType.referenceAlias:
      return `alias ${alias(target.value)}`;
    case TargetType.self:
      return 'self';
    default:
      return `target type ${String(target.type)} ${String(target.value)}`;
  }
}

async function inputText(
  input: PackageInput | undefined,
  quest: QuestRecord | undefined,
): Promise<string> {
  const value = input?.value;
  if (!value) return '?';
  switch (value.kind) {
    case 'bool':
    case 'int':
    case 'float':
    case 'objectList':
      return String(value.value);
    case 'location':
      return await locationText(value.location, quest);
    case 'singleRef':
    case 'targetSelector':
      return await targetText(value.target, quest);
    case 'topic':
      return typeof value.topic === 'number'
        ? await editorId(value.topic)
        : (value.topic ?? 'none');
  }
}

const packages = new Map<number, PackageRecord | undefined>();
async function packageRecord(formId: number): Promise<PackageRecord | undefined> {
  if (!packages.has(formId)) {
    const record = await db.get(formId);
    packages.set(formId, record?.type === 'PACK' ? parsePackage(record) : undefined);
  }
  return packages.get(formId);
}

/** A package: its procedures with their inputs named, flags, speed and conditions. */
async function packageText(
  formId: number,
  quest: QuestRecord | undefined,
  indent: string,
): Promise<string[]> {
  const pack = await packageRecord(formId);
  if (!pack) return [`${indent}[${hex(formId)}] (not a package)`];
  const template = pack.template === undefined ? undefined : await packageRecord(pack.template);
  const inputs = mergedInputs(pack, template);
  const names = new Map((template ?? pack).inputNames.map((name) => [name.id, name.name]));
  const flags = Object.entries(PackageFlag)
    .filter(([, bit]) => (pack.flags & bit) !== 0)
    .map(([name]) => name);
  const lines = [
    `${indent}${pack.editorId} [${hex(formId)}]${template ? ` template ${template.editorId}` : ''}, ${SPEEDS[pack.preferredSpeed] ?? '?'}${flags.length > 0 ? `, ${flags.join(' ')}` : ''}`,
  ];
  if (pack.conditions.length > 0)
    lines.push(`${indent}  if ${await conditionsText(pack.conditions, quest)}`);
  const walk = async (branch: ProcedureBranch | undefined, depth: string): Promise<void> => {
    if (!branch) return;
    const conditions =
      branch.conditions.length > 0 ? ` if ${await conditionsText(branch.conditions, quest)}` : '';
    if (branch.type === 'Procedure') {
      const parts: string[] = [];
      for (const id of branch.inputs) {
        if (id === 255) continue;
        parts.push(
          `${names.get(id) ?? `#${String(id)}`}=${await inputText(inputs.get(id), quest)}`,
        );
      }
      const completes = (branch.flags & 0x1) !== 0 ? ' (completes the package)' : '';
      const speed = branch.flagOverride?.preferredSpeed;
      const override = speed !== undefined ? ` speed ${SPEEDS[speed] ?? '?'}` : '';
      lines.push(
        `${depth}${branch.procedure ?? '?'}(${parts.join('; ')})${completes}${override}${conditions}`,
      );
      return;
    }
    lines.push(`${depth}${branch.type}${conditions}`);
    for (const child of branch.children) await walk(child, `${depth}  `);
  };
  await walk(pack.tree ?? template?.tree, `${indent}  `);
  return lines;
}

function fillText(alias: QuestAlias): Promise<string> {
  const fill = alias.fill;
  switch (fill.kind) {
    case 'forced':
      return referenceText(fill.form).then((text) => `forced ${text}`);
    case 'uniqueActor':
      return editorId(fill.npc).then((text) => `unique actor ${text}`);
    case 'created':
      return editorId(fill.base).then((text) => `created from ${text}`);
    case 'external':
      return editorId(fill.quest).then((text) => `external ${text} alias ${String(fill.alias)}`);
    case 'locationReference':
      return editorId(fill.location).then((text) => `location reference in ${text}`);
    case 'referenceLocation':
      return Promise.resolve(`reference location of alias ${String(fill.alias)}`);
    case 'fromEvent':
      return Promise.resolve(`from event ${fill.event} ${fill.data}`);
    case 'matching':
      return Promise.resolve(
        `find matching${fill.nearAlias === undefined ? '' : ` near alias ${String(fill.nearAlias)}`}`,
      );
    case 'none':
      return Promise.resolve('none');
  }
}

/** The line a dialogue action's topic says first (the first info's first response). */
async function lineText(topic: number | undefined): Promise<string> {
  if (topic === undefined) return 'no topic (looks only)';
  const infos = await dialogue.infos(topic);
  const text = infos[0]?.responses[0]?.text;
  return `${await editorId(topic)} "${text ?? '(nothing)'}"${infos.length > 1 ? ` (+${String(infos.length - 1)} infos)` : ''}`;
}

async function actionText(
  action: SceneAction,
  quest: QuestRecord | undefined,
  indent: string,
): Promise<string[]> {
  const aliasName = (id: number | undefined): string =>
    id === undefined
      ? 'nobody'
      : (quest?.aliases.find((a) => a.id === id)?.name ?? `alias${String(id)}`);
  const span =
    action.startPhase === action.endPhase || action.endPhase < action.startPhase
      ? `phase ${String(action.startPhase)}`
      : `phases ${String(action.startPhase)}-${String(action.endPhase)}`;
  const head = `${indent}#${String(action.index)} ${span}`;
  switch (action.type) {
    case 'timer':
      return [`${head} timer ${String(action.seconds)} s`];
    case 'dialogue': {
      const look =
        action.headtrackAlias >= 0 ? `, looks at ${aliasName(action.headtrackAlias)}` : '';
      return [`${head} says ${await lineText(action.topic)}${look}`];
    }
    case 'package': {
      const lines = [`${head} packages:`];
      for (const pack of action.packages)
        lines.push(...(await packageText(pack, quest, `${indent}    `)));
      return lines;
    }
  }
}

const quests = new Map<number, QuestRecord | undefined>();
async function questRecord(formId: number | undefined): Promise<QuestRecord | undefined> {
  if (formId === undefined) return undefined;
  if (!quests.has(formId)) {
    const record = await db.get(formId);
    quests.set(formId, record?.type === 'QUST' ? parseQuest(record) : undefined);
  }
  return quests.get(formId);
}

async function sceneRecord(formId: number): Promise<SceneRecord | undefined> {
  const record = await db.get(formId);
  return record?.type === 'SCEN' ? parseScene(record) : undefined;
}

/** The scene's expectations, actor by actor and phase by phase. */
async function printScene(scene: SceneRecord): Promise<void> {
  const quest = await questRecord(scene.quest);
  console.log(
    `\n${scene.editorId} [${hex(scene.formId)}] of ${quest?.editorId ?? 'no quest'}, ${String(scene.phases.length)} phases`,
  );
  if (scene.conditions.length > 0)
    console.log(`  starts if ${await conditionsText(scene.conditions, quest)}`);
  for (const [index, phase] of scene.phases.entries()) {
    const start =
      phase.startConditions.length > 0
        ? ` runs if ${await conditionsText(phase.startConditions, quest)}`
        : '';
    const done =
      phase.completionConditions.length > 0
        ? ` completes if ${await conditionsText(phase.completionConditions, quest)}`
        : '';
    if (start || done || phase.name)
      console.log(`  phase ${String(index)}${phase.name ? ` "${phase.name}"` : ''}${start}${done}`);
  }
  for (const actor of scene.actors) {
    const alias = quest?.aliases.find((entry) => entry.id === actor.alias);
    const flags = [
      (actor.flags & SceneActorFlag.optional) !== 0 ? 'optional' : '',
      (actor.flags & SceneActorFlag.runOnlyScenePackages) !== 0 ? 'run only scene packages' : '',
      alias && (alias.flags & AliasFlag.optional) !== 0 ? 'alias optional' : '',
    ].filter((flag) => flag !== '');
    console.log(
      `  ACTOR ${alias?.name ?? '?'}(${String(actor.alias)})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}: ${alias ? await fillText(alias) : 'no alias'}`,
    );
    if (alias && alias.conditions.length > 0)
      console.log(`    alias fill if ${await conditionsText(alias.conditions, quest)}`);
    if (alias && alias.packages.length > 0) {
      console.log('    its alias packages (over its own, outside scene packages):');
      for (const pack of alias.packages) {
        for (const line of await packageText(pack, quest, '      ')) console.log(line);
      }
    }
    const actions = scene.actions.filter((action) => action.alias === actor.alias);
    for (const [index] of scene.phases.entries()) {
      const here = actions.filter((action) => action.startPhase === index);
      const holding = actions.filter(
        (action) =>
          action.type === 'package' && action.startPhase < index && action.endPhase >= index,
      );
      if (here.length === 0) continue;
      console.log(
        `    phase ${String(index)}${holding.length > 0 ? ` (package #${holding.map((a) => String(a.index)).join(', #')} still runs)` : ''}:`,
      );
      for (const action of here)
        for (const line of await actionText(action, quest, '      ')) console.log(line);
    }
    if (actions.length === 0) console.log('    (no actions: its own packages)');
  }
}

// --- What our actors did (a trace) ----------------------------------------------------------

interface TraceEvent {
  readonly time: number;
  readonly kind: string;
  readonly words: readonly string[];
}

/** A trace's lines (src/shell/scene-trace.ts): a file of lines, or the JSON string CDP gives. */
function readTrace(path: string): TraceEvent[] {
  let text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('"')) text = JSON.parse(text) as string;
  const events: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/);
    const time = Number(words[0]);
    if (!Number.isFinite(time) || words.length < 2) continue;
    events.push({ time, kind: words[1] ?? '', words: words.slice(2) });
  }
  return events;
}

/** One actor as the trace last had it. */
interface ActorTrack {
  pack: string;
  procedure: string;
  flags: ReadonlySet<string>;
  position: readonly number[] | undefined;
  /** The scene that casts it now ('-': none). */
  scene: string;
  /**
   * Where it stood as its scene came to hold it still (a package action of it done, the action
   * still running: it stays where its package got it), or, with `own`, as the scene left it to
   * its own packages (no package action of it running).
   */
  standing: { at: readonly number[]; readonly own: boolean; readonly since: number } | undefined;
}

/** A running action of a scene, as the trace saw it start. */
interface ActionTrack {
  readonly scene: number;
  readonly action: SceneAction;
  readonly actor: string;
  readonly since: number;
  done: boolean;
  said: boolean;
  /** Its actor ran one of its packages at some time. */
  took: boolean;
  /** Its actor was in furniture at some time. */
  seated: boolean;
  reported: boolean;
}

const flat = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

/** A package's tree and its inputs (its template's under its own). */
async function packageParts(formId: number): Promise<
  | {
      readonly tree: ProcedureBranch | undefined;
      readonly inputs: ReadonlyMap<number, PackageInput>;
    }
  | undefined
> {
  const pack = await packageRecord(formId);
  if (!pack) return undefined;
  const template = pack.template === undefined ? undefined : await packageRecord(pack.template);
  return { tree: pack.tree ?? template?.tree, inputs: mergedInputs(pack, template) };
}

/** The first procedure of a package's tree (what it does first). */
async function firstProcedure(formId: number): Promise<ProcedureBranch | undefined> {
  const parts = await packageParts(formId);
  const first = (branch: ProcedureBranch | undefined): ProcedureBranch | undefined => {
    if (!branch) return undefined;
    if (branch.type === 'Procedure') return branch;
    for (const child of branch.children) {
      const found = first(child);
      if (found) return found;
    }
    return undefined;
  };
  return first(parts?.tree);
}

/** Where a package's first procedure goes: its first place or target that is a reference. */
async function packagePlace(
  formId: number,
): Promise<{ at: readonly number[]; radius: number; furniture: boolean } | undefined> {
  const parts = await packageParts(formId);
  const procedure = await firstProcedure(formId);
  if (!parts || !procedure) return undefined;
  for (const id of procedure.inputs) {
    const value = parts.inputs.get(id)?.value;
    let reference: number | undefined;
    let radius = 0;
    if (value?.kind === 'location' && value.location.type === LocationType.nearReference) {
      reference = value.location.form;
      radius = value.location.radius;
    } else if (
      (value?.kind === 'singleRef' || value?.kind === 'targetSelector') &&
      value.target.type === TargetType.specificReference
    ) {
      reference = value.target.value;
    }
    if (reference === undefined) continue;
    const record = await db.get(reference);
    if (record?.type !== 'REFR' && record?.type !== 'ACHR') return undefined;
    const placed = parseReference(record);
    const base = await db.get(placed.base);
    return { at: placed.position, radius, furniture: base?.type === 'FURN' };
  }
  return undefined;
}

/**
 * Procedures that end at their place (their success completes their package there); a patrol
 * ends at its path's end, not at its start.
 */
const GOES_TO = /^(travel|escort|sit|sleep|useidlemarker|activate|holdposition)$/i;
/** Procedures that use furniture at their place. */
const USES_FURNITURE = /^(sit|sleep|activate|useidlemarker)$/i;

/** Seconds an actor may take to take up its scene package before it counts as a deviation. */
const TAKE_UP = 3;
/** Units an actor may drift while its scene has no package for it. */
const STAND_DRIFT = 300;
/** Units off a package's place (beyond its radius) that count as not there. */
const ARRIVE_SLACK = 200;
/** Seconds a phase may wait before the end of the trace calls it stuck. */
const STUCK = 90;
/** Seconds a package action may run with furniture to use before it counts as unused. */
const SEAT_WITHIN = 15;
/** Seconds after a package is done that its actor's position is looked at. */
const SAMPLE_LAG = 1;

async function auditTrace(
  events: readonly TraceEvent[],
  only: ReadonlySet<number> | undefined,
): Promise<void> {
  const deviations: string[] = [];
  const notes: string[] = [];
  const actors = new Map<string, ActorTrack>();
  const trackOf = (actor: string): ActorTrack => {
    let found = actors.get(actor);
    if (!found) {
      found = {
        pack: '-',
        procedure: '-',
        flags: new Set(),
        position: undefined,
        scene: '-',
        standing: undefined,
      };
      actors.set(actor, found);
    }
    return found;
  };
  const running = new Map<string, ActionTrack>();
  const phases = new Map<number, { phase: number; since: number; paused: boolean }>();
  const records = new Map<number, SceneRecord | undefined>();
  const record = async (scene: number): Promise<SceneRecord | undefined> => {
    if (!records.has(scene)) records.set(scene, await sceneRecord(scene));
    return records.get(scene);
  };
  const seen = new Set<number>();
  const sceneName = async (scene: number): Promise<string> =>
    (await record(scene))?.editorId ?? hex(scene);
  const add = async (
    list: string[],
    time: number,
    scene: number | undefined,
    text: string,
  ): Promise<void> => {
    const where = scene === undefined ? '' : `${await sceneName(scene)}: `;
    list.push(`${time.toFixed(1).padStart(7)} s  ${where}${text}`);
  };
  const actorName = async (actor: string): Promise<string> => {
    const record = await db.get(parseInt(actor, 16));
    const base = record?.type === 'ACHR' ? parseReference(record).base : undefined;
    return base === undefined ? actor : `${await editorId(base)}(${actor})`;
  };
  const key = (scene: number, action: number | string): string => `${hex(scene)}#${String(action)}`;
  const flagged = new Set<string>();
  const walked = new Set<string>();
  /** Arrival checks of packages done, each looked at once its moment has come. */
  const arrivals: { readonly due: number; readonly check: () => Promise<void> }[] = [];

  /** An action ends (or its scene does): what it should have done by then. */
  /** Lines whose action ended before they were said (a line goes on past its action's end). */
  const unsaid = new Map<string, { run: ActionTrack; time: number; stopped: boolean }>();
  const finish = async (run: ActionTrack, time: number, stopped = false): Promise<void> => {
    running.delete(key(run.scene, run.action.index));
    const who = await actorName(run.actor);
    const action = run.action;
    if (action.type === 'dialogue' && action.topic !== undefined && !run.said) {
      unsaid.set(key(run.scene, action.index), { run, time, stopped });
    }
    if (action.type !== 'package') return;
    const pack = action.packages[0];
    const place = pack === undefined ? undefined : await packagePlace(pack);
    const procedure = pack === undefined ? undefined : await firstProcedure(pack);
    if (place?.furniture && USES_FURNITURE.test(procedure?.procedure ?? '') && !run.seated) {
      if (time - run.since >= SEAT_WITHIN)
        await add(
          deviations,
          time,
          run.scene,
          `#${String(action.index)} ${who} never got into the furniture of ${await editorId(pack)}`,
        );
    }
  };

  for (const event of events) {
    const w = event.words;
    for (const arrival of arrivals.filter((due) => due.due <= event.time)) {
      arrivals.splice(arrivals.indexOf(arrival), 1);
      await arrival.check();
    }
    if (event.kind === 'TRACE') {
      const scene = await sceneId((w[0] ?? '').replace(/:$/, ''));
      if (scene === undefined || (only && !only.has(scene))) continue;
      seen.add(scene);
      const rest = w.slice(1).join(' ');
      const started = /^#(\d+) (package|dialogue|timer) starts(?: for ([0-9a-f]+))?/.exec(rest);
      const done = /^#(\d+) package done( \(none may run\))?/.exec(rest);
      const said = /^#(\d+) said/.exec(rest);
      const ended = /^#(\d+) ends/.exec(rest);
      if (rest.startsWith('does not start')) {
        await add(deviations, event.time, scene, rest);
      } else if (rest.startsWith('waits for')) {
        await add(notes, event.time, scene, rest);
      } else if (/^phase \d+ skipped/.test(rest)) {
        await add(notes, event.time, scene, `${rest} (its start conditions did not hold)`);
      } else if (/^[0-9a-f]{8} ends it/.test(rest)) {
        await add(notes, event.time, scene, `${await actorName(rest.slice(0, 8))} ended it`);
      } else if (started) {
        const action = (await record(scene))?.actions.find((a) => a.index === Number(started[1]));
        if (!action) continue;
        const actor = (started[3] ?? '').replace(/^0+/, '');
        if (actor === '') {
          if (action.type !== 'timer')
            await add(notes, event.time, scene, `#${String(action.index)} has no actor (empty)`);
          continue;
        }
        running.set(key(scene, action.index), {
          scene,
          action,
          actor,
          since: event.time,
          done: false,
          said: false,
          took: false,
          seated: false,
          reported: false,
        });
      } else if (done) {
        const run = running.get(key(scene, done[1] ?? ''));
        if (run?.action.type !== 'package') continue;
        run.done = true;
        const who = await actorName(run.actor);
        const pack = run.action.packages[0];
        if (done[2]) {
          await add(
            notes,
            event.time,
            scene,
            `#${String(run.action.index)} ${who}: none of its packages may run, done at once`,
          );
          continue;
        }
        // Done: where its package's place is, it should be there (looked at a moment later: the
        // trace writes a position once the actor has gone 40 units on, at its next sample).
        const procedure = pack === undefined ? undefined : await firstProcedure(pack);
        const place = pack === undefined ? undefined : await packagePlace(pack);
        if (!place || !GOES_TO.test(procedure?.procedure ?? '')) continue;
        arrivals.push({
          due: event.time + SAMPLE_LAG,
          check: async () => {
            const at = trackOf(run.actor).position;
            if (!at || trackOf(run.actor).flags.has('unstaged')) return;
            const off = flat(place.at, at) - place.radius;
            if (off <= ARRIVE_SLACK) return;
            await add(
              deviations,
              event.time,
              scene,
              `#${String(run.action.index)} ${who}: ${await editorId(pack)} done ${String(Math.round(off))} units short of its place`,
            );
          },
        });
      } else if (said) {
        const run = running.get(key(scene, said[1] ?? ''));
        if (run) run.said = true;
        unsaid.delete(key(scene, said[1] ?? ''));
      } else if (ended) {
        const run = running.get(key(scene, ended[1] ?? ''));
        if (run) await finish(run, event.time);
      } else if (rest === 'ends' || rest === 'stopped') {
        for (const run of [...running.values()])
          if (run.scene === scene) await finish(run, event.time, rest === 'stopped');
        phases.delete(scene);
        if (rest === 'stopped') await add(notes, event.time, scene, 'stopped');
      }
    } else if (event.kind === 'scene') {
      // scene <id> playing phase <n> [paused]
      const scene = parseInt(w[0] ?? '', 16);
      if (only && !only.has(scene)) continue;
      phases.set(scene, { phase: Number(w[3]), since: event.time, paused: w[4] === 'paused' });
    } else if (event.kind === 'actor') {
      // actor <ref> <scene>:<alias>|- pack <id>/<procedure>|- [FLAGS] travel yes|no graph <states>
      const actor = w[0] ?? '';
      const track = trackOf(actor);
      const packAt = w.indexOf('pack');
      const [pack, procedure] = (w[packAt + 1] ?? '-').split('/');
      track.pack = pack ?? '-';
      track.procedure = procedure ?? '-';
      const travelAt = w.indexOf('travel');
      track.flags = new Set(w.slice(packAt + 2, travelAt < 0 ? undefined : travelAt));
      track.scene = w[1] ?? '-';
      const scene = parseInt(track.scene.split(':')[0] ?? '', 16);
      const inScene = track.scene !== '-' && (!only || only.has(scene));
      // Its package actions: is it running theirs?
      let held = false;
      let still = false;
      for (const run of running.values()) {
        if (run.actor !== actor || run.action.type !== 'package') continue;
        if (track.flags.has('FURNITURE') || [...track.flags].some((f) => f.startsWith('FURNITURE')))
          run.seated = true;
        if (run.done) {
          still = true;
          continue;
        }
        held = true;
        const ours = run.action.packages.some((id) => id === parseInt(track.pack, 16));
        if (ours) {
          run.took = true;
          continue;
        }
        // Off the stage (the low process runs it) or dead (the action is done with it).
        if (run.reported || track.flags.has('unstaged') || track.flags.has('dead')) continue;
        if (run.took || event.time - run.since > TAKE_UP) {
          run.reported = true;
          const fight = [...track.flags].join(' ');
          await add(
            deviations,
            event.time,
            run.scene,
            `#${String(run.action.index)} ${await actorName(actor)} should run ${(await Promise.all(run.action.packages.map(editorId))).join('/')} but runs ${track.pack === '-' ? 'nothing' : await editorId(parseInt(track.pack, 16))} (${track.procedure})${fight ? ` ${fight}` : ''}`,
          );
        }
      }
      // Its scene holds it still, or leaves it to its own packages.
      const own = !held && !still;
      if (!inScene || held || track.standing?.own !== own) track.standing = undefined;
      if (inScene && !held)
        track.standing ??= track.position && { at: track.position, own, since: event.time };
      // Fighting, fleeing or watching a fight while its scene has it.
      const fights = ['COMBAT', 'FLEE', 'OBSERVE'].filter((flag) => track.flags.has(flag));
      if (inScene && fights.length > 0 && !flagged.has(`${actor} ${fights.join(' ')}`)) {
        flagged.add(`${actor} ${fights.join(' ')}`);
        await add(
          deviations,
          event.time,
          scene,
          `${await actorName(actor)} ${fights.join(' ')} while in the scene (it runs ${track.pack} ${track.procedure})`,
        );
      }
    } else if (event.kind === 'pos') {
      const actor = w[0] ?? '';
      const track = trackOf(actor);
      track.position = (w[1] ?? '').split(',').map(Number);
      const standing = track.standing;
      // Carried, or in the air (a flier cannot stand there: it circles), it is not walking off.
      if (!standing || track.flags.has('CARRIED') || track.flags.has('FLYING')) continue;
      // Where it got to as its package was done is where it stands (a sample later).
      if (event.time < standing.since + SAMPLE_LAG) {
        standing.at = track.position;
        continue;
      }
      const moved = flat(standing.at, track.position);
      const scene = parseInt(track.scene.split(':')[0] ?? '', 16);
      const phase = phases.get(scene)?.phase ?? -1;
      const once = `${actor} ${hex(scene)}${standing.own ? '' : ` ${String(phase)}`}`;
      if (moved > STAND_DRIFT && !walked.has(once)) {
        walked.add(once);
        const runs = track.pack === '-' ? 'nothing' : await editorId(parseInt(track.pack, 16));
        if (standing.own) {
          // Its own packages move it: what they make of it is theirs, not the scene's.
          await add(
            notes,
            event.time,
            scene,
            `${await actorName(actor)} moves on its own packages from phase ${String(phase)}: ${runs} (${track.procedure})`,
          );
        } else {
          await add(
            deviations,
            event.time,
            scene,
            `${await actorName(actor)} walks off (${String(Math.round(moved))} units) in phase ${String(phase)}, though its scene package is done and holds it; it runs ${runs} (${track.procedure})`,
          );
        }
      }
    }
  }

  for (const arrival of arrivals) await arrival.check();

  // Lines never said (a stopped scene's cut short: a note).
  for (const { run, time, stopped } of unsaid.values()) {
    const action = run.action;
    if (action.type !== 'dialogue' || action.topic === undefined) continue;
    await add(
      stopped ? notes : deviations,
      time,
      run.scene,
      `#${String(action.index)} ${await actorName(run.actor)} did not say ${await lineText(action.topic)}${stopped ? ' (its scene was stopped)' : ''}`,
    );
  }

  // The end of the trace: phases that wait on and on, and what they wait for.
  const end = events.at(-1)?.time ?? 0;
  for (const [scene, at] of phases) {
    if (end - at.since < STUCK || at.paused) continue;
    const waits: string[] = [];
    for (const run of running.values()) {
      if (run.scene !== scene || run.done) continue;
      const action = run.action;
      if (Math.max(action.startPhase, action.endPhase) !== at.phase) continue;
      if (action.type === 'dialogue' && (action.topic === undefined || run.said)) continue;
      const track = trackOf(run.actor);
      waits.push(
        `#${String(action.index)} ${action.type} of ${await actorName(run.actor)} (${[...track.flags].join(' ') || 'staged'}, runs ${track.pack} ${track.procedure})`,
      );
    }
    // Waiting on its conditions alone is the data's (a scene waiting for the player to come).
    await add(
      waits.length > 0 ? deviations : notes,
      end,
      scene,
      `phase ${String(at.phase)} has waited ${String(Math.round(end - at.since))} s${waits.length > 0 ? ` on ${waits.join('; ')}` : ' (on its completion conditions)'}`,
    );
  }

  console.log(
    `\nTRACE: ${String(events.length)} events, ${String(end)} s, scenes: ${(await Promise.all([...seen].map(sceneName))).join(', ')}`,
  );
  console.log(
    deviations.length === 0
      ? 'no deviations'
      : `\n${String(deviations.length)} deviations:\n${deviations.join('\n')}`,
  );
  if (notes.length > 0) console.log(`\n${String(notes.length)} notes:\n${notes.join('\n')}`);
}

const sceneIds = new Map<string, number | undefined>();
/** A scene by the name the director's trace gives it (its editor id, else its hex id). */
async function sceneId(name: string): Promise<number | undefined> {
  if (!sceneIds.has(name)) sceneIds.set(name, await find(name, 'SCEN'));
  return sceneIds.get(name);
}

// --- How town scenes start ------------------------------------------------------------------

/**
 * Every quest with scenes that the Actor Dialogue event does not start (town and street
 * scenes, intros, bards; docs/ai.md "Town scenes"): how it starts (with the game, by a story
 * manager event, by scripts only), the trigger boxes whose scripts name it or its scenes and
 * whether they wait for the player (src/scripting/runtime/trigger-gates.ts), and what each
 * scene's first phase waits for. `pattern` filters the quests by editor id.
 */
async function printStarts(pattern: RegExp | undefined): Promise<void> {
  const events = new Map<number, Set<string>>();
  const nodes = new Map<number, StoryNode>();
  for (const type of ['SMEN', 'SMBN', 'SMQN']) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record && !record.deleted) nodes.set(formId, parseStoryNode(record));
    }
  }
  for (const node of nodes.values()) {
    let root: StoryNode | undefined = node;
    while (root && root.kind !== 'event') root = nodes.get(root.parent);
    for (const { quest } of node.quests) {
      const set = events.get(quest) ?? new Set<string>();
      set.add(root?.event ?? '?');
      events.set(quest, set);
    }
  }
  const byQuest = new Map<number, SceneRecord[]>();
  for (const formId of db.formIdsOfType('SCEN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const scene = parseScene(record);
    if (scene.quest === undefined) continue;
    byQuest.set(scene.quest, [...(byQuest.get(scene.quest) ?? []), scene]);
  }
  // The trigger boxes (references with a primitive) whose scripts name a quest or scene.
  const sceneIds = new Set([...byQuest.values()].flat().map((scene) => scene.formId));
  const triggers = new Map<number, { reference: number; scripts: string[]; cell: number }[]>();
  const enterAsks = new Map<string, Promise<boolean>>();
  const asksForPlayer = (name: string): Promise<boolean> => {
    const key = name.toLowerCase();
    let found = enterAsks.get(key);
    if (!found) {
      found = triggerEnterAsksForPlayer(key, (script) => db.script(script));
      enterAsks.set(key, found);
    }
    return found;
  };
  const scripted: { reference: number; base: number; cell: number; vmad?: Uint8Array }[] = [];
  await db.scan(
    ['REFR'],
    () => true,
    (record) => {
      if (record.deleted || !record.fields.has('XPRM')) return;
      const location = db.locate(record.formId);
      const group = location && db.parentGroup(location);
      const vmad = record.fields.first('VMAD');
      scripted.push({
        reference: record.formId,
        base: record.formIdField('NAME') ?? 0,
        cell: group?.label ?? 0,
        ...(vmad && { vmad: vmad.slice() }),
      });
    },
  );
  for (const placed of scripted) {
    const named = new Set<number>();
    const scripts: string[] = [];
    const found = { player: false };
    const read = async (formId: number, data: Uint8Array | undefined): Promise<void> => {
      const record = await db.get(formId);
      if (!record || !data) return;
      for (const script of parseVmad(data, record.type).scripts) {
        const forms = referencedForms(script).map((local) =>
          record.formIdAt(Uint8Array.of(local, local >>> 8, local >>> 16, local >>> 24)),
        );
        if (!forms.some((form) => byQuest.has(form) || sceneIds.has(form))) continue;
        for (const form of forms) named.add(form);
        found.player ||= forms.includes(0x14) || (await asksForPlayer(script.name));
        scripts.push(script.name);
      }
    };
    await read(placed.reference, placed.vmad);
    const base = await db.get(placed.base);
    await read(placed.base, base?.fields.first('VMAD'));
    for (const form of named) {
      const quest = byQuest.has(form)
        ? form
        : [...byQuest].find(([, scenes]) => scenes.some((s) => s.formId === form))?.[0];
      if (quest === undefined) continue;
      const list = triggers.get(quest) ?? [];
      if (!list.some((entry) => entry.reference === placed.reference)) {
        list.push({
          reference: placed.reference,
          scripts: found.player ? scripts.map((name) => `${name}, for the player`) : scripts,
          cell: placed.cell,
        });
      }
      triggers.set(quest, list);
    }
  }
  const counts = new Map<string, number>();
  for (const [questId, scenes] of byQuest) {
    const record = await db.get(questId);
    if (!record) continue;
    const quest = parseQuest(record);
    const started = events.get(questId) ?? new Set<string>();
    if (started.has('ADIA') || quest.event === 'ADIA') continue;
    if (pattern && !pattern.test(quest.editorId)) continue;
    const how = [
      (quest.flags & QuestFlag.startGameEnabled) !== 0 ? 'with the game' : '',
      started.size > 0 ? `by the story manager (${[...started].join(', ')})` : '',
    ].filter((part) => part !== '');
    const kind = how.length > 0 ? how.join(' and ') : 'by scripts only';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    console.log(`${quest.editorId} [${hex(questId)}]: starts ${kind}`);
    for (const trigger of triggers.get(questId) ?? []) {
      const at = parseReference((await db.get(trigger.reference)) ?? record).position;
      const cell = await editorId(trigger.cell);
      console.log(
        `  trigger ${await editorId(trigger.reference)} (${trigger.scripts.join('; ')}) in ${cell} at ${at.map(Math.round).join(',')}`,
      );
    }
    for (const scene of scenes) {
      const flags = [
        (scene.flags & SceneFlag.beginOnQuestStart) !== 0 ? 'begins with its quest' : '',
        (scene.flags & SceneFlag.repeatConditionsWhileTrue) !== 0 ? 'repeats' : '',
      ].filter((part) => part !== '');
      const first = scene.phases[0];
      const waits = first ? await conditionsText(first.completionConditions, quest) : '';
      const holds = await conditionsText(scene.conditions, quest);
      console.log(
        `  ${scene.editorId}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}${holds ? `; plays while ${holds}` : ''}; its first phase waits for ${waits || 'its actions'}`,
      );
    }
  }
  console.log(
    `\n${[...counts].map(([kind, count]) => `${String(count)} start ${kind}`).join('; ')}`,
  );
}

// --- Main -----------------------------------------------------------------------------------

if (values.starts !== undefined) {
  await printStarts(values.starts === '' ? undefined : new RegExp(values.starts, 'i'));
  process.exit(0);
}

const scenes: SceneRecord[] = [];
if (values.quest) {
  const quest = await find(values.quest, 'QUST');
  if (quest === undefined) throw new Error(`no quest ${values.quest}`);
  for (const formId of db.formIdsOfType('SCEN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const scene = parseScene(record);
    if (scene.quest === quest) scenes.push(scene);
  }
}
for (const name of positionals) {
  const formId = await find(name, 'SCEN');
  const scene = formId === undefined ? undefined : await sceneRecord(formId);
  if (!scene) throw new Error(`no scene ${name}`);
  scenes.push(scene);
}
if (!values.trace) {
  if (scenes.length === 0) {
    console.log('usage: node tools/scene-audit.ts <scene> | --quest <quest> [--trace <file>]');
    process.exit(1);
  }
  for (const scene of scenes) await printScene(scene);
} else {
  await auditTrace(
    readTrace(values.trace),
    scenes.length > 0 ? new Set(scenes.map((scene) => scene.formId)) : undefined,
  );
}
