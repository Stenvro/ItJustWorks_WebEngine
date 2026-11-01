import { describe, expect, it } from 'vitest';
import { wordValue } from '../../animation/named-graph-state.ts';
import { readAnimationGraphs } from './animation-graphs.ts';
import { EssWriter } from './ess-test-writer.ts';

/** One graph as the original writes it, with what follows its event modifiers. */
function graph(w: EssWriter, stateName: string): EssWriter {
  w.wstring('BShkbAnimationGraph');
  w.u32(1).wstring('0_Master.hkb/Master_Behavior').u32(2).wstring(stateName).u32(1).u32(0);
  w.u32(1).wstring('MT_Behavior.hkb/MT_Idle').f32(1.5);
  w.u32(1).wstring('Behavior00.hkb/GamebryoSequenceGenerator00').f32(55);
  w.wstring('IsSneaking').u8(1).u32(1);
  w.wstring('Speed').u8(1).f32(120);
  w.wstring('TargetLocation').u8(0).f32(1).f32(2).f32(3).f32(0);
  w.wstring('$-NoMoreVariables-$');
  w.u32(1).wstring('MT_Behavior.hkb/StartCombat_EDM').u8(1);
  // 12 bytes, no look-at modifier, and the rest not read.
  return w.bytes(new Uint8Array(12)).u32(0).bytes(new Uint8Array(18));
}

describe('animation graphs (change form)', () => {
  it("reads each graph's machines, clips, sequences, variables and event modifiers", () => {
    const w = new EssWriter().u8(1).u32(2);
    graph(w, 'Root');
    graph(w, 'FirstPerson');
    w.wstring('').u8(0).u32(42).u16(0);
    const read = readAnimationGraphs(w.done());
    expect(read.graphs).toHaveLength(2);
    const [first, second] = read.graphs;
    expect(first?.machines).toEqual([
      {
        graph: '0_Master.hkb',
        node: 'Master_Behavior',
        stateId: 2,
        stateName: 'Root',
        values: [1, 0],
      },
    ]);
    expect(first?.clips).toEqual([{ graph: 'MT_Behavior.hkb', node: 'MT_Idle', time: 1.5 }]);
    expect(first?.generators[0]?.time).toBe(55);
    expect(first?.words.map(([name]) => name)).toEqual(['IsSneaking', 'Speed']);
    expect(first?.quads).toEqual([['TargetLocation', 1, 2, 3, 0]]);
    expect(first?.eventModifiers).toEqual([['MT_Behavior.hkb/StartCombat_EDM', true]]);
    expect(second?.machines[0]?.stateName).toBe('FirstPerson');
  });

  it('reads the sequence a reference with no graph plays', () => {
    const w = new EssWriter().u8(0).wstring('Close').u8(0).u32(42).u16(0);
    expect(readAnimationGraphs(w.done())).toEqual({ graphs: [], sequence: 'Close' });
  });

  it("gives a word variable's value by its type", () => {
    const real = new DataView(new ArrayBuffer(4));
    real.setFloat32(0, 120, true);
    expect(wordValue(real.getUint32(0, true), 4)).toBe(120);
    expect(wordValue(0xffffffff, 3)).toBe(-1);
    expect(wordValue(0xff, 1)).toBe(-1);
    expect(wordValue(0x100, 0)).toBe(0);
    expect(wordValue(1, 0)).toBe(1);
    expect(wordValue(0, 7)).toBeUndefined();
  });
});
