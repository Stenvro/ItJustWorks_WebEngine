import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../byte-source.ts';
import { decodeGameText, decodeUtf8 } from '../text.ts';
import { parsePluginInfo } from './plugin-header.ts';
import { findRecord, indexPlugin, readRecord } from './plugin-index.ts';
import { fourCCToInt, GroupType, parseFields, RecordFlag } from './record.ts';
import { PluginStrings, StringTable } from './strings.ts';

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
const u16 = (value: number): number[] => [value & 0xff, value >>> 8];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  value >>> 24,
];

function field(type: string, data: number[]): number[] {
  return [...ascii(type), ...u16(data.length), ...data];
}

function record(type: string, formId: number, fields: number[], flags = 0): number[] {
  return [
    ...ascii(type),
    ...u32(fields.length),
    ...u32(flags),
    ...u32(formId),
    0,
    0,
    0,
    0,
    44,
    0,
    0,
    0,
    ...fields,
  ];
}

function group(label: number, groupType: number, contents: number[]): number[] {
  return [
    ...ascii('GRUP'),
    ...u32(24 + contents.length),
    ...u32(label),
    ...u32(groupType),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...contents,
  ];
}

const zstring = (text: string): number[] => [...ascii(text), 0];

describe('plugin structure', () => {
  const plugin = Uint8Array.from([
    ...record(
      'TES4',
      0,
      [
        ...field('HEDR', [0x9a, 0x99, 0xd9, 0x3f, ...u32(3), ...u32(0x800)]),
        ...field('CNAM', zstring('Test')),
        ...field('MAST', zstring('Skyrim.esm')),
        ...field('DATA', [0, 0, 0, 0, 0, 0, 0, 0]),
      ],
      RecordFlag.master,
    ),
    ...group(fourCCToInt('STAT'), GroupType.top, [
      ...record('STAT', 0x01000801, field('EDID', zstring('Second'))),
      ...record('STAT', 0x00012345, field('EDID', zstring('Override'))),
    ]),
  ]);

  it('indexes records and groups from headers', async () => {
    const index = await indexPlugin(new MemoryByteSource(plugin), 64);
    expect(index.recordCount).toBe(3);
    expect(index.groupCount).toBe(1);
    expect([index.groupFirstRecord[0], index.groupEndRecord[0]]).toEqual([1, 3]);
    expect(index.parentGroups[1]).toBe(1);
    expect(findRecord(index, 0x00012345)).toBe(2);
    expect(findRecord(index, 0x7)).toBe(-1);
  });

  it('reads TES4 and record fields', async () => {
    const source = new MemoryByteSource(plugin);
    const index = await indexPlugin(source);
    const tes4 = await readRecord(source, index, 0);
    const info = parsePluginInfo(parseFields(tes4.data));
    expect(info.masters).toEqual(['Skyrim.esm']);
    expect(info.author).toBe('Test');
    expect(info.version).toBeCloseTo(1.7);
    const stat = await readRecord(source, index, 1);
    expect(parseFields(stat.data)).toEqual([
      { type: 'EDID', data: Uint8Array.from(zstring('Second')) },
    ]);
  });

  it('honours XXXX size overrides', () => {
    const big = new Array<number>(70_000).fill(7);
    const data = Uint8Array.from([
      ...field('XXXX', u32(big.length)),
      ...ascii('OFST'),
      0,
      0,
      ...big,
    ]);
    const fields = parseFields(data);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.type).toBe('OFST');
    expect(fields[0]?.data.length).toBe(70_000);
  });
});

describe('string tables', () => {
  function table(kind: 'strings' | 'dlstrings', entries: [number, string][]): Uint8Array {
    const directory: number[] = [];
    const data: number[] = [];
    for (const [id, text] of entries) {
      directory.push(...u32(id), ...u32(data.length));
      const bytes = [...new TextEncoder().encode(text), 0];
      if (kind === 'dlstrings') data.push(...u32(bytes.length));
      data.push(...bytes);
    }
    return Uint8Array.from([...u32(entries.length), ...u32(data.length), ...directory, ...data]);
  }

  it('reads null-terminated and length-prefixed tables', () => {
    const strings = new StringTable(
      table('strings', [
        [1, 'Breezehome'],
        [2, 'Whiterun'],
      ]),
      'strings',
    );
    const dl = new StringTable(table('dlstrings', [[7, 'A long description.']]), 'dlstrings');
    expect(strings.get(2)).toBe('Whiterun');
    expect(dl.get(7)).toBe('A long description.');
    const all = new PluginStrings([strings, dl]);
    expect(all.get(7)).toBe('A long description.');
    expect(all.get(0)).toBe('');
    expect(all.get(99)).toBeUndefined();
  });

  it('decodes UTF-8 and falls back to Windows-1252', () => {
    expect(decodeUtf8(Uint8Array.of(0xc3, 0xa9))).toBe('é');
    expect(decodeUtf8(Uint8Array.of(0xe9))).toBeUndefined();
    expect(decodeUtf8(Uint8Array.of(0xc0, 0x80))).toBeUndefined(); // overlong
    expect(decodeGameText(Uint8Array.of(0x47, 0x72, 0xe9))).toBe('Gré');
  });
});
