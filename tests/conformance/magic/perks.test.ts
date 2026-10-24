// Conformance: perks (engine map: Magic, effects, perks > Perks): every perk entry point the load
// order's perks use is known and asked by the systems it belongs to.
//
// Sources:
// - The perks of the load order (PERK entries: `node tools/perk-info.ts --audit`).
// - The entry points' names and condition tabs: xEdit, UESP "Skyrim Mod:Mod File Format/PERK".

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRY_POINTS, EntryPoint } from '../../../src/gameplay/perk-entry-points.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parsePerk } from '../../../src/world/perk-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';

/** Every engine source file's text (src/, not the entry point table itself, not tests). */
function engineSources(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) engineSources(at, into);
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'perk-entry-points.ts'
    )
      into.push(fs.readFileSync(at, 'utf8'));
  }
  return into;
}

describe.skipIf(!hasGamedata())('the perks across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const used = new Map<number, number>();
  let perks = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('PERK')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      perks++;
      for (const entry of parsePerk(record).entries)
        if (entry.kind === 'entryPoint')
          used.set(entry.entryPoint, (used.get(entry.entryPoint) ?? 0) + 1);
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 483 perks and the 68 entry points they use', () => {
    expect(perks).toBe(483);
    expect(used.size).toBe(68);
    for (const id of used.keys()) expect(ENTRY_POINTS[id], String(id)).toBeDefined();
  });

  it('asks every entry point the perks use from the system it belongs to', () => {
    const sources = engineSources(path.resolve(import.meta.dirname, '../../../src')).join('\n');
    const names = new Map<number, string>(
      Object.entries(EntryPoint).map(([name, id]) => [id, name]),
    );
    const unasked = [...used.keys()].filter((id) => {
      const name = names.get(id);
      return name === undefined || !sources.includes(`EntryPoint.${name}`);
    });
    expect(unasked.map((id) => ENTRY_POINTS[id]?.name ?? String(id))).toEqual([]);
  });
});

describe('what the original’s perks do that ours do not yet', () => {
  it.todo('the 16 entry points no vanilla perk uses, as the engine asks them (mods)');
});
