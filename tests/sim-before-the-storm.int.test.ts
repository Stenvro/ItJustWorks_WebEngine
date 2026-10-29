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
/** MQ103: Bleak Falls Barrow. */
const MQ103 = 0xd0800;
/** BalgruufTheGreaterREF and FarengarSecretFireREF. */
const BALGRUUF = 0x1a677;
const FARENGAR = 0x1a67e;
/** MQ104 (Dragon Rising) and MS13 (The Golden Claw). */
const MQ104 = 0x2610c;
const MS13 = 0x39645;
/** Bleak Falls Temple and Bleak Falls Sanctum (BleakFallsBarrow01, 02). */
const TEMPLE = 0x371de;
const SANCTUM = 0x371dd;
/** The temple's campfire bandits and the one the dart trap is for (MS13DartVictimREF). */
const TEMPLE_BANDITS = [0x39fe4, 0x39fe2, 0x39fe1];
/** The temple's three puzzle pillars and how many turns each needs (initial to solve state). */
const PILLAR_TURNS: readonly (readonly [number, number])[] = [
  [0xaa8cb, 2],
  [0xaa8cc, 2],
  [0xaa8cd, 1],
];
const TEMPLE_LEVER = 0x6a9e2;
const PORTCULLIS = 0x3b9f1;
/** MS13FrostbiteSpiderREF, Arvel's web (MS13FXspiderWebKitDestructible), MS13ArvelREF. */
const WEB_SPIDER = 0x3a1e1;
const ARVELS_WEB = 0x1fc43;
const ARVEL = 0x39655;
/** MS13GoldenClaw and MQ103Dragonstone. */
const GOLDEN_CLAW = 0x39647;
const DRAGONSTONE = 0xdf202;
/** The claw door's rings (large, medium, small: two turns each) and its keyhole. */
const CLAW_RINGS = [0x4e2ba, 0x4e2bb, 0x4e2bc];
const CLAW_KEYHOLE = 0x4e2b9;
/** The sanctum's boss (its LvlDraugrAmbushBossMale in the coffin by the word wall). */
const SANCTUM_BOSS = 0x9bcd6;
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
  /** The game as the third left it: Irileth heard of Helgen (MQ102 100). */
  let beforeTheJarl: Uint8Array | undefined;
  /** The game as the fourth left it: the Jarl sent the player to Farengar (MQ102 200). */
  let toFarengar: Uint8Array | undefined;
  /** The game as the fifth left it: sent for the Dragonstone (MQ103 55). */
  let toBleakFalls: Uint8Array | undefined;
  /** The game as the sixth left it: the Golden Claw taken from Arvel. */
  let inTheSanctum: Uint8Array | undefined;

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
  // Frodnar meet. A scene now takes an actor from a begun scene with no action running on it
  // (for a quest of higher priority: see below).
  // Found 2026-10-28 (failing on a busy machine): with the player coming from Helgen, Alvor's
  // forge (cell 4,-12) was the loaded grid's edge, and his smithy's floor is placed in the cell
  // beyond (5,-11): set down, he fell through to the slope 142 units below, off the navmesh, and
  // his walk to Hadvar failed. Near a cell not held, an actor is now set down only by the
  // position check, and a cell being read keeps it waiting (src/shell/actor-stage.ts, #settle).
  // Found 2026-10-28: on time, as the player came into the house, WIGreetingScene took one of
  // Alvor's household (no action for them in the phases that take Hadvar and Alvor in) and ended
  // MQ102HadvarAlvorScene (MQ102A 52): an idle actor now goes only to a scene of a quest of
  // higher priority (WIGreeting 40, MQ102A 80).
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
      await sim.step(1);
      beforeTheJarl = await sim.save();
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
  // Not driven yet: Ralof’s route (MQ102B).
  it.todo('has the gate guard stop the player outside Whiterun (MQ102 82, 100)');

  it('tells the Jarl of Helgen, who sends the player to Farengar (MQ102 110, 150, 160, 200; MQ103 10)', async () => {
    expect(beforeTheJarl).toBeDefined();
    if (!beforeTheJarl) return;
    const sim = await loadSim(beforeTheJarl);
    try {
      // The player goes up to the throne and talks to Balgruuf (MQ102DragonsreachScene's phase
      // 8 waits for it, or for his force greet).
      const at = await sim.position(BALGRUUF);
      expect(at).toBeDefined();
      if (!at) return;
      expect(await sim.walkTo(at, 20, 140)).toBe(true);
      expect(await sim.talk(BALGRUUF)).toEqual(['I need to talk to you about Helgen.']);
      await sim.choose('talk to you about Helgen');
      await sim.choose('The dragon destroyed Helgen');
      sim.goodbye();
      expect(sim.stageDone(MQ102, 110)).toBe(true);
      // MQ102DragonsreachScene2: Balgruuf, Irileth and Proventus argue; its phase 7 sets 150.
      expect(await sim.until(() => sim.stageDone(MQ102, 150), 120)).toBe(true);
      // Balgruuf comes to the player with his reward (MQ102BalgruufForcegreetPlayer); it sets
      // 160, which ends MQ102 (200) and starts MQ103 (10).
      expect(await sim.listen(BALGRUUF, 30)).toBeDefined();
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ102, 160)).toBe(true);
      expect(sim.stageDone(MQ102, 200)).toBe(true);
      expect(sim.stageDone(MQ103, 10)).toBe(true);
      await sim.step(1);
      toFarengar = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28: Farengar's force greet (MQ103FarengarForcegreetPlayer, the ForceGreet
  // template) sandboxed at his wait location for ever: its Stacked root had taken its Sandbox
  // child before the player came into its trigger, and a running tree was taken again only
  // when a branch it ran no longer held. A Stacked branch's earlier child that now may run
  // takes over (src/ai/package-runtime.ts, #branchesHold).
  it('follows Balgruuf to Farengar, who asks for the Dragonstone (MQ103 15, 20, 50, 55)', async () => {
    expect(toFarengar).toBeDefined();
    if (!toFarengar) return;
    const sim = await loadSim(toFarengar);
    try {
      // MQ103IntroScene: Balgruuf walks to Farengar's room; the player keeps by him into its
      // trigger (15, 20), then goes up to Farengar, who greets them once Balgruuf has spoken.
      let topics: string[] | undefined;
      for (let second = 0; second < 150 && !topics; second++) {
        await sim.step(1);
        if (sim.stageDone(MQ103, 20)) await keepBy(sim, FARENGAR, 250);
        else await keepBy(sim, BALGRUUF, 200);
        topics = await sim.listen(FARENGAR, 0.01);
      }
      expect(sim.stageDone(MQ103, 20)).toBe(true);
      expect(topics).toContain('The Jarl said you had a project you needed help with.');
      await sim.choose('project you needed help with');
      await sim.choose('Where am I going and what am I fetching?');
      expect(sim.stageDone(MQ103, 50)).toBe(true);
      await sim.choose('Anything you can tell me about Bleak Falls Barrow?');
      sim.goodbye();
      expect(sim.stageDone(MQ103, 55)).toBe(true);
      expect(sim.runtime.state.quest(MQ103).objectives.get(50)?.displayed).toBe(true);
      await sim.step(25);
      toBleakFalls = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The walks between rooms are moves; the fights are kills by the player; looting is the
  // container menu's move to the player. Open (2026-10-29): freed from his web, Arvel stood
  // in it some 20 s before his MS13ArvelRunsScene travel took him away; the word wall's
  // trigger teaches no word and the boss sleeps on: WordWallTrigger02Script finds its
  // WordWallTriggerScript in OnLoad, which triggers (no model, a primitive) are not sent;
  // counting primitives as loaded 3D stalled MQ102A before stage 45 in Riverwood (to examine).
  it('solves the temple’s pillar puzzle, frees Arvel and takes the Golden Claw (MS13 35)', async () => {
    expect(toBleakFalls).toBeDefined();
    if (!toBleakFalls) return;
    const sim = await loadSim(toBleakFalls);
    try {
      const runtime = sim.runtime;
      await sim.openInterior(TEMPLE);
      await sim.step(2);
      for (const bandit of TEMPLE_BANDITS) await sim.kill(bandit, PLAYER_REF);
      // The pillars turn one face an activation (defaultPuzzlePillarScript) to their solve
      // states; the lever then raises the portcullis.
      await sim.moveTo([5350, -640, -760]);
      await sim.step(2);
      for (const [pillar, turns] of PILLAR_TURNS) {
        for (let turn = 0; turn < turns; turn++) {
          expect(sim.activate(pillar)).toBe(true);
          await sim.step(4);
        }
      }
      await sim.moveTo([5238, -1450, -760]);
      await sim.step(1);
      expect(sim.activate(TEMPLE_LEVER)).toBe(true);
      await sim.step(3);
      expect(sim.scriptEvents({ event: 'OnActivate', target: PORTCULLIS })).toHaveLength(1);
      // Arvel's web: its spider, then the web cut (the player's blows: DamageObject) frees him.
      await sim.moveTo([3000, -3300, -1780]);
      await sim.step(3);
      await sim.kill(WEB_SPIDER, PLAYER_REF);
      await sim.moveTo([3700, -3313, -1780]);
      await sim.step(2);
      for (let blow = 0; blow < 6 && !sim.stageDone(MS13, 35); blow++) {
        await runtime.damageObject(ARVELS_WEB, 50);
        await sim.step(1);
      }
      expect(sim.stageDone(MS13, 35)).toBe(true);
      await sim.step(30);
      await sim.kill(ARVEL, PLAYER_REF);
      await sim.step(2);
      await runtime.removeItem(ARVEL, runtime.formHandle(GOLDEN_CLAW), 1, false, PLAYER_REF);
      await sim.step(1);
      expect((await runtime.inventory(PLAYER_REF)).get(GOLDEN_CLAW)).toBe(1);
      inTheSanctum = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  it('opens the claw door, takes the Dragonstone and brings it to Farengar (MS13 50; MQ103 180, 190; MQ104 10)', async () => {
    expect(inTheSanctum).toBeDefined();
    if (!inTheSanctum) return;
    const sim = await loadSim(inTheSanctum);
    try {
      const runtime = sim.runtime;
      await sim.openInterior(SANCTUM);
      await sim.step(2);
      // The rings turn to the claw's symbols (HallofStoriesDiskScript), then the claw opens it.
      await sim.moveTo([400, -320, -250]);
      await sim.step(2);
      for (const ring of CLAW_RINGS) {
        for (let turn = 0; turn < 2; turn++) {
          expect(sim.activate(ring)).toBe(true);
          await sim.step(4);
        }
      }
      expect(sim.activate(CLAW_KEYHOLE)).toBe(true);
      await sim.step(10);
      expect(sim.stageDone(MS13, 50)).toBe(true);
      // The Dragonstone is the boss's (MQ103's dragonStone alias, made in BleakFallsBoss).
      await sim.moveTo([-7550, -150, 610]);
      await sim.step(5);
      await sim.kill(SANCTUM_BOSS, PLAYER_REF);
      await sim.step(2);
      await runtime.removeItem(SANCTUM_BOSS, runtime.formHandle(DRAGONSTONE), 1, false, PLAYER_REF);
      await sim.step(2);
      expect(sim.stageDone(MQ103, 180)).toBe(true);
      // Back to Farengar in Dragonsreach.
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const at = await sim.position(FARENGAR);
      expect(at).toBeDefined();
      if (!at) return;
      await sim.moveTo([at[0] + 120, at[1], at[2] + 20]);
      await sim.step(2);
      expect(await sim.talk(FARENGAR)).toContain('I have the stone tablet you wanted.');
      await sim.choose('stone tablet you wanted');
      await sim.choose('I got you the Dragonstone. What next?');
      sim.goodbye();
      await sim.step(3);
      expect(sim.stageDone(MQ103, 190)).toBe(true);
      expect(sim.stageDone(MQ104, 10)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
