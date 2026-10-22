import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import { DestructionStageFlag, parseDebris, parseDestruction } from './destruction-records.ts';

const formIdAt = (bytes: Uint8Array, offset = 0): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);

function record(fields: Field[], type = 'ACTI') {
  return { formId: 0x10, type, editorId: 'Test', fields: new Fields(fields), formIdAt };
}

function dest(health: number, count: number, flags = 0): Field {
  const data = new DataView(new ArrayBuffer(8));
  data.setInt32(0, health, true);
  data.setUint8(4, count);
  data.setUint8(5, flags);
  return { type: 'DEST', data: new Uint8Array(data.buffer) };
}

function dstd(
  percent: number,
  index: number,
  damageStage: number,
  flags: number,
  self: number,
  explosion: number,
  debris: number,
  debrisCount: number,
): Field {
  const data = new DataView(new ArrayBuffer(20));
  data.setUint8(0, percent);
  data.setUint8(1, index);
  data.setUint8(2, damageStage);
  data.setUint8(3, flags);
  data.setInt32(4, self, true);
  data.setUint32(8, explosion, true);
  data.setUint32(12, debris, true);
  data.setInt32(16, debrisCount, true);
  return { type: 'DSTD', data: new Uint8Array(data.buffer) };
}

describe('DEST', () => {
  it('reads the header and every stage with its model, texture swaps and end marker', () => {
    // DMDS: one swap (shape name "Ore:0", texture set 0x123, shape index 2).
    const name = new TextEncoder().encode('Ore:0');
    const swaps = new DataView(new ArrayBuffer(4 + 4 + name.length + 8));
    swaps.setUint32(0, 1, true);
    swaps.setUint32(4, name.length, true);
    new Uint8Array(swaps.buffer).set(name, 8);
    swaps.setUint32(8 + name.length, 0x123, true);
    swaps.setUint32(12 + name.length, 2, true);
    const data = parseDestruction(
      record([
        { type: 'EDID', data: text('Test') },
        { type: 'MODL', data: text('Clutter\\Urn.nif') },
        dest(125, 2, 0x01),
        dstd(75, 0, 1, DestructionStageFlag.capDamage, 0, 0, 0, 0),
        { type: 'DSTF', data: new Uint8Array(0) },
        dstd(0, 1, 4, DestructionStageFlag.destroy, 2, 0x1234, 0x5678, 20),
        { type: 'DMDL', data: text('Clutter\\UrnBroken.nif') },
        { type: 'DMDT', data: new Uint8Array(12) },
        { type: 'DMDS', data: new Uint8Array(swaps.buffer) },
        { type: 'DSTF', data: new Uint8Array(0) },
        { type: 'KSIZ', data: new Uint8Array(4) },
      ]),
    );
    expect(data).toEqual({
      health: 125,
      flags: 0x01,
      stages: [
        {
          healthPercent: 75,
          index: 0,
          modelDamageStage: 1,
          flags: DestructionStageFlag.capDamage,
          selfDamagePerSecond: 0,
          explosion: undefined,
          debris: undefined,
          debrisCount: 0,
          model: undefined,
          alternateTextures: [],
        },
        {
          healthPercent: 0,
          index: 1,
          modelDamageStage: 4,
          flags: DestructionStageFlag.destroy,
          selfDamagePerSecond: 2,
          explosion: 0x1234,
          debris: 0x5678,
          debrisCount: 20,
          model: 'Clutter\\UrnBroken.nif',
          alternateTextures: [{ shape: 'Ore:0', textureSet: 0x123, index: 2 }],
        },
      ],
    });
  });

  it('is undefined without DEST', () => {
    expect(parseDestruction(record([{ type: 'EDID', data: text('Test') }]))).toBeUndefined();
  });
});

describe('DEBR', () => {
  it('reads each model: percentage, path, collision flag', () => {
    const model = (percent: number, path: string, flags: number): Field => {
      const bytes = text(path);
      const data = new Uint8Array(bytes.length + 2);
      data[0] = percent;
      data.set(bytes, 1);
      data[bytes.length + 1] = flags;
      return { type: 'DATA', data };
    };
    const debris = parseDebris(
      record(
        [
          { type: 'EDID', data: text('IceWraithDebris') },
          model(30, 'Actors\\IceWraith\\IceWraithHavokParts08.nif', 1),
          { type: 'MODT', data: new Uint8Array(12) },
          model(70, 'Actors\\IceWraith\\IceWraithHavokParts07.nif', 0),
        ],
        'DEBR',
      ),
    );
    expect(debris.models).toEqual([
      { percentage: 30, model: 'Actors\\IceWraith\\IceWraithHavokParts08.nif', hasCollision: true },
      {
        percentage: 70,
        model: 'Actors\\IceWraith\\IceWraithHavokParts07.nif',
        hasCollision: false,
      },
    ]);
  });
});
