// All plugins of the load order as one database: global form ids, the winning version of
// each record (the last plugin that has it wins) and localized strings.
// Form id rules: docs/formats/esm.md

import type { ByteSource } from '../formats/byte-source.ts';
import { Fields, view, zstring } from '../formats/esm/fields.ts';
import { parsePluginInfo, type PluginInfo } from '../formats/esm/plugin-header.ts';
import {
  findRecord,
  indexPlugin,
  readRecord,
  type PluginIndex,
} from '../formats/esm/plugin-index.ts';
import { fourCCToInt, GroupType, parseFields, RecordFlag } from '../formats/esm/record.ts';
import {
  PluginStrings,
  STRING_TABLE_KINDS,
  StringTable,
  stringTablePath,
} from '../formats/esm/strings.ts';
import { asciiLowerCase } from '../formats/text.ts';
import type { LoadOrderEntry } from '../vfs/load-order.ts';
import type { Vfs } from '../vfs/vfs.ts';

export interface Plugin {
  readonly slot: number;
  readonly entry: LoadOrderEntry;
  readonly info: PluginInfo;
  readonly index: PluginIndex;
  readonly source: ByteSource;
  /** Load-order slot for each master (in `info.masters` order); -1 if missing. */
  readonly masterSlots: readonly number[];
  readonly strings: PluginStrings | undefined;
}

/** A record as seen by the engine: its winning version, with global form ids. */
export class GameRecord {
  readonly type: string;
  /** Global form id. */
  readonly formId: number;
  readonly flags: number;
  readonly fields: Fields;
  /** The plugin this version comes from. */
  readonly plugin: Plugin;
  readonly #db: RecordDatabase;

  constructor(
    db: RecordDatabase,
    plugin: Plugin,
    type: string,
    formId: number,
    flags: number,
    fields: Fields,
  ) {
    this.#db = db;
    this.plugin = plugin;
    this.type = type;
    this.formId = formId;
    this.flags = flags;
    this.fields = fields;
  }

  get editorId(): string | undefined {
    return this.fields.zstring('EDID');
  }

  get deleted(): boolean {
    return (this.flags & RecordFlag.deleted) !== 0;
  }

  /** A form id stored in this record's data, converted to a global form id. */
  formIdAt(data: Uint8Array, offset = 0): number {
    return this.#db.toGlobal(this.plugin, view(data).getUint32(offset, true));
  }

  /** A form id field (e.g. NAME), as a global form id. */
  formIdField(type: string): number | undefined {
    const data = this.fields.first(type);
    return data && data.length >= 4 ? this.formIdAt(data) : undefined;
  }

  /** A text field: a string table id in localized plugins, otherwise the text itself. */
  text(type: string): string | undefined {
    const data = this.fields.first(type);
    if (!data) return undefined;
    if (this.plugin.strings && data.length === 4) {
      return this.plugin.strings.get(view(data).getUint32(0, true)) ?? '';
    }
    return zstring(data);
  }
}

export interface InteriorCell {
  readonly formId: number;
  readonly editorId: string;
  /** Display name (FULL); empty for cells without one. */
  readonly name: string;
}

export interface RecordLocation {
  readonly plugin: Plugin;
  readonly record: number;
}

function hex(formId: number): string {
  return formId.toString(16).toUpperCase().padStart(8, '0');
}

export class RecordDatabase {
  readonly plugins: readonly Plugin[];
  readonly problems: readonly string[];
  /** Slot by full mod index (0x00-0xFD) and by light index (FE:xxx). */
  readonly #fullSlots = new Map<number, number>();
  readonly #lightSlots = new Map<number, number>();
  #cellChildren: Map<number, number>[] | undefined;

  private constructor(plugins: Plugin[], problems: string[]) {
    this.plugins = plugins;
    this.problems = problems;
    for (const plugin of plugins) {
      const { entry } = plugin;
      if (entry.lightIndex === undefined) this.#fullSlots.set(entry.modIndex, plugin.slot);
      else this.#lightSlots.set(entry.lightIndex, plugin.slot);
    }
  }

  /**
   * Indexes every plugin in the VFS load order and loads the string tables of localized
   * plugins for `language` (the INI's sLanguage, lowercase).
   */
  static async open(vfs: Vfs, language = 'english'): Promise<RecordDatabase> {
    const problems: string[] = [];
    const slotByName = new Map(
      vfs.loadOrder.map((entry, slot) => [asciiLowerCase(entry.name), slot]),
    );

    const plugins = await Promise.all(
      vfs.loadOrder.map(async (entry, slot): Promise<Plugin> => {
        const source = await vfs.openSource(entry.name);
        const index = await indexPlugin(source);
        const header = await readRecord(source, index, 0);
        if (header.header.type !== 'TES4')
          throw new Error(`${entry.name}: first record is not TES4`);
        const info = parsePluginInfo(parseFields(header.data));
        const masterSlots = info.masters.map((master) => {
          const masterSlot = slotByName.get(asciiLowerCase(master)) ?? -1;
          if (masterSlot < 0 || masterSlot >= slot) {
            problems.push(`${entry.name}: master ${master} is not loaded before it`);
          }
          return masterSlot;
        });

        let strings: PluginStrings | undefined;
        if (header.header.flags & RecordFlag.localized) {
          const tables: StringTable[] = [];
          for (const kind of STRING_TABLE_KINDS) {
            const path = stringTablePath(entry.name, language, kind);
            if (vfs.has(path)) tables.push(new StringTable(await vfs.read(path), kind));
            else problems.push(`${entry.name}: missing ${path}`);
          }
          strings = new PluginStrings(tables);
        }
        return { slot, entry, info, index, source, masterSlots, strings };
      }),
    );
    return new RecordDatabase(plugins, problems);
  }

  // --- Form ids ---------------------------------------------------------------

  /** Converts a form id stored in `plugin` into a global (load-order) form id. */
  toGlobal(plugin: Plugin, local: number): number {
    const high = local >>> 24;
    const target =
      high < plugin.masterSlots.length ? (plugin.masterSlots[high] ?? -1) : plugin.slot;
    const owner = this.plugins[target];
    if (!owner) return local; // missing master: keep the raw id
    const { lightIndex, modIndex } = owner.entry;
    return lightIndex === undefined
      ? ((modIndex << 24) | (local & 0xffffff)) >>> 0
      : (0xfe000000 | (lightIndex << 12) | (local & 0xfff)) >>> 0;
  }

  /** Converts a global form id into the id `plugin` would store, or undefined if it cannot. */
  toLocal(plugin: Plugin, global: number): number | undefined {
    const light = global >>> 24 === 0xfe;
    const target = light
      ? this.#lightSlots.get((global >>> 12) & 0xfff)
      : this.#fullSlots.get(global >>> 24);
    if (target === undefined) return undefined;
    const high =
      target === plugin.slot ? plugin.masterSlots.length : plugin.masterSlots.indexOf(target);
    if (high < 0) return undefined;
    return ((high << 24) | (global & (light ? 0xfff : 0xffffff))) >>> 0;
  }

  // --- Records ----------------------------------------------------------------

  /** Every version of a record, in load order (the last one wins). */
  locateAll(formId: number): RecordLocation[] {
    const found: RecordLocation[] = [];
    if (formId === 0) return found;
    for (const plugin of this.plugins) {
      const local = this.toLocal(plugin, formId);
      if (local === undefined) continue;
      const record = findRecord(plugin.index, local);
      if (record >= 0) found.push({ plugin, record });
    }
    return found;
  }

  locate(formId: number): RecordLocation | undefined {
    if (formId === 0) return undefined; // 0 means "none" (it is also the TES4 header's id)
    for (let slot = this.plugins.length - 1; slot >= 0; slot--) {
      const plugin = this.plugins[slot];
      if (!plugin) continue;
      const local = this.toLocal(plugin, formId);
      if (local === undefined) continue;
      const record = findRecord(plugin.index, local);
      if (record >= 0) return { plugin, record };
    }
    return undefined;
  }

  /** Reads a specific version of a record. */
  async read(location: RecordLocation): Promise<GameRecord> {
    const { plugin, record } = location;
    const loaded = await readRecord(plugin.source, plugin.index, record);
    return new GameRecord(
      this,
      plugin,
      loaded.header.type,
      this.toGlobal(plugin, loaded.header.formId),
      loaded.header.flags,
      new Fields(parseFields(loaded.data)),
    );
  }

  /** The winning version of a record, or undefined if no plugin has it. */
  async get(formId: number): Promise<GameRecord | undefined> {
    const location = this.locate(formId);
    return location && this.read(location);
  }

  async require(formId: number): Promise<GameRecord> {
    const record = await this.get(formId);
    if (!record) throw new Error(`Record ${hex(formId)} not found`);
    return record;
  }

  // --- Cells --------------------------------------------------------------------

  /**
   * Every interior cell (from the CELL top groups of all plugins), in its winning version,
   * sorted by editor id.
   */
  async interiorCells(): Promise<InteriorCell[]> {
    const cells = new Map<number, InteriorCell>();
    const cellType = fourCCToInt('CELL');
    for (const plugin of this.plugins) {
      const { index } = plugin;
      for (let group = 0; group < index.groupCount; group++) {
        if (index.groupTypes[group] !== GroupType.top || index.groupLabels[group] !== cellType)
          continue;
        const end = index.groupEndRecord[group] ?? 0;
        for (let record = index.groupFirstRecord[group] ?? 0; record < end; record++) {
          if (index.types[record] !== cellType) continue;
          const cell = await this.read({ plugin, record });
          if (cell.deleted) {
            cells.delete(cell.formId);
            continue;
          }
          cells.set(cell.formId, {
            formId: cell.formId,
            editorId: cell.editorId ?? '',
            name: cell.text('FULL') ?? '',
          });
        }
      }
    }
    return [...cells.values()].sort((a, b) => (a.editorId < b.editorId ? -1 : 1));
  }

  /**
   * Form ids of every placed reference (REFR, ACHR, ...) in a cell, collected from all
   * plugins that add to or override it.
   */
  cellReferences(cellFormId: number): number[] {
    this.#cellChildren ??= this.plugins.map((plugin) => {
      const map = new Map<number, number>();
      const { index } = plugin;
      for (let group = 0; group < index.groupCount; group++) {
        if (index.groupTypes[group] === GroupType.cellChildren) {
          map.set(index.groupLabels[group] ?? 0, group);
        }
      }
      return map;
    });

    const references = new Set<number>();
    for (const plugin of this.plugins) {
      const local = this.toLocal(plugin, cellFormId);
      if (local === undefined) continue;
      const group = this.#cellChildren[plugin.slot]?.get(local);
      if (group === undefined) continue;
      const { index } = plugin;
      const end = index.groupEndRecord[group] ?? 0;
      for (let record = index.groupFirstRecord[group] ?? 0; record < end; record++) {
        references.add(this.toGlobal(plugin, index.formIds[record] ?? 0));
      }
    }
    return [...references];
  }

  async close(): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        await plugin.source.close?.();
      }),
    );
  }
}
