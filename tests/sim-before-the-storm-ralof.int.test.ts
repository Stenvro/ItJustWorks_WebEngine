// Integration test: MQ102 "Before the Storm" on Ralof's route (MQ102B), in the headless
// simulation. MQ101 ends as the game ends it (stage 220: the player went into the keep with
// Ralof; 800: out of the cave, which sets MQ102B 5 and starts MQ102); the player then keeps by
// Ralof to Riverwood, where he meets his sister Gerdur at the mill (MQ102RalofGerdurScene), and
// Gerdur sends the player to Whiterun, where the route joins Hadvar's (MQ102's common stages:
// tests/sim-before-the-storm.int.test.ts). Each case goes on from the save the one before took.
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102B: Ralof's route (the friend's part of MQ102). */
const MQ102B = 0x2610a;
/** RalofRef. */
const RALOF = 0x2bf9e;
/** ChargenExitMarker, outside Helgen's cave (MQ102's property). */
const CHARGEN_EXIT = 0xd19aa;
/** MQ102B's Gerdur alias, and MQ102RalofGerdurScene (stage 35 starts it). */
const GERDUR_ALIAS = 2;
const GERDUR_SCENE = 0x27e56;
/** WhiterunWorld and Dragonsreach (WhiterunDragonsreach). */
const WHITERUN = 0x1a26f;
const DRAGONSREACH = 0x165a3;
/** Irileth (her force greet in MQ102DragonsreachScene). */
const IRILETH = 0x1a67f;

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

/** The player fights back: whoever is in combat with them dies by their hand. */
async function defend(sim: Sim): Promise<void> {
  const fighting = new Map<number, boolean>();
  for (const event of sim.events('combat')) {
    if (event.target === PLAYER_REF) fighting.set(event.actor, event.state !== 0);
    else fighting.delete(event.actor);
  }
  for (const [actor, now] of fighting) {
    if (now && !(await sim.runtime.actors.isDead(actor))) await sim.kill(actor, PLAYER_REF);
  }
}

describe.skipIf(!hasGamedata())('MQ102 Before the Storm (Ralof’s route)', () => {
  /** The game as the first segment left it, in Riverwood (MQ102B 35). */
  let inRiverwood: Uint8Array | undefined;
  /** The game as the second left it: sent to the Jarl (MQ102 30). */
  let toWhiterun: Uint8Array | undefined;

  it('leaves Helgen with Ralof and walks with him to Riverwood (MQ102 15, 10; MQ102B 35)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // Into the keep with Ralof (FactionPath 2), then out of the cave (stage 800's route
      // entry sets MQ102B 5, which starts MQ102). Not awaited: the fragments wait for frames.
      void sim.runtime.quests.setStage(MQ101, 220);
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
      for (let second = 0; second < 400 && !sim.stageDone(MQ102B, 35); second++) {
        await sim.step(1);
        await keepBy(sim, RALOF, 400);
        await defend(sim);
      }
      expect(sim.stageDone(MQ102, 15)).toBe(true);
      expect(sim.stageDone(MQ102, 10)).toBe(true);
      expect(sim.stageDone(MQ101, 1000)).toBe(true);
      expect(sim.stageDone(MQ102B, 35)).toBe(true);
      await sim.step(1);
      inRiverwood = await sim.save();
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Found 2026-10-29: the scene ran to its end (MQ102B 52) without Gerdur's word to the player
  // (50). In phase 45 her force greet (MQ102GerdurForceGreet: Travel to within 300 of the
  // player, then ForceGreet within 300) travelled to 299.9 across, 300.04 in three dimensions
  // on the slope: the greeting's GetWithinPackageLocation, measured in three dimensions,
  // failed, so the ForceGreet was skipped and the package done. Observed in the original: it
  // measures across within a height window (src/ai/package-start.ts, withinPlace).
  it('plays Ralof and Gerdur’s scene at the mill; Gerdur sends the player to Whiterun (MQ102B 40, 47, 50; MQ102 30)', async () => {
    expect(inRiverwood).toBeDefined();
    if (!inRiverwood) return;
    const sim = await loadSim(inRiverwood);
    try {
      const gerdur = sim.runtime.state.quest(MQ102B).aliases.get(GERDUR_ALIAS) ?? 0;
      // The player keeps by Ralof to the mill and the clearing; the scene's phase 43 makes
      // Gerdur the player's friend (47), and in phase 45 she comes to the player.
      for (let second = 0; second < 600 && !sim.stageDone(MQ102B, 47); second++) {
        await sim.step(1);
        await keepBy(sim, RALOF, 400);
        await defend(sim);
      }
      expect(sim.stageDone(MQ102B, 40)).toBe(true);
      expect(sim.stageDone(MQ102B, 47)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(GERDUR_SCENE)).toBe(true);
      // Gerdur's force greet (MQ102GerdurForceGreet, topic MQ102GerdurHelpForcegreetTopic) is
      // chosen while her ForceGreet package is current, so its info 9A039 holds:
      // GetIsCurrentPackage(MQ102GerdurForceGreet) == 1, GetIsAliasRef(Gerdur), MQ102B 50 not
      // done (9A036 needs 42 done too). 9A039 ("Here's a key to the house...") is an Invisible
      // Continue: TIF__0009A039 opens her gift menu (her supplies) and sets MQ102B 42, whose
      // fragment gives the player GerdursKey. It goes on through df023 ("There's something you
      // could do for me...", Invisible Continue) to df01d ("The Jarl needs to know...",
      // Goodbye): TIF__000DF01D sets MQ102B 50, whose fragment sets MQ102 30. The player picks
      // no topic: the conversation ends by itself.
      expect(await sim.listen(gerdur, 60)).toEqual([]);
      expect(
        sim.menus().some((menu) => menu.menu === 'Gift Menu' && menu.reference === gerdur),
      ).toBe(true);
      expect(sim.notices()).toContain("Key to Gerdur's House added");
      await sim.step(1);
      expect(sim.stageDone(MQ102B, 50)).toBe(true);
      expect(sim.stageDone(MQ102, 30)).toBe(true);
      expect(sim.runtime.state.quest(MQ102).objectives.get(30)?.displayed).toBe(true);
      await sim.step(1);
      toWhiterun = await sim.save();
    } finally {
      await sim.close();
    }
  }, 900_000);

  // In Whiterun the route joins Hadvar's (its later cases are
  // tests/sim-before-the-storm.int.test.ts's): Dragonsreach, Irileth, the Jarl.
  it('goes into Dragonsreach, where Irileth stops the player before the Jarl (MQ102 75, 80, 90, 100)', async () => {
    expect(toWhiterun).toBeDefined();
    if (!toWhiterun) return;
    const sim = await loadSim(toWhiterun);
    try {
      await sim.world.openExterior(WHITERUN, {
        arrival: { position: [19567, -7233, -3540], heading: Math.PI / 4 },
      });
      await sim.step(1);
      await sim.openInterior(DRAGONSREACH);
      await sim.step(1);
      expect(sim.stageDone(MQ102, 75)).toBe(true);
      // Up the hall to the throne, through MQ102SetStage80.
      await sim.moveTo([-374, 1450, 100]);
      await sim.walkTo([-383, 2600, 10], 8, 150);
      expect(sim.stageDone(MQ102, 80)).toBe(true);
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
});
