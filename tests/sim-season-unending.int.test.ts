// Integration test: MQ302 "Season Unending" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const MQ301 = 0x44c56;
const MQ302 = 0x45923;
/** HighHrothgarMapMarker and a front door of the monastery. */
const HIGH_HROTHGAR_MARKER = 0x16352;
const FRONT_DOOR = 0x877d3;
/** MQ302's aliases. */
const ARNGEIR = 5;
const TULLIUS = 6;
const ULFRIC = 7;
/** Castle Dour and the Palace of the Kings, where the two sit. */
const CASTLE_DOUR = 0x213a0;
const PALACE_OF_THE_KINGS = 0x1677c;
/** The trigger on the steps below the monastery (MQ302Stage50), the player's chair. */
const COUNCIL_TRIGGER = 0x868cb;
const PLAYER_CHAIR = 0x28e36;
/**
 * How long the council may take. Its scenes take some 15 minutes as they are, 11 of them in the
 * one line whose begin changes the holds' owners (CWScript's setOwner: TODO(M13) why the script
 * takes that long here).
 */
const COUNCIL_SECONDS = 1800;

/** The game with Arngeir willing to host the council (stage 15). */
let councilAgreed: Uint8Array | undefined;
/** The game with both sides coming (stage 40). */
let bothComing: Uint8Array | undefined;
/** The game with the player in their seat (stage 60). */
let council: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(MQ302).aliases.get(id) ?? 0;
}

/** An objective of MQ302 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ302).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())('MQ302 Season Unending', () => {
  // MQ302's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ301 to 30
  // (played in sim-the-fallen), whose 30 is MQ302's 10: "Talk to Arngeir". By the map to the
  // monastery, and in at its front door. "Both sides respect the Greybeards. They will listen." is
  // 15: the two to be asked.
  it('has Arngeir agree to host the peace council (0-15)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ302, 0);
      expect(await sim.until(() => sim.stageDone(MQ302, 10), 180)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ301, 30)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.fastTravel(HIGH_HROTHGAR_MARKER);
      await sim.step(2);
      const door = await sim.position(FRONT_DOOR);
      expect(door && (await sim.walkPath(door, 180, 200))).toBe(true);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const arngeir = alias(sim, ARNGEIR);
      const at = await sim.position(arngeir);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(arngeir)).toContain('I need your help to stop the war.');
      expect(await sim.choose(/help to stop the war/)).toEqual([
        "Jarl Balgruuf won't help me while the war rages.",
      ]);
      await sim.choose(/won't help me while the war rages/);
      await sim.choose(/Both sides respect the Greybeards/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ302, 15)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      councilAgreed = await sim.save('MQ302 15');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // General Tullius in Castle Dour and Ulfric in the Palace of the Kings: each says he will come
  // (20, 30), both is 40, and the objective is Arngeir again.
  it('has Tullius and Ulfric agree to come (20-40)', async () => {
    if (!councilAgreed) return;
    const sim = await loadSim(councilAgreed);
    try {
      await sim.openInterior(CASTLE_DOUR);
      await sim.step(2);
      const tullius = alias(sim, TULLIUS);
      let at = await sim.position(tullius);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      // Each of the two first takes a stranger for one who has come to join (CW00A, CW00B).
      expect(await sim.talk(tullius)).toEqual(['Hello.']);
      await sim.choose(/Hello/);
      await sim.choose(/already met/);
      await sim.choose(/helped Hadvar escape/);
      sim.goodbye();
      await sim.step(2);
      expect(await sim.talk(tullius)).toContain('I have a message from the Greybeards.');
      await sim.choose(/message from the Greybeards/);
      await sim.choose(/convening a peace council/);
      await sim.choose(/truce until the dragon menace/);
      await sim.choose(/can't afford to snub/);
      await sim.choose(/come to the peace council/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ302, 20)).toBe(true);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      await sim.openInterior(PALACE_OF_THE_KINGS);
      await sim.step(2);
      const ulfric = alias(sim, ULFRIC);
      at = await sim.position(ulfric);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(ulfric)).toContain("That's not why I'm here.");
      await sim.choose(/not why I'm here/);
      sim.goodbye();
      await sim.step(2);
      expect(await sim.talk(ulfric)).toContain('I have a message from the Greybeards.');
      await sim.choose(/message from the Greybeards/);
      await sim.choose(/negotiate a truce/);
      await sim.choose(/Tullius has already agreed/);
      await sim.choose(/come to the peace council/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ302, 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ302, 40), 5)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      bothComing = await sim.save('MQ302 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back at High Hrothgar: the trigger on the steps (MQ302Stage50) moves the council in and
  // MQ302CouncilSceneIntro goes on at the door; in the hall Arngeir greets the player (52, 55), and
  // the chair is the player's seat (60).
  it('has the council gather and the player take their seat (50-60)', async () => {
    if (!bothComing) return;
    const sim = await loadSim(bothComing);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.fastTravel(HIGH_HROTHGAR_MARKER);
      await sim.step(2);
      const steps = await sim.position(COUNCIL_TRIGGER);
      expect(steps && (await sim.walkPath(steps, 120, 100))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ302, 50), 30)).toBe(true);
      await sim.step(1);
      // Delphine and Esbern at the door: Arngeir's "You were not invited here" and his "Very well.
      // You may enter." wait for the player in the hall (the scene's phase 4).
      const door = await sim.position(FRONT_DOOR);
      expect(door && (await sim.walkPath(door, 180, 200))).toBe(true);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect(await sim.until(() => sim.stageDone(MQ302, 52), 120)).toBe(true);
      expect(lines).toContain('MQ302CouncilSceneIntro: #56 said');
      expect(lines).toContain('MQ302CouncilSceneIntro: #80 said');
      expect(await sim.listen(alias(sim, ARNGEIR), 90)).toBeDefined();
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MQ302, 55), 30)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: false });
      const chair = await sim.position(PLAYER_CHAIR);
      expect(chair && (await sim.walkPath(chair, 60, 120))).toBe(true);
      expect(sim.activate(PLAYER_CHAIR)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ302, 60), 30)).toBe(true);
      await sim.step(1);
      council = await sim.save('MQ302 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The council, scene after scene from the player's seat (no one else moves it on): the player
  // asked as the scenes come to it. Elenwen goes (81, 90), Tullius and Ulfric trade a hold for a hold
  // (140, 150), and a last demand follows. The deal is struck (260, its holds changing hands, 265)
  // and the seat is left at 300, with MQ301's next step: 50.
  it('plays the council through its scenes to the truce (70-300)', async () => {
    if (!council) return;
    const sim = await loadSim(council);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const asked: string[][] = [];
      const until = sim.time + COUNCIL_SECONDS;
      while (until - sim.time >= SIM_STEP / 2 && !sim.stageDone(MQ302, 300)) {
        let topics = await sim.listen(undefined, 5);
        // The first of what is asked each time (the later scenes are the data's random picks).
        for (let turn = 0; turn < 8 && topics?.[0] !== undefined; turn++) {
          asked.push(topics);
          topics = await sim.choose(topics[0]);
        }
        sim.goodbye();
      }
      expect(sim.stageDone(MQ302, 300)).toBe(true);
      expect(asked[0]).toContain("You're right. The Thalmor have no business here.");
      expect(asked.length).toBeGreaterThanOrEqual(3);
      // No alias tag left unfilled in what the player was asked.
      for (const topic of asked.flat()) expect(topic).not.toMatch(/<[^>]+>/);
      for (const stage of [81, 90, 100, 110, 120, 140, 150, 160, 180, 260, 265, 280]) {
        expect(sim.stageDone(MQ302, stage), `stage ${stage}`).toBe(true);
      }
      for (const scene of ['MQ302CouncilSceneElenwenLeaves', 'MQ302CouncilScene4']) {
        expect(lines.some((line) => line.startsWith(`${scene}: phase 0`)), scene).toBe(true);
      }
      await sim.step(2);
      expect(objective(sim, 60)).toEqual({ displayed: true, completed: true });
      expect(sim.stageDone(MQ301, 50)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
