// Idles and actions: IDLE (an idle animation: conditions, the behavior graph it is for, the
// animation event it sends, its place in the idle tree), AACT (an action: a root of the tree)
// and IDLM (an idle marker: the idles an actor plays at it). The tree is the Creation Kit's
// Idle Animations window: each IDLE's parent is an action or another IDLE; under a parent the
// idles of one behavior graph are ordered by each naming the sibling before it. An action
// resolves to the first idle under it whose conditions hold. Platform-independent: conditions
// are valued by the caller.
// Layouts: xEdit (wbDefinitionsTES5 IDLE / AACT / IDLM, wbIdleAnimation), CommonLibSSE-NG
// (TESIdleForm, BGSAction, BGSIdleCollection, BGSIdleMarker), UESP "Skyrim Mod:Mod File
// Format/IDLE". Notes: docs/formats/esm.md ("Idles and actions").

import { view } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { normalizePath } from '../formats/paths.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord, RecordDatabase } from '../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'flags' | 'fields' | 'formIdAt'>;

/**
 * IDLE DATA byte 2. 0x1 is set on exactly the idles without a parent (xEdit "Loose"; CommonLib
 * calls it kParent). The Creation Kit wiki: sequence, no attacking and blocking are no longer
 * used.
 */
export const IdleFlag = {
  loose: 0x01,
  sequence: 0x02,
  noAttacking: 0x04,
  blocking: 0x08,
} as const;

export interface IdleRecord {
  readonly formId: number;
  readonly editorId: string;
  /** CTDA: when it may play (run on the actor; CIS1 / CIS2 strings follow their CTDA). */
  readonly conditions: readonly Condition[];
  /** DNAM: the behavior graph it is for ("Actors\Character\Behaviors\0_Master.hkx"). */
  readonly behaviorGraph: string | undefined;
  /** ENAM: the animation event it sends to the actor's behavior graph. */
  readonly event: string | undefined;
  /** ANAM: its parent, an action (AACT) or an idle; undefined: a loose idle. */
  readonly parent: number | undefined;
  /** ANAM: the sibling before it; undefined: the first of its siblings. */
  readonly previous: number | undefined;
  /** DATA: looping seconds (both 255: forever). */
  readonly loopMin: number;
  readonly loopMax: number;
  /** DATA: IdleFlag. */
  readonly flags: number;
  /** DATA: "animation group section"; in Skyrim's data it holds stray bytes. */
  readonly animationGroupSection: number;
  readonly replayDelay: number;
}

/** AACT: an action, a root of the idle tree (ActionIdle, ActionDraw, ActionRightAttack, ...). */
export interface ActionRecord {
  readonly formId: number;
  readonly editorId: string;
  /** CNAM: its colour in the Creation Kit (r, g, b, a). */
  readonly color: readonly [number, number, number, number];
}

/** IDLF (BGSIdleCollection::IdleFlags; xEdit's names in brackets). */
export const IdleCollectionFlag = {
  /** Plays its idles in order ("Run In Sequence"), else picks among them. */
  pickSequence: 0x01,
  oldPickConditions: 0x02,
  doOnce: 0x04,
  looseOnly: 0x08,
  /** Sandboxing actors do not use it ("Ignored By Sandbox"). */
  noSandbox: 0x10,
} as const;

/** Record flags of IDLM (and FURN). */
export const IdleMarkerRecordFlag = {
  childCanUse: 0x20000000,
} as const;

/** The idles of an idle marker, or of a package (wbIdleAnimation: IDLF, IDLC, IDLT, IDLA). */
export interface IdleCollection {
  /** IDLF: IdleCollectionFlag. */
  readonly flags: number;
  /** IDLC: the idle count IDLA should have. */
  readonly count: number;
  /** IDLT: seconds between idles. */
  readonly timer: number;
  /** IDLA: the idles (IDLE), in order. */
  readonly idles: readonly number[];
}

/** IDLM: an idle marker. */
export interface IdleMarkerRecord extends IdleCollection {
  readonly formId: number;
  readonly editorId: string;
  /** Record flag 29: children can use it. */
  readonly childCanUse: boolean;
  /** MODL: its editor model. */
  readonly model: string | undefined;
}

const formOrUndefined = (record: RecordSource, data: Uint8Array, at: number): number | undefined =>
  data.length >= at + 4 && view(data).getUint32(at, true) !== 0
    ? record.formIdAt(data, at)
    : undefined;

/** A string field's text; undefined when it is missing or empty. */
const text = (record: RecordSource, type: string): string | undefined => {
  const value = record.fields.zstring(type);
  return value === '' ? undefined : value;
};

export function parseIdle(record: RecordSource): IdleRecord {
  const fields = record.fields.list;
  const conditions: Condition[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i]?.type !== 'CTDA') continue;
    const condition = conditionAt(fields, i, record);
    if (condition) conditions.push(condition);
  }
  const anam = record.fields.first('ANAM');
  const data = record.fields.first('DATA');
  const v = data && data.length >= 6 ? view(data) : undefined;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    conditions,
    behaviorGraph: text(record, 'DNAM'),
    event: text(record, 'ENAM'),
    parent: anam && formOrUndefined(record, anam, 0),
    previous: anam && formOrUndefined(record, anam, 4),
    loopMin: v?.getUint8(0) ?? 0,
    loopMax: v?.getUint8(1) ?? 0,
    flags: v?.getUint8(2) ?? 0,
    animationGroupSection: v?.getUint8(3) ?? 0,
    replayDelay: v?.getUint16(4, true) ?? 0,
  };
}

export function parseAction(record: RecordSource): ActionRecord {
  const cnam = record.fields.first('CNAM');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    color: [cnam?.[0] ?? 0, cnam?.[1] ?? 0, cnam?.[2] ?? 0, cnam?.[3] ?? 0],
  };
}

/** The idle collection of a record (IDLM; PACK has the same fields), or undefined without one. */
export function parseIdleCollection(
  record: Pick<GameRecord, 'fields' | 'formIdAt'>,
): IdleCollection | undefined {
  const fields = record.fields;
  if (!fields.has('IDLF') && !fields.has('IDLA')) return undefined;
  const idla = fields.first('IDLA');
  const idles: number[] = [];
  for (let at = 0; idla && at + 4 <= idla.length; at += 4) {
    if (view(idla).getUint32(at, true) !== 0) idles.push(record.formIdAt(idla, at));
  }
  return {
    flags: fields.first('IDLF')?.[0] ?? 0,
    count: fields.first('IDLC')?.[0] ?? idles.length,
    timer: fields.f32('IDLT') ?? 0,
    idles,
  };
}

export function parseIdleMarker(record: RecordSource): IdleMarkerRecord {
  const collection = parseIdleCollection(record);
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    childCanUse: (record.flags & IdleMarkerRecordFlag.childCanUse) !== 0,
    model: record.fields.zstring('MODL'),
    flags: collection?.flags ?? 0,
    count: collection?.count ?? 0,
    timer: collection?.timer ?? 0,
    idles: collection?.idles ?? [],
  };
}

/**
 * A behavior graph path as idles and behavior projects compare (lower case, backslashes,
 * without a leading "meshes\"): "actors\character\behaviors\0_master.hkx".
 */
export function behaviorGraphKey(path: string): string {
  return normalizePath(path).replace(/^meshes\\/, '');
}

/** A link in the tree that does not hold. */
export interface IdleTreeProblem {
  readonly idle: number;
  readonly problem:
    'parent missing' | 'previous missing' | 'previous not a sibling' | 'previous shared' | 'cycle';
}

/**
 * The idle tree of a load order: per action and idle its children, per behavior graph in
 * order. Built from the winning version of every AACT and IDLE.
 */
export class IdleTree {
  readonly actions: ReadonlyMap<number, ActionRecord>;
  readonly idles: ReadonlyMap<number, IdleRecord>;
  /** Idles without a parent (the Creation Kit's LOOSE section), in load order. */
  readonly loose: readonly IdleRecord[];
  readonly problems: readonly IdleTreeProblem[];
  /** Per idle, its graph (behaviorGraphKey): its own DNAM, else its nearest parent's. */
  readonly #graphs = new Map<number, string>();
  /** Per parent, its children by graph (in the order the graphs first appear). */
  readonly #children = new Map<number, Map<string, IdleRecord[]>>();
  readonly #actionsByName: ReadonlyMap<string, ActionRecord>;

  /** `idles` in load order (a record's first appearance): it orders siblings that share a previous. */
  constructor(actions: Iterable<ActionRecord>, idles: Iterable<IdleRecord>) {
    const actionMap = new Map<number, ActionRecord>();
    for (const action of actions) actionMap.set(action.formId, action);
    const idleMap = new Map<number, IdleRecord>();
    for (const idle of idles) idleMap.set(idle.formId, idle);
    this.actions = actionMap;
    this.idles = idleMap;
    this.#actionsByName = new Map(
      [...actionMap.values()].map((action) => [action.editorId.toLowerCase(), action]),
    );
    const problems: IdleTreeProblem[] = [];
    const loose: IdleRecord[] = [];
    const siblings = new Map<number, Map<string, IdleRecord[]>>();
    for (const idle of idleMap.values()) {
      if (idle.parent === undefined) {
        loose.push(idle);
        continue;
      }
      if (!actionMap.has(idle.parent) && !idleMap.has(idle.parent)) {
        problems.push({ idle: idle.formId, problem: 'parent missing' });
        continue;
      }
      const byGraph = siblings.get(idle.parent) ?? new Map<string, IdleRecord[]>();
      const graph = this.graph(idle.formId);
      const list = byGraph.get(graph) ?? [];
      list.push(idle);
      byGraph.set(graph, list);
      siblings.set(idle.parent, byGraph);
    }
    for (const [parent, byGraph] of siblings) {
      const ordered = new Map<string, IdleRecord[]>();
      for (const [graph, list] of byGraph) {
        ordered.set(
          graph,
          orderSiblings(list, (id) => idleMap.has(id), problems),
        );
      }
      this.#children.set(parent, ordered);
    }
    this.loose = loose;
    this.problems = problems;
  }

  /**
   * The behavior graph an idle is for (behaviorGraphKey): its own DNAM, else that of its
   * nearest parent idle with one; '' for none.
   */
  graph(idle: number): string {
    const known = this.#graphs.get(idle);
    if (known !== undefined) return known;
    const chain: number[] = [];
    let graph = '';
    let at: number | undefined = idle;
    while (at !== undefined && !chain.includes(at)) {
      const cached = this.#graphs.get(at);
      if (cached !== undefined) {
        graph = cached;
        break;
      }
      const record = this.idles.get(at);
      if (!record) break;
      chain.push(at);
      if (record.behaviorGraph) {
        graph = behaviorGraphKey(record.behaviorGraph);
        break;
      }
      at = record.parent;
    }
    for (const id of chain) this.#graphs.set(id, graph);
    return graph;
  }

  /**
   * The children of an action or idle in order: those for one behavior graph
   * (behaviorGraphKey), or (undefined) every graph's in turn.
   */
  children(parent: number, graph?: string): readonly IdleRecord[] {
    const byGraph = this.#children.get(parent);
    if (!byGraph) return [];
    if (graph !== undefined) return byGraph.get(graph) ?? [];
    return [...byGraph.values()].flat();
  }

  /** The behavior graphs that have idles under an action or idle. */
  graphsUnder(parent: number): string[] {
    return [...(this.#children.get(parent)?.keys() ?? [])];
  }

  /** An action by its editor id (case-insensitive). */
  action(editorId: string): ActionRecord | undefined {
    return this.#actionsByName.get(editorId.toLowerCase());
  }

  /** The action at the root of an idle's branch, or undefined for a loose idle. */
  rootAction(idle: number): ActionRecord | undefined {
    const seen = new Set<number>();
    let at: number | undefined = idle;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const action = this.actions.get(at);
      if (action) return action;
      at = this.idles.get(at)?.parent;
    }
    return undefined;
  }

  /**
   * The idle an action picks for an actor whose behavior graph is `graph`
   * (behaviorGraphKey): among the action's children for that graph, in order, the first that
   * `accepts` (its conditions hold on the actor) is taken; if it has children, the first of
   * those that `accepts` is taken in turn, down the tree. The deepest idle taken is the
   * result: when it has no animation event (an empty leaf, or a group none of whose children
   * qualified), the action plays nothing. Undefined: no child of the action qualifies.
   * Sources: the Creation Kit wiki "Idle Animations" (idles under an action are evaluated
   * hierarchically, an action returns the first valid idle), the Construction Set wiki "Idle
   * Manager" (an idle whose conditions are met and none of whose children's are is the idle
   * chosen; a chosen idle without an animation plays none).
   */
  /** As resolve, with conditions valued asynchronously (the running game's). */
  async resolveAsync(
    action: number,
    graph: string,
    accepts: (idle: IdleRecord) => Promise<boolean>,
  ): Promise<IdleRecord | undefined> {
    let chosen: IdleRecord | undefined;
    const visited = new Set<number>();
    let parent = action;
    for (;;) {
      let next: IdleRecord | undefined;
      for (const idle of this.children(parent, graph)) {
        if (visited.has(idle.formId)) continue;
        if (await accepts(idle)) {
          next = idle;
          break;
        }
      }
      if (!next) return chosen;
      visited.add(next.formId);
      chosen = next;
      parent = next.formId;
    }
  }

  resolve(
    action: number,
    graph: string,
    accepts: (idle: IdleRecord) => boolean,
  ): IdleRecord | undefined {
    let chosen: IdleRecord | undefined;
    const visited = new Set<number>();
    let parent = action;
    for (;;) {
      const next = this.children(parent, graph).find(
        (idle) => !visited.has(idle.formId) && accepts(idle),
      );
      if (!next) return chosen;
      visited.add(next.formId);
      chosen = next;
      parent = next.formId;
    }
  }

  /**
   * Whether an idle's conditions and those of every idle above it hold (CommonLib
   * TESIdleForm::CheckConditions with a_checkParentIdle): for an idle played by itself
   * (a package, a script, an idle marker).
   */
  holdsWithParents(idle: IdleRecord, accepts: (idle: IdleRecord) => boolean): boolean {
    const seen = new Set<number>();
    let at: IdleRecord | undefined = idle;
    while (at && !seen.has(at.formId)) {
      if (!accepts(at)) return false;
      seen.add(at.formId);
      at = at.parent === undefined ? undefined : this.idles.get(at.parent);
    }
    return true;
  }
}

/** The idle tree of a load order: every action and idle (their winning versions). */
export async function readIdleTree(db: RecordDatabase): Promise<IdleTree> {
  // Read in large chunks (thousands of idles), then put in the order of the form ids of the
  // type (the load order they first appear in), which the siblings' order relies on.
  const actions = new Map<number, ActionRecord>();
  const idles = new Map<number, IdleRecord>();
  await db.scan(
    ['AACT', 'IDLE'],
    (flags) => (flags & RecordFlag.deleted) === 0,
    (record) => {
      if (record.type === 'AACT') actions.set(record.formId, parseAction(record));
      else idles.set(record.formId, parseIdle(record));
    },
  );
  const inOrder = <T>(type: string, parsed: ReadonlyMap<number, T>): T[] =>
    db.formIdsOfType(type).flatMap((formId) => {
      const record = parsed.get(formId);
      return record === undefined ? [] : [record];
    });
  return new IdleTree(inOrder('AACT', actions), inOrder('IDLE', idles));
}

/**
 * Siblings (one parent, one graph) in order: each names the one before it (none: the first).
 * Where several name the same one, the one later in the load order comes first, as if each
 * were put right after the one it names when its plugin loads. Siblings the chains from the
 * first do not reach (their previous is no sibling, a cycle) follow in load order.
 */
function orderSiblings(
  list: readonly IdleRecord[],
  exists: (idle: number) => boolean,
  problems: IdleTreeProblem[],
): IdleRecord[] {
  const ids = new Set(list.map((idle) => idle.formId));
  const after = new Map<number | undefined, IdleRecord[]>();
  for (const idle of list) {
    const previous = idle.previous;
    if (previous !== undefined && !ids.has(previous)) {
      const problem = exists(previous) ? 'previous not a sibling' : 'previous missing';
      problems.push({ idle: idle.formId, problem });
      continue;
    }
    const next = after.get(previous) ?? [];
    next.unshift(idle);
    after.set(previous, next);
  }
  for (const next of after.values()) {
    if (next.length < 2) continue;
    for (const idle of next) problems.push({ idle: idle.formId, problem: 'previous shared' });
  }
  const ordered: IdleRecord[] = [];
  const placed = new Set<number>();
  // Depth first, iterative: sibling chains run to a hundred idles.
  const place = (first: IdleRecord): void => {
    const stack: IdleRecord[] = [first];
    while (stack.length > 0) {
      const idle = stack.pop();
      if (!idle || placed.has(idle.formId)) continue;
      placed.add(idle.formId);
      ordered.push(idle);
      stack.push(...[...(after.get(idle.formId) ?? [])].reverse());
    }
  };
  for (const first of after.get(undefined) ?? []) place(first);
  for (const idle of list) {
    if (placed.has(idle.formId)) continue;
    if (idle.previous === undefined || ids.has(idle.previous)) {
      problems.push({ idle: idle.formId, problem: 'cycle' });
    }
    place(idle);
  }
  return ordered;
}
