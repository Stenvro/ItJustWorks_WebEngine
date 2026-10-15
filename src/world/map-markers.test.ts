import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { MapMarkerFlag, parseMapMarker } from './map-markers.ts';

describe('parseMapMarker', () => {
  it('reads a map marker: name, icon, flags, where it stands', () => {
    const data = new DataView(new ArrayBuffer(24));
    data.setFloat32(0, 100, true);
    data.setFloat32(4, -200, true);
    data.setFloat32(8, 30, true);
    const fields = new Fields([
      { type: 'XMRK', data: new Uint8Array(0) },
      { type: 'FNAM', data: Uint8Array.of(MapMarkerFlag.visible | MapMarkerFlag.canTravel) },
      { type: 'TNAM', data: Uint8Array.of(40, 0) },
      { type: 'DATA', data: new Uint8Array(data.buffer) },
    ]);
    const marker = parseMapMarker(
      { formId: 0x100, fields, text: (type) => (type === 'FULL' ? 'Whiterun' : undefined) },
      0x3c,
    );
    expect(marker).toEqual({
      reference: 0x100,
      name: 'Whiterun',
      type: 40,
      flags: 3,
      position: [100, -200, 30],
      world: 0x3c,
    });
  });

  it('is undefined for a reference without marker data', () => {
    const fields = new Fields([]);
    expect(parseMapMarker({ formId: 1, fields, text: () => undefined }, undefined)).toBeUndefined();
  });
});
