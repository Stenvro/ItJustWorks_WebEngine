import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../binary-reader.ts';
import { ANIMATION_PARSERS } from './animation-blocks.ts';

describe('BSProceduralLightningController', () => {
  it('reads its interpolators and the bolts it builds', () => {
    // NiTimeController (26 bytes), 9 interpolator refs, 3 u16, 5 f32, 3 bools, a ref: 95 bytes.
    const bytes = new Uint8Array(95);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, -1, true); // next controller
    view.setUint16(4, 108, true); // flags
    view.setFloat32(6, 1, true); // frequency
    view.setFloat32(14, 0, true); // start
    view.setFloat32(18, 1.4, true); // stop
    view.setInt32(22, 61, true); // target: the ProceduralGeometry node
    [10, 11, -1, -1, -1, -1, -1, -1, 12].forEach((ref, i) => {
      view.setInt32(26 + i * 4, ref, true);
    });
    view.setUint16(62, 6, true);
    view.setUint16(64, 1, true);
    view.setUint16(66, 1, true);
    [512, 30, 2.5, 0.75, 19.9].forEach((value, i) => {
      view.setFloat32(68 + i * 4, value, true);
    });
    bytes[88] = 1;
    bytes[89] = 0;
    bytes[90] = 1;
    view.setInt32(91, -1, true);
    const reader = new BinaryReader(bytes);
    const parse = ANIMATION_PARSERS.get('BSProceduralLightningController');
    const block = parse?.(
      reader,
      { strings: [], bsVersion: 100 },
      'BSProceduralLightningController',
    );
    expect(reader.remaining).toBe(0);
    expect(block).toMatchObject({
      kind: 'lightning-controller',
      target: 61,
      interpolators: [10, 11, -1, -1, -1, -1, -1, -1, 12],
      subdivisions: 6,
      branches: 1,
      branchesVariation: 1,
      length: 512,
      lengthVariation: 30,
      width: 2.5,
      fadeMainBolt: true,
      fadeChildBolts: false,
      animateArcOffset: true,
      shaderProperty: -1,
    });
    if (block?.kind !== 'lightning-controller') throw new Error('not a lightning controller');
    expect(block.childWidthMultiplier).toBeCloseTo(0.75);
    expect(block.arcOffset).toBeCloseTo(19.9);
  });
});
