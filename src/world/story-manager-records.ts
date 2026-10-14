// The story manager's trees (SMEN event nodes, SMBN branch nodes, SMQN quest nodes): one tree
// per event type, its nodes in the order the Creation Kit shows them (each names its parent
// and its previous sibling), each with its conditions and flags; quest nodes list their
// quests with the game hours before the story manager may start one again.
// Platform-independent. Layout: docs/formats/esm.md ("Story manager"), after xEdit's
// SMEN/SMBN/SMQN definitions and UESP's pages.

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

/** DNAM flags of every node (an SMQN's low 16 bits). */
export const StoryNodeFlag = {
  /** Its children (or a quest node's quests) are tried in random order, not top to bottom. */
  random: 0x1,
  /** "Warn if no child quest started" (xEdit: "No child warn"). */
  warnIfNoQuest: 0x2,
} as const;

/** An SMQN's quest flags (DNAM's high 16 bits). */
export const StoryQuestNodeFlag = {
  /** Every quest of the node is started once before one starts again. */
  doAllBeforeRepeating: 0x1,
  /** The event goes on to the next nodes after this one started a quest. */
  sharesEvent: 0x2,
  /** Starts up to `questsToRun` quests (MNAM), not one. */
  numQuestsToRun: 0x4,
} as const;

export interface StoryQuest {
  readonly quest: number;
  /** Game hours before the story manager starts it again (0: no wait); RNAM / 24 (xEdit, UESP). */
  readonly hoursUntilReset: number;
}

export interface StoryNode {
  readonly formId: number;
  readonly editorId: string;
  readonly kind: 'event' | 'branch' | 'quest';
  readonly parent: number;
  readonly previousSibling: number;
  readonly conditions: readonly Condition[];
  /** StoryNodeFlag. */
  readonly flags: number;
  /** StoryQuestNodeFlag (quest nodes). */
  readonly questFlags: number;
  /** XNAM: at most this many of a quest node's quests run at once (0: no limit). */
  readonly maxConcurrent: number;
  /** MNAM: how many quests to start with StoryQuestNodeFlag.numQuestsToRun. */
  readonly questsToRun: number;
  readonly quests: readonly StoryQuest[];
  /** ENAM of an event node: the event type ("SCPT", "KILL", "CLOC", ...). */
  readonly event: string | undefined;
  /** Child nodes in order (filled by buildStoryTrees). */
  readonly children: StoryNode[];
}

const KIND: Readonly<Record<string, StoryNode['kind']>> = {
  SMEN: 'event',
  SMBN: 'branch',
  SMQN: 'quest',
};

export function parseStoryNode(record: RecordSource): StoryNode {
  const kind = KIND[record.type];
  if (!kind) throw new Error(`${record.type} is not a story manager node`);
  const fields = record.fields.list;
  const conditions: Condition[] = [];
  const quests: { quest: number; hoursUntilReset: number }[] = [];
  let flags = 0;
  let questFlags = 0;
  let maxConcurrent = 0;
  let questsToRun = 0;
  let parent = 0;
  let previousSibling = 0;
  let event: string | undefined;
  for (let i = 0; i < fields.length; i++) {
    const { type, data } = fields[i] ?? { type: '', data: new Uint8Array() };
    if (type === 'PNAM' && data.length >= 4) parent = record.formIdAt(data);
    else if (type === 'SNAM' && data.length >= 4) previousSibling = record.formIdAt(data);
    else if (type === 'CTDA') {
      const condition = conditionAt(fields, i, record);
      if (condition) conditions.push(condition);
    } else if (type === 'DNAM' && data.length >= 4) {
      const value = view(data).getUint32(0, true);
      flags = value & 0xffff;
      questFlags = kind === 'quest' ? value >>> 16 : 0;
    } else if (type === 'XNAM' && data.length >= 4) maxConcurrent = view(data).getUint32(0, true);
    else if (type === 'MNAM' && data.length >= 4) questsToRun = view(data).getUint32(0, true);
    else if (type === 'NNAM' && data.length >= 4)
      quests.push({ quest: record.formIdAt(data), hoursUntilReset: 0 });
    else if (type === 'RNAM' && data.length >= 4) {
      const last = quests.at(-1);
      // The Creation Kit shows RNAM / 24 as "Hours until reset" (xEdit reads it so too).
      if (last) last.hoursUntilReset = view(data).getFloat32(0, true) / 24;
    } else if (type === 'ENAM' && data.length >= 4) {
      event = String.fromCharCode(...data.subarray(0, 4));
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    kind,
    parent,
    previousSibling,
    conditions,
    flags,
    questFlags,
    maxConcurrent,
    questsToRun,
    quests,
    event,
    children: [],
  };
}

/**
 * The event nodes by event type, each node's children ordered: the first child has no
 * previous sibling, each next one names the one before it.
 */
export function buildStoryTrees(nodes: readonly StoryNode[]): Map<string, StoryNode> {
  const byParent = new Map<number, StoryNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parent) ?? [];
    siblings.push(node);
    byParent.set(node.parent, siblings);
  }
  for (const node of nodes) {
    const children = byParent.get(node.formId) ?? [];
    const after = new Map(children.map((child) => [child.previousSibling, child]));
    const ordered: StoryNode[] = [];
    for (
      let next = after.get(0);
      next && ordered.length < children.length;
      next = after.get(next.formId)
    ) {
      ordered.push(next);
    }
    // Siblings whose chain is broken (a plugin removed one) keep their record order after.
    for (const child of children) if (!ordered.includes(child)) ordered.push(child);
    node.children.push(...ordered);
  }
  const trees = new Map<string, StoryNode>();
  for (const node of nodes) {
    if (node.kind === 'event' && node.event !== undefined) trees.set(node.event, node);
  }
  return trees;
}
