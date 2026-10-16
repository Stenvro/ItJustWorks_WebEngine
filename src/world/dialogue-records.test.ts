import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parseBranch, parseInfo, parseTopic, TopicCategory } from './dialogue-records.ts';
import { DIALOGUE_SUBTYPES, dialogueSubtype } from './dialogue-subtypes.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][]) => ({
  formId: 0x100,
  editorId: 'Test',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
  textAt: (data: Uint8Array) => new TextDecoder().decode(data).replace(/\0.*$/s, ''),
});

describe('dialogue records', () => {
  it("read a topic's subtype and info count, a branch's category", () => {
    const topic = parseTopic(
      record([
        ['FULL', text('What happened here?')],
        ['PNAM', new Uint8Array(Float32Array.of(50).buffer)],
        ['QNAM', u32s(0x3372b)],
        ['DATA', bytes(0, TopicCategory.miscellaneous, 79, 0)],
        ['SNAM', text('HELO').subarray(0, 4)],
        ['TIFC', u32s(12)],
      ]),
    );
    expect(topic).toMatchObject({
      quest: 0x3372b,
      category: TopicCategory.miscellaneous,
      subtype: 79,
      subtypeName: 'HELO',
      infoCount: 12,
    });
    const branch = parseBranch(
      record([
        ['QNAM', u32s(0x3372b)],
        ['TNAM', u32s(TopicCategory.favor)],
        ['DNAM', u32s(0x1)],
        ['SNAM', u32s(0xbecbd)],
      ]),
    );
    expect(branch).toMatchObject({
      category: TopicCategory.favor,
      flags: 1,
      startingTopic: 0xbecbd,
    });
  });

  it("read an info's favor level, walk-away topic and audio output override", () => {
    const info = parseInfo(
      record([
        ['ENAM', bytes(0x80, 0, 0, 0)],
        ['CNAM', bytes(2)],
        ['TRDT', new Uint8Array(24)],
        ['NAM1', text('Hey, where are you going?')],
        ['TWAT', u32s(0x2f3a1)],
        ['ONAM', u32s(0x6ab21)],
      ]),
    );
    expect(info).toMatchObject({
      favorLevel: 2,
      walkAwayTopic: 0x2f3a1,
      audioOutputOverride: 0x6ab21,
    });
    expect(info.responses.map((response) => response.text)).toEqual(['Hey, where are you going?']);
    expect(parseInfo(record([['CNAM', bytes(0)]]))).toMatchObject({
      favorLevel: 0,
      walkAwayTopic: undefined,
      audioOutputOverride: undefined,
    });
  });

  it('know every topic subtype: its code, its place in the order and its tab', () => {
    expect(DIALOGUE_SUBTYPES).toHaveLength(103);
    expect(new Set(DIALOGUE_SUBTYPES.map((subtype) => subtype.code)).size).toBe(103);
    expect(DIALOGUE_SUBTYPES.every((subtype, index) => subtype.index === index)).toBe(true);
    expect(dialogueSubtype('CUST')).toEqual({
      code: 'CUST',
      name: 'Custom',
      index: 0,
      category: TopicCategory.topic,
    });
    expect(dialogueSubtype('SCEN')).toMatchObject({ index: 14, category: TopicCategory.scene });
    expect(dialogueSubtype('ATCK')).toMatchObject({ index: 26, category: TopicCategory.combat });
    expect(dialogueSubtype('ALIL')).toMatchObject({
      index: 55,
      category: TopicCategory.detection,
    });
    expect(dialogueSubtype('BAEX')).toMatchObject({ index: 70, category: TopicCategory.service });
    expect(dialogueSubtype('GBYE')).toMatchObject({ index: 78, name: 'Goodbye' });
    expect(dialogueSubtype('HELO')).toMatchObject({
      index: 79,
      category: TopicCategory.miscellaneous,
    });
    expect(dialogueSubtype('LWBS')?.index).toBe(102);
    expect(dialogueSubtype('XXXX')).toBeUndefined();
  });
});
