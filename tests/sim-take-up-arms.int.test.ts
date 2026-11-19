// Integration test: C00 "Take Up Arms" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const C00 = 0x4b2d9;
const VILKAS_TRAINING = 0xa3ebc;
/** Jorrvaskr's hall, its door down to the living quarters, and the quarters. */
const JORRVASKR = 0x165b5;
const QUARTERS_DOOR = 0x77fa2;
const QUARTERS = 0x7947a;
const QUARTERS_UP = 0x794e4;
/** The hall's door out to the training yard (JorrvaskrDoor4REF's other side). */
const YARD_DOOR = 0x75d6b;
const KODLAK = 0x1a68f;
const VILKAS = 0x1a695;

const EORLUND = 0x1a683;
const AELA = 0x1a697;
const FARKAS = 0x1a693;
/** ArmorSteelShield: Aela's shield (C00's AelaShield alias, made in Eorlund's inventory). */
const STEEL_SHIELD = 0x13955;
/** JorrvaskrDoor4REF: from the yard into the hall. */
const YARD_IN = 0x4816b;
/** SkyforgeSteelSword: Vilkas's sword (C00's VilkasSword alias, made in his inventory). */
const SKYFORGE_SWORD = 0x9f25c;
/** C00VilkasTrainingQuestOverTopic: "How was that?", Vilkas's greeting after the fight. */
const HOW_WAS_THAT = 0xa3e4b;
const COMPANIONS_FACTION = 0x48362;
/** CR04 "Hired Muscle", one of the jobs Farkas gives. */
const CR04 = 0x25231;

/** The game with the player sent to train with Vilkas (C00 20). */
let toTrain: Uint8Array | undefined;
/** The game with Vilkas's sword in the player's hands (C00 30). */
let afterTraining: Uint8Array | undefined;
/** The game with Aela's shield in the player's hands (C00 40). */
let afterSword: Uint8Array | undefined;
/** The game with Farkas called to show the player their bed (C00 50). */
let afterShield: Uint8Array | undefined;

/** An objective of C00 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(C00).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The player goes through a door they walk up to. */
async function through(sim: Sim, door: number): Promise<number | undefined> {
  const at = await sim.position(door);
  expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  return (await sim.runtime.placement(PLAYER_REF))?.cell;
}

describe.skipIf(!hasGamedata())('C00 Take Up Arms', () => {
  // Into Jorrvaskr (the way there is not under test) and down to the living quarters, where
  // Kodlak sits with Vilkas. "I would like to join the Companions": he has a look at the player
  // (C00KodlakVilkasArgueAboutPlayer: Vilkas doubts, Kodlak speaks for the heart), then comes back
  // to them (his ForceGreet): "I can handle myself" has him send Vilkas out to test them
  // (C00KodlakDismissVilkas): C00 20, "Train with Vilkas".
  it('has Kodlak send the player to train with Vilkas (C00 20)', async () => {
    const sim = await openSim({ interior: JORRVASKR, hour: 10 });
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.step(2);
      expect(await through(sim, QUARTERS_DOOR)).toBe(QUARTERS);
      const at = await sim.position(KODLAK);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(KODLAK)).toContain('I would like to join the Companions.');
      expect(await sim.choose(/join the Companions/)).toEqual([]);
      expect(await sim.listen(KODLAK, 150)).toContain('I can handle myself.');
      expect(lines).toContain('C00KodlakVilkasArgueAboutPlayer: #6 said');
      expect(await sim.choose(/I can handle myself/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(C00, 20), 60)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      toTrain = await sim.save('C00 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Up and out to the training yard, where Vilkas waits. "So you're supposed to train me?": a few
  // swings at him (C00VilkasTrainingQuest; C00TrainerScript counts three blows).
  it('has the player train with Vilkas', async () => {
    if (!toTrain) return;
    const sim = await loadSim(toTrain);
    try {
      expect(await through(sim, QUARTERS_UP)).toBe(JORRVASKR);
      await through(sim, YARD_DOOR);
      await sim.step(2);
      const at = await sim.position(VILKAS);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      expect(await sim.talk(VILKAS)).toEqual(["So you're supposed to train me?"]);
      expect(await sim.choose(/train me/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(VILKAS_TRAINING, 10), 10)).toBe(true);
      let blows = 0;
      for (let swing = 0; swing < 12 && !sim.stageDone(VILKAS_TRAINING, 150); swing++) {
        if ((await sim.swingAt(VILKAS, 80)).landed) blows += 1;
      }
      expect(blows).toBe(3);
      expect(sim.stageDone(VILKAS_TRAINING, 150)).toBe(true);
      // The fight stopped, he comes to the player: "How was that?" (his ForceGreet's topic), "Not
      // bad", and his sword to take to Eorlund (the continuation's PassTheSword): C00 30.
      expect(await sim.listen(VILKAS, 30)).toEqual([]);
      expect(sim.menus().at(-1)?.opening).toBe(HOW_WAS_THAT);
      expect(await sim.until(() => sim.stageDone(C00, 30), 10)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(VILKAS_TRAINING, 200)).toBe(true);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.itemCount(PLAYER_REF, SKYFORGE_SWORD)).toBe(1);
      afterTraining = await sim.save('C00 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Up to the Skyforge with the sword.
  it('has the player bring Vilkas his sword to Eorlund (C00 40)', async () => {
    if (!afterTraining) return;
    const sim = await loadSim(afterTraining);
    try {
      const at = await sim.position(EORLUND);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(EORLUND)).toEqual(['Vilkas sent me with his sword.']);
      await sim.choose(/Vilkas sent me/);
      await sim.choose(/always send newcomers/);
      await sim.choose(/Are you a Companion/);
      expect(await sim.choose(/need to be going/)).toEqual(['What is it?']);
      await sim.choose(/What is it/);
      expect(await sim.choose(/happy to lend a hand/)).toEqual([]);
      await sim.step(1);
      expect(sim.stageDone(C00, 40)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.itemCount(PLAYER_REF, SKYFORGE_SWORD)).toBe(0);
      expect(await sim.runtime.itemCount(PLAYER_REF, STEEL_SHIELD)).toBe(1);
      afterSword = await sim.save('C00 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back into Jorrvaskr and down to Skjor's quarters, where Aela waits (C00's 40 put her there).
  // "I have your shield": Skjor and Aela talk the newcomer over (C00AelaSkjorScene), and Aela
  // comes to them: "I don't care for boasting" has her call Farkas to show them their bed
  // (C00AelaSkjorFarkasScene): C00 50.
  it('has the player bring Aela her shield (C00 50)', async () => {
    if (!afterSword) return;
    const sim = await loadSim(afterSword);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      expect(await through(sim, YARD_IN)).toBe(JORRVASKR);
      expect(await through(sim, QUARTERS_DOOR)).toBe(QUARTERS);
      const at = await sim.position(AELA);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(AELA)).toContain('I have your shield.');
      expect(await sim.choose(/I have your shield/)).toEqual([]);
      expect(await sim.runtime.itemCount(PLAYER_REF, STEEL_SHIELD)).toBe(0);
      expect(await sim.listen(AELA, 60)).toContain("I don't care for boasting.");
      expect(lines).toContain('C00AelaSkjorScene: #3 said');
      expect(await sim.choose(/care for boasting/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(C00, 50), 30)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: false });
      afterShield = await sim.save('C00 50');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Farkas shows the newcomer to the whelps' quarters (C00FarkasNarration1 to 4, each waiting for
  // the player to keep up), and welcomes them there: C00 100, PlayerJoin.
  it('has Farkas show the player their quarters (C00 100)', async () => {
    if (!afterShield) return;
    const sim = await loadSim(afterShield);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      for (let leg = 0; leg < 80 && !sim.stageDone(C00, 100); leg++) {
        const at = await sim.position(FARKAS);
        if (at && ((await sim.distance(PLAYER_REF, FARKAS)) ?? 0) > 180) {
          await sim.walkPath(at, 3, 150);
        } else await sim.step(3);
      }
      expect(sim.stageDone(C00, 100)).toBe(true);
      for (const said of ['Narration1', 'Narration2', 'Narration3', 'Narration4']) {
        expect(lines).toContain(`C00Farkas${said}: #${said === 'Narration4' ? 2 : 1} said`);
      }
      await sim.step(1);
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: true });
      expect(
        await sim.runtime.actors.factionRank(PLAYER_REF, COMPANIONS_FACTION),
      ).toBeGreaterThanOrEqual(0);
      // A Companion now: Farkas has work for them. His C00FarkasFGPostTour (while CR04 or CR05
      // runs) greets them with C00FarkasPostJoinBranchTopic: "By the way, if you're looking for
      // something to do." Its info for the running job (CR04's 000F7943, CR05's 000F7942) is an
      // Invisible Continue whose one choice is that job's "I'm looking for work.", taken without
      // the player choosing; Hired Muscle's answer is one too (CR04DoesntMatterNowDoesIt), and
      // its offer is what is listed.
      const offer = sim.runtime.state.quest(CR04).running
        ? ['I can handle that.', "I'd rather not do that."]
        : ['What kind of trouble should I expect?'];
      expect(await sim.listen(FARKAS, 30)).toEqual(expect.arrayContaining(offer));
      sim.goodbye();
    } finally {
      await sim.close();
    }
  }, 600_000);
});
