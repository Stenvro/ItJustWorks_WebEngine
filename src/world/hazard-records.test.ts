import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { HazardFlag, parseHazard } from './hazard-records.ts';

describe('HAZD', () => {
  it('reads DATA (40 bytes), its model and image-space modifier', () => {
    // GuardianCircleTurnHazard's layout: limit 1, radius 12, lifetime 30, interval 0.2.
    const data = new DataView(new ArrayBuffer(40));
    data.setUint32(0, 1, true);
    data.setFloat32(4, 12, true);
    data.setFloat32(8, 30, true);
    data.setFloat32(12, 0, true);
    data.setFloat32(16, 0.2, true);
    data.setUint32(20, HazardFlag.inheritDurationFromSpawnSpell, true);
    data.setUint32(24, 0x109ceb, true);
    data.setUint32(28, 0x10cdc8, true);
    data.setUint32(36, 0x56623, true);
    const imad = new DataView(new ArrayBuffer(4));
    imad.setUint32(0, 0x247bd, true);
    const fields = new Fields([
      { type: 'MODL', data: new TextEncoder().encode('Magic\\HealingHazard.nif\0') },
      { type: 'MNAM', data: new Uint8Array(imad.buffer) },
      { type: 'DATA', data: new Uint8Array(data.buffer) },
    ]);
    const formIdAt = (bytes: Uint8Array, offset = 0): number =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
    const hazard = parseHazard({
      formId: 0xfead3,
      editorId: 'GuardianCircleTurnHazard',
      fields,
      formIdAt,
      formIdField: (type) => {
        const bytes = fields.first(type);
        return bytes ? formIdAt(bytes) : undefined;
      },
    });
    expect(hazard).toMatchObject({
      limit: 1,
      radius: 12,
      lifetime: 30,
      imageSpaceRadius: 0,
      flags: HazardFlag.inheritDurationFromSpawnSpell,
      spell: 0x109ceb,
      light: 0x10cdc8,
      impactDataSet: undefined,
      sound: 0x56623,
      imageSpaceModifier: 0x247bd,
      model: 'Magic\\HealingHazard.nif',
    });
    expect(hazard.targetInterval).toBeCloseTo(0.2, 6);
  });
});
