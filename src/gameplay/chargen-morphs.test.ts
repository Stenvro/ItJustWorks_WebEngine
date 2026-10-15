import { describe, expect, it } from 'vitest';
import type { TriFile } from '../formats/nif/tri.ts';
import { bakeHeadPart, headPartMorphPaths } from './chargen-morphs.ts';

const tri = (vertexCount: number, morphs: Record<string, number[]>): TriFile => ({
  vertexCount,
  positions: new Float32Array(vertexCount * 3).fill(100),
  triangles: new Uint32Array(0),
  morphs: Object.entries(morphs).map(([name, offsets]) => ({
    name,
    offsets: Float32Array.from(offsets),
  })),
  modifiers: [],
});

describe('chargen morph baking', () => {
  it('adds the weighted morphs of every file to the model positions, each name once', () => {
    const base = Float32Array.of(0, 0, 0, 1, 10, 10, 10, 1); // x, y, z, w
    const baked = bakeHeadPart(
      base,
      4,
      {
        race: tri(2, { NordRace: [1, 0, 0, 0, 1, 0], DremoraRace: [5, 5, 5, 5, 5, 5] }),
        chargen: tri(2, { NoseLong: [0, 2, 0, 0, 0, 2], NordRace: [9, 9, 9, 9, 9, 9] }),
        expressions: tri(2, { SkinnyMorph: [0, 0, 4, 4, 0, 0], Aah: [7, 7, 7, 7, 7, 7] }),
      },
      new Map([
        ['nordrace', 1],
        ['noselong', 0.5],
        ['skinnymorph', 0.25],
        ['aah', 0],
      ]),
    );
    expect([...baked]).toEqual([1, 1, 1, 1, 11, 11, 11, 1]);
    expect([...base]).toEqual([0, 0, 0, 1, 10, 10, 10, 1]);
  });

  it('leaves out files of another vertex count', () => {
    const baked = bakeHeadPart(
      Float32Array.of(0, 0, 0),
      3,
      { chargen: tri(2, { NoseLong: [1, 1, 1, 1, 1, 1] }) },
      new Map([['noselong', 1]]),
    );
    expect([...baked]).toEqual([0, 0, 0]);
  });

  it('finds the morph files of a head part', () => {
    expect(
      headPartMorphPaths({
        files: [
          { type: 0, path: 'Actors\\Character\\Character Assets\\MaleHeadRaces.tri' },
          { type: 1, path: 'Actors\\Character\\Character Assets\\MaleHead.tri' },
          { type: 2, path: 'Actors\\Character\\Character Assets\\MaleHeadCustomizations.tri' },
        ],
      }),
    ).toEqual({
      race: 'meshes\\actors\\character\\character assets\\maleheadraces.tri',
      expressions: 'meshes\\actors\\character\\character assets\\malehead.tri',
      chargen: 'meshes\\actors\\character\\character assets\\maleheadcustomizations.tri',
    });
  });
});
