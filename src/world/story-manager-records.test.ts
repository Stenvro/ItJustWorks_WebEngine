import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  buildStoryTrees,
  parseStoryNode,
  StoryNodeFlag,
  StoryQuestNodeFlag,
} from './story-manager-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const f32 = (value: number): Uint8Array => new Uint8Array(Float32Array.of(value).buffer);
const condition = (fn: number): Uint8Array => {
  const data = new Uint8Array(32);
  new DataView(data.buffer).setUint16(8, fn, true);
  return data;
};
const node = (type: string, formId: number, fields: [string, Uint8Array][]) => ({
  formId,
  type,
  editorId: `Node${formId.toString(16)}`,
  fields: new Fields(fields.map(([field, data]) => ({ type: field, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('story manager nodes', () => {
  it('read a quest node: node flags, quest flags, limits, quests with their reset hours', () => {
    const quest = parseStoryNode(
      node('SMQN', 0x896a9, [
        ['PNAM', u32s(0x896a8)],
        ['SNAM', u32s(0)],
        ['CITC', u32s(1)],
        ['CTDA', condition(74)],
        // Random; do all before repeating and shares event.
        ['DNAM', u32s(0x0003_0001)],
        ['XNAM', u32s(2)],
        ['MNAM', u32s(3)],
        ['QNAM', u32s(2)],
        ['NNAM', u32s(0x4a602)],
        ['FNAM', u32s(2)],
        // The Creation Kit shows RNAM / 24 as "hours until reset".
        ['RNAM', f32(1728)],
        ['NNAM', u32s(0x4eef6)],
      ]),
    );
    expect(quest).toMatchObject({
      kind: 'quest',
      parent: 0x896a8,
      previousSibling: 0,
      flags: StoryNodeFlag.random,
      questFlags: StoryQuestNodeFlag.doAllBeforeRepeating | StoryQuestNodeFlag.sharesEvent,
      maxConcurrent: 2,
      questsToRun: 3,
      quests: [
        { quest: 0x4a602, hoursUntilReset: 72 },
        { quest: 0x4eef6, hoursUntilReset: 0 },
      ],
    });
    expect(quest.conditions.map((c) => c.function)).toEqual([74]);
  });

  it('build one tree per event, children in the order their previous siblings give', () => {
    const event = parseStoryNode(
      node('SMEN', 0x1379a, [['ENAM', new TextEncoder().encode('SCPT')]]),
    );
    // Listed out of order: the chain is 0x30 (first), 0x10, 0x20.
    const second = parseStoryNode(
      node('SMBN', 0x10, [
        ['PNAM', u32s(0x1379a)],
        ['SNAM', u32s(0x30)],
      ]),
    );
    const third = parseStoryNode(
      node('SMQN', 0x20, [
        ['PNAM', u32s(0x1379a)],
        ['SNAM', u32s(0x10)],
      ]),
    );
    const first = parseStoryNode(
      node('SMQN', 0x30, [
        ['PNAM', u32s(0x1379a)],
        ['SNAM', u32s(0)],
      ]),
    );
    const trees = buildStoryTrees([event, second, third, first]);
    expect(trees.get('SCPT')?.children.map((child) => child.formId)).toEqual([0x30, 0x10, 0x20]);
  });
});
