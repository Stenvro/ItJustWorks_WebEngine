// Body part data (BPTD): a race's body parts by their skeleton nodes (xEdit wbDefinitionsTES5
// BPTD). Each part is a run of fields: BPTN its name, PNAM its pose-matching model, BPNN its node
// (the bone it is), BPNT the node a severed limb is cut at (the VATS target), BPNI the prefix of
// its hit-reaction variables (the IK chain's start), BPND its data, NAM1 the model of what flies
// off when it is severed or explodes (a head piece), NAM4 the node the gore effects follow (the
// gore object), NAM5 the model's texture hashes. The head part names where a creature's head is
// (detection's eyes, look-at, aim: src/shell/actors.ts); the severable and explodable parts drive
// dismemberment (src/shell/actor-dismemberment.ts). Platform-independent.

import type { Fields } from '../formats/esm/fields.ts';

/** BPND's part type: the engine knows one part per type (its limb enum). */
export const BodyPartType = {
  torso: 0,
  head: 1,
  eye: 2,
  lookAt: 3,
  flyGrab: 4,
  saddle: 5,
} as const;

/** BPND's flags. */
export const BodyPartFlag = {
  severable: 0x01,
  ikData: 0x02,
  ikBipedData: 0x04,
  explodable: 0x08,
  ikIsHead: 0x10,
  ikHeadtracking: 0x20,
  toHitChanceAbsolute: 0x40,
} as const;

/** What a part throws when it is cut off (severable) or blown apart (explodable). */
export interface BodyPartGore {
  /** DEBR: the generic debris thrown (0: none). */
  readonly debris: number;
  /** How many of the debris' models are thrown. */
  readonly debrisCount: number;
  /** The debris' scale. */
  readonly debrisScale: number;
  /** EXPL: the explosion placed at the part (0: none). */
  readonly explosion: number;
  /** IPDS: the impact data set whose blood decals are laid around it (0: none). */
  readonly impactData: number;
  /** How many decals of the impact data are laid. */
  readonly decalCount: number;
}

export interface BodyPart {
  readonly name: string;
  /** BPNN: the skeleton node it is. */
  readonly node: string;
  /** BPNT: the node a severed part is cut at (the VATS target). */
  readonly target: string;
  /** BPNI: the IK chain's start (the hit reaction's variable prefix). */
  readonly ikStart: string;
  /** BPND's part type (BodyPartType). */
  readonly type: number;
  /** BPND's flags (BodyPartFlag). */
  readonly flags: number;
  /** The damage multiplier of hits on it. */
  readonly damageMult: number;
  /** Its health share, percent. */
  readonly healthPercent: number;
  /** The chance (percent) that a killing blow that may blow it apart does. */
  readonly explosionChance: number;
  /** Severing: its debris, explosion and blood. */
  readonly severed: BodyPartGore;
  /** Exploding: its debris, explosion and blood. */
  readonly exploded: BodyPartGore;
  /** Where the gore effects sit relative to the gore node: translation, then rotation (degrees). */
  readonly goreTranslate: readonly [number, number, number];
  readonly goreRotate: readonly [number, number, number];
  /** NAM1: the model that flies off (the limb replacement; '' none). */
  readonly limbModel: string;
  /** The limb replacement model's scale. */
  readonly limbScale: number;
  /** NAM4: the node the gore effects attach to ('' the part's node). */
  readonly goreNode: string;
}

const zString = (data: Uint8Array): string => {
  let text = '';
  for (const byte of data) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
};

/** The record as the parser needs it: its fields, and its form ids made global. */
export interface BodyPartRecord {
  readonly fields: Fields;
  /** A form id in the record's data as a global one (the plugin's masters); raw if absent. */
  formIdAt?(data: Uint8Array, offset: number): number;
  /** A text field's text (localized plugins keep string ids); the raw text if absent. */
  textAt?(data: Uint8Array): string;
}

const NO_GORE: BodyPartGore = {
  debris: 0,
  debrisCount: 0,
  debrisScale: 1,
  explosion: 0,
  impactData: 0,
  decalCount: 0,
};

interface Building {
  name: string;
  node: string;
  target: string;
  ikStart: string;
  type: number;
  flags: number;
  damageMult: number;
  healthPercent: number;
  explosionChance: number;
  severed: BodyPartGore;
  exploded: BodyPartGore;
  goreTranslate: readonly [number, number, number];
  goreRotate: readonly [number, number, number];
  limbModel: string;
  limbScale: number;
  goreNode: string;
}

const emptyPart = (name: string): Building => ({
  name,
  node: '',
  target: '',
  ikStart: '',
  type: -1,
  flags: 0,
  damageMult: 1,
  healthPercent: 0,
  explosionChance: 0,
  severed: NO_GORE,
  exploded: NO_GORE,
  goreTranslate: [0, 0, 0],
  goreRotate: [0, 0, 0],
  limbModel: '',
  limbScale: 1,
  goreNode: '',
});

/** BPND (84 bytes in SSE): the part's numbers and the forms of its gore. */
function readNodeData(record: BodyPartRecord, data: Uint8Array, part: Building): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const has = (end: number): boolean => data.length >= end;
  const form = (offset: number): number => {
    const raw = view.getUint32(offset, true);
    return raw === 0 ? 0 : (record.formIdAt?.(data, offset) ?? raw);
  };
  if (!has(6)) return;
  part.damageMult = view.getFloat32(0, true);
  part.flags = data[4] ?? 0;
  part.type = data[5] ?? -1;
  if (!has(10)) return;
  part.healthPercent = data[6] ?? 0;
  part.explosionChance = data[9] ?? 0;
  if (!has(28)) return;
  const explodedDebrisCount = view.getUint16(10, true);
  const explodedDebris = form(12);
  const explodedExplosion = form(16);
  const explodedDebrisScale = view.getFloat32(24, true);
  if (!has(84)) {
    part.exploded = {
      ...NO_GORE,
      debris: explodedDebris,
      debrisCount: explodedDebrisCount,
      debrisScale: explodedDebrisScale,
      explosion: explodedExplosion,
    };
    return;
  }
  part.severed = {
    debrisCount: view.getInt32(28, true),
    debris: form(32),
    explosion: form(36),
    debrisScale: view.getFloat32(40, true),
    impactData: form(68),
    decalCount: data[76] ?? 0,
  };
  part.exploded = {
    debris: explodedDebris,
    debrisCount: explodedDebrisCount,
    debrisScale: explodedDebrisScale,
    explosion: explodedExplosion,
    impactData: form(72),
    decalCount: data[77] ?? 0,
  };
  part.goreTranslate = [
    view.getFloat32(44, true),
    view.getFloat32(48, true),
    view.getFloat32(52, true),
  ];
  part.goreRotate = [
    view.getFloat32(56, true),
    view.getFloat32(60, true),
    view.getFloat32(64, true),
  ];
  part.limbScale = view.getFloat32(80, true);
}

/** The parts of a BPTD record, in order. */
export function parseBodyPartData(record: BodyPartRecord): BodyPart[] {
  const parts: BodyPart[] = [];
  let current: Building | undefined;
  for (const field of record.fields.list) {
    switch (field.type) {
      case 'BPTN':
        if (current) parts.push(current);
        current = emptyPart(record.textAt?.(field.data) ?? zString(field.data));
        break;
      case 'BPNN':
        if (current) current.node = zString(field.data);
        break;
      case 'BPNT':
        if (current) current.target = zString(field.data);
        break;
      case 'BPNI':
        if (current) current.ikStart = zString(field.data);
        break;
      case 'BPND':
        if (current) readNodeData(record, field.data, current);
        break;
      case 'NAM1':
        if (current) current.limbModel = zString(field.data);
        break;
      case 'NAM4':
        if (current) current.goreNode = zString(field.data);
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
