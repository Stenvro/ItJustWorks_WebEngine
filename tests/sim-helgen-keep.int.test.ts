// Integration test: MQ101 in Helgen Keep on the headless simulation. Setting a stage runs every
// log entry whose conditions hold (docs/scripting.md): the keep's stages have one entry for both
// routes and one per FactionPath, and the route's entry starts its scene. Skipped without game
// data.

import { afterAll, describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102B: Ralof's route (the friend's part of MQ102). */
const MQ102B = 0x2610a;
/** HelgenKeep01toExteriorExitREF: the cave's way out into Tamriel (an automatic door). */
const CAVE_EXIT = 0x91608;
const TAMRIEL = 0x3c;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route) and MQ101KeepIntroSceneA (Hadvar's). */
const INTRO_RALOF = 0x4e1e2;
/** MQ101's PlayerFriend alias (stage 250's route entry fills it). */
const PLAYER_FRIEND = 73;
/** Gunjar's body (MQ101CorpseSons01), lying in the keep. */
const GUNJAR = 0xb1694;
/** MQ101KeepGate2Ref (the portcullis between Ralof and the Imperials) and its lever. */
const KEEP_GATE_2 = 0xb35af;
const KEEP_LEVER_2 = 0x47cc0;
/** MQ101's BarracksRoomSoldier01 (the officer, who carries the key) and BarracksRoomSoldier02. */
const BARRACKS_OFFICER = 173;
const BARRACKS_SOLDIER = 174;
/** MQ101KeepDoorKey. */
const KEEP_DOOR_KEY = 0xb5178;

/** MQ101KeepScene2B (down the stairs to the torture room), 4B (to the bridge), 5B (the caves). */
const KEEP_SCENE_2B = 0xb622c;
const KEEP_SCENE_4B = 0x5b2cd;
const KEEP_SCENE_5B = 0x5b3f0;
/** MQ101SetStage292 and MQ101SetStage305, where the player walks in (as placed). */
const SCENE_TRIGGERS_300: readonly (readonly [number, Vec3])[] = [
  [292, [-955, 4723, 530]],
  [305, [124, 4128, 206]],
];
/** MQ101SetStage350 (by the torture room) and 400 (past it), as placed. */
const SET_STAGE_350: Vec3 = [1133, 2682, -17];
const SET_STAGE_400: Vec3 = [-1639, 2168, -676];
/** The caves' set-stage triggers, in the route's order (MQ101SetStage550 ... 800). */
const CAVE_TRIGGERS: readonly (readonly [number, Vec3])[] = [
  [550, [-6061, -8009, -1616]],
  [560, [-6697, -9619, -1659]],
  [650, [-5646, -12703, -2239]],
  [700, [-4416, -13552, -2570]],
  [720, [-3816, -16191, -2383]],
  [760, [-4510, -18097, -2684]],
  [800, [-4497, -20198, -3110]],
];

type Vec3 = [number, number, number];

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

describe.skipIf(!hasGamedata())('MQ101 in Helgen Keep', () => {
  it('starts the route’s keep scene as the player enters with Ralof (stage 220, then 250)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // As MQ101SetStage220 does when the player walks in with Ralof (not awaited: the
      // fragments of the stages it sets wait for frames).
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      // The town's scenes are over by the time the player reaches the keep (here they still
      // hold Ralof: the opening was skipped to this point).
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      await sim.step(1);
      expect(sim.stageDone(MQ101, 250)).toBe(true);
      // Entry 2 (FactionPath 2) ran after entry 0 (both routes): Ralof's scene and friend.
      expect(sim.runtime.scenes.isPlaying(INTRO_RALOF)).toBe(true);
      const ralof = sim.runtime.state.quest(MQ101).aliases.get(12);
      expect(sim.runtime.state.quest(MQ101).aliases.get(PLAYER_FRIEND)).toBe(ralof);
    } finally {
      await sim.close();
    }
  }, 300_000);

  // Found 2026-10-24: the sim aimed its activation at a standing actor's chest, above a body
  // lying on the floor. It aims where the crosshair's rule meets an actor: its posed body.
  it('lets the player activate Gunjar’s corpse lying on the floor (stage 257)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      await sim.step(1);
      const gunjar = sim.actor(GUNJAR);
      expect(gunjar).toBeDefined();
      const [x, y, z] = gunjar?.position ?? [0, 0, 0];
      await sim.moveTo([x + 80, y, z + 10]);
      await sim.step(0.5);
      expect(sim.activate(GUNJAR)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ101, 257)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Found 2026-10-28: the scene was never stuck in phase 6 (its line is 17 s long). Stage 275's
  // fragment has the Imperial activate the outer lever (KeepLever1.Activate(soldier)): that
  // default activation sat the player in the lever, walking them through the shut gate into
  // MQ101SetStage270RalofMarker, so stage 270 skipped the gate phases. Then the soldier, held in
  // a dialogue idle, never set out for the inner lever: an actor on its way to furniture was
  // taken for one in it, and its idle never stopped.
  it('opens the inner gate by the Imperial’s lever package (KeepIntroSceneB phases 20-26)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      const ralof = sim.runtime.state.quest(MQ101).aliases.get(12) ?? 0;
      const phase = (): number =>
        sim.runtime.scenes.snapshot().find((playing) => playing.scene === INTRO_RALOF)?.phase ?? -1;
      // The player keeps by Ralof (within the 100 units his "wait for the player" phase asks)
      // and loots Gunjar when he says to (stage 255).
      let looted = false;
      for (let second = 0; second < 150 && !sim.stageDone(MQ101, 270); second++) {
        await sim.step(1);
        const near = await sim.distance(ralof, PLAYER_REF);
        const at = await sim.position(ralof);
        const me = await sim.position(PLAYER_REF);
        if (near !== undefined && near > 95 && at && me) {
          const k = 80 / near;
          await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
        }
        if (!looted && sim.stageDone(MQ101, 255)) {
          const [x, y, z] = sim.actor(GUNJAR)?.position ?? [0, 0, 0];
          await sim.moveTo([x + 80, y, z + 10]);
          await sim.step(0.5);
          looted = sim.activate(GUNJAR);
        }
      }
      expect(looted).toBe(true);
      // The soldier pulled the inner lever, the gate opened (phase 25's condition), and the
      // fight's phase ended (its fragment sets 270), with the player never seated anywhere.
      expect(sim.scriptEvents({ event: 'OnActivate', target: KEEP_LEVER_2 }).length).toBe(1);
      expect(
        await sim.runtime.vm.getVariable(new ObjectHandle(KEEP_GATE_2, 'form'), '::isOpen_var'),
      ).toBe(true);
      expect(phase()).toBeGreaterThanOrEqual(26);
      expect(sim.stageDone(MQ101, 270)).toBe(true);
      expect(sim.world.stage.furniture.interaction(PLAYER_REF)).toBeUndefined();
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Found 2026-10-28: with both Imperials killed (stage 280) the scene reached phase 30 ("Ralof
  // goes to get key": stage 260 or MQ101RalofGetDoorKey done) and stalled. That package is an
  // Acquire (Travel, then Find the MQ101KeepDoorKey within 101 units of the dead officer beside
  // a Wander, then Acquire): Find searched only placed references, and the key is carried, so
  // Ralof wandered by the body for ever. The engine's search looks into inventories too (a
  // corpse's among them), and Acquire takes the key from the body.
  it('has Ralof take the key from the dead officer and open the door (stages 285, 300)', async () => {
    const sim = await openSim({ opening: true });
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
      const ralof = quest.aliases.get(12) ?? 0;
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
      // The player fights the two Imperials (stage 280 once both are dead).
      const officer = quest.aliases.get(BARRACKS_OFFICER) ?? 0;
      await sim.kill(officer, PLAYER_REF);
      await sim.kill(quest.aliases.get(BARRACKS_SOLDIER) ?? 0, PLAYER_REF);
      expect(await sim.runtime.itemCount(officer, KEEP_DOOR_KEY)).toBe(1);
      for (let second = 0; second < 60 && !sim.stageDone(MQ101, 300); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
      }
      // Ralof took the key from the body (not the player: no stage 260) and opened the door.
      expect(sim.stageDone(MQ101, 260)).toBe(false);
      expect(await sim.runtime.itemCount(officer, KEEP_DOOR_KEY)).toBe(0);
      expect(await sim.runtime.itemCount(ralof, KEEP_DOOR_KEY)).toBe(1);
      expect(sim.stageDone(MQ101, 285)).toBe(true);
      expect(sim.stageDone(MQ101, 300)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Ralof's route on from stage 300: one sim, segment by segment (each case goes on from where
  // the one before left it). The player keeps by Ralof, fights where the route has a fight,
  // and walks into the set-stage triggers a scene waits for.
  describe('Ralof’s route past the key', () => {
    let sim: Sim | undefined;
    /** The game as the caves' case left it (by the cave's exit). */
    let byTheExit: Uint8Array | undefined;
    const killed = new Set<number>();
    afterAll(async () => {
      await sim?.close();
    });
    /** Ralof's scene phases now (−1: not playing). */
    const phase = (scene: number): number =>
      sim?.runtime.scenes.snapshot().find((playing) => playing.scene === scene)?.phase ?? -1;
    /** The player kills the route's enemies (MQ101's aliases) once. */
    async function fight(open: Sim, aliases: readonly number[]): Promise<void> {
      for (const alias of aliases) {
        const actor = open.runtime.state.quest(MQ101).aliases.get(alias);
        if (actor === undefined || killed.has(actor)) continue;
        killed.add(actor);
        await open.kill(actor, PLAYER_REF);
      }
    }

    // Found 2026-10-28: MQ101KeepScene2B's first phase escorts the player down the stairs
    // (MQ101FriendEscortPlayerToKeepMarker3) and waits for 310, which the collapsing hall's
    // trigger sets as the player follows (MQ101KeepCollapseTriggerRef). Ralof never set out: a
    // cart wheel (HandCart01Wheel, a navmesh obstacle) lying by the doorway covered the middle
    // of the doorway's triangles, and an obstacle closed every triangle whose middle it
    // covered. It cuts only what lies under it. Then MQ101SetStage500 (defaultSetStageOnEnter,
    // Ralof and the player both inside) never fired: the script has no auto state of its own,
    // so it sat in the empty state, not its parent's "waiting" where the handlers are.
    it('follows Ralof through the storeroom, the torture room and over the bridge (stage 500)', async () => {
      const open = await openSim({ opening: true });
      sim = open;
      await open.step(1);
      for (const playing of open.runtime.scenes.snapshot()) open.runtime.scenes.stop(playing.scene);
      void open.runtime.quests.setStage(MQ101, 220);
      await open.step(0.5);
      await open.openInterior(KEEP);
      for (const playing of open.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) open.runtime.scenes.stop(playing.scene);
      }
      const quest = open.runtime.state.quest(MQ101);
      const ralof = quest.aliases.get(12) ?? 0;
      let looted = false;
      for (let second = 0; second < 150 && !open.stageDone(MQ101, 272); second++) {
        await open.step(1);
        await keepBy(open, ralof);
        if (!looted && open.stageDone(MQ101, 255)) {
          const [x, y, z] = open.actor(GUNJAR)?.position ?? [0, 0, 0];
          await open.moveTo([x + 80, y, z + 10]);
          await open.step(0.5);
          looted = open.activate(GUNJAR);
        }
      }
      await fight(open, [BARRACKS_OFFICER, BARRACKS_SOLDIER]);
      for (let second = 0; second < 60 && !open.stageDone(MQ101, 300); second++) {
        await open.step(1);
        await keepBy(open, ralof);
      }
      // Into MQ101SetStage292 and MQ101SetStage305.
      for (const [stage, at] of SCENE_TRIGGERS_300) {
        for (let second = 0; second < 40 && !open.stageDone(MQ101, stage); second++) {
          await open.step(1);
          await keepBy(open, ralof);
          if (second > 5) await open.moveTo(at);
        }
      }
      expect(open.stageDone(MQ101, 305)).toBe(true);
      for (let second = 0; second < 300 && !open.stageDone(MQ101, 500); second++) {
        await open.step(1);
        await keepBy(open, ralof);
        // The storeroom's Imperials (340), the torturer and his assistant (380), the pool
        // room's Imperials (470).
        if (open.stageDone(MQ101, 320) && !open.stageDone(MQ101, 340)) {
          await fight(open, [134, 135]);
        }
        if (phase(KEEP_SCENE_2B) >= 17 && !open.stageDone(MQ101, 380)) await fight(open, [71, 70]);
        // Phase 23 waits for the player in MQ101SetStage400 (after 350's trigger, its
        // prerequisite), which keeping by Ralof (moves, not walks) may pass over: the player
        // walks into them.
        if (phase(KEEP_SCENE_2B) >= 23 && !open.stageDone(MQ101, 400)) {
          if (!open.stageDone(MQ101, 350)) {
            await open.moveTo(SET_STAGE_350);
            await open.step(1);
          }
          await open.moveTo(SET_STAGE_400);
        }
        if (phase(KEEP_SCENE_4B) >= 4 && open.stage(MQ101) < 470) {
          await fight(open, [105, 106, 107, 108, 109]);
        }
      }
      // Ralof led the player down the stairs (the hall collapsed behind them: 310), on through
      // the torture room (400) and lowered the bridge (490); both crossed it (500).
      for (const stage of [310, 340, 380, 400, 470, 490, 500]) {
        expect(open.stageDone(MQ101, stage)).toBe(true);
      }
    }, 600_000);

    // Found 2026-10-28: past the bridge Ralof stopped for good on his way to
    // MQ101KeepFriendMarker7a: the only way runs over tilted collision boxes under the
    // rubble's navmesh (CollisionMarkers, navmesh obstacles), whose upright bounds reached
    // above the navmesh lying on them. A box cuts the navmesh between its own faces straight
    // above and below each point.
    it('goes on with Ralof through the caves past the spiders to the exit (stage 800)', async () => {
      const open = sim;
      expect(open?.stageDone(MQ101, 500)).toBe(true);
      if (!open) return;
      const ralof = open.runtime.state.quest(MQ101).aliases.get(12) ?? 0;
      let last = '';
      let stalled = 0;
      for (let second = 0; second < 300 && !open.stageDone(MQ101, 800); second++) {
        await open.step(1);
        await keepBy(open, ralof);
        // The spiders (630).
        if (phase(KEEP_SCENE_5B) >= 12 && !open.stageDone(MQ101, 630)) {
          await fight(open, [127, 128, 129, 130, 131]);
        }
        // A scene waiting for the player to walk on: into the next set-stage trigger.
        const now = `${String(open.stage(MQ101))} ${String(phase(KEEP_SCENE_5B))}`;
        stalled = now === last ? stalled + 1 : 0;
        last = now;
        const next = CAVE_TRIGGERS.find(([stage]) => !open.stageDone(MQ101, stage));
        if (stalled >= 6 && next) {
          await open.moveTo(next[1]);
          stalled = 0;
        }
      }
      // Ralof waited at the marker past the rubble (550 as the player came by), and the scene
      // went on through the spiders' cave (630).
      for (const stage of [550, 560, 630, 650, 800])
        expect(open.stageDone(MQ101, stage)).toBe(true);
      byTheExit = await open.save();
    }, 600_000);

    // Past 800 MQ102 (5) and MQ102B (5) run, and Ralof makes for the cave's exit
    // (MQ102FriendTravelToExit). The cave's end is an automatic door, which takes the player
    // out as they come near; outside, the exit's trigger sets MQ102 15 (MQ102B 10), Ralof's
    // talk outside the cave plays, and its end sets MQ102 10, which sets MQ101 900 (some 45 s
    // after the player came out). The bear (MQ101BearRef) was passed by the triggers, not
    // fought or sneaked by.
    it('walks up to the cave’s end and out into Tamriel with Ralof (MQ102 15, MQ102B 10, MQ101 900)', async () => {
      expect(byTheExit).toBeDefined();
      if (!byTheExit) return;
      const open = await loadSim(byTheExit);
      try {
        const ralof = open.runtime.state.quest(MQ101).aliases.get(12) ?? 0;
        await open.step(1);
        const door = await open.position(CAVE_EXIT);
        expect(door).toBeDefined();
        if (!door) return;
        // Along the cave towards its end: the automatic door takes the player out on the way.
        await open.walkPath(door, 30, 120);
        expect(await open.until(() => open.world.loadedCells.length > 1, 5)).toBe(true);
        expect((await open.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
        // Outside, the exit's trigger sets MQ102 15 (its route entry MQ102B 10); Ralof's talk
        // there ends with MQ102 10, which sets MQ101 900.
        for (let second = 0; second < 120 && !open.stageDone(MQ101, 900); second++) {
          await open.step(1);
          if ((await open.runtime.placement(ralof))?.world === TAMRIEL) await keepBy(open, ralof);
        }
        expect(open.stageDone(MQ102, 15)).toBe(true);
        expect(open.stageDone(MQ102B, 10)).toBe(true);
        expect(open.stageDone(MQ101, 900)).toBe(true);
        expect((await open.runtime.placement(ralof))?.world).toBe(TAMRIEL);
      } finally {
        await open.close();
      }
    }, 600_000);
  });
});
