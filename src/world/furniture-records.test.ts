import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  FurnitureEntry,
  FurnitureFlag,
  FurnitureMarkerFlag,
  FurnitureMarkerType,
  FurnitureRecordFlag,
  isMarkerActive,
  markerData,
  parseFurniture,
} from './furniture-records.ts';

const u16s = (...values: number[]): Uint8Array => new Uint8Array(Uint16Array.from(values).buffer);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][], flags = 0) => ({
  formId: 0x200,
  editorId: 'ExecutionerBlock',
  flags,
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('furniture records', () => {
  it('read what AI uses: flags, keywords, markers and their entry points', () => {
    const furniture = parseFurniture(
      record(
        [
          ['EDID', text('ExecutionerBlock')],
          ['MODL', text('Furniture\\ExecutionBlock.nif')],
          ['KSIZ', u32s(1)],
          ['KWDA', u32s(0x6c9c6)],
          ['FNAM', u16s(FurnitureFlag.ignoredBySandbox)],
          ['KNAM', u32s(0x13794)],
          ['MNAM', u32s(0x3 | FurnitureMarkerFlag.canSit | FurnitureMarkerFlag.mustExitToTalk)],
          ['WBDT', Uint8Array.of(0, 0xff)],
          // Marker 0: not from behind, the executioner's keyword; marker 1: no NAM0, no keyword.
          ['ENAM', u32s(0)],
          ['NAM0', u16s(0, FurnitureEntry.behind)],
          ['FNMK', u32s(0xdd8b5)],
          ['ENAM', u32s(1)],
          ['FNMK', u32s(0)],
          ['FNPR', u16s(FurnitureMarkerType.sit, FurnitureEntry.front)],
          ['FNPR', u16s(FurnitureMarkerType.sit, FurnitureEntry.front | FurnitureEntry.left)],
          ['XMRK', text('Furniture\\ExecutionBlockMarker.nif')],
        ],
        FurnitureRecordFlag.mustExitToTalk,
      ),
    );
    expect(furniture).toEqual({
      formId: 0x200,
      editorId: 'ExecutionerBlock',
      recordFlags: FurnitureRecordFlag.mustExitToTalk,
      flags: FurnitureFlag.ignoredBySandbox,
      interactionKeyword: 0x13794,
      markerFlags: (0x3 | FurnitureMarkerFlag.canSit | FurnitureMarkerFlag.mustExitToTalk) >>> 0,
      associatedSpell: undefined,
      markers: [
        { index: 0, disabledEntries: FurnitureEntry.behind, keyword: 0xdd8b5 },
        { index: 1, disabledEntries: 0, keyword: undefined },
      ],
      entryPoints: [
        { type: FurnitureMarkerType.sit, entries: FurnitureEntry.front },
        { type: FurnitureMarkerType.sit, entries: FurnitureEntry.front | FurnitureEntry.left },
      ],
      keywords: [0x6c9c6],
      model: 'Furniture\\ExecutionBlock.nif',
      markerModel: 'Furniture\\ExecutionBlockMarker.nif',
    });
    expect(isMarkerActive(furniture, 1)).toBe(true);
    expect(isMarkerActive(furniture, 2)).toBe(false);
    expect(markerData(furniture, 0)?.keyword).toBe(0xdd8b5);
    expect(markerData(furniture, 2)).toBeUndefined();
  });

  it('read a sleep marker’s flag, and furniture without MNAM', () => {
    const bed = parseFurniture(
      record([
        ['MNAM', u32s((0x1 | FurnitureMarkerFlag.canSleep) >>> 0)],
        ['NAM1', u32s(0x9a55)],
      ]),
    );
    expect(((bed.markerFlags ?? 0) & FurnitureMarkerFlag.canSleep) !== 0).toBe(true);
    expect(bed.associatedSpell).toBe(0x9a55);
    const bare = parseFurniture(record([]));
    expect(bare).toMatchObject({ markerFlags: undefined, flags: 0, markers: [], entryPoints: [] });
    expect(isMarkerActive(bare, 5)).toBe(true);
  });
});
