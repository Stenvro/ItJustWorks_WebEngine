// What the records tell detection (docs/ai.md, "Detection"): how loud a weapon's swing is
// (WEAP VNAM, its detection sound level), how loud casting a magic effect is (MGEF DATA, its
// casting sound level), and the package lists a quest alias overrides its actor's reactions
// with (QUST: SPOR spectator, OCOR observe corpse, GWOR guard warn, ECOR combat, after each
// alias's ALST / ALLS). Layouts: xEdit's wbDefinitionsTES5 (WEAP VNAM "Detection Sound Level",
// MGEF DATA "Casting Sound Level", the alias's override package lists), CommonLibSSE
// (BGSOverridePackCollection). Sound levels: SoundLevel in src/ai/detection.ts. The NPC_'s own
// lists: src/ai/race-combat-records.ts. Platform-independent. Notes: docs/formats/esm.md
// ("Actors"); check: `node tools/detection-info.ts --records`.

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from '../world/record-db.ts';
import type { OverridePackageLists } from './race-combat-records.ts';
import { SoundLevel } from './detection.ts';

type RecordSource = Pick<GameRecord, 'fields' | 'formIdAt'>;

/** MGEF DATA: the casting sound level's offset (after the perk to apply). */
const MGEF_CASTING_SOUND_LEVEL = 140;

/** WEAP VNAM: how loud attacking with it is (0 loud, 1 normal, 2 silent; none: normal). */
export function weaponSoundLevel(record: RecordSource): number {
  const vnam = record.fields.first('VNAM');
  return vnam && vnam.length >= 4 ? view(vnam).getUint32(0, true) : SoundLevel.normal;
}

/** MGEF DATA: how loud casting the effect is (0 loud, 1 normal, 2 silent, 3 very loud). */
export function castingSoundLevel(record: RecordSource): number {
  const data = record.fields.first('DATA');
  return data && data.length >= MGEF_CASTING_SOUND_LEVEL + 4
    ? view(data).getUint32(MGEF_CASTING_SOUND_LEVEL, true)
    : SoundLevel.normal;
}

/** A quest's reference aliases' override package lists, by alias id (those with any). */
export function aliasOverrideLists(record: RecordSource): Map<number, OverridePackageLists> {
  const lists = new Map<number, OverridePackageLists>();
  let alias: number | undefined;
  let current: { -readonly [K in keyof OverridePackageLists]: OverridePackageLists[K] } = {
    spectator: undefined,
    observeCorpse: undefined,
    guardWarn: undefined,
    combat: undefined,
  };
  const keys: Readonly<Record<string, keyof OverridePackageLists>> = {
    SPOR: 'spectator',
    OCOR: 'observeCorpse',
    GWOR: 'guardWarn',
    ECOR: 'combat',
  };
  for (const { type, data } of record.fields.list) {
    if (type === 'ALST' || type === 'ALLS') {
      // Location aliases (ALLS) have no packages; their id still ends the one before.
      alias = type === 'ALST' && data.length >= 4 ? view(data).getUint32(0, true) : undefined;
      current = {
        spectator: undefined,
        observeCorpse: undefined,
        guardWarn: undefined,
        combat: undefined,
      };
      continue;
    }
    const key = keys[type];
    if (key === undefined || alias === undefined || data.length < 4) continue;
    const formId = record.formIdAt(data, 0);
    if (formId === 0) continue;
    current[key] = formId;
    lists.set(alias, { ...current });
  }
  return lists;
}
