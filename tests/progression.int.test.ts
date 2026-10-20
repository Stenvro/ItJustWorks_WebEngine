// Integration test: skills, levels and auto-calculated stats on the local game data (the
// running engine: src/scripting/runtime/progression-engine.ts). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorLevel, autoCalcStats } from '../src/gameplay/actor-leveling.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { NpcFlag, TemplateFlag } from '../src/world/actor-records.ts';
import { parseNpcStats, parseRaceStats } from '../src/world/actor-stats-records.ts';
import { ActorValue } from '../src/world/actor-values.ts';
import { parseClassStats } from '../src/world/leveling-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** HousecarlWhiterun (Lydia) and her placed reference. */
const LYDIA_BASE = 0xa2c8e;
const LYDIA = 0xa2c94;
const LOCKPICKING = ActorValue.firstSkill + 8;

describe.skipIf(!hasGamedata())('progression on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const runtime = (): ScriptRuntime =>
    new ScriptRuntime(db, new ScriptLibrary((name) => db.script(name)));

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  });

  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("reproduces every auto-calculated NPC's stored health, magicka and stamina", async () => {
    let checked = 0;
    for (const formId of db.formIdsOfType('NPC_')) {
      const record = await db.get(formId);
      if (!record) continue;
      const npc = parseNpcStats(record);
      if ((npc.flags & NpcFlag.autoCalcStats) === 0) continue;
      if ((npc.templateFlags & (TemplateFlag.stats | TemplateFlag.traits)) !== 0) continue;
      const clas = await db.get(npc.class ?? 0);
      const race = await db.get(npc.race ?? 0);
      if (clas?.type !== 'CLAS' || race?.type !== 'RACE') continue;
      const stats = autoCalcStats({
        level: actorLevel(
          {
            level: npc.level,
            followsPlayer: (npc.flags & NpcFlag.pcLevelMult) !== 0,
            calcMinLevel: npc.calcMinLevel,
            calcMaxLevel: npc.calcMaxLevel,
          },
          1,
        ),
        weights: parseClassStats(clas),
        race: parseRaceStats(race),
        healthOffset: npc.healthOffset,
        magickaOffset: npc.magickaOffset,
        staminaOffset: npc.staminaOffset,
      });
      // (DNAM keeps negative values as u16.)
      expect([stats.health, stats.magicka, stats.stamina].map((v) => v & 0xffff)).toEqual([
        npc.health,
        npc.magicka,
        npc.stamina,
      ]);
      checked++;
    }
    expect(checked).toBeGreaterThan(1500);
  }, 60_000);

  it('levels Lydia with the player she follows', async () => {
    const game = runtime();
    game.state.actor(PLAYER_REF).level = 20;
    game.state.actor(LYDIA).playerTeammate = true;
    expect((await game.actors.info(LYDIA))?.leveled).toBe(LYDIA_BASE);
    expect(await game.actors.level(LYDIA)).toBe(20);
    expect((await game.actors.value(LYDIA, ActorValue.health)).base).toBe(321);
    expect((await game.actors.value(LYDIA, ActorValue.stamina)).base).toBe(114);
    expect((await game.actors.value(LYDIA, ActorValue.firstSkill)).base).toBe(61);
  });

  it('raises the player by skill experience to a level-up and takes it', async () => {
    const game = runtime();
    const increases: number[] = [];
    game.progression.listener = { skillIncreased: (increase) => increases.push(increase.level) };
    // UESP: AdvSkill Lockpicking 50 = 45 × 50 + 10 experience, 15 → 21.
    await game.progression.useSkill(PLAYER_REF, 'Lockpicking', 50);
    expect(increases).toEqual([16, 17, 18, 19, 20, 21]);
    expect((await game.actors.value(PLAYER_REF, LOCKPICKING)).base).toBe(21);
    expect(game.state.playerExperience).toBe(16 + 17 + 18 + 19 + 20 + 21);
    expect(game.state.levelUps).toBe(1);
    expect(await game.progression.levelUp(ActorValue.health)).toBe(true);
    expect(await game.actors.playerLevel()).toBe(2);
    expect((await game.actors.value(PLAYER_REF, ActorValue.health)).base).toBe(110);
    expect(game.perkPoints).toBe(1);
    expect(game.state.playerExperience).toBe(111 - 100);
  });
});
