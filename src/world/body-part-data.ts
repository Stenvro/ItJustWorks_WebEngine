// Body part data (BPTD): a race's body parts by their skeleton nodes (xEdit wbDefinitionsTES5
// BPTD). Each part is a run of fields: BPTN its name, BPNN its node (the bone it is), BPNT the
// node a limb's replacement attaches to, BPNI the IK chain's start, BPND its data: damage
// multiplier (f32), flags (u8), its type (u8: 0 torso, 1 head, 2 eye, 3 look-at, 4 fly grab,
// 5 saddle), health percent, actor value, to-hit chance, explosion chance (u8s), ...; then its
// limb replacement model and gore fields. The head part names where a creature's head is
// (detection's eyes, look-at, aim: src/shell/actors.ts). Platform-independent.

import type { Fields } from '../formats/esm/fields.ts';

/** BPND's part type. */
export const BodyPartType = {
  torso: 0,
  head: 1,
  eye: 2,
  lookAt: 3,
  flyGrab: 4,
  saddle: 5,
} as const;

export interface BodyPart {
  readonly name: string;
  /** BPNN: the skeleton node it is. */
  readonly node: string;
  /** BPND's part type (BodyPartType). */
  readonly type: number;
}

const zString = (data: Uint8Array): string => {
  let text = '';
  for (const byte of data) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
};

/** The parts of a BPTD record, in order. */
export function parseBodyPartData(record: { readonly fields: Fields }): BodyPart[] {
  const parts: BodyPart[] = [];
  let current: { name: string; node: string; type: number } | undefined;
  for (const field of record.fields.list) {
    switch (field.type) {
      case 'BPTN':
        if (current) parts.push(current);
        current = { name: zString(field.data), node: '', type: -1 };
        break;
      case 'BPNN':
        if (current) current.node = zString(field.data);
        break;
      case 'BPND':
        if (current && field.data.length > 5) current.type = field.data[5] ?? -1;
        break;
      default:
        break;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** The node of a body part data's head (its first part of the head type), if it has one. */
export function headNode(parts: readonly BodyPart[]): string | undefined {
  return parts.find((part) => part.type === BodyPartType.head && part.node !== '')?.node;
}
