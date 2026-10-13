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
import {
  fourCCFromInt,
  fourCCToInt,
  GroupType,
  parseFields,
  RecordFlag,
} from '../formats/esm/record.ts';
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

export interface WorldspaceInfo {
  readonly formId: number;
  readonly editorId: string;
  /** Display name (FULL); empty if none. */
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
  readonly #worldGroupCache = new Map<
    Plugin,
    Map<number, { subBlocks: Map<string, number>; persistent: number[] }>
  >();
  readonly #subBlockCache = new Map<string, Promise<Map<string, number>>>();

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
   * plugins for `language` (the INI's sLanguage, lowercase). `index` reads a plugin's
   * record headers (the browser does it in workers; by default here).
   */
  static async open(
    vfs: Vfs,
    language = 'english',
    index: (source: ByteSource, name: string) => Promise<PluginIndex> = (source) =>
      indexPlugin(source),
  ): Promise<RecordDatabase> {
    const problems: string[] = [];
    const slotByName = new Map(
      vfs.loadOrder.map((entry, slot) => [asciiLowerCase(entry.name), slot]),
    );

    const plugins = await Promise.all(
      vfs.loadOrder.map(async (entry, slot): Promise<Plugin> => {
        const source = await vfs.openSource(entry.name);
        const pluginIndex = await index(source, entry.name);
        const header = await readRecord(source, pluginIndex, 0);
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
        return { slot, entry, info, index: pluginIndex, source, masterSlots, strings };
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

  /**
   * The global form id of a plugin's own record (`objectId`: the low 24 bits), or undefined
   * if the plugin is not loaded. For records the engine refers to by plugin and id.
   */
  formIdOf(pluginName: string, objectId: number): number | undefined {
    const name = asciiLowerCase(pluginName);
    const plugin = this.plugins.find((p) => asciiLowerCase(p.entry.name) === name);
    if (!plugin) return undefined;
    return this.toGlobal(plugin, ((plugin.masterSlots.length << 24) | (objectId & 0xffffff)) >>> 0);
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

  /** The record type ("REFR", "NAVM", ...) of a record version. */
  typeAt(location: RecordLocation): string {
    return fourCCFromInt(location.plugin.index.types[location.record] ?? 0);
  }

  /** Global form ids of every record of a type (e.g. "COBJ") in any plugin, in load order. */
  formIdsOfType(type: string): number[] {
    const code = fourCCToInt(type);
    const ids = new Set<number>();
    for (const plugin of this.plugins) {
      const { index } = plugin;
      for (let record = 0; record < index.recordCount; record++) {
        if (index.types[record] === code)
          ids.add(this.toGlobal(plugin, index.formIds[record] ?? 0));
      }
    }
    return [...ids];
  }

  /**
   * The group a record version sits in: its type and label (for cell and topic children
   * groups the label is the parent record, returned as a global form id).
   */
  parentGroup(location: RecordLocation): { type: number; label: number } | undefined {
    const { plugin, record } = location;
    const group = (plugin.index.parentGroups[record] ?? 0) - 1;
    if (group < 0) return undefined;
    const type = plugin.index.groupTypes[group] ?? 0;
    const label = plugin.index.groupLabels[group] ?? 0;
    const childGroup =
      type === GroupType.topicChildren ||
      type === GroupType.cellChildren ||
      type === GroupType.cellPersistentChildren ||
      type === GroupType.cellTemporaryChildren ||
      type === GroupType.worldChildren;
    return { type, label: childGroup ? this.toGlobal(plugin, label) : label };
  }

  /** The cell a reference is placed in (global form id), from the group it sits in. */
  cellOfReference(formId: number): number | undefined {
    const location = this.locate(formId);
    const group = location && this.parentGroup(location);
    if (
      group?.type !== GroupType.cellPersistentChildren &&
      group?.type !== GroupType.cellTemporaryChildren &&
      group?.type !== GroupType.cellChildren
    ) {
      return undefined;
    }
    return group.label;
  }

  /** The worldspace an exterior cell belongs to; undefined for interior cells. */
  worldOfCell(formId: number): number | undefined {
    const location = this.locate(formId);
    if (!location) return undefined;
    const { plugin, record } = location;
    const { index } = plugin;
    let group = (index.parentGroups[record] ?? 0) - 1;
    for (let depth = 0; group >= 0 && depth < 16; depth++) {
      if (index.groupTypes[group] === GroupType.worldChildren) {
        return this.toGlobal(plugin, index.groupLabels[group] ?? 0);
      }
      group = (index.groupParents[group] ?? 0) - 1;
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

  // --- Worldspaces ---------------------------------------------------------------

  /** Every worldspace (WRLD), in its winning version, sorted by editor id. */
  async worldspaces(): Promise<WorldspaceInfo[]> {
    const worlds = new Map<number, WorldspaceInfo>();
    const worldType = fourCCToInt('WRLD');
    for (const plugin of this.plugins) {
      const { index } = plugin;
      for (let group = 0; group < index.groupCount; group++) {
        if (index.groupTypes[group] !== GroupType.top || index.groupLabels[group] !== worldType)
          continue;
        const end = index.groupEndRecord[group] ?? 0;
        for (let record = index.groupFirstRecord[group] ?? 0; record < end; record++) {
          if (index.types[record] !== worldType) continue;
          const world = await this.read({ plugin, record });
          if (world.deleted) {
            worlds.delete(world.formId);
            continue;
          }
          worlds.set(world.formId, {
            formId: world.formId,
            editorId: world.editorId ?? '',
            name: world.text('FULL') ?? '',
          });
        }
      }
    }
    return [...worlds.values()].sort((a, b) => (a.editorId < b.editorId ? -1 : 1));
  }

  /**
   * Per plugin: the world children group of each worldspace, its exterior sub-block groups
   * by "x,y" (8×8 cells each) and its persistent cell record.
   */
  #worldGroups(
    plugin: Plugin,
  ): Map<number, { subBlocks: Map<string, number>; persistent: number[] }> {
    let groups = this.#worldGroupCache.get(plugin);
    if (groups) return groups;
    groups = new Map();
    const { index } = plugin;
    const cellType = fourCCToInt('CELL');
    const owners = new Map<number, number>(); // world children group → world (global)
    for (let group = 0; group < index.groupCount; group++) {
      const type = index.groupTypes[group];
      if (type === GroupType.worldChildren) {
        const world = this.toGlobal(plugin, index.groupLabels[group] ?? 0);
        owners.set(group, world);
        const entry = { subBlocks: new Map<string, number>(), persistent: [] as number[] };
        groups.set(world, entry);
        // The persistent cell sits directly in the world children group.
        const end = index.groupEndRecord[group] ?? 0;
        for (let record = index.groupFirstRecord[group] ?? 0; record < end; record++) {
          if (index.types[record] === cellType && (index.parentGroups[record] ?? 0) - 1 === group) {
            entry.persistent.push(record);
          }
        }
      } else if (type === GroupType.exteriorCellSubBlock) {
        let parent = (index.groupParents[group] ?? 0) - 1;
        while (parent >= 0 && !owners.has(parent)) parent = (index.groupParents[parent] ?? 0) - 1;
        const world = owners.get(parent);
        if (world === undefined) continue;
        const label = index.groupLabels[group] ?? 0;
        const y = (label << 16) >> 16;
        const x = label >> 16;
        groups.get(world)?.subBlocks.set(`${String(x)},${String(y)}`, group);
      }
    }
    this.#worldGroupCache.set(plugin, groups);
    return groups;
  }

  /** The exterior cell at grid position (x, y) of a worldspace (winning version), if any. */
  async exteriorCell(world: number, x: number, y: number): Promise<number | undefined> {
    const subX = Math.floor(x / 8);
    const subY = Math.floor(y / 8);
    const key = `${String(world)}:${String(subX)},${String(subY)}`;
    let pending = this.#subBlockCache.get(key);
    if (!pending) {
      pending = this.#readSubBlock(world, subX, subY);
      this.#subBlockCache.set(key, pending);
    }
    return (await pending).get(`${String(x)},${String(y)}`);
  }

  async #readSubBlock(world: number, subX: number, subY: number): Promise<Map<string, number>> {
    const cells = new Map<string, number>();
    const cellType = fourCCToInt('CELL');
    for (const plugin of this.plugins) {
      const group = this.#worldGroups(plugin)
        .get(world)
        ?.subBlocks.get(`${String(subX)},${String(subY)}`);
      if (group === undefined) continue;
      const { index } = plugin;
      const end = index.groupEndRecord[group] ?? 0;
      for (let record = index.groupFirstRecord[group] ?? 0; record < end; record++) {
        if (index.types[record] !== cellType || (index.parentGroups[record] ?? 0) - 1 !== group)
          continue;
        const cell = await this.read({ plugin, record });
        const xclc = cell.fields.first('XCLC');
        if (!xclc || xclc.length < 8) continue;
        const data = view(xclc);
        const key = `${String(data.getInt32(0, true))},${String(data.getInt32(4, true))}`;
        if (cell.deleted) cells.delete(key);
        else cells.set(key, cell.formId);
      }
    }
    return cells;
  }

  /** The worldspace's persistent cell: references that stay loaded, placed anywhere. */
  persistentCell(world: number): number | undefined {
    let found: number | undefined;
    for (const plugin of this.plugins) {
      for (const record of this.#worldGroups(plugin).get(world)?.persistent ?? []) {
        found = this.toGlobal(plugin, plugin.index.formIds[record] ?? 0);
      }
    }
    return found;
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
