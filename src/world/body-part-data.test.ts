import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { BodyPartType, headNode, parseBodyPartData } from './body-part-data.ts';

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
});
