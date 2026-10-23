import { describe, expect, it } from 'vitest';
import { parseRagdollData, ragdollPoseLocals, type RagdollData } from './ragdoll-data.ts';

/** XRGD's bytes: per bone its id, three unused bytes, a position and a rotation. */
function xrgd(bones: readonly (readonly [number, number[], number[]])[]): Uint8Array {
  const data = new Uint8Array(bones.length * 28);
  const view = new DataView(data.buffer);
  bones.forEach(([part, position, rotation], i) => {
    view.setUint8(i * 28, part);
    [...position, ...rotation].forEach((value, k) => {
      view.setFloat32(i * 28 + 4 + k * 4, value, true);
    });
  });
  return data;
}

const fields = (map: Record<string, Uint8Array>) => ({ first: (type: string) => map[type] });
const IDENTITY = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('placed ragdoll poses (XRGD)', () => {
  it('reads the bones and the biped rotation', () => {
    const biped = new Uint8Array(12);
    new DataView(biped.buffer).setFloat32(0, 1.5, true);
    const data = parseRagdollData(
      fields({
        XRGD: xrgd([
          [2, [0, 0, 0], [0.5, 0, 0]],
          [8, [1, 2, 3], [0, 0, 1]],
        ]),
        XRGB: biped,
      }),
    );
    expect(data?.bones).toHaveLength(2);
    expect(data?.bones[1]?.part).toBe(8);
    expect(data?.bones[1]?.position).toEqual([1, 2, 3]);
    expect(data?.bones[0]?.rotation[0]).toBeCloseTo(0.5);
    expect(data?.bipedRotation?.[0]).toBeCloseTo(1.5);
    expect(parseRagdollData(fields({}))).toBeUndefined();
  });

  it('poses the nodes in order up to the first entry that does not match its body', () => {
    const data: RagdollData = {
      bones: [
        { part: 2, position: [0, 0, 0], rotation: [0, 0, Math.PI / 2] },
        { part: 8, position: [0, 0, 30], rotation: [0, 0, 0] },
        { part: 9, position: [0, 0, 40], rotation: [0, 0, 0] },
      ],
    };
    const nodes = new Map([
      ['com', 0],
      ['thigh', 1],
      ['calf', 2],
    ]);
    const order = [
      { node: 'COM', part: 2 },
      { node: 'Thigh', part: 8 },
      { node: 'Calf', part: 9 },
    ];
    const all = ragdollPoseLocals(data, order, (name) => nodes.get(name.toLowerCase()), IDENTITY);
    expect(all.complete).toBe(true);
    expect(all.locals.size).toBe(3);
    // The rotation is built as a reference's is: a quarter turn about z.
    const com = all.locals.get(0);
    expect(Math.abs(com?.[0] ?? 1)).toBeLessThan(1e-6);
    expect(Math.abs(com?.[1] ?? 0)).toBeCloseTo(1);
    expect(all.locals.get(2)?.[14]).toBeCloseTo(40);
    // A mismatch stops the walk there: what came before stays applied.
    const wrong = [order[0], { node: 'Thigh', part: 14 }, order[2]].filter((x) => x !== undefined);
    const partial = ragdollPoseLocals(
      data,
      wrong,
      (name) => nodes.get(name.toLowerCase()),
      IDENTITY,
    );
    expect(partial.complete).toBe(false);
    expect([...partial.locals.keys()]).toEqual([0]);
    // More entries than nodes, or fewer: the walk ends where either does.
    expect(
      ragdollPoseLocals(data, order.slice(0, 2), (n) => nodes.get(n.toLowerCase()), IDENTITY)
        .complete,
    ).toBe(true);
  });

  it('stops at a corrupt entry', () => {
    const data: RagdollData = {
      bones: [
        { part: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
        { part: 8, position: [6e6, 0, 0], rotation: [0, 0, 0] },
      ],
    };
    const order = [
      { node: 'a', part: 2 },
      { node: 'b', part: 8 },
    ];
    const result = ragdollPoseLocals(data, order, (name) => (name === 'a' ? 0 : 1), IDENTITY);
    expect(result.complete).toBe(false);
    expect(result.locals.size).toBe(1);
  });
});
