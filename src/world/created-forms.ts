// Forms the running game makes (the game's created objects, CommonLibSSE
// BGSCreatedObjectManager: the enchantments, potions and poisons the player makes; here also the
// enchanted weapon or armor itself): plain data, kept in the game state (GameState.createdForms,
// saved with it: M12) and read as records like the plugins' own (CreatedRecord). A created
// form is a record type and its fields; each field holds its bytes and, when it was copied
// from a plugin's record (a template's model, an enchantment's conditions), the name of that
// plugin, whose master list its form ids are read with; the engine's own fields hold global
// form ids. Text fields the engine writes are UTF-8 strings (never string table ids).
// Platform-independent. Notes: docs/gameplay.md ("Crafting").

import { Fields, view, zstring } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import { asciiLowerCase, encodeUtf8 } from '../formats/text.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** A field of a created form. */
export interface CreatedField {
  readonly type: string;
  readonly data: Uint8Array;
  /** The plugin (file name) whose form ids the data holds; none: global form ids. */
  readonly plugin?: string;
}

/** A form the game made: its record type and fields (in record order). */
export interface CreatedForm {
  readonly type: string;
  readonly fields: readonly CreatedField[];
}

/** The save's own range of form ids (created references and forms share it). */
export function isCreatedFormId(formId: number): boolean {
  return formId >>> 24 === 0xff;
}

/**
 * A created form read as a record: its fields' form ids converted by the plugin each came from
 * (the engine's own are global already), its texts read as strings or, for a localized
 * plugin's copied field, from that plugin's string tables.
 */
export class CreatedRecord extends GameRecord {
  readonly #db: RecordDatabase;
  /** The plugin of each copied field, by the field's own buffer. */
  readonly #plugins: WeakMap<ArrayBufferLike, Plugin>;

  constructor(db: RecordDatabase, formId: number, form: CreatedForm) {
    const plugins = new WeakMap<ArrayBufferLike, Plugin>();
    const fields: Field[] = [];
    let home: Plugin | undefined;
    for (const field of form.fields) {
      // Each field in a buffer of its own: the buffer tells its plugin.
      const data = field.data.slice();
      const plugin = field.plugin === undefined ? undefined : pluginNamed(db, field.plugin);
      if (plugin) {
        plugins.set(data.buffer, plugin);
        home ??= plugin;
      }
      fields.push({ type: field.type, data });
    }
    // The record's plugin: its template's (a copied script's properties are read by it).
    super(db, home ?? db.plugins[0] ?? ({} as Plugin), form.type, formId, 0, new Fields(fields));
    this.#db = db;
    this.#plugins = plugins;
  }

  override formIdAt(data: Uint8Array, offset = 0): number {
    const local = view(data).getUint32(offset, true);
    const plugin = this.#plugins.get(data.buffer);
    return plugin ? this.#db.toGlobal(plugin, local) : local;
  }

  override textAt(data: Uint8Array): string {
    const plugin = this.#plugins.get(data.buffer);
    if (plugin?.strings && data.length === 4)
      return plugin.strings.get(view(data).getUint32(0, true)) ?? '';
    return zstring(data);
  }

  /** Its fields are its own already. */
  override detached(): GameRecord {
    return this;
  }

  /** The plugin a field's data came from (none: global form ids). */
  pluginOf(data: Uint8Array): Plugin | undefined {
    return this.#plugins.get(data.buffer);
  }
}

function pluginNamed(db: RecordDatabase, name: string): Plugin | undefined {
  const lower = asciiLowerCase(name);
  return db.plugins.find((plugin) => asciiLowerCase(plugin.entry.name) === lower);
}

/**
 * A record's fields as created fields (copied with the plugin they are read by), those `keep`
 * accepts. A created record's copied fields keep their own plugin.
 */
export function copyFields(
  record: GameRecord,
  keep: (type: string) => boolean = () => true,
): CreatedField[] {
  const fields: CreatedField[] = [];
  for (const { type, data } of record.fields.list) {
    if (!keep(type)) continue;
    fields.push(copyField(record, type, data));
  }
  return fields;
}

/** One field's data of a record, copied with the plugin it is read by. */
export function copyField(record: GameRecord, type: string, data: Uint8Array): CreatedField {
  const plugin = record instanceof CreatedRecord ? record.pluginOf(data) : record.plugin;
  const copy = data.slice();
  return plugin?.entry === undefined
    ? { type, data: copy }
    : { type, data: copy, plugin: plugin.entry.name };
}

/** Field encoders (little-endian; form ids global). */
export const createdField = {
  zstring(type: string, text: string): CreatedField {
    const bytes = encodeUtf8(text);
    const data = new Uint8Array(bytes.length + 1);
    data.set(bytes);
    return { type, data };
  },
  formId(type: string, formId: number): CreatedField {
    return createdField.u32(type, formId);
  },
  u16(type: string, value: number): CreatedField {
    const data = new Uint8Array(2);
    view(data).setUint16(0, value, true);
    return { type, data };
  },
  u32(type: string, value: number): CreatedField {
    const data = new Uint8Array(4);
    view(data).setUint32(0, value >>> 0, true);
    return { type, data };
  },
  /** Form ids packed one after another (KWDA). */
  formIds(type: string, formIds: readonly number[]): CreatedField {
    const data = new Uint8Array(formIds.length * 4);
    formIds.forEach((formId, i) => {
      view(data).setUint32(i * 4, formId >>> 0, true);
    });
    return { type, data };
  },
  bytes(type: string, data: Uint8Array): CreatedField {
    return { type, data };
  },
};

/** An effect item: its magic effect (global form id) and EFIT (magnitude, area, duration). */
export interface CreatedEffect {
  readonly effect: number;
  readonly magnitude: number;
  readonly area: number;
  readonly duration: number;
  /** Its conditions (CTDA and what follows them), copied from the effect item it is made from. */
  readonly conditions?: readonly CreatedField[];
}

/** EFID, EFIT and the conditions of each effect, in order (UESP: magic items' effects). */
export function effectFields(effects: readonly CreatedEffect[]): CreatedField[] {
  const fields: CreatedField[] = [];
  for (const effect of effects) {
    fields.push(createdField.formId('EFID', effect.effect));
    const efit = new Uint8Array(12);
    const data = view(efit);
    data.setFloat32(0, effect.magnitude, true);
    data.setUint32(4, Math.max(0, Math.round(effect.area)), true);
    data.setUint32(8, Math.max(0, Math.round(effect.duration)), true);
    fields.push(createdField.bytes('EFIT', efit));
    fields.push(...(effect.conditions ?? []));
  }
  return fields;
}

/**
 * The fields of a record's effect items, each EFID's conditions (CTDA, with the CIS1 / CIS2
 * strings that follow them) copied by effect, in order.
 */
export function effectConditionFields(record: GameRecord): CreatedField[][] {
  const effects: CreatedField[][] = [];
  let current: CreatedField[] | undefined;
  for (const { type, data } of record.fields.list) {
    if (type === 'EFID') {
      current = [];
      effects.push(current);
    } else if (current && (type === 'CTDA' || type === 'CIS1' || type === 'CIS2')) {
      current.push(copyField(record, type, data));
    }
  }
  return effects;
}

/** Two created forms hold the same fields (a potion made again is the one made before). */
export function sameCreatedForm(a: CreatedForm, b: CreatedForm): boolean {
  if (a.type !== b.type || a.fields.length !== b.fields.length) return false;
  return a.fields.every((field, i) => {
    const other = b.fields[i];
    return (
      other?.type === field.type &&
      (other.plugin ?? '') === (field.plugin ?? '') &&
      other.data.length === field.data.length &&
      other.data.every((byte, at) => byte === field.data[at])
    );
  });
}
