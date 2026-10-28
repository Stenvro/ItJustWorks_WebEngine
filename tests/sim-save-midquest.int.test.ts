// Integration test: a save taken mid-quest loads into the same game (docs/formats/save.md).
// MQ101 in Helgen Keep on Ralof's route, saved at stage 272 (KeepIntroSceneB in phase 28, the
// two Imperials in the barracks): loaded, killing both sets 280 (their aliases' MQ101EnemyScript
// counts the deaths) and Ralof goes on to fetch the key. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route). */
const INTRO_RALOF = 0x4e1e2;
/** Gunjar's body (MQ101CorpseSons01). */
const GUNJAR = 0xb1694;
/** MQ101's Ralof alias, BarracksRoomSoldier01 (the officer) and BarracksRoomSoldier02. */
const RALOF = 12;
const BARRACKS_OFFICER = 173;
const BARRACKS_SOLDIER = 174;

/** The player keeps by Ralof (within the 100 units his "wait for the player" phases ask). */
async function keepBy(sim: Sim, ralof: number): Promise<void> {
  const near = await sim.distance(ralof, PLAYER_REF);
  const at = await sim.position(ralof);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > 95 && at && me) {
    const k = 80 / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
  }
}

/** What the quest is: its stages, aliases, scene and the aliases holding its actors. */
function questState(sim: Sim, actors: readonly number[]): unknown {
  const quest = sim.runtime.state.quest(MQ101);
  return {
    stages: [...quest.stagesDone].sort((a, b) => a - b),
    aliases: [...quest.aliases].sort((a, b) => a[0] - b[0]),
    scenes: sim.runtime.scenes
      .snapshot()
      .map((playing) => ({ scene: playing.scene, phase: playing.phase })),
    holding: actors.map((actor) => sim.runtime.aliasesHolding(actor)),
  };
}

describe.skipIf(!hasGamedata())('A save mid-quest', () => {
  // Found 2026-10-28: loaded at 272, the Imperials' deaths no longer set 280. The runtime's
  // index of the references aliases hold (which events reach alias scripts, which packages,
  // factions and names aliases give) was built only as aliases filled, never from a loaded
  // game's quests: MQ101EnemyScript's OnDeath never ran.
  it('loads MQ101 at 272 mid-fight (280 follows the deaths) and mid-line (the scene goes on)', async () => {
    const sim = await openSim({ opening: true });
    let bytes: Uint8Array;
    let saved: unknown;
    let fights: (number | undefined)[];
    let midLine: Uint8Array;
    let lineSaved: unknown;
    let ralof: number;
    let imperials: number[] = [];
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      const quest = sim.runtime.state.quest(MQ101);
      ralof = quest.aliases.get(RALOF) ?? 0;
      let looted = false;
      for (let second = 0; second < 150 && !sim.stageDone(MQ101, 272); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
        if (!looted && sim.stageDone(MQ101, 255)) {
          const [x, y, z] = sim.actor(GUNJAR)?.position ?? [0, 0, 0];
          await sim.moveTo([x + 80, y, z + 10]);
          await sim.step(0.5);
          looted = sim.activate(GUNJAR);
        }
      }
      expect(sim.stageDone(MQ101, 272)).toBe(true);
      imperials = [BARRACKS_OFFICER, BARRACKS_SOLDIER].map(
        (alias) => quest.aliases.get(alias) ?? 0,
      );
      // Saved as they fight the player (as Actor.StartCombat has them: their own fight starts
      // when they see the player, at a time that varies with the route).
      for (const imperial of imperials) {
        const state = sim.runtime.state.actor(imperial);
        state.combatTargets = [...(state.combatTargets ?? []), PLAYER_REF];
        sim.runtime.world.startCombat?.(imperial, PLAYER_REF);
      }
      const fighting = (): boolean =>
        imperials.every((imperial) => sim.world.stage.combat.targetOf(imperial) === PLAYER_REF);
      expect(await sim.until(fighting, 5)).toBe(true);
      await sim.step(1);
      saved = questState(sim, [ralof, ...imperials]);
      fights = imperials.map((imperial) => sim.world.stage.combat.targetOf(imperial));
      bytes = await sim.save();
      // Saved again mid-line: phase 29's line (Ralof: the key), as it is said.
      for (const imperial of imperials) await sim.kill(imperial, PLAYER_REF);
      const saying = (): boolean =>
        sim.runtime.scenes
          .snapshot()
          .some((playing) => playing.open.some((action) => action.type === 'dialogue'));
      expect(await sim.until(saying, 10)).toBe(true);
      await sim.step(0.5);
      expect(saying()).toBe(true);
      lineSaved = questState(sim, [ralof]);
      midLine = await sim.save('Mid-line');
    } finally {
      await sim.close();
    }
    const after = await loadSim(bytes);
    try {
      expect(questState(after, [ralof, ...imperials])).toEqual(saved);
      expect(after.runtime.aliasesHolding(imperials[0] ?? 0)).toContainEqual({
        quest: MQ101,
        alias: BARRACKS_OFFICER,
      });
      // Their fight goes on.
      await after.step(0.5);
      expect(imperials.map((imperial) => after.world.stage.combat.targetOf(imperial))).toEqual(
        fights,
      );
      for (const imperial of imperials) await after.kill(imperial, PLAYER_REF);
      await after.step(1);
      expect(after.stageDone(MQ101, 280)).toBe(true);
      // The scene goes on: Ralof fetches the key from the officer's body and opens the door.
      const getDoorKey = await after.formId('PACK', 'MQ101RalofGetDoorKey');
      for (let second = 0; second < 60 && !after.stageDone(MQ101, 300); second++) {
        await after.step(1);
        await keepBy(after, ralof);
      }
      expect(after.packages(ralof)).toContainEqual({
        actor: ralof,
        package: getDoorKey,
        type: 'start',
      });
      expect(after.stageDone(MQ101, 285)).toBe(true);
      expect(after.stageDone(MQ101, 300)).toBe(true);
    } finally {
      await after.close();
    }
    // Loaded mid-line: the scene says its line again and goes on to the key and the door.
    const line = await loadSim(midLine);
    try {
      expect(questState(line, [ralof])).toEqual(lineSaved);
      for (let second = 0; second < 60 && !line.stageDone(MQ101, 300); second++) {
        await line.step(1);
        await keepBy(line, ralof);
      }
      expect(line.stageDone(MQ101, 285)).toBe(true);
      expect(line.stageDone(MQ101, 300)).toBe(true);
    } finally {
      await line.close();
    }
  }, 600_000);
});
