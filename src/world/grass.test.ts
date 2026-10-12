import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  GrassFlag,
  parseGrass,
  placeGrass,
  textureWeightsAt,
  WaterRule,
  type GrassType,
} from './grass.ts';
import { CELL_SIZE, LAND_GRID, QUADRANT_GRID, type LandData } from './land.ts';

const POINTS = LAND_GRID * LAND_GRID;

function land(options: { tilt?: number; layerOpacity?: number; height?: number } = {}): LandData {
  const heights = new Float32Array(POINTS).fill(options.height ?? 100);
  const normals = new Float32Array(POINTS * 3);
  const tilt = options.tilt ?? 0;
  for (let i = 0; i < POINTS; i++) normals.set([Math.sin(tilt), 0, Math.cos(tilt)], i * 3);
  const layer = {
    texture: 0x20,
    alpha: new Float32Array(QUADRANT_GRID * QUADRANT_GRID).fill(options.layerOpacity ?? 0),
  };
  return {
    heights,
    normals,
    colors: undefined,
    quadrants: [
      { base: 0x10, layers: [layer] },
      { base: 0x10, layers: [layer] },
      { base: 0x10, layers: [layer] },
      { base: 0x10, layers: [layer] },
    ],
  };
}

function grass(overrides: Partial<GrassType> = {}): GrassType {
  return {
    formId: 0x100,
    editorId: 'TundraGrass',
    model: 'meshes\\landscape\\grass\\tundragrass01.nif',
    density: 50,
    minSlope: 0,
    maxSlope: 40,
    waterDistance: 0,
    waterRule: 0,
    positionRange: 20,
    heightRange: 0.3,
    colorRange: 0.2,
    wavePeriod: 120,
    flags: GrassFlag.uniformScaling | GrassFlag.fitToSlope,
    ...overrides,
  };
}

const count = (placed: ReadonlyMap<GrassType, readonly unknown[]>): number =>
  [...placed.values()].reduce((sum, list) => sum + list.length, 0);

describe('parseGrass', () => {
  it('reads the model and DATA', () => {
    const data = new Uint8Array(32);
    const view = new DataView(data.buffer);
    data.set([60, 5, 35]);
    view.setUint16(4, 105, true);
    view.setUint32(8, WaterRule.aboveAtLeast, true);
    [32, 0.25, 0.1, 60].forEach((v, i) => {
      view.setFloat32(12 + i * 4, v, true);
    });
    data[28] = 6;
    const type = parseGrass({
      formId: 1,
      editorId: 'RockGrass',
      fields: new Fields([
        { type: 'MODL', data: new TextEncoder().encode('Landscape\\Grass\\RockGrass.nif\0') },
        { type: 'DATA', data },
      ]),
    });
    expect(type.model).toBe('meshes\\landscape\\grass\\rockgrass.nif');
    expect(type.density).toBe(60);
    expect([type.minSlope, type.maxSlope]).toEqual([5, 35]);
    expect(type.waterDistance).toBe(105);
    expect(type.waterRule).toBe(WaterRule.aboveAtLeast);
    expect(type.positionRange).toBe(32);
    expect(type.wavePeriod).toBe(60);
    expect(type.flags).toBe(6);
  });
});

describe('textureWeightsAt', () => {
  it('lets layers cover the base by their opacity', () => {
    const weights = textureWeightsAt(land({ layerOpacity: 0.25 }), 100, 100);
    expect(weights.get(0x10)).toBeCloseTo(0.75, 5);
    expect(weights.get(0x20)).toBeCloseTo(0.25, 5);
  });
});

describe('placeGrass', () => {
  const tundra = grass();
  const onBase = (ltex: number | undefined): readonly GrassType[] =>
    ltex === 0x10 ? [tundra] : [];

  it('places about density percent of the points, the same every time', () => {
    const a = placeGrass(land(), 3, -2, onBase, undefined);
    const b = placeGrass(land(), 3, -2, onBase, undefined);
    const points = (CELL_SIZE / 20) ** 2;
    expect(count(a)).toBeGreaterThan(points * 0.45);
    expect(count(a)).toBeLessThan(points * 0.55);
    expect(a.get(tundra)?.[10]).toEqual(b.get(tundra)?.[10]);
    for (const plant of a.get(tundra) ?? []) {
      expect(plant.position[0]).toBeGreaterThanOrEqual(3 * CELL_SIZE);
      expect(plant.position[1]).toBeLessThan(-1 * CELL_SIZE);
      expect(plant.position[2]).toBeCloseTo(100, 3);
      expect(plant.scaleXY).toBe(plant.scaleZ);
    }
  });

  it('grows only where its texture is', () => {
    const covered = placeGrass(land({ layerOpacity: 1 }), 0, 0, onBase, undefined);
    expect(count(covered)).toBe(0);
    const half = placeGrass(land({ layerOpacity: 0.5 }), 0, 0, onBase, undefined);
    const full = placeGrass(land(), 0, 0, onBase, undefined);
    expect(count(half) / count(full)).toBeGreaterThan(0.4);
    expect(count(half) / count(full)).toBeLessThan(0.6);
  });

  it('keeps to its slope range', () => {
    const steep = placeGrass(land({ tilt: (60 * Math.PI) / 180 }), 0, 0, onBase, undefined);
    expect(count(steep)).toBe(0);
  });

  it('keeps its distance from water', () => {
    const shore = grass({ waterRule: WaterRule.aboveAtLeast, waterDistance: 105 });
    const of = (ltex: number | undefined): readonly GrassType[] => (ltex === 0x10 ? [shore] : []);
    expect(count(placeGrass(land({ height: 100 }), 0, 0, of, 50))).toBe(0);
    expect(count(placeGrass(land({ height: 200 }), 0, 0, of, 50))).toBeGreaterThan(0);
    expect(count(placeGrass(land({ height: 100 }), 0, 0, of, undefined))).toBeGreaterThan(0);
  });
});
