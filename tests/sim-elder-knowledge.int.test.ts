// Integration test: MQ205 "Elder Knowledge" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ204 = 0x2d515;
const MQ205 = 0x2d516;
const DA04 = 0x2d512;
const COLLEGE_BRIDGE = 0xc9f08;
/** MQ205's Arngeir alias; HighHrothgarMapMarker and a front door of the monastery. */
const ARNGEIR = 1;
const HIGH_HROTHGAR_MARKER = 0x16352;
const FRONT_DOOR = 0x877d3;
/** MG01 "First Lessons", its Faralda alias, where its start puts her (MG01NiryaWaitMarker), and the
 * College's gate. */
const MG01 = 0x1f251;
const MG01_FARALDA = 11;
const FARALDA_WAITS = 0x379ef;
const COLLEGE_GATE = 0x37a7d;
/** WinterholdMapMarker, the door to the Hall of the Elements from the courtyard, and the hall. */
const WINTERHOLD_MARKER = 0x177ef;
const HALL_OF_THE_ELEMENTS_DOOR = 0x177f9;
const HALL_OF_THE_ELEMENTS = 0x1380e;
/** The Arcanaeum's door, MQ205's Urag alias, his book (DA04Book1Ref), Septimus's map marker. */
const ARCANAEUM_DOOR = 0x175dd;
const URAG = 2;
const RUMINATIONS = 0x32787;
const SEPTIMUS_MARKER = 0x2d511;
/** The Arcanaeum and where Urag puts his books down (DA04UragPlaceBooksMARKER). */
const ARCANAEUM = 0x13810;
const BOOKS_PLACED = 0x2726d;
/** The way out of the Arcanaeum and of the Hall, the hatch to Septimus's outpost, DA04's alias. */
const ARCANAEUM_OUT = 0x46bec;
const HALL_OUT = 0x175ef;
const OUTPOST_DOOR = 0xe8e46;
const SEPTIMUS = 0;
const OUTPOST = 0x2d4e4;
/** AlftandMapMarker; the Attunement Sphere and the blank lexicon (DA04's 20 gives them). */
const ALFTAND_MARKER = 0x15d4a;
const SPHERE = 0x3532c;
const BLANK_LEXICON = 0x3a3d2;
/** Alftand: the crack in the ice from Tamriel, the first cell and its large door (MQ205's
 * AlftandSecondCellDoor alias), the second and its door to the cathedral (AlftandWorldDoor). */
const ALFTAND_CRACK = 0x15d48;
const ALFTAND_01 = 0x152c3;
const ALFTAND_01_DOOR = 0x92809;
const ALFTAND_02 = 0x56c1b;
const ALFTAND_02_DOOR = 0x9256a;
const ALFTAND_WORLD = 0x69857;
/** The cathedral: the way past the swinging wall's plates, the lever of the stair's portcullis,
 * the lock (MQ205's BlackreachLock alias), the door to Blackreach and Blackreach. */
const CATHEDRAL_LANE: readonly Vec3[] = [
  [3374, 3145, 293],
  [2640, 3280, 293],
  [2400, 3300, 293],
];
const PORTCULLIS_LEVER = 0x69ae9;
const BLACKREACH_LOCK = 0xa9fda;
const BLACKREACH_DOOR = 0x6998d;
const BLACKREACH = 0x1ee62;
/** The thresher on the Animonculory's stair (TrapDweThresher), the stair's foot, and the way up
 * between its pressure plates (TrapPressurePlateDwe01). */
const THRESHER = 0x8879e;
const STAIR_FOOT: Vec3 = [4104, -3427, -1397];
const PLATE_LANE: readonly Vec3[] = [
  [4060, -3480, -1340],
  [3990, -3590, -1280],
  [4010, -3650, -1250],
  [4125, -3715, -1190],
  [4135, -3790, -1130],
];
const TAMRIEL = 0x3c;

/** The game with the player told of the College (stage 50). */
let toldOfCollege: Uint8Array | undefined;
/** The game with the player over the bridge, at the Hall of the Elements' door. */
let afterBridge: Uint8Array | undefined;
/** The game with Septimus's errand (MQ205 80). */
let afterSeptimus: Uint8Array | undefined;
/** The game in Alftand's second cell, and in its cathedral. */
let inAlftand02: Uint8Array | undefined;
let inCathedral: Uint8Array | undefined;
/** The game in Blackreach. */
export let inBlackreach: Uint8Array | undefined;
/** The game with Urag's word on Septimus (MQ205 60). */
let afterUrag: Uint8Array | undefined;

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
    // A walk that found no way returns without a step: time goes on while it asks again.
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

/** An objective of MQ205 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ205).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())('MQ205 Elder Knowledge', () => {
  // MQ205's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ204 to 210
  // (played in sim-throat-of-the-world) and its 200 sets 10. Paarthurnax's word sends the player to
  // those who may know: Arngeir, of the two ("I talked to Paarthurnax": 45; "I need the Elder
  // Scroll the ancients used": 50, which opens the College's way, MGMainQuestBridge).
  it('has Arngeir send the player to the College (0-50)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ205, 0);
      expect(await sim.until(() => sim.stageDone(MQ205, 10), 180)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ204, 200)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.fastTravel(HIGH_HROTHGAR_MARKER);
      await sim.step(2);
      const door = await sim.position(FRONT_DOOR);
      expect(door && (await sim.walkPath(door, 180, 200))).toBe(true);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const arngeir = alias(sim, MQ205, ARNGEIR);
      const at = await sim.position(arngeir);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(arngeir)).toContain('I talked to Paarthurnax.');
      await sim.choose(/talked to Paarthurnax/);
      expect(sim.stageDone(MQ205, 45)).toBe(false);
      await sim.choose(/he told me how to find out/);
      expect(sim.stageDone(MQ205, 45)).toBe(true);
      expect(sim.stageDone(MQ205, 50)).toBe(false);
      await sim.choose(/Elder Scroll the ancients used/);
      sim.goodbye();
      expect(sim.stageDone(MQ205, 50)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 50).displayed).toBe(false);
      expect(sim.isRunning(COLLEGE_BRIDGE)).toBe(true);
      toldOfCollege = await sim.save('MQ205 50');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Winterhold (the way there, on foot or by carriage, is not under test), and to the College's
  // bridge. Faralda stands at its foot (MG01's start put her there), and warns the player off it.
  // Found 2026-11-06: her greeting asks IsInDialogueWithPlayer, and the actor was in dialogue only
  // once the greeting was chosen, so she had nothing to say to anyone. "Would you grant entry to
  // the Dragonborn?" (MQ205's 50): she waits for a Shout (MG01QuestScript's WaitingForShout), and
  // comes to the player ("That proves I have the Voice"): MG01 30. Her Escort takes them across.
  it('has Faralda ask for a Shout, and take the Dragonborn into the College (MG01 30)', async () => {
    if (!toldOfCollege) return;
    const sim = await loadSim(toldOfCollege);
    try {
      const faralda = alias(sim, MG01, MG01_FARALDA);
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      expect(sim.openState(COLLEGE_GATE)).not.toBe(1);
      const at = await sim.position(faralda);
      expect(await sim.distance(faralda, FARALDA_WAITS)).toBeLessThan(200);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      let topics = await sim.talk(faralda);
      for (let again = 0; again < 3 && topics?.length === 0; again++) {
        topics = await sim.listen(faralda, 3);
      }
      expect(topics).toContain('What is this place?');
      await sim.choose(/What is this place/);
      await sim.choose(/May I enter/);
      await sim.choose(/ice and fire/);
      expect(await sim.choose(/grant entry to the Dragonborn/)).toEqual([]);
      expect(sim.stage(MG01)).toBeLessThan(30);
      await sim.step(0.5);
      expect(await sim.equip(await sim.formId('SHOU', 'UnrelentingForceShout'))).toBe(true);
      const me = sim.world.player.feet;
      sim.look([me[0] + 300, me[1] + 300, me[2] + 110]);
      await sim.step(1);
      sim.press('Shout', true);
      await sim.step(0.1);
      sim.press('Shout', false);
      await sim.listen(faralda, 30);
      sim.goodbye();
      expect(await sim.until(() => sim.stage(MG01) === 30, 10)).toBe(true);
      await sim.step(1);
      expect(sim.package(faralda)?.procedure).toBe('Escort');
      // Over the bridge after her, through the gate she opens, up to the Hall of the Elements.
      const hall = await sim.position(HALL_OF_THE_ELEMENTS_DOOR);
      expect(hall && (await sim.walkPath(hall, 150, 200))).toBe(true);
      expect(sim.openState(COLLEGE_GATE)).toBe(1);
      afterBridge = await sim.save('MQ205 bridge');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Through the Hall of the Elements to the Arcanaeum. Urag has heard of the Dragonborn: he brings
  // what he has on the Scrolls (DA04UragGetBooks), the player reads Septimus's Ruminations, and
  // Urag tells where its author went (DA04's 10: MQ205's 60).
  it('has Urag bring his books and point to Septimus (DA04 10, MQ205 60)', async () => {
    if (!afterBridge) return;
    const sim = await loadSim(afterBridge);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      expect(sim.activate(HALL_OF_THE_ELEMENTS_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HALL_OF_THE_ELEMENTS);
      const door = await sim.position(ARCANAEUM_DOOR);
      expect(door && (await sim.walkPath(door, 90, 150))).toBe(true);
      expect(sim.activate(ARCANAEUM_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(ARCANAEUM);
      const urag = alias(sim, MQ205, URAG);
      const at = await sim.position(urag);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(urag)).toContain("I'm looking for an Elder Scroll.");
      await sim.choose(/looking for an Elder Scroll/);
      await sim.choose(/Do you have one here/);
      await sim.choose(/What about the Dragonborn/);
      sim.goodbye();
      const brought = 'DA04UragGetBooks: #3 said';
      expect(await sim.until(() => lines.includes(brought), 120)).toBe(true);
      expect(await sim.distance(urag, BOOKS_PLACED)).toBeLessThan(300);
      const book = await sim.position(RUMINATIONS);
      expect(book && (await sim.walkPath(book, 30, 120))).toBe(true);
      const base = await sim.runtime.baseOf(RUMINATIONS);
      expect(base !== undefined && (await sim.read(base, RUMINATIONS))).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(DA04, 10)).toBe(false);
      const back = await sim.position(urag);
      expect(back && (await sim.walkPath(back, 30, 150))).toBe(true);
      expect(await sim.talk(urag)).toContain('This "Ruminations" book is incomprehensible.');
      await sim.choose(/Ruminations/);
      expect(await sim.choose(/Where did he go/)).toEqual([]);
      expect(sim.stageDone(DA04, 10)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ205, 60)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      afterUrag = await sim.save('MQ205 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Out of the College and north over the ice to the hermit's outpost. "I heard you know about
  // Elder Scrolls": he has the player inscribe a lexicon in Blackreach (DA04's 20: the cube and the
  // sphere; MQ205's 80: objective 50).
  it('has Septimus send the player to Blackreach (DA04 20, MQ205 80)', async () => {
    if (!afterUrag) return;
    const sim = await loadSim(afterUrag);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const septimus = alias(sim, DA04, SEPTIMUS);
      for (const out of [ARCANAEUM_OUT, HALL_OUT]) {
        const door = await sim.position(out);
        expect(door && (await sim.walkPath(door, 120, 150))).toBe(true);
        expect(sim.activate(out)).toBe(true);
        await sim.world.settle();
        await sim.step(1);
      }
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
      // Back over the bridge: the College's rock has no other way down.
      const foot = await sim.position(FARALDA_WAITS);
      expect(foot && (await sim.walkPath(foot, 90, 200))).toBe(true);
      const hatch = await sim.position(OUTPOST_DOOR);
      let there = false;
      for (let leg = 0; leg < 25 && hatch && !there; leg++) {
        there = await sim.walkPath(hatch, 15, 200);
        await fendOff(sim);
      }
      expect(there).toBe(true);
      expect(sim.activate(OUTPOST_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(OUTPOST);
      expect((await sim.runtime.placement(septimus))?.cell).toBe(OUTPOST);
      const at = await sim.position(septimus);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(septimus)).toContain('I heard you know about Elder Scrolls.');
      await sim.choose(/know about Elder Scrolls/);
      await sim.choose(/where is the Scroll/);
      await sim.choose(/help me get the Elder Scroll/);
      await sim.choose(/What do you want/);
      expect(sim.stageDone(DA04, 20)).toBe(false);
      await sim.choose(/Where is this "Blackreach"/);
      await sim.choose(/How do I get in/);
      sim.goodbye();
      expect(sim.stageDone(DA04, 20)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ205, 80)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: false });
      expect(sim.runtime.mapMarkerVisible(ALFTAND_MARKER)).toBe(true);
      for (const item of [SPHERE, BLANK_LEXICON]) {
        expect(await sim.runtime.itemCount(PLAYER_REF, item)).toBe(1);
      }
      afterSeptimus = await sim.save('MQ205 80');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The map's new marker, and into the glacier by the crack in the ice (an automatic door). Through
  // the ruins' first cell to its large door: the lift beside the shut portcullis on the way is
  // for later, from the far side. What comes at the player falls (the fights are not under test).
  it('has the player go through the ruins of Alftand (Alftand01)', async () => {
    if (!afterSeptimus) return;
    const sim = await loadSim(afterSeptimus);
    try {
      await sim.fastTravel(ALFTAND_MARKER);
      await sim.step(2);
      const crack = await sim.position(ALFTAND_CRACK);
      expect(crack && (await walkFighting(sim, crack, 90))).toBe(true);
      expect(sim.activate(ALFTAND_CRACK)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(ALFTAND_01);
      const door = await sim.position(ALFTAND_01_DOOR);
      expect(door && (await walkFighting(sim, door, 300))).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      expect(sim.activate(ALFTAND_01_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(ALFTAND_02);
      inAlftand02 = await sim.save('MQ205 alftand02');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The Animonculory: up the stair the thresher sweeps, on the lane between its three pressure
  // plates (a plate trodden on, the blade takes 94 of the player's health at this level), and down
  // past the Falmer to the large door of the cathedral.
  it('has the player pass the thresher and reach the cathedral (Alftand02)', async () => {
    if (!inAlftand02) return;
    const sim = await loadSim(inAlftand02);
    try {
      const unhurt = (): number => sim.events('trapHit').length;
      expect(await walkFighting(sim, STAIR_FOOT, 60, 40)).toBe(true);
      for (const lane of PLATE_LANE) expect(await sim.walkTo(lane, 5, 24)).toBe(true);
      expect(unhurt()).toBe(0);
      expect(await sim.enabled(THRESHER)).toBe(true);
      const door = await sim.position(ALFTAND_02_DOOR);
      expect(door && (await walkFighting(sim, door, 300))).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      expect(sim.activate(ALFTAND_02_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(ALFTAND_WORLD);
      inCathedral = await sim.save('MQ205 cathedral');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Alftand's cathedral: across the hall clear of the swinging wall's plates (it takes as much as
  // the thresher), up to the lever that opens the portcullis on the stair (TrapLever, through its
  // TrapLinker), up the stair to the lock. The Attunement Sphere is the key: the lock opens
  // (BlackreachLockScript), the great stair folds out, and the door at its foot is Blackreach's.
  it('has the player open the way to Blackreach with the sphere (Alftand cathedral)', async () => {
    if (!inCathedral) return;
    const sim = await loadSim(inCathedral);
    try {
      for (const lane of CATHEDRAL_LANE) expect(await sim.walkTo(lane, 10, 60)).toBe(true);
      expect(sim.events('trapHit')).toEqual([]);
      const lock = await sim.position(BLACKREACH_LOCK);
      expect(lock).toBeDefined();
      if (!lock) return;
      // The portcullis holds the stair until the lever is pulled.
      expect(await walkFighting(sim, lock, 15)).toBe(false);
      const lever = await sim.position(PORTCULLIS_LEVER);
      expect(lever && (await walkFighting(sim, lever, 60, 130))).toBe(true);
      expect(sim.activate(PORTCULLIS_LEVER)).toBe(true);
      await sim.step(4);
      expect(await walkFighting(sim, lock, 90)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, SPHERE)).toBe(1);
      expect(sim.activate(BLACKREACH_LOCK)).toBe(true);
      await sim.step(5);
      const down = await sim.position(BLACKREACH_DOOR);
      expect(down && (await walkFighting(sim, down, 60, 150))).toBe(true);
      expect(sim.activate(BLACKREACH_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(BLACKREACH);
      inBlackreach = await sim.save('MQ205 blackreach');
    } finally {
      await sim.close();
    }
  }, 600_000);
});
