// Game settings (GMST) of the load order, by editor id. The first letter of the editor id
// gives the type: f float, i/u integer, b bool, s string.

import { view } from '../formats/esm/fields.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** A GMST's value by the type its editor id's first letter gives; undefined without one. */
export function gameSettingValue(
  record: Pick<GameRecord, 'editorId' | 'fields' | 'text'>,
): number | string | undefined {
  const editorId = record.editorId;
  const data = record.fields.first('DATA');
  if (!editorId || !data) return undefined;
  const type = editorId[0]?.toLowerCase();
  if (type === 's') return record.text('DATA') ?? '';
  if (data.length < 4) return undefined;
  const d = view(data);
  return type === 'f'
    ? d.getFloat32(0, true)
    : type === 'u' || type === 'b'
      ? d.getUint32(0, true)
      : d.getInt32(0, true);
}

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

  /** Sets a setting (the console's setgs). */
  set(editorId: string, value: number | string): void {
    const key = editorId.toLowerCase();
    if (typeof value === 'string') this.#strings.set(key, value);
    else this.#numbers.set(key, value);
  }

  get size(): number {
    return this.#numbers.size + this.#strings.size;
  }

  static async read(db: RecordDatabase): Promise<GameSettings> {
    const settings = new GameSettings();
    for (const formId of db.formIdsOfType('GMST')) {
      const record = await db.get(formId);
      const key = record?.editorId?.toLowerCase();
      if (!record || record.deleted || !key) continue;
      const value = gameSettingValue(record);
      if (typeof value === 'string') settings.#strings.set(key, value);
      else if (value !== undefined) settings.#numbers.set(key, value);
    }
    return settings;
  }
}
