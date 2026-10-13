// Footsteps: an armor addon (ARMA SNDD; a race's skin addons for bare feet and creatures)
// names a footstep set (FSTS), which lists footsteps (FSTP) by gait: each answers an animation
// event by its tag ("FootLeft", "FootRight", "FootFront", "JumpDown", a wolf's
// "NPCWolfHowl") with an impact data set (IPDS), whose impact for the material underfoot
// sounds. Platform-independent. Notes: docs/formats/esm.md ("Footsteps").

import { zstring } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

/**
 * The gaits of a footstep set's sections (FSTS XCNT), in order: what their footsteps' impact
 * sets are named for in every human set (DefaultFootstepSet: Sneak, Sprint, Run, Walk), not
 * the walk / run forward (and alternate) names the record's documentation gives. The fifth is
 * empty in the human sets; creatures' sets fill it with their noises.
 */
export const FOOTSTEP_GAITS = ['sneak', 'sprint', 'run', 'walk', 'other'] as const;
export type FootstepGait = (typeof FOOTSTEP_GAITS)[number];

/** FSTS: the footsteps (FSTP form ids) of each gait. */
export interface FootstepSet {
  readonly formId: number;
  readonly editorId: string;
  readonly gaits: ReadonlyMap<FootstepGait, readonly number[]>;
}

/** FSTP: what answers an animation event. */
export interface Footstep {
  readonly formId: number;
  readonly editorId: string;
  /** DATA: the impact data set (IPDS). */
  readonly impactDataSet: number | undefined;
  /** ANAM: the animation event it answers. */
  readonly tag: string;
}

/** FSTS: XCNT counts per gait (u32 each), DATA the footsteps of all gaits in order. */
export function parseFootstepSet(record: RecordSource): FootstepSet {
  const xcnt = record.fields.first('XCNT');
  const data = record.fields.first('DATA');
  const gaits = new Map<FootstepGait, number[]>();
  let at = 0;
  FOOTSTEP_GAITS.forEach((gait, i) => {
    const count =
      xcnt && xcnt.length >= (i + 1) * 4
        ? new DataView(xcnt.buffer, xcnt.byteOffset, xcnt.byteLength).getUint32(i * 4, true)
        : 0;
    const steps: number[] = [];
    for (let k = 0; k < count && data && at + 4 <= data.length; k++, at += 4) {
      const formId = record.formIdAt(data, at);
      if (formId !== 0) steps.push(formId);
    }
    gaits.set(gait, steps);
  });
  return { formId: record.formId, editorId: record.editorId ?? '', gaits };
}

export function parseFootstep(record: RecordSource): Footstep {
  const data = record.fields.first('DATA');
  const anam = record.fields.first('ANAM');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    impactDataSet: data && data.length >= 4 ? record.formIdAt(data) || undefined : undefined,
    tag: anam ? zstring(anam) : '',
  };
}
