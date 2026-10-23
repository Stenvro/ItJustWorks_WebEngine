// Idles and actions against the real files (src/ai/idle-records.ts): the idle tree of the load
// order (IDLE under AACT, per behavior graph), idle markers (IDLM) and the furniture data AI
// reads (src/world/furniture-records.ts).
//
//   node tools/idle-info.ts --parse                     counts, idles per action, broken links
//   node tools/idle-info.ts --tree ActionDraw [0_master] an action's (or idle's) subtree per
//                                                        behavior graph (matching the filter)
//   node tools/idle-info.ts --idlm                      idle markers with their idles
//   node tools/idle-info.ts --furn                      the furniture's AI data: distinct values
//   node tools/idle-info.ts --cameras                   the kill cameras' tree (CPTH) with its
//                                                        shots (CAMS): conditions, times, models

import {
  behaviorGraphKey,
  IdleFlag,
  parseIdleMarker,
  readIdleTree,
  type IdleRecord,
  type IdleTree,
} from '../src/ai/idle-records.ts';
import { loadCharacterInfo } from '../src/formats/hkx/behavior.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import type { Condition } from '../src/scripting/conditions.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { parseRace } from '../src/world/actor-records.ts';
import { meshPath } from '../src/world/actors.ts';
import {
  FurnitureMarkerFlag,
  FurnitureMarkerType,
  parseFurniture,
} from '../src/world/furniture-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  parseCameraPath,
  parseCameraShot,
  type CameraPathRecord,
} from '../src/gameplay/combat/combat-records.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const hex = (id: number): string => id.toString(16).padStart(8, '0');
const names = new Map<number, string>();
const name = async (formId: number | undefined): Promise<string> => {
  if (formId === undefined || formId === 0) return '-';
  let known = names.get(formId);
  if (known === undefined) {
    known = (await db.get(formId))?.editorId ?? `?${hex(formId)}`;
    names.set(formId, known);
  }
  return known;
};
const add = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};
const list = <K>(map: Map<K, number>, show: (key: K) => string = String, top = Infinity): string =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([key, count]) => `${show(key)} ${String(count)}`)
    .join(', ');
const shortGraph = (graph: string): string => graph.split('\\').pop() ?? graph;

/** ConditionRunOn's values by name (src/scripting/conditions.ts). */
const RUN_ON_NAMES = [
  'subject',
  'target',
  'reference',
  'combatTarget',
  'linkedReference',
  'questAlias',
  'packageData',
  'eventData',
];

/** "GetIsRace(DraugrRace)@target==1 OR ..." */
async function describeConditions(conditions: readonly Condition[]): Promise<string> {
  const parts: string[] = [];
  for (const condition of conditions) {
    const operator = ['==', '!=', '>', '>=', '<', '<='][condition.operator] ?? '?';
    const comparand =
      typeof condition.comparand === 'number'
        ? String(condition.comparand)
        : await name(condition.comparand.global);
    // The first parameter: its string (CIS1), the form it names (object ids under 0x800 are
    // the engine's own forms: numbers, rather), else its number.
    const param =
      condition.strings.length > 0
        ? condition.strings.join(', ')
        : (condition.raw1 & 0xffffff) >= 0x800 && db.locate(condition.form)
          ? await name(condition.form)
          : condition.raw1 !== 0
            ? String(condition.raw1)
            : '';
    // What it runs on when not the subject: "@target", "@combatTarget", "@<reference>", ...;
    // "swap" for Swap Subject and Target.
    const runOn =
      condition.runOn === 0
        ? ''
        : condition.runOn === 2
          ? `@${await name(condition.reference)}`
          : `@${RUN_ON_NAMES[condition.runOn] ?? String(condition.runOn)}`;
    const swap = condition.swapSubjectAndTarget === true ? '(swap)' : '';
    parts.push(
      `${conditionFunctionName(condition.function)}(${param})${runOn}${swap}${operator}${comparand}${condition.or ? ' OR' : ''}`,
    );
  }
  return parts.join(' ');
}

/** The number of idles under a node (one graph, or all). */
const subtreeSize = (tree: IdleTree, parent: number, graph?: string): number =>
  tree
    .children(parent, graph)
    .reduce((sum, idle) => sum + 1 + subtreeSize(tree, idle.formId, graph), 0);

async function parseAll(): Promise<void> {
  const tree = await readIdleTree(db);
  const idles = [...tree.idles.values()];
  const markers = db.formIdsOfType('IDLM');
  console.log(
    `${String(idles.length)} IDLE, ${String(tree.actions.size)} AACT, ${String(markers.length)} IDLM`,
  );
  const plugins = new Map<string, number>();
  for (const idle of idles) {
    const location = db.locate(idle.formId);
    if (location) add(plugins, location.plugin.entry.name);
  }
  console.log(`IDLE winning versions by plugin: ${list(plugins)}`);
  const roots = [...tree.actions.values()]
    .map((action) => ({
      action,
      graphs: tree.graphsUnder(action.formId).length,
      size: subtreeSize(tree, action.formId),
    }))
    .filter((root) => root.graphs > 0)
    .sort((a, b) => b.size - a.size);
  const unused = [...tree.actions.values()].filter(
    (action) => tree.graphsUnder(action.formId).length === 0,
  );
  console.log(
    `${String(roots.length)} actions have idles; none: ${unused.map((action) => action.editorId).join(', ')}`,
  );
  for (const root of roots) {
    console.log(
      `  ${root.action.editorId} [${hex(root.action.formId)}]: ${String(root.size)} idles, ${String(root.graphs)} graphs`,
    );
  }
  console.log(`${String(tree.loose.length)} loose idles (no parent)`);
  const withChildren = idles.filter((idle) => tree.children(idle.formId).length > 0);
  const noEvent = idles.filter((idle) => idle.event === undefined);
  const groups = noEvent.filter((idle) => tree.children(idle.formId).length > 0);
  console.log(
    `${String(withChildren.length)} idles have children; ${String(noEvent.length)} have no event: ${String(groups.length)} groups, ${String(noEvent.length - groups.length)} leaves; ${String(withChildren.length - groups.length)} have an event and children`,
  );
  // Behavior graphs: DNAM, else inherited from the parent idle.
  const graphs = new Map<string, number>();
  let own = 0;
  let none = 0;
  let otherThanParent = 0;
  for (const idle of idles) {
    const graph = tree.graph(idle.formId);
    add(graphs, graph || '(none)');
    if (idle.behaviorGraph) own++;
    if (!graph) none++;
    const parent = idle.parent === undefined ? undefined : tree.idles.get(idle.parent);
    if (parent && idle.behaviorGraph && tree.graph(parent.formId) !== tree.graph(idle.formId)) {
      otherThanParent++;
      console.log(
        `  ${idle.editorId} names ${shortGraph(tree.graph(idle.formId))}, its parent ${parent.editorId} ${shortGraph(tree.graph(parent.formId))}`,
      );
    }
  }
  console.log(
    `${String(graphs.size)} behavior graphs; ${String(own)} idles name one (DNAM), ${String(idles.length - own - none)} inherit their parent's, ${String(none)} have none; ${String(otherThanParent)} name another than their parent's`,
  );
  console.log(`  idles per graph: ${list(graphs, shortGraph, 10)}, ...`);
  const flags = new Map<string, number>();
  for (const idle of idles) {
    add(flags, `0x${idle.flags.toString(16)}${idle.parent === undefined ? ' loose' : ''}`);
  }
  const looseFlag = idles.filter((idle) => (idle.flags & IdleFlag.loose) !== 0);
  console.log(
    `DATA flags: ${list(flags)}; 0x1 on ${String(looseFlag.length)}, all loose: ${String(looseFlag.every((idle) => idle.parent === undefined))}`,
  );
  const loops = new Map<string, number>();
  const delays = new Map<number, number>();
  for (const idle of idles) {
    add(loops, `${String(idle.loopMin)}/${String(idle.loopMax)}`);
    add(delays, idle.replayDelay);
  }
  console.log(
    `DATA looping min/max: ${list(loops)}; replay delay: ${list(delays, String, 8)}, ...`,
  );
  const sections = new Set(idles.map((idle) => idle.animationGroupSection));
  console.log(`DATA animation group section: ${String(sections.size)} distinct values`);
  const functions = new Map<string, number>();
  let conditioned = 0;
  for (const idle of idles) {
    if (idle.conditions.length > 0) conditioned++;
    for (const condition of idle.conditions)
      add(functions, conditionFunctionName(condition.function));
  }
  console.log(
    `${String(conditioned)} idles have conditions, ${String(functions.size)} functions; most used: ${list(functions, String, 16)}`,
  );
  const kinds = new Map<string, number>();
  for (const problem of tree.problems) add(kinds, problem.problem);
  console.log(`broken links: ${kinds.size === 0 ? 'none' : list(kinds)}`);
  for (const problem of tree.problems) {
    const idle = tree.idles.get(problem.idle);
    const plugin = db.locate(problem.idle)?.plugin.entry.name ?? '?';
    console.log(
      `  ${problem.problem}: ${idle?.editorId ?? '?'} [${hex(problem.idle)}] (${plugin}) under ${await name(idle?.parent)}, previous ${await name(idle?.previous)}`,
    );
  }
  await dlcInsertions(tree);
  await raceGraphs(tree);
}

/** The root behavior of every race's behavior projects against the graphs idles are for. */
async function raceGraphs(tree: IdleTree): Promise<void> {
  const projects = new Map<string, string[]>();
  for (const formId of db.formIdsOfType('RACE')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const race = parseRace(record);
    for (const project of new Set(race.behavior)) {
      if (!project) continue;
      const path = meshPath(project);
      projects.set(path, [...(projects.get(path) ?? []), race.editorId]);
    }
  }
  const graphs = new Set<string>();
  for (const idle of tree.idles.values()) graphs.add(tree.graph(idle.formId));
  const used = new Set<string>();
  const without: string[] = [];
  for (const [project, races] of projects) {
    let graph: string | undefined;
    try {
      const behavior = (await loadCharacterInfo(project, (path) => vfs.read(path))).behavior;
      graph = behavior === undefined ? undefined : behaviorGraphKey(behavior);
    } catch {
      graph = undefined;
    }
    if (graph !== undefined && graphs.has(graph)) used.add(graph);
    else
      without.push(
        `${project} (${races.length > 2 ? `${races.slice(0, 2).join(', ')}, ...` : races.join(', ')}): ${graph ?? 'does not load'}`,
      );
  }
  console.log(
    `${String(projects.size)} behavior projects of races; ${String(projects.size - without.length)} have a root behavior idles are for (${String(used.size)} of the ${String(graphs.size)} graphs)`,
  );
  for (const line of without) console.log(`  no idles: ${line}`);
  const unused = [...graphs].filter((graph) => !used.has(graph));
  if (unused.length > 0) console.log(`  graphs of no race's project: ${unused.join(', ')}`);
}

/** Idles under a parent from another plugin, and idles whose links a later plugin changes. */
async function dlcInsertions(tree: IdleTree): Promise<void> {
  let added = 0;
  let relinked = 0;
  for (const idle of tree.idles.values()) {
    const origin = db.origin(idle.formId)?.plugin;
    const parentOrigin = idle.parent === undefined ? undefined : db.origin(idle.parent)?.plugin;
    if (origin && parentOrigin && origin !== parentOrigin) added++;
    const versions = db.locateAll(idle.formId);
    const first = versions[0];
    if (!first || versions.length < 2) continue;
    const original = await db.read(first);
    const anam = original.fields.first('ANAM');
    const parent = anam && anam.length >= 8 ? original.formIdAt(anam, 0) : 0;
    const previous = anam && anam.length >= 8 ? original.formIdAt(anam, 4) : 0;
    if (parent !== (idle.parent ?? 0) || previous !== (idle.previous ?? 0)) relinked++;
  }
  console.log(
    `${String(added)} idles sit under a parent from another plugin; ${String(relinked)} have their parent or previous changed by a later plugin`,
  );
}

async function printIdle(
  tree: IdleTree,
  idle: IdleRecord,
  graph: string,
  depth: number,
): Promise<void> {
  const conditions = await describeConditions(idle.conditions);
  console.log(
    `${'  '.repeat(depth)}${idle.editorId} [${hex(idle.formId)}] ${idle.event ?? '(no event)'}${
      conditions ? `  if ${conditions}` : ''
    }`,
  );
  for (const child of tree.children(idle.formId, graph))
    await printIdle(tree, child, graph, depth + 1);
}

async function showTree(editorId: string, filter: string): Promise<void> {
  const tree = await readIdleTree(db);
  const action = tree.action(editorId);
  const idle = action
    ? undefined
    : [...tree.idles.values()].find(
        (candidate) => candidate.editorId.toLowerCase() === editorId.toLowerCase(),
      );
  const root = action?.formId ?? idle?.formId;
  if (root === undefined) {
    console.log(`${editorId}: no action or idle of that editor id`);
    return;
  }
  if (idle) {
    console.log(`under ${tree.rootAction(idle.formId)?.editorId ?? '(loose)'}`);
    await printIdle(tree, idle, tree.graph(idle.formId), 0);
    return;
  }
  for (const graph of tree.graphsUnder(root)) {
    if (!graph.includes(filter.toLowerCase())) continue;
    console.log(`${editorId} <${graph}>: ${String(subtreeSize(tree, root, graph))} idles`);
    for (const child of tree.children(root, graph)) await printIdle(tree, child, graph, 1);
  }
}

async function showMarkers(): Promise<void> {
  const tree = await readIdleTree(db);
  const flags = new Map<number, number>();
  const kinds = new Map<string, number>();
  let mismatched = 0;
  let empty = 0;
  let count = 0;
  for (const formId of db.formIdsOfType('IDLM')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const marker = parseIdleMarker(record);
    count++;
    add(flags, marker.flags);
    if (marker.count !== marker.idles.length) mismatched++;
    if (marker.idles.length === 0) empty++;
    const idles: string[] = [];
    for (const id of marker.idles) {
      const found = tree.idles.get(id);
      if (!found) {
        idles.push(`${await name(id)}?`);
        add(kinds, 'not an idle');
        continue;
      }
      add(
        kinds,
        found.parent === undefined ? 'loose' : `under ${tree.rootAction(id)?.editorId ?? '?'}`,
      );
      idles.push(`${found.editorId}${found.event ? `=${found.event}` : ''}`);
    }
    console.log(
      `${marker.editorId} [${hex(formId)}] flags 0x${marker.flags.toString(16)} timer ${String(marker.timer)}${
        marker.childCanUse ? ' child' : ''
      }: ${idles.join(', ') || '(no idles)'}`,
    );
  }
  console.log(
    `${String(count)} IDLM; IDLF ${list(flags, (value) => `0x${value.toString(16)}`)}; ${String(empty)} without idles; ${String(mismatched)} with IDLC not the IDLA count; their idles: ${list(kinds)}`,
  );
}

async function showFurniture(): Promise<void> {
  const counts = {
    records: 0,
    recordFlags: new Map<string, number>(),
    flags: new Map<string, number>(),
    interaction: new Map<string, number>(),
    markerFlags: new Map<string, number>(),
    can: new Map<string, number>(),
    shape: new Map<string, number>(),
    indices: new Map<number, number>(),
    disabled: new Map<string, number>(),
    keywords: new Map<string, number>(),
    spells: new Map<string, number>(),
    types: new Map<number, number>(),
    entries: new Map<string, number>(),
  };
  const show = (value: number): string => `0x${value.toString(16)}`;
  for (const formId of db.formIdsOfType('FURN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const furniture = parseFurniture(record);
    counts.records++;
    for (let bit = 0; bit < 32; bit++) {
      if (bit !== 5 && (furniture.recordFlags & (2 ** bit)) !== 0)
        add(counts.recordFlags, show(2 ** bit));
    }
    add(counts.flags, show(furniture.flags));
    add(counts.interaction, await name(furniture.interactionKeyword));
    const flags = furniture.markerFlags;
    if (flags === undefined) add(counts.markerFlags, 'no MNAM');
    for (let bit = 24; bit < 32 && flags !== undefined; bit++) {
      if ((flags & (2 ** bit)) !== 0) add(counts.markerFlags, show(2 ** bit));
    }
    for (const marker of furniture.markers) {
      add(counts.indices, marker.index);
      add(counts.disabled, show(marker.disabledEntries));
      add(counts.keywords, await name(marker.keyword));
    }
    add(counts.spells, await name(furniture.associatedSpell));
    let types = 0;
    for (const point of furniture.entryPoints) {
      add(counts.types, point.type);
      add(counts.entries, show(point.entries));
      types |= point.type;
    }
    // MNAM's high "can" bits against the types of the FNPR markers.
    const fit = (bit: number, type: number, label: string): void => {
      const set = ((flags ?? 0) & bit) !== 0;
      const has =
        furniture.entryPoints.length === 0 ? 'no FNPR' : (types & type) !== 0 ? 'has' : 'none';
      add(counts.can, `${label} ${set ? 'set' : 'clear'}/${has}`);
    };
    fit(FurnitureMarkerFlag.canSit, FurnitureMarkerType.sit, 'sit');
    fit(FurnitureMarkerFlag.canSleep, FurnitureMarkerType.sleep, 'sleep');
    fit(FurnitureMarkerFlag.canLean, FurnitureMarkerType.lean, 'lean');
    let active = 0;
    for (let bit = 0; bit < 24; bit++) if (((flags ?? 0) & (1 << bit)) !== 0) active++;
    add(
      counts.shape,
      `${String(active)} active/${String(furniture.markers.length)} ENAM/${String(furniture.entryPoints.length)} FNPR`,
    );
  }
  console.log(`${String(counts.records)} FURN`);
  console.log(`record flags: ${list(counts.recordFlags)}`);
  console.log(`FNAM: ${list(counts.flags)}`);
  console.log(`KNAM: ${list(counts.interaction)}`);
  console.log(`MNAM bits 24-31: ${list(counts.markerFlags)}`);
  console.log(`MNAM can-bits set/clear against FNPR types: ${list(counts.can)}`);
  console.log(`active markers / ENAM / FNPR: ${list(counts.shape, String, 12)}, ...`);
  console.log(`ENAM marker index: ${list(counts.indices)}`);
  console.log(`NAM0 disabled entry points: ${list(counts.disabled)}`);
  console.log(`FNMK: ${list(counts.keywords)}`);
  console.log(`NAM1: ${list(counts.spells)}`);
  console.log(`FNPR type: ${list(counts.types)}; entry points: ${list(counts.entries)}`);
}

/** The kill cameras' tree: every root path, then its children in order, with their shots. */
async function showCameras(): Promise<void> {
  const paths: CameraPathRecord[] = [];
  for (const formId of db.formIdsOfType('CPTH')) {
    const record = await db.get(formId);
    if (record && !record.deleted) paths.push(parseCameraPath(record));
  }
  const shotText = async (formId: number): Promise<string | undefined> => {
    const record = await db.get(formId);
    if (record?.type !== 'CAMS') return undefined;
    const shot = parseCameraShot(record);
    const imad =
      shot.imageSpaceModifier === undefined ? '' : ` imad ${await name(shot.imageSpaceModifier)}`;
    return (
      `${shot.editorId}(${shot.model ?? 'first person'} max ${shot.maxTime.toFixed(2)} ` +
      `min ${shot.minTime.toFixed(2)} time x${shot.globalTimeMult.toFixed(2)} ` +
      `player x${shot.playerTimeMult.toFixed(2)} target x${shot.targetTimeMult.toFixed(2)} ` +
      `at ${String(shot.location)} looks ${String(shot.target)} flags ${shot.flags.toString(16)}${imad})`
    );
  };
  const print = async (path: CameraPathRecord, depth: number): Promise<void> => {
    const conditions = await describeConditions(path.conditions);
    const shots: string[] = [];
    for (const shot of path.shots) {
      const text = await shotText(shot);
      if (text !== undefined) shots.push(text);
    }
    const indent = '  '.repeat(depth);
    const after = path.previous === undefined ? '' : ` after ${await name(path.previous)}`;
    console.log(
      `${indent}${path.editorId} [${hex(path.formId)}] zoom ${String(path.zoom)}${after}` +
        (conditions ? `  if ${conditions}` : ''),
    );
    if (shots.length > 0) console.log(`${indent}    shots ${shots.join(', ')}`);
    for (const child of paths.filter((other) => other.parent === path.formId))
      await print(child, depth + 1);
  };
  for (const root of paths.filter((path) => path.parent === undefined)) await print(root, 0);
}

if (args[0] === '--parse') await parseAll();
else if (args[0] === '--cameras') await showCameras();
else if (args[0] === '--tree') await showTree(args[1] ?? 'ActionIdle', args[2] ?? '');
else if (args[0] === '--idlm') await showMarkers();
else if (args[0] === '--furn') await showFurniture();
else
  console.log(
    'usage: node tools/idle-info.ts --parse | --tree <action or idle> [graph] | --idlm | --furn | --cameras',
  );
