import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { BodyPartFlag, BodyPartType, headNode, parseBodyPartData } from './body-part-data.ts';

const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const data = (type: number): Uint8Array => {
  const bytes = new Uint8Array(12);
  bytes[5] = type;
  return bytes;
};

describe('body part data', () => {
  it("reads the parts by node and type, and finds the head's node", () => {
    const fields = new Fields([
      { type: 'EDID', data: text('WolfBodyPartData') },
      { type: 'BPTN', data: text('Torso') },
      { type: 'BPNN', data: text('Canine_Spine2') },
      { type: 'BPND', data: data(BodyPartType.torso) },
      { type: 'BPTN', data: text('Head') },
      { type: 'BPNN', data: text('Canine_Head') },
      { type: 'BPND', data: data(BodyPartType.head) },
    ]);
    const parts = parseBodyPartData({ fields });
    expect(parts.map((part) => [part.node, part.type])).toEqual([
      ['Canine_Spine2', 0],
      ['Canine_Head', 1],
    ]);
    expect(headNode(parts)).toBe('Canine_Head');
  });

  it('reads the cut node, the gore node, the limb model and the gore forms of BPND', () => {
    const bpnd = new Uint8Array(84);
    const view = new DataView(bpnd.buffer);
    view.setFloat32(0, 1, true);
    bpnd[4] = BodyPartFlag.severable | BodyPartFlag.explodable;
    bpnd[5] = BodyPartType.head;
    bpnd[9] = 40; // explosion chance
    view.setUint16(10, 3, true); // exploded: debris count, debris, explosion, debris scale
    view.setUint32(12, 0x100, true);
    view.setUint32(16, 0x101, true);
    view.setFloat32(24, 2, true);
    view.setInt32(28, 5, true); // severed: debris count, debris, explosion, debris scale
    view.setUint32(32, 0x200, true);
    view.setUint32(36, 0x201, true);
    view.setFloat32(40, 0.5, true);
    view.setFloat32(44, 1.5, true); // gore translation x
    view.setFloat32(64, 90, true); // gore rotation z
    view.setUint32(68, 0x1f82a, true); // severed and exploded impact data
    view.setUint32(72, 0x1f82b, true);
    bpnd[76] = 4;
    bpnd[77] = 6;
    view.setFloat32(80, 1.25, true);
    const fields = new Fields([
      { type: 'BPTN', data: text('Head') },
      { type: 'BPNN', data: text('NPC Head [Head]') },
      { type: 'BPNT', data: text('NPC Neck [Neck]') },
      { type: 'BPNI', data: text('NPC Head [Head]') },
      { type: 'BPND', data: bpnd },
      { type: 'NAM1', data: text('Actors\\Character\\Head.nif') },
      { type: 'NAM4', data: text('Camera3rd [Cam3]') },
    ]);
    // Form ids made global by the record's plugin (here: its load order slot 1).
    const [head] = parseBodyPartData({
      fields,
      formIdAt: (bytes, offset) =>
        new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true) + 0x01000000,
    });
    expect(head).toMatchObject({
      node: 'NPC Head [Head]',
      target: 'NPC Neck [Neck]',
      ikStart: 'NPC Head [Head]',
      type: BodyPartType.head,
      flags: BodyPartFlag.severable | BodyPartFlag.explodable,
      explosionChance: 40,
      limbModel: 'Actors\\Character\\Head.nif',
      limbScale: 1.25,
      goreNode: 'Camera3rd [Cam3]',
      goreTranslate: [1.5, 0, 0],
      goreRotate: [0, 0, 90],
      severed: {
        debris: 0x01000200,
        debrisCount: 5,
        debrisScale: 0.5,
        explosion: 0x01000201,
        impactData: 0x0101f82a,
        decalCount: 4,
      },
      exploded: {
        debris: 0x01000100,
        debrisCount: 3,
        debrisScale: 2,
        explosion: 0x01000101,
        impactData: 0x0101f82b,
        decalCount: 6,
      },
    });
  });
});
