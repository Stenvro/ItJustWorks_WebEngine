// Integration test: MQ206 "Alduin's Bane" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ204 = 0x2d515;
const MQ205 = 0x2d516;
const MQ206 = 0x36193;
const MQ301 = 0x44c56;
/** The spot on the way to the summit's Time-Wound (as in sim-throat-of-the-world), the Elder Scroll,
 * the Time-Wound's trigger and where the scroll puts the player (MQ206PlayerStartMarker). */
const ON_THE_SUMMIT: Vec3 = [56147, -48664, 36258];
const ELDER_SCROLL = 0x2d513;
const TIME_WOUND_TRIGGER = 0x64769;
const PLAYER_START = 0x43786;
/** MQ206BattleScene, MQ206PresentDayScene. */
const BATTLE_SCENE = 0x44241;
const PRESENT_SCENE = 0x4496d;
/** MQ206's aliases: the dragon Gormlaith kills, Gormlaith, Felldir, Hakon, the ancient Alduin, the
 * present one, Paarthurnax. */
const DRAGON = 55;
const GORMLAITH = 58;
const FELLDIR = 59;
const HAKON = 60;
const ANCIENT_ALDUIN = 57;
const ALDUIN = 61;
const PAARTHURNAX = 62;
const ALDUIN_LANDS = 67;
/** The middle of the place his force greet asks the player to be in (its package's), its radius. */
const PAARTHURNAX_GREETS = 0x9c21f;
const GREET_RADIUS = 1800;

/** The game with the player at the Time-Wound, the scroll in the pack. */
let atTheWound: Uint8Array | undefined;
/** The game in the past, Gormlaith to fall (stage 80). */
let inThePast: Uint8Array | undefined;
/** The game back in the present (stage 100). */
let inThePresent: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of MQ206 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ206).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The player holds the voice key long enough for all a shout's words, and lets it out. */
async function shoutAll(sim: Sim): Promise<void> {
  sim.press('Shout', true);
  await sim.step(2);
  sim.press('Shout', false);
}

describe.skipIf(!hasGamedata())("MQ206 Alduin's Bane", () => {
  // MQ206's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ205 to 100
  // (played in sim-elder-knowledge) and whose 100 is MQ206's 10, with the scroll in the pack. The
  // climb is not played again: sim-throat-of-the-world plays it, and the skip leaves the gate's wind
  // up, as it has not heard Clear Skies, so the player is put on the summit.
  // Paarthurnax, on his perch, greets them as they come near (MQ206PaarthurnaxForceGreet while
  // under 15): his "You have it" is 15, MQ204's end.
  it('has the player bring the Elder Scroll to the summit (0-15)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ206, 0);
      expect(await sim.until(() => sim.stageDone(MQ206, 10), 180)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ205, 100)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, ELDER_SCROLL)).toBe(1);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      expect(await sim.enabled(TIME_WOUND_TRIGGER)).toBe(true);
      await sim.moveTo(ON_THE_SUMMIT);
      await sim.step(1);
      const paarthurnax = alias(sim, MQ206, PAARTHURNAX);
      expect(await sim.enabled(paarthurnax)).toBe(true);
      const perch = await sim.position(PAARTHURNAX_GREETS);
      expect(perch && (await sim.walkPath(perch, 60, GREET_RADIUS - 100))).toBe(true);
      expect(await sim.listen(paarthurnax, 60)).toBeDefined();
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ206, 15)).toBe(true);
      expect(sim.stageDone(MQ204, 220)).toBe(true);
      expect(sim.isRunning(MQ204)).toBe(false);
      const wound = await sim.position(TIME_WOUND_TRIGGER);
      expect(wound && (await sim.walkPath(wound, 60, 100))).toBe(true);
      atTheWound = await sim.save('MQ206 15');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Read at the Time-Wound (MQ206TimeWoundTriggerScript, as the scroll is read in its trigger), the
  // scroll is 20: the player stands in the past, watching (controls off, a ghost), and
  // MQ206BattleScene runs. Hakon crossing the trigger on his way (MQ206SetStage32: he is placed
  // disabled, and comes from where he is placed) wakes the dragon; Gormlaith kills it; Alduin comes
  // (60), shouts from the perch at Felldir (the scene's 144), the heroes answer with Dragonrend, the
  // player learns it (70) and Alduin comes down (75); Gormlaith can die from 80.
  it('has the Elder Scroll take the player into the past, to learn Dragonrend (20-80)', async () => {
    if (!atTheWound) return;
    const sim = await loadSim(atTheWound);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const said = (action: number): boolean =>
        lines.includes(`MQ206BattleScene: #${action} said`);
      const dragonrend = await sim.runtime.casting.shout(await sim.formId('SHOU', 'DragonrendShout'));
      expect(dragonrend).toBeDefined();
      if (!dragonrend) return;
      expect(sim.runtime.casting.wordsKnown(PLAYER_REF, dragonrend)).toBe(0);
      expect(await sim.readFromInventory(ELDER_SCROLL)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 30), 30)).toBe(true);
      await sim.step(1);
      expect(sim.runtime.scenes.isPlaying(BATTLE_SCENE)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.distance(PLAYER_REF, PLAYER_START)).toBeLessThan(300);
      expect(await sim.enabled(alias(sim, MQ206, PAARTHURNAX))).toBe(false);
      for (const hero of [GORMLAITH, FELLDIR, HAKON]) {
        expect(await sim.enabled(alias(sim, MQ206, hero))).toBe(true);
      }
      expect(await sim.until(() => sim.stageDone(MQ206, 32), 60)).toBe(true);
      await sim.step(1);
      expect(await sim.enabled(alias(sim, MQ206, DRAGON))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 40), 60)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 42), 60)).toBe(true);
      expect(sim.actor(alias(sim, MQ206, DRAGON))?.dead).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 60), 180)).toBe(true);
      expect(await sim.enabled(alias(sim, MQ206, ANCIENT_ALDUIN))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 70), 60)).toBe(true);
      await sim.step(1);
      expect(lines).toContain('MQ206BattleScene: #144 package done');
      expect(sim.runtime.casting.wordsKnown(PLAYER_REF, dragonrend)).toBe(3);
      expect(await sim.until(() => sim.stageDone(MQ206, 80), 90)).toBe(true);
      expect(said(61)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      inThePast = await sim.save('MQ206 80');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Alduin bites Gormlaith, who has no more health than the one she was left at 82 (the UseWeapon
  // template's heroes come on with the weapons they carry: Allow Already Held), and her dying is
  // 85. His own graph goes on from the bite (its PairEnd). Felldir reads the scroll (88), Hakon
  // falls (87) and Alduin is gone (90); the scene's end is 100, the player back at the Time-Wound
  // with Dragonrend and Alduin coming.
  it('has the heroes fall and cast Alduin out, and brings the player back (82-100)', async () => {
    if (!inThePast) return;
    const sim = await loadSim(inThePast);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const said = (action: number): boolean =>
        lines.includes(`MQ206BattleScene: #${action} said`);
      expect(await sim.until(() => sim.stageDone(MQ206, 82), 60)).toBe(true);
      await sim.step(1);
      const gormlaith = alias(sim, MQ206, GORMLAITH);
      const ancient = alias(sim, MQ206, ANCIENT_ALDUIN);
      expect(await sim.runtime.actors.isEssential(gormlaith)).toBe(false);
      expect(await sim.until(() => sim.stageDone(MQ206, 85), 60)).toBe(true);
      expect(await sim.runtime.actors.isDead(gormlaith)).toBe(true);
      expect(sim.deaths().at(-1)?.killer).toBe(ancient);
      await sim.step(2);
      expect(sim.actor(ancient)?.placed.behavior?.synchronizedClip()).toBeUndefined();
      expect(await sim.until(() => sim.stageDone(MQ206, 88), 60)).toBe(true);
      expect(said(28)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 90), 90)).toBe(true);
      expect(sim.stageDone(MQ206, 87)).toBe(true);
      expect(said(116)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 100), 60)).toBe(true);
      await sim.step(3);
      expect(said(33)).toBe(true);
      expect(said(99)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(BATTLE_SCENE)).toBe(false);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(PRESENT_SCENE), 30)).toBe(true);
      for (const hero of [GORMLAITH, FELLDIR, HAKON]) {
        expect(await sim.enabled(alias(sim, MQ206, hero))).toBe(false);
      }
      expect(await sim.enabled(alias(sim, MQ206, ALDUIN))).toBe(true);
      expect(await sim.enabled(alias(sim, MQ206, PAARTHURNAX))).toBe(true);
      expect(await sim.distance(PLAYER_REF, TIME_WOUND_TRIGGER)).toBeLessThan(300);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      inThePresent = await sim.save('MQ206 100');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // MQ206PresentDayScene: Alduin and Paarthurnax trade words (120, 140) and take to the air. The
  // player's Dragonrend, once it reaches him (MQ206AlduinScript's OnMagicEffectApply), is 180, and it
  // brings him down. The player's blows land on him there; `fendOff`'s kin stands in for the rest
  // of a fight the first level's fists do not win: what is left of his health is taken by the
  // player's hand. Essential, he bleeds out (200); he says his last and is gone (230, and 220: MQ301
  // begins); his way out over the mountains ends at 240.
  it('has the player bring Alduin down with Dragonrend, and he escapes (120-240)', async () => {
    if (!inThePresent) return;
    const sim = await loadSim(inThePresent);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const said = (action: number): boolean =>
        lines.includes(`MQ206PresentDayScene: #${action} said`);
      const alduin = alias(sim, MQ206, ALDUIN);
      expect(await sim.equip(await sim.formId('SHOU', 'DragonrendShout'))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 120), 60)).toBe(true);
      expect(said(3)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 140), 60)).toBe(true);
      expect(said(14)).toBe(true);
      expect(sim.stageDone(MQ206, 180)).toBe(false);
      let shouts = 0;
      for (; shouts < 30 && !sim.stageDone(MQ206, 180); shouts++) {
        const at = await sim.position(alduin);
        expect(at).toBeDefined();
        if (!at) return;
        sim.look(at);
        await sim.step(0.2);
        await shoutAll(sim);
        await sim.step(3);
      }
      expect(sim.stageDone(MQ206, 180)).toBe(true);
      expect(await sim.until(() => sim.world.stage.flight.state(alduin) === 0, 60)).toBe(true);
      // On his forced landing marker (the script's, as his Dragonrend brings him down).
      expect(await sim.distance(alduin, alias(sim, MQ206, ALDUIN_LANDS))).toBeLessThan(100);
      expect(said(8)).toBe(true);
      const before = (await sim.runtime.actors.value(alduin, ActorValue.health)).current;
      await sim.attack(0.1);
      let landed = false;
      for (let swing = 0; swing < 6 && !landed; swing++) {
        ({ landed } = await sim.swingAt(alduin, 150));
      }
      expect(landed).toBe(true);
      const left = (await sim.runtime.actors.value(alduin, ActorValue.health)).current;
      expect(left).toBeLessThan(before);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      await sim.runtime.actors.damage(alduin, ActorValue.health, left, PLAYER_REF);
      expect(await sim.until(() => sim.stageDone(MQ206, 200), 30)).toBe(true);
      expect(await sim.runtime.actors.isDead(alduin)).toBe(false);
      expect(await sim.until(() => sim.stageDone(MQ206, 230), 60)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 220), 30)).toBe(true);
      await sim.step(1);
      expect(said(12)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(sim.stage(MQ301)).toBe(10);
      expect(sim.isRunning(MQ301)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ206, 240), 180)).toBe(true);
      await sim.step(1);
      expect(await sim.enabled(alduin)).toBe(false);
      expect(sim.isRunning(MQ206)).toBe(false);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
