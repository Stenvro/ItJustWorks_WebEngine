// Integration test: MQ102 "Before the Storm" on Hadvar's route, in the headless simulation. MQ101
// ends as the game ends it (stage 210: the player went into the keep with Hadvar; 800: out of
// the cave, which sets MQ102A 5 and starts MQ102); the player then keeps by Hadvar to Riverwood,
// follows him into Alvor's house, and talks to Alvor. The second segment starts from the save
// the first took. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102A: Hadvar's route (the friend's part of MQ102). */
const MQ102A = 0x2bf9c;
/** HadvarRef and AlvorREF. */
const HADVAR = 0x2bfa2;
const ALVOR = 0x13482;
/** ChargenExitMarker, outside Helgen's cave (MQ102's property). */
const CHARGEN_EXIT = 0xd19aa;
/** MQ102HadvarAlvorScene (stage 35 starts it). */
const ALVOR_SCENE = 0x2bfac;
/** Where the player waits inside Alvor's door (his house). */
const BY_ALVORS_DOOR: [number, number, number] = [-537, -231, 241];
/** WhiterunWorld and Dragonsreach (WhiterunDragonsreach). */
const WHITERUN = 0x1a26f;
const DRAGONSREACH = 0x165a3;
/** Irileth (her force greet in MQ102DragonsreachScene). */
const IRILETH = 0x1a67f;
/** Alvor's MQ102A topic that sets stage 50. */
const SUPPLIES = 'Do you have any supplies I could take?';

/** The player keeps by an actor (within `reach`), as one following them does. */
async function keepBy(sim: Sim, actor: number, reach: number): Promise<void> {
  const near = await sim.distance(actor, PLAYER_REF);
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > reach && at && me) {
    const k = (reach * 0.6) / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 30]);
  }
}

describe.skipIf(!hasGamedata())('MQ102 Before the Storm (Hadvar’s route)', () => {
  /** The game as the first segment left it, in Riverwood (MQ102A 35). */
  let inRiverwood: Uint8Array | undefined;
  /** The game as the second left it: sent to the Jarl (MQ102 30). */
  let toWhiterun: Uint8Array | undefined;

  it('leaves Helgen with Hadvar and walks with him to Riverwood (MQ102 15, 10; MQ102A 35)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // Into the keep with Hadvar (FactionPath 1), then out of the cave (stage 800's route
      // entry sets MQ102A 5, which starts MQ102). Not awaited: the fragments wait for frames.
      void sim.runtime.quests.setStage(MQ101, 210);
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 800);
      expect(await sim.until(() => sim.stageDone(MQ102, 5), 30)).toBe(true);
      const exit = await sim.runtime.placement(CHARGEN_EXIT);
      expect(exit?.world).toBeDefined();
      if (exit?.world === undefined) return;
      await sim.world.openExterior(exit.world, {
        arrival: { position: exit.position, heading: exit.rotation[2] },
      });
      // Out of the cave the exit's trigger sets MQ102 15 (MQ102A 10: MQ102AHadvarToRiverwood);
      // its phases lead by Bleak Falls and the Guardian Stones, waiting for the player.
      for (let second = 0; second < 400 && !sim.stageDone(MQ102A, 35); second++) {
        await sim.step(1);
        await keepBy(sim, HADVAR, 400);
      }
      expect(sim.stageDone(MQ102, 15)).toBe(true);
      expect(sim.stageDone(MQ102, 10)).toBe(true);
      expect(sim.stageDone(MQ101, 1000)).toBe(true);
      expect(sim.stageDone(MQ102A, 35)).toBe(true);
      await sim.step(1);
      inRiverwood = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28: stage 35 started MQ102HadvarAlvorScene, which waited for ever for Dorthe:
  // the Riverwood kids' play scene holds her in its first phase (no action) until she and
  // Frodnar meet. A scene now takes an actor whose other scene has nothing running on it.
  // Found 2026-10-28: in phase 26 Alvor's force greet gave up its travel to the player by the
  // door once a second: the player stood a few units off the navmesh, and a path to a point off
  // it ended short, never complete. Such a path now ends at the navmesh's nearest point within
  // the arrival radius (src/shell/actor-movers.ts, navGoal).
  // Found 2026-10-28: a bandit (0xb6ce1) that followed Hadvar from the cave caught him by Riverwood's river bank,
  // where he swam (the bank lies under the cell's water, its navmesh unflagged): his graph took
  // no draw, his combat tree (and its Exit Water) waited for one, and the scene stayed paused for
  // the fight. A swimming fighter now makes for the shore first, to ground where it no longer
  // swims (src/shell/actor-combat-ai.ts, exitWater).
  it('plays Hadvar and Alvor’s scene into the house; Alvor comes to the player by the door and sends them to Whiterun (MQ102 30)', async () => {
    expect(inRiverwood).toBeDefined();
    if (!inRiverwood) return;
    const sim = await loadSim(inRiverwood);
    try {
      let inside = false;
      for (let second = 0; second < 400 && !sim.stageDone(MQ102A, 47); second++) {
        await sim.step(1);
        // The player follows Hadvar to Alvor and through his door (and waits inside by it).
        const hadvar = await sim.runtime.placement(HADVAR);
        if (!inside && hadvar && hadvar.world === undefined && hadvar.cell !== undefined) {
          await sim.openInterior(hadvar.cell);
          await sim.moveTo(BY_ALVORS_DOOR);
          inside = true;
        } else if (!inside) await keepBy(sim, HADVAR, 300);
      }
      expect(sim.stageDone(MQ102A, 45)).toBe(true);
      expect(sim.stageDone(MQ102A, 47)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(ALVOR_SCENE)).toBe(true);
      // The player waits by the door; in phase 26 Alvor comes to them (MQ102AlvorForceGreet) and
      // talks: his quest topic sets MQ102A 50, and that MQ102 30 (the Jarl's objective).
      expect(await sim.listen(ALVOR, 120)).toContain(SUPPLIES);
      await sim.choose(SUPPLIES);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ102A, 50)).toBe(true);
      expect(sim.stageDone(MQ102, 30)).toBe(true);
      expect(sim.runtime.state.quest(MQ102).objectives.get(30)?.displayed).toBe(true);
      await sim.step(1);
      toWhiterun = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28: Irileth's force greet (MQ102IrilethForcegreetPlayer) ended its travel with
  // the player 320 units off, past the 300 its ForceGreet branch asks (the path had ended at the
  // navmesh point nearest the player, and she arrived within 300 of that), so the branch was
  // skipped and the package done. And her blocking branch (MQ102IrilethForcegreet, "I need to
  // speak to the Jarl...") was never offered: conversations started only from top-level
  // branches, and the Creation Kit's Blocking type is not flagged top-level (996 branches).
  it('goes into Dragonsreach, where Irileth stops the player before the Jarl (MQ102 75, 80, 90, 100)', async () => {
    expect(toWhiterun).toBeDefined();
    if (!toWhiterun) return;
    const sim = await loadSim(toWhiterun);
    try {
      // Into the city by its gate (as one who opened it: see the todo below for the gate
      // guard), then into Dragonsreach, whose cell sets MQ102 75 (MQ102DragonsreachScene).
      await sim.world.openExterior(WHITERUN, {
        arrival: { position: [19567, -7233, -3540], heading: Math.PI / 4 },
      });
      await sim.step(1);
      await sim.openInterior(DRAGONSREACH);
      await sim.step(1);
      expect(sim.stageDone(MQ102, 75)).toBe(true);
      // Up the hall to the throne, through MQ102SetStage80 (the scene's phase 0 waits for it).
      await sim.moveTo([-374, 1450, 100]);
      await sim.walkTo([-383, 2600, 10], 8, 150);
      expect(sim.stageDone(MQ102, 80)).toBe(true);
      // Irileth comes and stops them; the player tells her of Helgen (MQ102 90, 100).
      expect(await sim.listen(IRILETH, 30)).toEqual(['I need to speak to the Jarl...']);
      expect(await sim.choose('speak to the Jarl')).toContain(
        'I have news from Helgen. About the dragon attack.',
      );
      await sim.choose('news from Helgen');
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ102, 90)).toBe(true);
      expect(sim.stageDone(MQ102, 100)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Still open (2026-10-28): Whiterun's gate guard (GuardWhiterunImperialGate1REF, 0xdc9e4) is a
  // temporary actor of a WhiterunWorld cell (26748, 1606, the Cloud District), where
  // WhiterunGateGuardTravel sits him. His WhiterunGateGuardForcegreet (while
  // DialogueWhiterunGuardGateStop 10 is not done) waits at WhiterunGateGuard (0xd1986) in Tamriel,
  // outside the gate, and greets the player in its 2,000-unit trigger. With the player outside
  // the gate he never comes: his cell is not loaded and he is not persistent, so the actors away
  // (src/shell/actors-away.ts) never ask where his package has him (the package start would now
  // know: src/ai/package-start.ts). UESP has him outside the gate. Next: how the engine brings a
  // temporary actor whose package lies in another worldspace there (original); then the case: "Halt!",
  // "Riverwood calls for the Jarl's aid" (82, which sets MQ102 100), the gate unlocked.
  // Further on, not driven yet: Balgruuf (MQ102 110, 150: MQ103 8; MQ102DragonsreachScene was in
  // its phase 2 after Irileth), Farengar (MQ102 160, MQ103 10), then MQ103 in Bleak Falls Barrow
  // (the bandits, Arvel in the web, the pillar puzzles, the claw door, the Dragonstone), and
  // Ralof's route (MQ102B).
  it.todo('has the gate guard stop the player outside Whiterun (MQ102 82, 100)');
});
