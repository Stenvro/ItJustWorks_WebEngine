import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { AliasFlag, parseQuest, QuestFlag, StageFlag } from './quest-records.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const i16 = (value: number, ...rest: number[]): Uint8Array =>
  Uint8Array.from([value & 0xff, (value >> 8) & 0xff, ...rest]);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const condition = (fn: number): Uint8Array => {
  const data = new Uint8Array(32);
  new DataView(data.buffer).setUint16(8, fn, true);
  return data;
};
const record = (fields: [string, Uint8Array][]) => ({
  formId: 0x3372b,
  editorId: 'MQ101',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
  textAt: (data: Uint8Array) => new TextDecoder().decode(data).replace(/\0.*$/, ''),
});

describe('quests', () => {
  it('read the header: flags, priority, type, event and both sets of conditions', () => {
    const quest = parseQuest(
      record([
        ['FULL', text('Unbound')],
        // Start Game Enabled, Run Once; priority 90; type 1 (main quest).
        ['DNAM', bytes(0x01, 0x01, 90, 0, 0, 0, 0, 0, 1, 0, 0, 0)],
        ['ENAM', text('CLOC')],
        ['CTDA', condition(58)],
        ['NEXT', new Uint8Array(0)],
        ['CTDA', condition(72)],
        ['CTDA', condition(14)],
      ]),
    );
    expect(quest).toMatchObject({
      name: 'Unbound',
      flags: QuestFlag.startGameEnabled | QuestFlag.runOnce,
      priority: 90,
      type: 1,
      event: 'CLOC',
    });
    expect(quest.dialogueConditions.map((c) => c.function)).toEqual([58]);
    expect(quest.eventConditions.map((c) => c.function)).toEqual([72, 14]);
  });

  it('read stages with their log entries, and objectives with their targets', () => {
    const quest = parseQuest(
      record([
        ['INDX', i16(0, StageFlag.startUp, 0)],
        ['INDX', i16(10, 0, 0)],
        ['QSDT', bytes(0)],
        ['CNAM', text('I have been captured.')],
        ['QSDT', bytes(0x01)],
        ['CTDA', condition(59)],
        ['CNAM', text('I escaped.')],
        ['NAM0', u32s(0x3372c)],
        ['QOBJ', i16(10)],
        ['FNAM', u32s(0)],
        ['NNAM', text('Make your way to the Keep')],
        ['QSTA', u32s(3, 0)],
        ['CTDA', condition(72)],
      ]),
    );
    expect(quest.stages.map((stage) => [stage.index, stage.flags])).toEqual([
      [0, StageFlag.startUp],
      [10, 0],
    ]);
    expect(quest.stages[1]?.logEntries).toMatchObject([
      { flags: 0, text: 'I have been captured.' },
      { flags: 1, text: 'I escaped.', nextQuest: 0x3372c },
    ]);
    expect(quest.stages[1]?.logEntries[1]?.conditions).toHaveLength(1);
    expect(quest.objectives).toMatchObject([
      { index: 10, text: 'Make your way to the Keep', targets: [{ alias: 3, flags: 0 }] },
    ]);
    expect(quest.objectives[0]?.targets[0]?.conditions).toHaveLength(1);
  });

  it('tell how each alias is filled', () => {
    const alias = (id: number, ...fields: [string, Uint8Array][]): [string, Uint8Array][] => [
      ['ALST', u32s(id)],
      ...fields,
      ['ALED', new Uint8Array(0)],
    ];
    const quest = parseQuest(
      record([
        ['ANAM', u32s(9)],
        ...alias(0, ['ALID', text('Player')], ['ALFR', u32s(0x14)]),
        ...alias(1, ['ALID', text('Ralof')], ['ALUA', u32s(0x2bf9f)], ['ALPC', u32s(0x500)]),
        ...alias(2, ['ALCO', u32s(0x700)], ['ALCA', u32s(0x80000001)], ['ALCL', u32s(2)]),
        ...alias(3, ['ALEQ', u32s(0x3372c)], ['ALEA', u32s(4)]),
        ...alias(4, ['FNAM', u32s(AliasFlag.inLoadedArea)], ['CTDA', condition(72)]),
        ...alias(5, ['FNAM', u32s(AliasFlag.optional)]),
        ...alias(6, ['ALFE', text('CLOC')], ['ALFD', text('NLOC')]),
        ...alias(7, ['ALFA', u32s(8)], ['ALRT', u32s(0x130f8)]),
        ['ALLS', u32s(8)],
        ['ALID', text('Location')],
        ['ALFL', u32s(0x1bdb3)],
        ['ALED', new Uint8Array(0)],
      ]),
    );
    expect(quest.aliases.map((a) => [a.id, a.name, a.location, a.fill])).toEqual([
      [0, 'Player', false, { kind: 'forced', form: 0x14 }],
      [1, 'Ralof', false, { kind: 'uniqueActor', npc: 0x2bf9f }],
      [2, '', false, { kind: 'created', base: 0x700, alias: 1, inside: true, level: 2 }],
      [3, '', false, { kind: 'external', quest: 0x3372c, alias: 4 }],
      [4, '', false, { kind: 'matching', nearAlias: undefined }],
      [5, '', false, { kind: 'none' }],
      [6, '', false, { kind: 'fromEvent', event: 'CLOC', data: 'NLOC' }],
      [7, '', false, { kind: 'locationReference', location: 8, referenceType: 0x130f8 }],
      [8, 'Location', true, { kind: 'forced', form: 0x1bdb3 }],
    ]);
    expect(quest.aliases[1]?.packages).toEqual([0x500]);
  });
});
