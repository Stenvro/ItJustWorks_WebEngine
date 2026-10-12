// Game settings (GMST) of the load order, by editor id. The first letter of the editor id
// gives the type: f float, i/u integer, b bool, s string.

import { view } from '../formats/esm/fields.ts';
import type { RecordDatabase } from './record-db.ts';

export class GameSettings {
  readonly #numbers = new Map<string, number>();
  readonly #strings = new Map<string, string>();

  /** A setting's number (case-insensitive editor id), if the load order has it. */
  number(editorId: string): number | undefined {
    return this.#numbers.get(editorId.toLowerCase());
  }

  string(editorId: string): string | undefined {
    return this.#strings.get(editorId.toLowerCase());
  }

  get size(): number {
    return this.#numbers.size + this.#strings.size;
  }

  static async read(db: RecordDatabase): Promise<GameSettings> {
    const settings = new GameSettings();
    for (const formId of db.formIdsOfType('GMST')) {
      const record = await db.get(formId);
      const editorId = record?.editorId;
      const data = record?.fields.first('DATA');
      if (!record || record.deleted || !editorId || !data) continue;
      const key = editorId.toLowerCase();
      const type = key[0];
      if (type === 's') {
        settings.#strings.set(key, record.text('DATA') ?? '');
      } else if (data.length >= 4) {
        const d = view(data);
        const value =
          type === 'f'
            ? d.getFloat32(0, true)
            : type === 'u' || type === 'b'
              ? d.getUint32(0, true)
              : d.getInt32(0, true);
        settings.#numbers.set(key, value);
      }
    }
    return settings;
  }
}
