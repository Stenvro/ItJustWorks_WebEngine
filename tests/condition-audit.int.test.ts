// Integration test: every condition function the load order's records use is valued by the
// evaluator that runs it (tools/condition-usage.ts): an unknown function is an error, not a
// pass. Only functions of a later milestone are held (NOT_YET, each with its TODO). Skipped
// without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { conditionAudit, NOT_YET, type ConditionAudit } from '../tools/condition-usage.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('the condition functions of the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let audit: ConditionAudit;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    const runtime = new ScriptRuntime(db, library, { warn: () => undefined });
    audit = await conditionAudit(db, runtime);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('scans the conditions of every record type', () => {
    expect(audit.usage.size).toBeGreaterThan(200);
    const types = new Set([...audit.usage.values()].flatMap((usage) => [...usage.records.keys()]));
    for (const type of ['INFO', 'PACK', 'IDLE', 'PERK', 'MGEF', 'QUST', 'SCEN', 'SNDR', 'CPTH'])
      expect(types).toContain(type);
  });

  it('values every function the data uses', () => {
    expect(audit.unvalued.map((finding) => `${finding.name}: ${finding.why}`)).toEqual([]);
    expect(audit.errors).toEqual([]);
  });

  it('holds back only functions of a later milestone, each with its TODO', () => {
    for (const finding of audit.notYet) expect(finding.why).toMatch(/^TODO\(M\d+\)/);
    // A held function the data no longer uses is not held.
    const used = new Set(audit.usage.keys());
    for (const held of NOT_YET.keys()) expect(used).toContain(held);
  });
});
