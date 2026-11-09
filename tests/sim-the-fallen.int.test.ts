// Integration test: MQ301 "The Fallen" on the headless simulation, played through as the player plays
// it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ206 = 0x36193;
const MQ301 = 0x44c56;
const MQ302 = 0x45923;
const MQ303 = 0x46ef0;
/** MQ301's aliases. */
const PAARTHURNAX = 0;
const JARL = 2;
/** The spot on the summit (as in sim-throat-of-the-world), and WhiterunDragonsreach. */
const ON_THE_SUMMIT: Vec3 = [56147, -48664, 36258];
const DRAGONSREACH = 0x165a3;

/** The Shout that calls Odahviing. */
const CALL_SHOUT = 'CallDragonShout';
/** Dragonsreach's door to its porch, the porch's worldspace, the trigger that begins the attack
 * (MQ301StartDragonAttackTrigREF), the scene and the trap's furniture (WhiteRunDragonTrap01). */
const PORCH_DOOR = 0x46b84;
const DRAGONSREACH_WORLD = 0x46033;
const ATTACK_TRIGGER = 0x485cd;
const ATTACK_SCENE = 0x46ef5;
const TRAP = 0xa85c3;
/** MQ301's alias for the dragon. */
const ODAHVIING = 4;

/** The game with the player sent to the Jarl of Whiterun (stage 25). */
let toTheJarl: Uint8Array | undefined;
/** The game with the Shout learned (stage 70). */
let withTheShout: Uint8Array | undefined;
/** The game with the player on the porch, the attack's scene begun (stage 120). */
let onThePorch: Uint8Array | undefined;
/** The game with Odahviing in the trap (stage 200). */
let trapped: Uint8Array | undefined;

/** How far MQ301DragonAttackScene has got, by MQ301Script's count of it. */
async function attackStage(sim: Sim): Promise<number> {
  return Number(
    await sim.runtime.vm.getVariable(
      new ObjectHandle(MQ301, 'mq301script'),
      '::DragonAttackStage_var',
    ),
  );
}

/** The player holds the voice key long enough for all a shout's words, and lets it out. */
async function shoutAll(sim: Sim): Promise<void> {
  sim.press('Shout', true);
  await sim.step(2);
  sim.press('Shout', false);
}

/** How near a flying dragon has to come before the player shouts at him (units). */
const SHOUT_REACH = 2500;

/**
 * The player shouts at a flier as a player does: once their voice is ready again (Dragonrend's
 * three words take 15 s to recover) and they are on their feet, when he comes within
 * SHOUT_REACH, following him with their aim all the while the words are held and let out (the
 * shout leaves along the aim as it is let out: VoiceDragonRendProjectile is a 9° cone at 4000
 * units a second). False, without a shout, if `done` comes first or he does not come near in
 * `seconds`.
 */
async function shoutAt(
  sim: Sim,
  flier: number,
  seconds: number,
  done: () => Promise<boolean>,
): Promise<boolean> {
  const follow = async (): Promise<number> => {
    const [at, me] = await Promise.all([sim.position(flier), sim.position(PLAYER_REF)]);
    if (!at || !me) return Infinity;
    sim.look(at);
    return Math.hypot(at[0] - me[0], at[1] - me[1], at[2] - me[2]);
  };
  const ready = (): boolean =>
    (sim.runtime.state.actors.get(PLAYER_REF)?.voiceRecoveryTime ?? 0) <= 0 &&
    sim.world.play?.held === false;
  for (let waited = 0; !(ready() && (await follow()) < SHOUT_REACH); waited += 0.1) {
    if (waited >= seconds || (await done())) return false;
    await sim.step(0.1);
  }
  sim.press('Shout', true);
  for (let held = 0; held < 2; held += 0.1) {
    await follow();
    await sim.step(0.1);
  }
  sim.press('Shout', false);
  for (let after = 0; after < 1; after += 0.1) {
    await follow();
    await sim.step(0.1);
  }
  return true;
}

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of MQ301 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ301).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())('MQ301 The Fallen', () => {
  // MQ301's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ206 to 240
  // (played in sim-alduins-bane), whose 220 is MQ301's 10. "I need to find out where Alduin went."
  // to Paarthurnax on the summit is 20, the objective to go to the Jarl (25).
  it('has Paarthurnax tell of a dragon to trap (0-25)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ301, 0);
      expect(await sim.until(() => sim.stageDone(MQ301, 10), 180)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ206, 220)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.moveTo(ON_THE_SUMMIT);
      await sim.step(1);
      const paarthurnax = alias(sim, MQ301, PAARTHURNAX);
      expect(await sim.enabled(paarthurnax)).toBe(true);
      const at = await sim.position(paarthurnax);
      expect(at && (await sim.walkPath(at, 60, 600))).toBe(true);
      expect(await sim.talk(paarthurnax)).toEqual(['I defeated Alduin, but he escaped.']);
      expect(await sim.choose(/I defeated Alduin/)).toContain(
        'I need to find out where Alduin went.',
      );
      await sim.choose(/where Alduin went/);
      expect(sim.stageDone(MQ301, 20)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ301, 25)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      toTheJarl = await sim.save('MQ301 25');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The Jarl (in Dragonsreach; the way there is sim-dragon-rising's): "I need to trap a dragon in
  // your palace" is 27; he will not while the war is on: "What if you didn't have to worry about an
  // enemy attack?" is 30, and MQ302 begins.
  it('has the Jarl refuse while the war is on (27-30)', async () => {
    if (!toTheJarl) return;
    const sim = await loadSim(toTheJarl);
    try {
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const jarl = alias(sim, MQ301, JARL);
      const at = await sim.position(jarl);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      const first = await sim.talk(jarl);
      expect(first).toContain('I need your help. I need to trap a dragon in your palace.');
      await sim.choose(/trap a dragon in your palace/);
      expect(sim.stageDone(MQ301, 27)).toBe(true);
      await sim.choose(/You heard right/);
      await sim.choose(/The threat is worse/);
      await sim.choose(/only hopeless if we give up/);
      await sim.choose(/only way to find Alduin/);
      await sim.choose(/worry about an enemy attack/);
      expect(sim.stageDone(MQ301, 30)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      expect(objective(sim, 25)).toEqual({ displayed: true, completed: false });
      expect(sim.stage(MQ302)).toBe(10);
      expect(sim.isRunning(MQ302)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back from the peace council (MQ302's end, played in sim-season-unending, is set here: its 350
  // is this quest's 40, 50). Paarthurnax on the summit gives the dragon's name, and the Shout that
  // calls it (70).
  it('has Paarthurnax teach the player to call Odahviing (40-70)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ302, 0);
      expect(await sim.until(() => sim.stageDone(MQ302, 10), 180)).toBe(true);
      await sim.step(1);
      void sim.runtime.quests.setStage(MQ302, 350);
      expect(await sim.until(() => sim.stageDone(MQ301, 50), 30)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      await sim.moveTo(ON_THE_SUMMIT);
      await sim.step(1);
      const paarthurnax = alias(sim, MQ301, PAARTHURNAX);
      const at = await sim.position(paarthurnax);
      expect(at && (await sim.walkPath(at, 60, 600))).toBe(true);
      const call = await sim.runtime.casting.shout(await sim.formId('SHOU', CALL_SHOUT));
      expect(call).toBeDefined();
      if (!call) return;
      expect(sim.runtime.casting.wordsKnown(PLAYER_REF, call)).toBe(0);
      expect(await sim.talk(paarthurnax)).toContain(
        'I need a way to lure a dragon to Dragonsreach. Any ideas?',
      );
      await sim.choose(/lure a dragon/);
      await sim.choose(/we know his name/);
      await sim.choose(/come when called/);
      sim.goodbye();
      await sim.step(2);
      expect(sim.stageDone(MQ301, 70)).toBe(true);
      expect(sim.runtime.casting.wordsKnown(PLAYER_REF, call)).toBe(3);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: false });
      expect(sim.stage(MQ302)).toBeGreaterThanOrEqual(310);
      withTheShout = await sim.save('MQ301 70');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The Jarl, in Dragonsreach: "I'm ready. Let's go trap a dragon." is 120, and his men take their
  // places. Out on the porch the trigger begins MQ301DragonAttackScene.
  it('has the Jarl ready his men, and the player go out on the porch (120)', async () => {
    if (!withTheShout) return;
    const sim = await loadSim(withTheShout);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const jarl = alias(sim, MQ301, JARL);
      const at = await sim.position(jarl);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(jarl)).toContain('Are you ready to spring the trap on the dragon?');
      await sim.choose(/ready to spring the trap/);
      await sim.choose(/I'm ready/);
      sim.goodbye();
      await sim.step(2);
      expect(sim.stageDone(MQ301, 120)).toBe(true);
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: false });
      const door = await sim.position(PORCH_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(PORCH_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(DRAGONSREACH_WORLD);
      const trigger = await sim.position(ATTACK_TRIGGER);
      expect(trigger && (await sim.walkPath(trigger, 30, 60))).toBe(true);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(ATTACK_SCENE), 10)).toBe(true);
      expect(await attackStage(sim)).toBe(1);
      expect(await sim.enabled(alias(sim, MQ301, ODAHVIING))).toBe(false);
      onThePorch = await sim.save('MQ301 120');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The Shout calls him (150, the attack's stage 2): he comes over the walls, takes a soldier in his
  // talons on the way in (the flight grab) and fights (3). Dragonrend, each time it reaches him,
  // brings him down (the player shouts it at him as he comes near, aiming at him while the words
  // are held: a shout aimed where he was two seconds before reached him only by chance, and
  // whether the fight's turns brought him back there changed with any change to who goes where
  // on the porch), and on the ground he comes for the player into the trap at the porch's end
  // (5: 180; "Now! Quickly!"): the trap holds him, and he speaks to the player (200).
  it('has the player call Odahviing and bring him down into the trap (150-200)', async () => {
    if (!onThePorch) return;
    const sim = await loadSim(onThePorch);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const said = (action: number): boolean =>
        lines.includes(`MQ301DragonAttackScene: #${action} said`);
      const odahviing = alias(sim, MQ301, ODAHVIING);
      expect(await sim.equip(await sim.formId('SHOU', CALL_SHOUT))).toBe(true);
      await sim.step(1);
      await shoutAll(sim);
      expect(await sim.until(() => sim.stageDone(MQ301, 150), 15)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 50)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 60)).toEqual({ displayed: true, completed: false });
      expect(await sim.enabled(odahviing)).toBe(true);
      for (let second = 0; second < 60 && (await attackStage(sim)) < 3; second++) await sim.step(1);
      expect(await attackStage(sim)).toBe(3);
      expect(said(37)).toBe(true);
      expect(await sim.equip(await sim.formId('SHOU', 'DragonrendShout'))).toBe(true);
      const down = async (): Promise<boolean> => (await attackStage(sim)) >= 4;
      for (let shouts = 0; shouts < 10 && !(await down()); shouts++) {
        if (!(await shoutAt(sim, odahviing, 60, down))) break;
      }
      expect(await attackStage(sim)).toBeGreaterThanOrEqual(4);
      expect(await sim.until(() => sim.stageDone(MQ301, 180), 120)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ301, 200), 60)).toBe(true);
      await sim.step(1);
      expect(said(7)).toBe(true);
      expect(sim.package(odahviing)?.procedure).toBe('Sit');
      expect(await sim.distance(odahviing, TRAP)).toBeLessThan(300);
      expect(objective(sim, 60)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 70)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      trapped = await sim.save('MQ301 200');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // In the trap he speaks (the scene's last phases), and greets the player as they come up. What he
  // knows is 220: MQ303 begins, and this quest has done its job; his price, the player's word to
  // set him free, is 230, MQ303's 20.
  it('has Odahviing tell of Skuldafn for his freedom (220-230)', async () => {
    if (!trapped) return;
    const sim = await loadSim(trapped);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const odahviing = alias(sim, MQ301, ODAHVIING);
      const inScene = (line: string): boolean => lines.includes('MQ301DragonAttackScene: ' + line);
      expect(await sim.until(() => inScene('phase 18'), 90)).toBe(true);
      expect(inScene('#13 said')).toBe(true);
      const at = await sim.position(odahviing);
      expect(at && (await sim.walkPath(at, 30, 500))).toBe(true);
      expect(await sim.listen(odahviing, 60)).toEqual(["That's right. Where is he hiding?"]);
      await sim.choose(/Where is he hiding/);
      await sim.choose(/telling me where to find Alduin/);
      await sim.choose(/Not until Alduin is defeated/);
      expect(sim.stageDone(MQ301, 220)).toBe(false);
      await sim.choose(/Tell me what you know/);
      expect(sim.stageDone(MQ301, 220)).toBe(true);
      await sim.choose(/set you free if you promise/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MQ301, 230), 5)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 70)).toEqual({ displayed: true, completed: true });
      expect(sim.stageDone(MQ303, 10)).toBe(true);
      expect(sim.stageDone(MQ303, 20)).toBe(true);
      expect(sim.isRunning(MQ303)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
