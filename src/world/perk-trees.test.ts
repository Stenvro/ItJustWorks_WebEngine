import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parentsOf, parseSkill, treeNode } from './perk-trees.ts';

const u32 = (value: number): Uint8Array => new Uint8Array(Uint32Array.of(value).buffer);
const f32 = (value: number): Uint8Array => new Uint8Array(Float32Array.of(value).buffer);

describe('perk trees', () => {
  it('reads a skill and its perk tree nodes', () => {
    const fields: [string, Uint8Array][] = [
      ['CNAM', u32(3)], // the skill's category: not a node's connection
      ['AVSK', new Uint8Array(Float32Array.of(45, 10, 0.25, 300).buffer)],
      ['PNAM', u32(0)],
      ['FNAM', u32(0)],
      ['XNAM', u32(0)],
      ['YNAM', u32(0)],
      ['HNAM', f32(0)],
      ['VNAM', f32(0)],
      ['SNAM', u32(0x454)],
      ['CNAM', u32(10)],
      ['INAM', u32(0)],
      ['PNAM', u32(0xf392a)],
      ['FNAM', u32(1)],
      ['XNAM', u32(3)],
      ['YNAM', u32(0)],
      ['HNAM', f32(-0.54)],
      ['VNAM', f32(-0.04)],
      ['SNAM', u32(0x454)],
      ['CNAM', u32(1)],
      ['INAM', u32(10)],
    ];
    const skill = parseSkill({
      formId: 0x454,
      editorId: 'AVLockpicking',
      fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
      text: (type) => (type === 'FULL' ? 'Lockpicking' : undefined),
      formIdAt: (data, offset) =>
        new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset ?? 0, true),
    });
    expect(skill.name).toBe('Lockpicking');
    expect(skill.use).toEqual({
      useMult: 45,
      useOffset: 10,
      improveMult: 0.25,
      improveOffset: 300,
    });
    expect(skill.nodes).toHaveLength(2);
    expect(skill.nodes[0]).toMatchObject({ index: 0, perk: undefined, children: [10] });
    const novice = treeNode(skill, 10);
    expect(novice).toMatchObject({ perk: 0xf392a, column: 3, row: 0, children: [1] });
    expect(novice?.offsetX).toBeCloseTo(-0.54, 5);
    expect(parentsOf(skill, 10).map((node) => node.index)).toEqual([0]);
  });
});
