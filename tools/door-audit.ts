// Every door and gate the game's scripts open or shut (docs/scripting.md, "Doors and gates"):
// the calls of the load order's Papyrus scripts that swing a reference (ObjectReference.SetOpen,
// a two-state activator's own SetOpen, PlayAnimation / PlayAnimationAndWait,
// PlayGamebryoAnimation), the references they act on (a script property's value, the
// reference the script is attached to, a quest alias), and how each reference swings: a door's
// open and close sequences, a behavior graph, or nothing to swing; whether its collision
// follows (keyframed bodies on the nodes its sequences move); and the references the engine
// would leave standing still.
//
//   node tools/door-audit.ts            the counts and the references left still
//   node tools/door-audit.ts --list     every reference with its calls
//   node tools/door-audit.ts <text>     the references whose editor id contains <text>

import { parseVmad, type AttachedScript } from '../src/formats/esm/vmad.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import type { PexScript, PexValue } from '../src/formats/pex/pex.ts';
import { buildCollision } from '../src/physics/collision-data.ts';
import { buildSequences } from '../src/render/animation.ts';
import { parseQuest } from '../src/world/quest-records.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

/** The calls that swing a reference, by their lower-case name. */
const SWINGS = new Set([
  'setopen',
  'playanimation',
  'playanimationandwait',
  'playgamebryoanimation',
]);
/** The calls that fetch an alias's reference (its target is the alias, filled at run time). */
const ALIAS_GETS = new Set(['getref', 'getreference', 'getactorref', 'getactorreference']);
/** Record types whose VMAD attaches scripts that may swing something. */
const ATTACHING = ['REFR', 'ACHR', 'QUST', 'SCEN', 'INFO', 'PACK', 'DOOR', 'ACTI', 'FURN', 'NPC_'];

type Target =
  | { readonly kind: 'self' }
  | { readonly kind: 'property'; readonly name: string }
  | { readonly kind: 'alias'; readonly name: string }
  | { readonly kind: 'other' };

interface SwingCall {
  readonly call: string;
  readonly target: Target;
  /** The animation event or sequence a PlayAnimation names, if a literal. */
  readonly event: string | undefined;
}

const args = process.argv.slice(2);
const listAll = args.includes('--list');
const filter = args.find((arg) => !arg.startsWith('--'))?.toLowerCase();
const hex = (id: number): string => id.toString(16).padStart(8, '0');

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const id = (value: PexValue | undefined): string | undefined =>
  value?.kind === 'identifier' ? value.name.toLowerCase() : undefined;

/** A script's swinging calls (its parents' too: their `self` is the same reference). */
const callsOf = new Map<string, Promise<SwingCall[]>>();
function swingCalls(name: string): Promise<SwingCall[]> {
  const key = name.toLowerCase();
  let pending = callsOf.get(key);
  if (!pending) {
    pending = (async () => {
      const script = await db.script(key);
      if (!script) return [];
      const own = readCalls(script);
      const parent = script.objects[0]?.parent;
      return parent ? [...own, ...(await swingCalls(parent))] : own;
    })();
    callsOf.set(key, pending);
  }
  return pending;
}

/** The swinging calls of a script's own functions, each target traced back one assignment at a time. */
function readCalls(script: PexScript): SwingCall[] {
  const calls: SwingCall[] = [];
  for (const object of script.objects) {
    const byVariable = new Map<string, string>();
    for (const property of object.properties) {
      if (property.autoVariable) byVariable.set(property.autoVariable.toLowerCase(), property.name);
    }
    for (const state of object.states) {
      for (const fn of state.functions) {
        const sources = new Map<string, Target>();
        const traced = (value: PexValue | undefined): Target => {
          const name = id(value);
          if (name === undefined) return { kind: 'other' };
          if (name === 'self') return { kind: 'self' };
          const property = byVariable.get(name);
          if (property !== undefined) return { kind: 'property', name: property };
          return sources.get(name) ?? { kind: 'other' };
        };
        for (const { op, args: operands } of fn.code) {
          if (op === 'assign' || op === 'cast') {
            const into = id(operands[0]);
            if (into !== undefined) sources.set(into, traced(operands[1]));
          } else if (op === 'propget') {
            const into = id(operands[2]);
            const property = id(operands[0]);
            if (into !== undefined && property !== undefined && id(operands[1]) === 'self') {
              sources.set(into, { kind: 'property', name: property });
            }
          } else if (op === 'callmethod') {
            const method = id(operands[0]) ?? '';
            const result = id(operands[2]);
            if (ALIAS_GETS.has(method) && result !== undefined) {
              const alias = traced(operands[1]);
              sources.set(
                result,
                alias.kind === 'property' ? { kind: 'alias', name: alias.name } : { kind: 'other' },
              );
            }
            if (!SWINGS.has(method)) continue;
            const event = operands[4];
            calls.push({
              call: method,
              target: traced(operands[1]),
              event: event?.kind === 'string' ? event.value : undefined,
            });
          }
        }
      }
    }
  }
  return calls;
}

/** How a model swings: its sequences, its behavior graph, its collision on moving nodes. */
interface Swinging {
  readonly sequences: readonly string[];
  readonly graph: string | undefined;
  readonly movingBodies: number;
  readonly fixedBodies: number;
}
const swingingOf = new Map<string, Promise<Swinging | undefined>>();
function modelSwinging(model: string): Promise<Swinging | undefined> {
  const key = model.toLowerCase();
  let pending = swingingOf.get(key);
  if (!pending) {
    pending = (async () => {
      const path = key.startsWith('meshes\\') ? key : `meshes\\${key}`;
      if (!vfs.has(path)) return undefined;
      const file = parseNif(await vfs.read(path));
      const graph = file.blocks.find((block) => block.kind === 'behavior-graph-extra-data');
      const sequences = buildSequences(file, graph !== undefined);
      const collision = buildCollision(file);
      return {
        sequences: [...(sequences?.byName.keys() ?? [])],
        graph: graph?.kind === 'behavior-graph-extra-data' ? graph.graph : undefined,
        movingBodies: collision.bodies.filter((body) => body.motion === 'keyframed').length,
        fixedBodies: collision.bodies.filter((body) => body.motion === 'fixed').length,
      };
    })().catch(() => undefined);
    swingingOf.set(key, pending);
  }
  return pending;
}

/** A reference some script swings, with what swings it. */
interface Swung {
  readonly reference: number;
  readonly by: Set<string>;
}
const swung = new Map<number, Swung>();
/** Bases whose own scripts swing `self`: every reference of them is swung so. */
const selfBases = new Map<number, Set<string>>();
let aliasTargets = 0;
let otherTargets = 0;
const note = (reference: number, by: string): void => {
  let entry = swung.get(reference);
  if (!entry) {
    entry = { reference, by: new Set() };
    swung.set(reference, entry);
  }
  entry.by.add(by);
};

/** The form a script property's object value names on a record. */
function propertyForm(
  record: GameRecord,
  script: AttachedScript,
  name: string,
): number | undefined {
  const property = script.properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (property?.value.type !== 'object' || property.value.value.formId === 0) return undefined;
  return db.toGlobal(record.plugin, property.value.value.formId);
}

/** The reference a quest alias is forced to (its property's object value names quest and alias). */
async function forcedAlias(
  record: GameRecord,
  script: AttachedScript,
  name: string,
): Promise<number | undefined> {
  const property = script.properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (property?.value.type !== 'object' || property.value.value.alias < 0) return undefined;
  const questId =
    property.value.value.formId === 0
      ? record.formId
      : db.toGlobal(record.plugin, property.value.value.formId);
  const quest = await db.get(questId);
  if (quest?.type !== 'QUST') return undefined;
  const alias = parseQuest(quest).aliases.find((entry) => entry.id === property.value.value.alias);
  return alias?.fill.kind === 'forced' ? alias.fill.form : undefined;
}

for (const type of ATTACHING) {
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    const data = record?.fields.first('VMAD');
    if (!record || !data) continue;
    let attached: AttachedScript[];
    try {
      const vmad = parseVmad(data, record.type);
      attached = [...vmad.scripts, ...vmad.aliases.flatMap((alias) => alias.scripts)];
    } catch {
      continue;
    }
    for (const script of attached) {
      for (const call of await swingCalls(script.name)) {
        const by = `${script.name}.${call.call}${call.event ? `(${call.event})` : ''}`;
        if (call.target.kind === 'self') {
          if (record.type === 'REFR') note(formId, by);
          else if (record.type !== 'QUST' && record.type !== 'SCEN' && record.type !== 'INFO') {
            const bases = selfBases.get(formId) ?? new Set();
            bases.add(by);
            selfBases.set(formId, bases);
          }
        } else if (call.target.kind === 'property') {
          const form = propertyForm(record, script, call.target.name);
          const target = form === undefined ? undefined : db.locate(form);
          if (form !== undefined && target && db.typeAt(target) === 'REFR') note(form, by);
          else otherTargets++;
        } else if (call.target.kind === 'alias') {
          const form = await forcedAlias(record, script, call.target.name);
          const target = form === undefined ? undefined : db.locate(form);
          if (form !== undefined && target && db.typeAt(target) === 'REFR') note(form, by);
          else aliasTargets++;
        } else otherTargets++;
      }
    }
  }
}

// The references of bases that swing themselves.
if (selfBases.size > 0) {
  for (const formId of db.formIdsOfType('REFR')) {
    const record = await db.get(formId);
    const base = record?.formIdField('NAME');
    const by = base === undefined ? undefined : selfBases.get(base);
    if (by) for (const call of by) note(formId, call);
  }
}

/** How the engine swings a reference (docs/scripting.md, "Doors and gates"). */
type Kind =
  | 'door: sequences'
  | 'door: graph'
  | 'load door'
  | 'activator: graph'
  | 'activator: sequences'
  | 'nothing to swing'
  | 'no model';
const counts = new Map<string, number>();
const count = (key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
const still: string[] = [];
const lines: string[] = [];
for (const { reference, by } of swung.values()) {
  const record = await db.get(reference);
  const base = record?.formIdField('NAME');
  const baseRecord = base === undefined ? undefined : await db.get(base);
  if (!record || !baseRecord) continue;
  const model = baseRecord.fields.zstring('MODL');
  const swinging = model ? await modelSwinging(model) : undefined;
  const door = baseRecord.type === 'DOOR';
  let kind: Kind;
  if (door && record.fields.has('XTEL')) kind = 'load door';
  else if (!swinging) kind = 'no model';
  else if (swinging.graph) kind = door ? 'door: graph' : 'activator: graph';
  else if (swinging.sequences.length > 0) kind = door ? 'door: sequences' : 'activator: sequences';
  else kind = 'nothing to swing';
  count(`${baseRecord.type} · ${kind}`);
  const usesSetOpen = [...by].some((call) => call.toLowerCase().includes('.setopen'));
  // A door's open sequence (or its graph) swings it; the collision follows on keyframed bodies.
  const opens = swinging?.sequences.includes('open') === true || swinging?.graph !== undefined;
  const follows = (swinging?.movingBodies ?? 0) > 0;
  if (door && usesSetOpen && kind !== 'load door') {
    count(`SetOpen doors · ${opens ? 'swing' : 'nothing to swing'}`);
    // A graph's door: the bodies on the nodes its clips move follow its pose (made keyframed
    // as it is placed: PhysicsWorld), which the model alone does not tell.
    const collision = swinging?.graph
      ? 'follows the graph'
      : follows
        ? 'follows its sequences'
        : (swinging?.fixedBodies ?? 0) > 0
          ? 'stays (no body on a moving node)'
          : 'none';
    count(`SetOpen doors · collision ${collision}`);
    if (record.fields.has('ONAM')) count('SetOpen doors · placed open (ONAM)');
    if (!opens) still.push(`${record.editorId ?? ''} [${hex(reference)}] ${model ?? ''}`);
  }
  const line =
    `${record.editorId ?? ''} [${hex(reference)}] ${baseRecord.type} ${baseRecord.editorId ?? ''} ` +
    `${kind}${swinging ? ` seq(${swinging.sequences.join(',')})` : ''}` +
    `${swinging?.graph ? ` graph ${swinging.graph}` : ''} bodies ${String(swinging?.movingBodies ?? 0)} moving ` +
    `${String(swinging?.fixedBodies ?? 0)} fixed${record.fields.has('ONAM') ? ' ONAM' : ''} by ${[...by].join(', ')}`;
  if (listAll || (filter !== undefined && line.toLowerCase().includes(filter))) lines.push(line);
}

console.log(
  `References scripts swing: ${String(swung.size)} (calls on aliases not forced ${String(aliasTargets)}, on others ${String(otherTargets)}; bases that swing themselves ${String(selfBases.size)})`,
);
for (const [key, value] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${key}: ${String(value)}`);
}
if (still.length > 0) {
  console.log(`\nDoors scripts open that have nothing to swing (${String(still.length)}):`);
  for (const line of still.slice(0, 40)) console.log(`  ${line}`);
}
if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
await db.close();
