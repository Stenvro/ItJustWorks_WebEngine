// Harvestable flora: FLOR (plants, fish, the Dragonborn's mushrooms) and TREE (shrubs with
// berries) carry PFIG, the ingredient (an INGR, or a leveled item list) the player harvests,
// SNAM the harvest sound, PFPC the chance (percent) of producing it by season (spring, summer,
// fall, winter) and FLOR's RNAM the activation's verb ("Harvest", "Catch", "Pick"). Layouts
// after xEdit's wbDefinitionsTES5 (FLOR, TREE). Where a model has a NiSwitchNode, its second
// child is the harvested look (the Creation Kit's flora models: "unharvested, harvested").
// Platform-independent. Notes: docs/gameplay.md ("Harvesting").

import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<
  GameRecord,
  'type' | 'formId' | 'editorId' | 'fields' | 'formIdField' | 'text'
>;

export interface FloraRecord {
  readonly formId: number;
  readonly editorId: string;
  /** PFIG: what harvesting gives (INGR, ALCH, LVLI, ...). */
  readonly ingredient: number;
  /** SNAM: SNDR played as it is harvested. */
  readonly sound: number | undefined;
  /** PFPC: percent chance of producing in spring, summer, fall and winter (all 100 without). */
  readonly production: readonly [number, number, number, number];
  /** RNAM: the activation's verb (FLOR only; sHarvest otherwise). */
  readonly verb: string | undefined;
}

/** The switch child of a flora model that shows it harvested (NiSwitchNode index). */
export const HARVESTED_SWITCH_CHILD = 1;

/** A FLOR or TREE with an ingredient to harvest; undefined for others (and those without). */
export function parseFlora(record: RecordSource): FloraRecord | undefined {
  if (record.type !== 'FLOR' && record.type !== 'TREE') return undefined;
  const ingredient = record.formIdField('PFIG');
  if (ingredient === undefined || ingredient === 0) return undefined;
  const sound = record.formIdField('SNAM');
  const pfpc = record.fields.first('PFPC');
  const production: [number, number, number, number] =
    pfpc && pfpc.length >= 4
      ? [pfpc[0] ?? 0, pfpc[1] ?? 0, pfpc[2] ?? 0, pfpc[3] ?? 0]
      : [100, 100, 100, 100];
  const verb = record.type === 'FLOR' ? record.text('RNAM') : undefined;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    ingredient,
    sound: sound === 0 ? undefined : sound,
    production,
    verb: verb === '' ? undefined : verb,
  };
}

/**
 * The season of a month (0 Morning Star .. 11 Evening Star): 0 spring (First Seed, Rain's Hand,
 * Second Seed), 1 summer (Midyear, Sun's Height, Last Seed), 2 fall (Hearthfire, Frostfall,
 * Sun's Dusk), 3 winter (Evening Star, Morning Star, Sun's Dawn). TODO(M13): the engine's
 * split of the months is not documented; the calendar's (UESP "Lore:Calendar") is taken.
 */
export function seasonOf(month: number): number {
  const m = ((Math.floor(month) % 12) + 12) % 12;
  if (m >= 2 && m <= 4) return 0;
  if (m >= 5 && m <= 7) return 1;
  if (m >= 8 && m <= 10) return 2;
  return 3;
}

/** The chance (0..1) a flora produces its ingredient in a month. */
export function productionChance(flora: FloraRecord, month: number): number {
  return Math.min(100, Math.max(0, flora.production[seasonOf(month)] ?? 100)) / 100;
}
