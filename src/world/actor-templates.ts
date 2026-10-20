// An actor's base as the game makes it: a leveled list (LVLN) placed by a reference picks one
// NPC_; an NPC_ with a template (TPLT) takes each part its template data flags name (traits,
// stats, factions, spells, AI data, packages, base data, inventory, script, keywords, ...)
// from the template, which may itself be a leveled list or have a template. Each leveled list
// on the way is picked once per actor, so every part comes from the same picks; the
// reference's form id seeds them, so an actor is the same every time it loads.
// Platform-independent. Notes: docs/formats/esm.md ("Actors").

import { view } from '../formats/esm/fields.ts';
import { parseLeveledList, type LeveledList } from './actor-records.ts';
import { pickLeveled, seededRandom } from './leveled.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

/** Templates and leveled lists nest; vanilla chains are a few levels deep. */
const MAX_DEPTH = 16;

export interface ActorTemplates {
  /** The NPC_ the reference's base came down to (GetLeveledActorBase for a leveled one). */
  readonly placed: number;
  /** The NPC_ that gives a part (a TemplateFlag): the placed one, or a template. */
  part(flag: number): number;
}

/** The seed of a reference's leveled choices (shared by its look and its scripts). */
export const actorSeed = (reference: number): number => (reference ^ 0x9e3779b9) >>> 0;

/**
 * Resolves the templates of an actor placed with `base` (NPC_ or LVLN) by `reference`, at
 * `level` (the level its leveled lists are picked at: its encounter zone's or the player's, by
 * its level modifier; the progression engine's leveledLevel).
 */
export async function resolveActorTemplates(
  get: (formId: number) => Promise<RecordSource | undefined>,
  base: number,
  reference: number,
  level: number,
  /** A leveled list as it stands (scripts add to them); its record's by default. */
  leveled: (record: RecordSource) => Promise<LeveledList> = (record) =>
    Promise.resolve(parseLeveledList(record)),
): Promise<ActorTemplates | undefined> {
  const random = seededRandom(actorSeed(reference));
  const picks = new Map<number, number | undefined>();
  const toNpc = async (formId: number, depth = 0): Promise<RecordSource | undefined> => {
    if (depth > MAX_DEPTH) return undefined;
    const record = await get(formId);
    if (record?.type === 'NPC_') return record;
    if (record?.type !== 'LVLN') return undefined;
    if (!picks.has(formId)) picks.set(formId, pickLeveled(await leveled(record), level, random));
    const picked = picks.get(formId);
    return picked === undefined ? undefined : toNpc(picked, depth + 1);
  };
  const placed = await toNpc(base);
  if (!placed) return undefined;
  // The template chain, once: each link with the flags of the NPC_ that names it.
  const chain: { record: RecordSource; flags: number }[] = [];
  let current: RecordSource | undefined = placed;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    const acbs: Uint8Array | undefined = current.fields.first('ACBS');
    const flags: number = acbs && acbs.length >= 20 ? view(acbs).getUint16(18, true) : 0;
    chain.push({ record: current, flags });
    const tplt: Uint8Array | undefined = current.fields.first('TPLT');
    const template: number = tplt && tplt.length >= 4 ? current.formIdAt(tplt) : 0;
    current = flags !== 0 && template !== 0 ? await toNpc(template) : undefined;
  }
  return {
    placed: placed.formId,
    part(flag: number): number {
      // Down the chain while each link takes this part from its template.
      let at = 0;
      while (at + 1 < chain.length && ((chain[at]?.flags ?? 0) & flag) !== 0) at++;
      return chain[at]?.record.formId ?? placed.formId;
    },
  };
}
