// Integration test: MG01 "First Lessons" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { alias, approachAndTalk, follow, goThrough, objective } from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MG01 = 0x1f251;
const MG02 = 0x1f252;
/** MG01's Faralda, gate stone, Mirabelle and Tolfdir aliases. */
const FARALDA = 11;
const GATE_STONE = 6;
const MIRABELLE = 0;
const TOLFDIR = 2;
/** WinterholdMapMarker and where MG01's start puts Faralda (MG01NiryaWaitMarker). */
const WINTERHOLD_MARKER = 0x177ef;
const FARALDA_WAITS = 0x379ef;
/** The College's gate and the door to the Hall of the Elements from the courtyard. */
const COLLEGE_GATE = 0x37a7d;
const HALL_OF_THE_ELEMENTS_DOOR = 0x177f9;
const GOLD = 0xf;
/** Where Tolfdir has the player stand for the ward lesson (MG01PlayerCastMarker). */
const CAST_MARKER = 0xf9363;
/** The ward he teaches (WardLesser, "Lesser Ward"). */
const LESSER_WARD = 0x13018;
/** The fire of the Firebolt he casts at the player (MG01FireDamageFFAimed). */
const TEACHING_FIRE = 0x9152e;
/** The spells of the test, by MG01's objective that asks for each. */
const TEST_SPELLS: Readonly<Record<number, string>> = {
  20: 'MagelightSpell',
  21: 'ConjureFlameAtronach',
  22: 'Firebolt',
  23: 'Fear',
  24: 'HealingHands',
};

/** The game with the player at the College's gate, admitted (MG01 30). */
let admitted: Uint8Array | undefined;
/** The game after Mirabelle's tour (MG01 50). */
let toured: Uint8Array | undefined;

/** The objective of MG01's test shown in the journal now. */
function testObjective(sim: Sim): number | undefined {
  for (const [id, state] of sim.runtime.state.quest(MG01).objectives) {
    if (id >= 20 && id <= 24 && state.displayed && !state.completed) return id;
  }
  return undefined;
}

describe.skipIf(!hasGamedata())('MG01 First Lessons', () => {
  // To Winterhold and the foot of the College's bridge. Faralda greets the player: what the College
  // is, whether they may enter, why ("ice and fire"), and her test: a spell of the school she names,
  // sold for 30 gold if the player does not know it, cast as she asks (at the gate's stone, or on
  // her for Healing Hands). Passed, she comes to say so: MG01 30, and she leads the way over.
  it('has Faralda test the player and let them in (MG01 30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      // The gold the player has come by on the way (her spell costs 30).
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(GOLD), 100, true);
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      const faralda = alias(sim, MG01, FARALDA);
      expect(await sim.distance(faralda, FARALDA_WAITS)).toBeLessThan(200);
      expect(await approachAndTalk(sim, faralda)).toContain('What is this place?');
      await sim.choose(/What is this place/);
      await sim.choose(/May I enter/);
      await sim.choose(/ice and fire/);
      await sim.choose(/take your test/);
      await sim.choose(/don't know/);
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      expect(await sim.choose(/Give 30 gold/)).toEqual([]);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBe(gold - 30);
      const asked = testObjective(sim);
      expect(asked).toBeDefined();
      if (asked === undefined) return;
      const spell = await sim.formId('SPEL', TEST_SPELLS[asked] ?? '');
      expect(await sim.runtime.actors.hasSpell(PLAYER_REF, spell)).toBe(true);
      expect(await sim.equip(spell)).toBe(true);
      const target = asked === 24 ? faralda : alias(sim, MG01, GATE_STONE);
      const aim = await sim.position(target);
      expect(aim).toBeDefined();
      if (aim) sim.look([aim[0], aim[1], aim[2] + 60]);
      await sim.step(0.5);
      await sim.attack(asked === 24 ? 3 : 1);
      expect(sim.stageDone(MG01, 30)).toBe(false);
      await sim.listen(faralda, 30);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG01, 30), 30)).toBe(true);
      // The gate swings open (Fragment_13's SetOpen).
      expect(sim.openState(COLLEGE_GATE)).not.toBe(3);
      admitted = await sim.save('MG01 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Faralda's Escort over the bridge, through the gate she opened, to the Hall of the Elements;
  // inside, Mirabelle Ervine: "I was told to come see you" (MG01 40: the College's robes), and
  // her tour ("I'd love to have a look around"): the Hall of Attainment, the player's quarters,
  // and back to the Hall of the Elements, where Tolfdir's class has begun (50).
  it('has Mirabelle take the player on her tour (MG01 40-50)', async () => {
    if (!admitted) return;
    const sim = await loadSim(admitted);
    try {
      const faralda = alias(sim, MG01, FARALDA);
      await sim.step(1);
      expect(sim.package(faralda)?.procedure).toBe('Escort');
      const hall = await sim.position(HALL_OF_THE_ELEMENTS_DOOR);
      expect(hall && (await sim.walkPath(hall, 150, 200))).toBe(true);
      expect(sim.openState(COLLEGE_GATE)).toBe(1);
      // She waits in the courtyard, before the statue.
      const mirabelle = alias(sim, MG01, MIRABELLE);
      expect(await approachAndTalk(sim, mirabelle)).toContain('I was told to come see you.');
      await sim.choose(/told to come see you/);
      expect(sim.stageDone(MG01, 40)).toBe(false);
      await sim.choose(/love to have a look around/);
      sim.goodbye();
      expect(sim.stageDone(MG01, 40)).toBe(true);
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      expect(await follow(sim, mirabelle, () => sim.stageDone(MG01, 50), 900)).toBe(true);
      // The way went through the Hall of Attainment to the player's quarters and back out.
      expect(lines).toContain('MG01TourScene: phase 10 completes');
      expect(objective(sim, MG01, 50)).toEqual({ displayed: true, completed: false });
      toured = await sim.save('MG01 50');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // Into the Hall of the Elements, where Tolfdir lectures the new Apprentices (Onmund, Brelyna,
  // J'zargo) on safety; asked, the player gives their opinion. Then wards: he teaches Lesser Ward
  // if the player has none, has them stand on their mark and hold it up while he casts at them
  // (MG01WardScene), and sends the class to Saarthal (200; MG02 starts). Found 2026-11-18: his
  // Firebolt (MG01TeachFirebolt) is detrimental, not hostile, and the ward let it through: the
  // lesson took the fire on the player as a failed one and began again without end.
  it("has Tolfdir's first lesson end with Saarthal (MG01 200)", async () => {
    if (!toured) return;
    const sim = await loadSim(toured);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      expect(await goThrough(sim, HALL_OF_THE_ELEMENTS_DOOR)).toBe(true);
      const tolfdir = alias(sim, MG01, TOLFDIR);
      const answers = [/Safety should be/, /learning about Wards/, /don't know any Ward/];
      const asked: string[] = [];
      for (let turn = 0; turn < 12 && !lines.includes('MG01WardScene: #6 said'); turn++) {
        const near = await sim.position(tolfdir);
        if (near) await sim.walkPath(near, 30, 250);
        let topics = await sim.listen(undefined, 30);
        while (topics && topics.length > 0) {
          const answer = answers.find((each) => topics?.some((topic) => each.test(topic)));
          if (!answer) break;
          asked.push(String(answer));
          topics = await sim.choose(answer);
        }
        sim.goodbye();
      }
      expect(asked).toEqual([String(answers[0]), String(answers[2])]);
      const learned = sim.events('spellsLearned').map((each) => each.spell);
      expect(learned).toEqual([LESSER_WARD]);
      // On the mark, the ward raised toward him and held while he casts at the player.
      const mark = await sim.position(CAST_MARKER);
      expect(mark && (await sim.walkPath(mark, 30, 40))).toBe(true);
      expect(await sim.equip(LESSER_WARD)).toBe(true);
      const at = await sim.position(tolfdir);
      if (at) sim.look([at[0], at[1], at[2] + 100]);
      await sim.step(0.5);
      await sim.attack(10);
      // His Firebolt taken by the ward (OnWardHit, absorbed), its fire kept off the player: the
      // lesson passed ("Excellent work!": the last phase).
      const fromTolfdir = sim.events('magicWardHit').filter((hit) => hit.caster === tolfdir);
      expect(fromTolfdir.length).toBeGreaterThan(0);
      expect(fromTolfdir.every((hit) => hit.status === 1)).toBe(true);
      const burned = sim
        .events('magicEffectApply')
        .filter((each) => each.target === PLAYER_REF && each.effect === TEACHING_FIRE);
      expect(burned).toEqual([]);
      expect(lines).toContain('MG01WardScene: phase 4 skipped');
      expect(lines).toContain('MG01WardScene: phase 5 completes');
      expect(await sim.until(() => sim.stageDone(MG01, 200), 120)).toBe(true);
      await sim.step(1);
      expect(sim.isRunning(MG01)).toBe(false);
      expect(sim.isRunning(MG02)).toBe(true);
      expect(sim.stageDone(MG02, 10)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 1_200_000);
});
