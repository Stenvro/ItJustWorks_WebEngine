// Equip slots (EQUP, xEdit "Equip Type"; CommonLibSSE BGSEquipSlot): what items, spells and
// shouts are equipped to. A slot without parents is one of the actor's own places: the left
// hand, the right hand, the voice, the potion slot (the default objects LHEQ, RHEQ, VOEQ and
// POEQ name the engine's own). A slot with parents (PNAM) takes them: all of them when its DATA
// says "use all parents" (BothHands: both hands; Shield: the left hand), else one of them
// (EitherHand). A race lists the slots its members have (RACE QNAM: a wolf has only its right
// hand, a dragon its right hand and its voice). Platform-independent. Notes: docs/gameplay.md
// ("Equipment").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

/** The default objects (DOBJ) of the engine's equip slots. */
export const EquipSlotUse = {
  leftHand: 'LHEQ',
  rightHand: 'RHEQ',
  eitherHand: 'EHEQ',
  voice: 'VOEQ',
  potion: 'POEQ',
} as const;

/** EQUP DATA flags (CommonLibSSE BGSEquipSlot::Flag). */
export const EquipSlotFlag = { useAllParents: 0x1, parentsOptional: 0x2, itemSlot: 0x4 } as const;

export interface EquipSlotRecord {
  readonly formId: number;
  readonly editorId: string;
  /** PNAM: the slots it can be equipped to. */
  readonly parents: readonly number[];
  /** DATA (EquipSlotFlag). */
  readonly flags: number;
}

export function parseEquipSlot(record: RecordSource): EquipSlotRecord {
  const pnam = record.fields.first('PNAM');
  const parents: number[] = [];
  for (let at = 0; pnam && at + 4 <= pnam.length; at += 4) {
    const parent = record.formIdAt(pnam, at);
    if (parent !== 0) parents.push(parent);
  }
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    parents,
    flags: data && data.length >= 4 ? view(data).getUint32(0, true) : 0,
  };
}

/** Where a slot puts what takes it: one hand, either (one chosen), both, the voice, the potion slot. */
export type SlotPlace = 'left' | 'right' | 'either' | 'both' | 'voice' | 'potion';

/** An actor's own places (the slots without parents). */
export type OwnSlot = 'left' | 'right' | 'voice' | 'potion';

/** The engine's own slots, by the default objects. */
export interface OwnSlotForms {
  readonly left: number | undefined;
  readonly right: number | undefined;
  readonly voice: number | undefined;
  readonly potion: number | undefined;
}

/** Nested slots: vanilla's are one level deep. */
const MAX_DEPTH = 8;

/** The equip slots of the load order: where each puts what is equipped to it. */
export class EquipSlots {
  readonly #records: ReadonlyMap<number, EquipSlotRecord>;
  readonly #own: OwnSlotForms;
  readonly #places = new Map<number, SlotPlace | undefined>();

  constructor(records: Iterable<EquipSlotRecord>, own: OwnSlotForms) {
    this.#records = new Map([...records].map((record) => [record.formId, record]));
    this.#own = own;
  }

  get own(): OwnSlotForms {
    return this.#own;
  }

  /** Where a slot puts what takes it (undefined: not a slot of the load order). */
  place(slot: number | undefined): SlotPlace | undefined {
    if (slot === undefined) return undefined;
    if (!this.#places.has(slot)) this.#places.set(slot, this.#resolve(slot, 0));
    return this.#places.get(slot);
  }

  #resolve(slot: number, depth: number): SlotPlace | undefined {
    const own = this.#own;
    if (slot === own.left) return 'left';
    if (slot === own.right) return 'right';
    if (slot === own.voice) return 'voice';
    if (slot === own.potion) return 'potion';
    const record = this.#records.get(slot);
    if (!record || record.parents.length === 0 || depth > MAX_DEPTH) return undefined;
    const places = new Set<SlotPlace>();
    for (const parent of record.parents) {
      const place = this.#resolve(parent, depth + 1);
      if (place === 'both' || place === 'either') {
        places.add('left');
        places.add('right');
      } else if (place) {
        places.add(place);
      }
    }
    const hands = places.has('left') && places.has('right');
    if (hands) return (record.flags & EquipSlotFlag.useAllParents) !== 0 ? 'both' : 'either';
    return places.size === 1 ? [...places][0] : undefined;
  }

  /** The places a race's members have (RACE QNAM: its equip slots). */
  ownSlots(raceSlots: readonly number[]): Set<OwnSlot> {
    const slots = new Set<OwnSlot>();
    for (const slot of raceSlots) {
      const place = this.place(slot);
      if (place === 'both' || place === 'either') {
        slots.add('left');
        slots.add('right');
      } else if (place) {
        slots.add(place);
      }
    }
    return slots;
  }
}

/** RACE QNAM: the equip slots a race's members have, in order. */
export function raceEquipSlots(record: Pick<GameRecord, 'fields' | 'formIdAt'>): number[] {
  return record.fields
    .all('QNAM')
    .flatMap((data) => (data.length >= 4 ? [record.formIdAt(data, 0)] : []))
    .filter((formId) => formId !== 0);
}
