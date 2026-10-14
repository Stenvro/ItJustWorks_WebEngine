// Integration test: a new game's scripts in the script runtime, on the local game data: the
// quests that start with the game and the opening run, every native the scripts call exists,
// aliases fill as the Creation Kit describes. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { QuestFlag } from '../src/world/quest-records.ts';
import { ActorValue } from '../src/world/actor-values.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const MQ101 = 0x0003372b;
const MQ103 = 0x000d0800;
const PLAYER = 0x14;

describe.skipIf(!hasGamedata())('the script runtime on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const warnings: string[] = [];

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library, { warn: (message) => warnings.push(message) });
    await runtime.newGame();
    // Ten seconds of play at TimeScale 20.
    for (let t = 0; t < 10; t += 0.1) {
      runtime.update(0.1, (0.1 * 20) / 86400);
      await runtime.vm.idle();
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('starts every quest that starts with the game', async () => {
    const missed: string[] = [];
    for (const formId of db.formIdsOfType('QUST')) {
      const quest = await runtime.forms.quest(formId);
      if (!quest || (quest.flags & QuestFlag.startGameEnabled) === 0) continue;
      // Some stop themselves at once (the patch and DLC set-up quests): they started.
      if ((runtime.state.quests.get(formId)?.starts ?? 0) === 0) missed.push(quest.editorId);
    }
    expect(missed).toEqual([]);
  });

  it('runs the opening, its stages choosing their log entry (no debug fragments)', () => {
    const opening = runtime.state.quests.get(MQ101);
    expect(opening?.running).toBe(true);
    expect(opening?.aliases.size).toBeGreaterThan(100);
    // A later log entry of an early stage asks the debug question; it must not run.
    expect(runtime.state.messages.some((text) => text.includes('befriend'))).toBe(false);
  });

  it('has every native the scripts call', () => {
    expect(warnings.filter((message) => message.endsWith('is not implemented'))).toEqual([]);
  });

  it("fills a location's reference of a type from the master's and the DLCs' merged lists", () => {
    // Bleak Falls Barrow's boss: Skyrim.esm lists it; Dawnguard.esm's override adds others.
    const boss = runtime.state.quests.get(MQ103)?.aliases;
    expect(boss && [...boss.values()].length).toBeGreaterThan(0);
  });

  it("gives the player the race's starting attributes", async () => {
    const health = await runtime.actors.value(PLAYER, ActorValue.health);
    expect(health.max).toBeGreaterThan(0);
    expect(await runtime.actors.level(PLAYER)).toBe(1);
  });
});
