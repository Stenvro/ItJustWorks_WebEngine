// The Default Object Manager (DOBJ, one record): the forms the engine itself uses for a
// purpose, keyed by a four-letter use code — the music category (MDSC), the default music
// (DFMS), combat music (BTMS), the dialogue output models, ... Later plugins list only the uses
// they set (the rest of their array is zero), so each version of the record adds to or replaces
// the ones before it, use by use. Platform-independent. Notes: docs/formats/esm.md ("Default
// objects").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** Use codes of default objects the engine reads. */
export const DefaultObjectUse = {
  /** MUSC played where nothing else names music. */
  defaultMusic: 'DFMS',
  /** MUSC of combat. */
  battleMusic: 'BTMS',
  deathMusic: 'DTMS',
  successMusic: 'SCMS',
  levelUpMusic: 'LUMS',
  dungeonClearedMusic: 'DCMS',
  /** SNCT music plays in. */
  musicCategory: 'MDSC',
  /** MATT of the landscape (where a land texture names none). */
  landMaterial: 'DLMT',
  /** SNDR looping while the camera is under water. */
  underwaterLoop: 'UWLS',
} as const;

/** Entries of DOBJ DNAM: u32 use code (four characters), form id. */
const ENTRY_SIZE = 8;

export class DefaultObjects {
  readonly #objects = new Map<string, number>();

  /** The form for a use, if the load order sets one. */
  get(use: string): number | undefined {
    return this.#objects.get(use);
  }

  get size(): number {
    return this.#objects.size;
  }

  /** Applies one version of the DOBJ record over what earlier plugins set. */
  apply(record: Pick<GameRecord, 'fields' | 'formIdAt'>): void {
    const dnam = record.fields.first('DNAM');
    if (!dnam) return;
    const data = view(dnam);
    for (let offset = 0; offset + ENTRY_SIZE <= dnam.byteLength; offset += ENTRY_SIZE) {
      if (data.getUint32(offset, true) === 0) continue;
      const use = String.fromCharCode(...dnam.subarray(offset, offset + 4));
      const formId = record.formIdAt(dnam, offset + 4);
      if (formId === 0) this.#objects.delete(use);
      else this.#objects.set(use, formId);
    }
  }

  /** The default objects of the load order: every DOBJ version in turn. */
  static async read(db: RecordDatabase): Promise<DefaultObjects> {
    const objects = new DefaultObjects();
    for (const formId of db.formIdsOfType('DOBJ')) {
      for (const location of db.locateAll(formId)) objects.apply(await db.read(location));
    }
    return objects;
  }
}
