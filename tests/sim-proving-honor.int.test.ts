// Integration test: C01 "Proving Honor" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left): the radiant job
// that earns it (CR05 "Trouble in Skyrim", Farkas's), then the trial at Dustman's Cairn. Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const C00 = 0x4b2d9;
const C01 = 0x6e803;
/** C01's Observer alias: the Shield-Sibling who watches the trial. */
const C01_OBSERVER = 1;
/** C01's DungeonMarker alias (Dustman's Cairn's map marker), and its Observer's way there. */
const C01_DUNGEON_MARKER = 4;
const OBSERVER_WAITS_OUTSIDE = 0xf64fd;
/** CR05 "Trouble in Skyrim" and its aliases: Location, Boss, MapMarker. */
const CR05 = 0x2522f;
const CR05_LOCATION = 4;
const CR05_BOSS = 9;
const CR05_MARKER = 16;
const JORRVASKR = 0x165b5;
const FARKAS = 0x1a693;
/** Dawnguard's Moldering Ruins: its location, the way down from Tamriel and its one cell. */
const MOLDERING_RUINS = 0x2003cfd;
const RUINS_WAY_DOWN = 0x2002801;
const RUINS = 0x200285d;
const SKJOR = 0x1a691;
const GOLD = 0xf;
/** WhiterunMapMarkerREF (in the city: WhiterunWorld), and Jorrvaskr's front door (JorrvaskrDoor1REF). */
const WHITERUN_MARKER = 0x162ce;
const WHITERUN = 0x1a26f;
const JORRVASKR_FRONT = 0x41248;
/** The hall's side of that door. */
const JORRVASKR_OUT = 0x165d9;

/** The game with Farkas's job taken (CR05 10). */
let jobTaken: Uint8Array | undefined;
/** The game with the ruins' leader dead (CR05 20). */
let jobDone: Uint8Array | undefined;
/** The game with Farkas's gold paid and Skjor asking for the player (C01 10). */
let paid: Uint8Array | undefined;
/** The game with the trial given, Farkas the Shield-Brother (C01 20). */
let sentOff: Uint8Array | undefined;

/** An objective of C01 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(C01).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows, where
 * the fight is not what the segment tests).
 */
async function fendOff(sim: Sim): Promise<number> {
  let fallen = 0;
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) {
      await sim.kill(actor, PLAYER_REF);
      fallen += 1;
    }
  }
  return fallen;
}

/** Hurt, with none fighting them, the player waits an hour (the wait menu): their health comes back. */
async function catchBreath(sim: Sim): Promise<void> {
  const health = await sim.runtime.actors.value(PLAYER_REF, ActorValue.health);
  if (health.current >= 60) return;
  const fighting = sim.actors().some((staged) => {
    return !staged.dead && sim.world.stage.combat.targetOf(staged.reference) === PLAYER_REF;
  });
  if (!fighting) await sim.rest(1, false);
}

/** The player makes their way to a point, what comes at them falling as they go (fendOff). */
async function walkFighting(
  sim: Sim,
  target: Vec3,
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(target, Math.min(5, until - sim.time), reach);
    await fendOff(sim);
    await catchBreath(sim);
    if (there) return true;
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

describe.skipIf(!hasGamedata())('C01 Proving Honor', () => {
  // A Companion (C00's stages, as its own play leaves them: sim-take-up-arms), back in the hall
  // after an hour, where Farkas sits to eat (CompanionsShift2Eat13x3). "I'm looking for work": his
  // radiant job (CompanionsHousekeepingScript's CycleRadiantQuests gave him CR04 and CR05), a band
  // in Whiterun Hold. "I'll take care of it": CR05 10, "Kill the leader of Moldering Ruins".
  it('has Farkas give the player a job (CR05 10)', async () => {
    const sim = await openSim({ interior: JORRVASKR, hour: 14 });
    try {
      expect(await sim.until(() => sim.stageDone(C00, 1), 90)).toBe(true);
      for (const stage of [10, 20, 30, 40, 50, 100]) {
        void sim.runtime.quests.setStage(C00, stage);
        expect(await sim.until(() => sim.stageDone(C00, stage), 10)).toBe(true);
        await sim.step(0.5);
      }
      expect(sim.isRunning(CR05)).toBe(true);
      await sim.step(3);
      await sim.rest(1, false);
      expect((await sim.runtime.placement(FARKAS))?.cell).toBe(JORRVASKR);
      const at = await sim.position(FARKAS);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(FARKAS)).toContain("I'm looking for work.");
      await sim.choose(/looking for work/);
      await sim.choose(/What kind of trouble/);
      expect(await sim.choose(/take care of it/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(CR05, 10), 10)).toBe(true);
      expect(alias(sim, CR05, CR05_LOCATION)).toBe(MOLDERING_RUINS);
      expect(sim.runtime.state.quest(CR05).objectives.get(10)?.displayed).toBe(true);
      jobTaken = await sim.save('CR05 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To the ruins (the way there is not under test), down their ladder, and through them to their
  // leader (CR05's Boss): dead, CR05 20, "Return to Farkas".
  it('has the player kill the leader of Moldering Ruins (CR05 20)', async () => {
    if (!jobTaken) return;
    const sim = await loadSim(jobTaken);
    try {
      await sim.fastTravel(alias(sim, CR05, CR05_MARKER));
      await sim.step(2);
      const way = await sim.position(RUINS_WAY_DOWN);
      expect(way && (await walkFighting(sim, way, 120))).toBe(true);
      expect(sim.activate(RUINS_WAY_DOWN)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(RUINS);
      const boss = alias(sim, CR05, CR05_BOSS);
      for (let leg = 0; leg < 30 && !sim.stageDone(CR05, 20); leg++) {
        const at = await sim.position(boss);
        if (at) await walkFighting(sim, at, 10, 300);
        if (sim.world.stage.combat.targetOf(boss) === PLAYER_REF) await sim.kill(boss, PLAYER_REF);
        await sim.step(0.5);
      }
      console.log(
        'boss',
        boss.toString(16),
        await sim.runtime.actors.isDead(boss),
        await sim.distance(PLAYER_REF, boss),
      );
      console.log(
        sim
          .problems()
          .filter((p) => p.tag !== 'cell')
          .slice(0, 10),
      );
      expect(sim.stageDone(CR05, 20)).toBe(true);
      jobDone = await sim.save('CR05 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back to Whiterun (the way there is not under test), through the gate and up to Jorrvaskr,
  // where the player waits for Farkas to come in. "I've taken care of the problem": his gold
  // (CompleteRadiantQuest), and the radiant job done is what C01 waits for
  // (RadiantQuestsUntilC01): Skjor wants to see the player (C01 10).
  it('has Farkas pay the player and Skjor ask for them (CR05 200, C01 10)', async () => {
    if (!jobDone) return;
    const sim = await loadSim(jobDone);
    try {
      await sim.fastTravel(WHITERUN_MARKER);
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(WHITERUN);
      const door = await sim.position(JORRVASKR_FRONT);
      expect(door && (await sim.walkPath(door, 240, 200))).toBe(true);
      expect(sim.activate(JORRVASKR_FRONT)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(JORRVASKR);
      for (let hour = 0; hour < 24 && !sim.actor(FARKAS); hour++) await sim.rest(1, false);
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      const at = await sim.position(FARKAS);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(FARKAS)).toContain("I've taken care of the problem.");
      expect(await sim.choose(/taken care of the problem/)).toEqual(["I'm looking for work."]);
      expect(await sim.until(() => sim.stageDone(C01, 1), 10)).toBe(true);
      // CR05 done (its 200), and started again for the next job (CycleRadiantQuests).
      expect(sim.stagesSet(CR05).map((set) => set.stage)).toContain(200);
      expect((await sim.runtime.itemCount(PLAYER_REF, GOLD)) - gold).toBe(100);
      // No more work: Skjor has something for them ("What does he want?": C01 10).
      expect(await sim.choose(/looking for work/)).toEqual(['What does he want?']);
      expect(await sim.choose(/What does he want/)).toEqual([]);
      await sim.step(1);
      expect(sim.stageDone(C01, 10)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      paid = await sim.save('C01 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The player waits in the hall for Skjor to come in. "You wanted to see me?": a scholar's word of
  // a fragment of Wuuthrad; "I would be honored to retrieve it": the trial, with Farkas as the
  // player's Shield-Brother (C01's Observer): C01 20.
  it("has Skjor send the player to Dustman's Cairn with Farkas (C01 20)", async () => {
    if (!paid) return;
    const sim = await loadSim(paid);
    try {
      for (let hour = 0; hour < 24 && !sim.actor(SKJOR); hour++) await sim.rest(1, false);
      const at = await sim.position(SKJOR);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(SKJOR)).toContain('You wanted to see me?');
      expect(await sim.choose(/wanted to see me/)).toEqual(['What do you mean?']);
      await sim.choose(/What do you mean/);
      expect(await sim.choose(/honored to retrieve it/)).toEqual([]);
      await sim.step(1);
      expect(sim.stageDone(C01, 20)).toBe(true);
      expect(alias(sim, C01, C01_OBSERVER)).toBe(FARKAS);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      sentOff = await sim.save('C01 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // "You're going to be my Shield-Brother?", "I'll meet you at Dustman's Cairn": C01 30, the
  // cairn's map marker (C01's DungeonMarker) on the map, and Farkas sets out for the cairn
  // (C01ObserverWaitOutsidePackage, until he is in its location). Out of the hall to the city.
  it("has Farkas set out for Dustman's Cairn (C01 30)", async () => {
    if (!sentOff) return;
    const sim = await loadSim(sentOff);
    try {
      for (let hour = 0; hour < 24 && !sim.actor(FARKAS); hour++) await sim.rest(1, false);
      const at = await sim.position(FARKAS);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(FARKAS)).toEqual(["You're going to be my Shield-Brother?"]);
      expect(await sim.choose(/Shield-Brother/)).toContain("I'll meet you at Dustman's Cairn.");
      expect(await sim.choose(/meet you at Dustman's Cairn/)).toEqual([]);
      await sim.step(2);
      expect(sim.stageDone(C01, 30)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(sim.package(FARKAS)?.id).toBe(OBSERVER_WAITS_OUTSIDE);
      expect(sim.runtime.mapMarkerVisible(alias(sim, C01, C01_DUNGEON_MARKER))).toBe(true);
      const out = await sim.position(JORRVASKR_OUT);
      expect(out && (await sim.walkPath(out, 120, 150))).toBe(true);
      expect(sim.activate(JORRVASKR_OUT)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(WHITERUN);
      await sim.save('C01 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // TODO(M13): fast travelled to the cairn (some hours from Whiterun), the player finds Farkas
  // waiting there in the original; ours leaves him in Jorrvaskr (the time jump's run does not
  // put him at his travel package's end). Then the cairn, the fragment, the Silver Hand's ambush,
  // Farkas's change and the way back (C01 40 to 200).
  it.todo("has Farkas wait at Dustman's Cairn, and the trial played to its end (C01 40-200)");
});
