// Integration test: every subrecord of two plugins decodes by the subrecord layouts, consumes
// its data exactly, and its form ids and string ids check out (the whole load order:
// `node tools/format-census.ts esm`). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePluginInfo, PluginFlag } from '../src/formats/esm/plugin-header.ts';
import { forEachRecord, indexPlugin, readRecord } from '../src/formats/esm/plugin-index.ts';
import { parseFields } from '../src/formats/esm/record.ts';
import { decodeRecord } from '../src/formats/esm/record-layouts.ts';
import {
  PluginStrings,
  STRING_TABLE_KINDS,
  StringTable,
  stringTablePath,
} from '../src/formats/esm/strings.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder, resolveDataFile } from '../tools/gamedata-path.ts';
import { NodeFileSource } from '../tools/node-game-folder.ts';

describe.skipIf(!hasGamedata())('subrecord layouts on the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  }, 60_000);
  afterAll(async () => {
    await vfs.close();
  });

  for (const plugin of ['Update.esm', 'Dawnguard.esm']) {
    it(`decodes every subrecord of ${plugin} exactly`, async () => {
      const source = await NodeFileSource.open(resolveDataFile(plugin));
      const index = await indexPlugin(source);
      const head = await readRecord(source, index, 0);
      const info = parsePluginInfo(parseFields(head.data));
      const localized = (head.header.flags & PluginFlag.localized) !== 0;
      const tables: StringTable[] = [];
      for (const kind of STRING_TABLE_KINDS) {
        const file = stringTablePath(plugin, 'english', kind);
        if (localized && vfs.has(file)) tables.push(new StringTable(await vfs.read(file), kind));
      }
      const context = {
        localized,
        masterCount: info.masters.length,
        strings: localized ? new PluginStrings(tables) : undefined,
      };
      const failures: string[] = [];
      let records = 0;
      await forEachRecord(source, index, (_record, loaded) => {
        records++;
        const decoded = decodeRecord(loaded.header.type, parseFields(loaded.data), context);
        for (const code of decoded.unknown)
          failures.push(`${loaded.header.type} ${code}: no layout`);
        for (const [code, problems] of decoded.problems) {
          failures.push(
            `${loaded.header.type} ${code}: ${problems[0]?.kind} ${problems[0]?.detail}`,
          );
        }
      });
      await source.close();
      expect(records).toBeGreaterThan(1000);
      expect(failures.slice(0, 10)).toEqual([]);
    }, 120_000);
  }
});
