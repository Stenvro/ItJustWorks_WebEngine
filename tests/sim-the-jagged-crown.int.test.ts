// Integration test: CW02A "The Jagged Crown" (the Legion's) on the headless simulation, played as
// the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { exteriorOfCell } from '../src/world/exterior-doors.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const CW01A = 0xd517a;
const CW02A = 0x2d75c;
const CASTLE_DOUR = 0x213a0;
/** CW02A's aliases: Rikke, the meeting point outside Korvanjund, the location. */
const RIKKE = 9;
const MEETING_POINT = 11;
const KORVANJUND = 0x19261;
/** The Stormcloaks before the barrow (CW02A's ExteriorDefender aliases). */
const EXTERIOR_DEFENDERS = [13, 15, 16, 48, 49];
/** The barrow's first cell. */
const KORVANJUND_01 = 0x152a1;
/** CW02A's LockedGateLever02 alias: the lever of the inner gate. */
const LEVER = 43;
/** CW02A's Cell01ExitDoor, EbonyClaw and HallOfStoriesDoor (the keyhole) aliases. */
const CELL_01_EXIT = 55;
const EBONY_CLAW = 36;
const HALL_OF_STORIES_DOOR = 45;
/** The Hall of Stories' cell, the claw's base (dunKorvanjundEbonyDragonClaw). */
const KORVANJUND_02 = 0x2954d;
const CLAW_BASE = 0x5af48;
/** CW02A's Cell02ExitDoor, DraugrBoss, Book (the Jagged Crown) and GeneralTullius aliases. */
const CELL_02_EXIT = 56;
const DRAUGR_BOSS = 44;
const CROWN = 18;
const TULLIUS = 4;
/** The barrow's last chamber; SolitudeMapmarkerRef; CW03 "Message to Whiterun". */
const KORVANJUND_03 = 0x2954c;
const SOLITUDE_MARKER = 0x4d0f4;
const CW03 = 0xd661c;
/** The Hall of Stories' rings (small, middle, large) and how often each is turned. */
const RINGS = [
  [0x5af4b, 1],
  [0x5af4c, 1],
  [0x5af4d, 2],
] as const;

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
  target: readonly [number, number, number],
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(
      [target[0], target[1], target[2]],
      Math.min(5, until - sim.time),
      reach,
    );
    await fendOff(sim);
    await catchBreath(sim);
    if (there) return true;
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

/** The game with the player sent to Korvanjund (CW02A 30). */
let toKorvanjund: Uint8Array | undefined;
/** The game with the Stormcloaks outside the barrow fallen (CW02A 60). */
let outsideBarrow: Uint8Array | undefined;
/** The game at the inner barrow's shut gate (CW02A 70). */
let atGate: Uint8Array | undefined;
/** The game with the inner gate open (CW02A 150). */
let gateOpen: Uint8Array | undefined;
/** The game with the Jagged Crown taken (CW02A 180). */
let withCrown: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('CW02A The Jagged Crown', () => {
  // Castle Dour, the oath just taken (Joining the Legion's stages, as
  // tests/sim-joining-the-legion.int.test.ts plays them). Rikke's first assignment: "General
  // Tullius told me to report to you." (20), and she sends the player to Korvanjund (30).
  it('has Rikke send the new soldier to Korvanjund (CW02A 10, 20, 30)', async () => {
    const sim = await openSim({ hour: 10, interior: CASTLE_DOUR });
    try {
      await sim.step(1);
      for (const stage of [1, 100, 150, 160, 200]) {
        void sim.runtime.quests.setStage(CW01A, stage);
        expect(await sim.until(() => sim.stageDone(CW01A, stage), 30)).toBe(true);
      }
      await sim.step(2);
      expect(sim.stageDone(CW02A, 10)).toBe(true);
      const rikke = alias(sim, CW02A, RIKKE);
      const at = await sim.position(rikke);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(rikke)).toEqual(['General Tullius told me to report to you.']);
      expect(await sim.choose(/report to you/)).toContain("What's the mission?");
      expect(sim.stageDone(CW02A, 30)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      const objectives = sim.runtime.state.quest(CW02A).objectives;
      expect(objectives.get(10)?.completed).toBe(true);
      expect(objectives.get(20)?.displayed).toBe(true);
      toKorvanjund = await sim.save('CW02A 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Korvanjund (the way there is not under test): Rikke and her soldiers come to the meeting
  // point; "I'm ready, ma'am." (40, 42; 50: the charge). The Stormcloaks before the barrow fall
  // (CW02A's five ExteriorDefender aliases): 60, the way into the barrow.
  it('has Rikke lead the charge on the Stormcloaks outside Korvanjund (CW02A 40, 50, 60)', async () => {
    expect(toKorvanjund).toBeDefined();
    if (!toKorvanjund) return;
    const sim = await loadSim(toKorvanjund);
    try {
      const place = await sim.runtime.location(KORVANJUND);
      expect(place?.marker).toBeDefined();
      await sim.fastTravel(place?.marker ?? 0);
      await sim.step(2);
      const meeting = await sim.position(alias(sim, CW02A, MEETING_POINT));
      expect(meeting && (await walkFighting(sim, meeting, 120, 300))).toBe(true);
      const rikke = alias(sim, CW02A, RIKKE);
      const near = async (): Promise<boolean> =>
        ((await sim.distance(rikke, PLAYER_REF)) ?? Infinity) < 600;
      for (let second = 0; second < 300 && !(await near()); second += 5) await sim.step(5);
      expect(await near()).toBe(true);
      const at = await sim.position(rikke);
      expect(at && (await sim.walkPath(at, 30, 150))).toBe(true);
      expect(await sim.talk(rikke)).toContain("I'm ready, ma'am.");
      expect(await sim.choose(/ready, ma'am/)).toEqual([]);
      sim.goodbye();
      expect(sim.stageDone(CW02A, 50)).toBe(true);
      for (const id of EXTERIOR_DEFENDERS) {
        const defender = alias(sim, CW02A, id);
        const where = await sim.position(defender);
        const reached = where && (await walkFighting(sim, where, 60, 250));
        if (reached && !(await sim.runtime.actors.isDead(defender))) {
          await sim.kill(defender, PLAYER_REF);
        }
        expect(await sim.runtime.actors.isDead(defender)).toBe(true);
      }
      expect(await sim.until(() => sim.stageDone(CW02A, 60), 10)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      await sim.step(1);
      outsideBarrow = await sim.save('CW02A 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Into the barrow (its outer door, the way Korvanjund01's way out comes out): the soldiers come
  // in after the player (61), and the player keeps by Rikke through the Stormcloaks' ambush
  // (62, 63, 65) to the shut gate of the inner barrow (78, 70).
  it('has the player follow Rikke into Korvanjund to its shut gate (CW02A 61, 65, 70)', async () => {
    expect(outsideBarrow).toBeDefined();
    if (!outsideBarrow) return;
    const sim = await loadSim(outsideBarrow);
    try {
      const rikke = alias(sim, CW02A, RIKKE);
      const out = await exteriorOfCell(sim.db, KORVANJUND_01);
      expect(out).toBeDefined();
      if (!out) return;
      const door = await sim.position(out.door);
      expect(door && (await walkFighting(sim, door, 120, 150))).toBe(true);
      expect(sim.activate(out.door)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(KORVANJUND_01);
      expect(sim.stageDone(CW02A, 61)).toBe(true);
      for (let second = 0; second < 600 && !sim.stageDone(CW02A, 70); second += 5) {
        const at = await sim.position(rikke);
        const far = ((await sim.distance(rikke, PLAYER_REF)) ?? 0) > 300;
        const before = sim.time;
        if (at && far) await walkFighting(sim, at, 5, 250);
        // Within the walk's reach of her across a height (at the head of the stair she went down
        // towards the gate) the walk is over before it begins: the player waits there instead
        // (else the clock stood still, and her line in progress was never done).
        if (sim.time - before < SIM_STEP / 2) await sim.step(5);
        await fendOff(sim);
      }
      for (const stage of [62, 63, 65, 78, 70]) expect(sim.stageDone(CW02A, stage)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      atGate = await sim.save('CW02A 70');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // On through the temple's far door (Cell01ExitDoor) into the Hall of Stories' cell (100, 81:
  // the Stormcloaks' bodies and the Ebony Claw, 102, 103). The claw taken, its palm's animals set
  // on the rings (each ring turned once its turn is over), the claw in the keyhole opens the
  // door (130, 135). Up the stair beyond it to the balcony's pull bar, which opens the gate
  // (150).
  it('has the player open the Hall of Stories with the Ebony Claw and the gate beyond (CW02A 100-150)', async () => {
    expect(atGate).toBeDefined();
    if (!atGate) return;
    const sim = await loadSim(atGate);
    try {
      const exit = alias(sim, CW02A, CELL_01_EXIT);
      const exitAt = await sim.position(exit);
      expect(exitAt && (await walkFighting(sim, exitAt, 150, 150))).toBe(true);
      expect(sim.activate(exit)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(KORVANJUND_02);
      const claw = alias(sim, CW02A, EBONY_CLAW);
      const clawAt = await sim.position(claw);
      expect(clawAt && (await walkFighting(sim, clawAt, 60, 100))).toBe(true);
      expect(sim.activate(claw)).toBe(true);
      await sim.step(1);
      expect(await sim.runtime.itemCount(PLAYER_REF, CLAW_BASE)).toBe(1);
      const keyhole = alias(sim, CW02A, HALL_OF_STORIES_DOOR);
      const at = await sim.position(keyhole);
      expect(at && (await walkFighting(sim, at, 60, 130))).toBe(true);
      // HallofStoriesDiskScript's states: each turn goes on to the next (3 to 1), and the
      // solveState the claw shows: the small ring once, the middle ring once, the large twice.
      for (const [ring, turns] of RINGS) {
        for (let turn = 0; turn < turns; turn++) {
          expect(sim.activate(ring)).toBe(true);
          await sim.step(5);
        }
      }
      expect(sim.activate(keyhole)).toBe(true);
      expect(await sim.until(() => sim.stageDone(CW02A, 130), 15)).toBe(true);
      await sim.step(10);
      const lever = alias(sim, CW02A, LEVER);
      const leverAt = await sim.position(lever);
      expect(leverAt && (await walkFighting(sim, leverAt, 180, 150))).toBe(true);
      expect(sim.stageDone(CW02A, 135)).toBe(true);
      expect(sim.activate(lever)).toBe(true);
      expect(await sim.until(() => sim.stageDone(CW02A, 150), 10)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      await sim.step(2);
      gateOpen = await sim.save('CW02A 150');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Through the gate and the hall's far door (Cell02ExitDoor) into the barrow's last chamber
  // (160, 162): its draugr wake (170, 171) and their lord falls (176). The Jagged Crown is on
  // him: taken, it is the player's to deliver to Tullius (172, 180; objective 80).
  it('has the player take the Jagged Crown from Korvanjund’s draugr lord (CW02A 160-180)', async () => {
    expect(gateOpen).toBeDefined();
    if (!gateOpen) return;
    const sim = await loadSim(gateOpen);
    try {
      const exit = alias(sim, CW02A, CELL_02_EXIT);
      const exitAt = await sim.position(exit);
      expect(exitAt && (await walkFighting(sim, exitAt, 240, 150))).toBe(true);
      expect(sim.activate(exit)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(KORVANJUND_03);
      expect(sim.stageDone(CW02A, 160)).toBe(true);
      const boss = alias(sim, CW02A, DRAUGR_BOSS);
      const bossAt = await sim.position(boss);
      expect(bossAt && (await walkFighting(sim, bossAt, 300, 300))).toBe(true);
      expect(sim.stageDone(CW02A, 170)).toBe(true);
      if (!(await sim.runtime.actors.isDead(boss))) await sim.kill(boss, PLAYER_REF);
      expect(await sim.until(() => sim.stageDone(CW02A, 176), 10)).toBe(true);
      const crown = alias(sim, CW02A, CROWN);
      expect(sim.runtime.state.references.get(crown)?.container?.holder).toBe(boss);
      const base = (await sim.runtime.baseOf(crown)) ?? 0;
      const lying = await sim.position(boss);
      expect(lying && (await walkFighting(sim, lying, 30, 120))).toBe(true);
      expect(await sim.take(boss, base)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, base)).toBe(1);
      expect(await sim.until(() => sim.stageDone(CW02A, 180), 10)).toBe(true);
      // Its fragment shows the next objective as it runs on.
      const deliver = (): boolean =>
        sim.runtime.state.quest(CW02A).objectives.get(80)?.displayed === true;
      expect(await sim.until(deliver, 5)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      await sim.step(1);
      withCrown = await sim.save('CW02A 180');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back in Castle Dour: "Here's the Jagged Crown. Legate Rikke sent me to deliver it to you."
  // (190), "Nothing I couldn't handle." The quest is done (200), and Message to Whiterun begins.
  it('has the player deliver the crown to Tullius (CW02A 190, 200; CW03 starts)', async () => {
    expect(withCrown).toBeDefined();
    if (!withCrown) return;
    const sim = await loadSim(withCrown);
    try {
      await sim.fastTravel(SOLITUDE_MARKER);
      await sim.step(1);
      await sim.openInterior(CASTLE_DOUR);
      await sim.step(2);
      const tullius = alias(sim, CW02A, TULLIUS);
      const at = await sim.position(tullius);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(tullius)).toContain(
        "Here's the Jagged Crown. Legate Rikke sent me to deliver it to you.",
      );
      expect(await sim.choose(/Here's the Jagged Crown/)).toContain("Nothing I couldn't handle.");
      expect(await sim.choose(/Nothing I couldn't handle/)).toEqual([]);
      sim.goodbye();
      await sim.step(2);
      expect(sim.stageDone(CW02A, 190)).toBe(true);
      expect(sim.stageDone(CW02A, 200)).toBe(true);
      expect(sim.isRunning(CW02A)).toBe(false);
      expect(sim.isRunning(CW03)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
