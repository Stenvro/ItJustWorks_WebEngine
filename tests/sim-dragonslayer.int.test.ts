// Integration test: MQ305 "Dragonslayer" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left): out of the Hall
// of Valor with the three heroes, the mist cleared with Clear Skies, Alduin's fight, his death, and
// Tsun's Shout back to Skyrim. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { ActorValue } from '../src/world/actor-values.ts';
import type { Arrival } from '../src/world/worldspace.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ304 = 0x46ef1;
const MQ305 = 0x46ef2;
/** Sovngarde's worldspace and Tamriel's. */
const SOVNGARDE = 0x2ee41;
const TAMRIEL = 0x3c;
/** The Hall of Valor, MQ304's trigger by the three heroes (MQ304SetStage180, where MQ304 ends),
 * and the hall's door out. */
const HALL = 0x95c44;
const HEROES_TRIGGER = 0xec3a7;
const HALL_EXIT = 0x22f00;
/** MQ305SetStage12 (in the hall, by its doors) and MQ305SetStage15 (outside, on the way). */
const STAGE_12_TRIGGER = 0xec3af;
const STAGE_15_TRIGGER = 0x98bc9;
/** MQ305Script's ShoutBattleMarker (MQ305Hero2ShoutMarker: the ShoutTarget alias). */
const SHOUT_BATTLE_MARKER = 0x503a7;
/** A bank of the mist before the heroes' line (MQSovngardeFog974cc). */
const MIST = 0x974cc;
/** MQ305's aliases. */
const GORMLAITH = 0;
const FELLDIR = 1;
const HAKON = 2;
const ALDUIN = 3;
const TSUN = 5;
/** The scene of the mist and the one after Alduin's death. */
const INTRO = 'MQ305IntroScene';
const OUTRO = 'MQ305OutroScene';
const INTRO_SCENE = 0x503b2;
const OUTRO_SCENE = 0x5195c;
/** The faction FXAlduinScript puts him in as his soul is torn from him. */
const MQ_KILL_DRAGON_FACTION = 0x35d62;
const MQ306 = 0x46ef3;

/** The game outside the hall, the heroes at their line (stage 30). */
let atTheLine: Uint8Array | undefined;
/** The game with the mist cleared and Alduin come (stage 140). */
let alduinComes: Uint8Array | undefined;
/** The game with Alduin dead and the quest complete (stage 200). */
let alduinFallen: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(MQ305).aliases.get(id) ?? 0;
}

/** An objective of MQ305 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ305).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The player's Shout, held for all of its words. */
async function shoutAll(sim: Sim): Promise<void> {
  sim.press('Shout', true);
  await sim.step(1.2);
  sim.press('Shout', false);
}

/** MQ305Script's count of the player's Clear Skies at the mist (since Alduin last restored it). */
async function mistClearCount(sim: Sim): Promise<number> {
  return Number(
    await sim.runtime.vm.getVariable(
      new ObjectHandle(MQ305, 'mq305script'),
      '::MistClearCount_var',
    ),
  );
}

describe.skipIf(!hasGamedata())('MQ305 Dragonslayer', () => {
  // MQ305's own start for a game that skips ahead: its stage 0 sets 1, which teaches Lok (Clear
  // Skies' first word) and plays MQ304 to 200 (played in sim-sovngarde, up to the heroes in the
  // hall), whose 200 is this quest's 10: MQ305IntroScene begins, Gormlaith calls the heroes to
  // battle. The skip plays every earlier quest's stages too; once those have run the player is put
  // where MQ304 ends, in the hall by the three heroes (MQ304SetStage180). The skip sets MQ304's
  // stages up to 200 but none of the hall's triggers': MQ304SetStage160 (no prerequisite) lies
  // across the hall's way in, before its doors, and would start MQ304HallofValorScene (its 200,
  // which stops it, past), which would take the heroes back into the hall as MQ305IntroScene lets
  // them go. In the game it is long done by now; the player keeps to the doors' near side here.
  // MQ304's own skip (stage 0) would leave its 150 undone, Tsun's leave to cross the bridge
  // outside, whose trigger kills the player who comes out of the hall without it. By the doors
  // MQ305SetStage12 (12) sends the heroes out; outside, MQ305SetStage15 (15) to their places in
  // the line; the scene's end of that is 20, and the player near the line (MQ305Script's
  // OnUpdate: within 1000 of the ShoutBattleMarker) is 30.
  it('has the heroes go out to their line, the player following (0-30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      void sim.runtime.quests.setStage(MQ305, 0);
      expect(await sim.until(() => sim.stageDone(MQ305, 10), 120)).toBe(true);
      const byTheHeroes = await sim.position(HEROES_TRIGGER);
      expect(byTheHeroes).toBeDefined();
      if (!byTheHeroes) return;
      // On the hall's floor (the trigger's middle is 121 units over it).
      const arrival: Arrival = {
        position: [byTheHeroes[0], byTheHeroes[1], byTheHeroes[2] - 121],
        heading: Math.PI,
      };
      // The earlier quests' stages move the player through their places as they run (MQ102's
      // put them by Helgen, among the fight there); each time, they are put back in the hall.
      await sim.openInterior(HALL, arrival);
      let settled = false;
      for (let second = 0; second < 300 && !settled; second++) {
        settled = await sim.until(
          () =>
            sim.stageDone(MQ304, 200) &&
            !sim.runtime.vm.pendingThreads().some((thread) => /QF_/i.test(thread.where)),
          1,
        );
        if ((await sim.runtime.placement(PLAYER_REF))?.cell !== HALL) {
          await sim.openInterior(HALL, arrival);
        }
      }
      expect(settled).toBe(true);
      expect(lines).toContain(`${INTRO}: #50 said`);
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HALL);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      // The skip sets this quest's 10 (Alduin's alias TryToDisable) before MQ304's 5 (its own
      // alias's TryToEnable, for the valley), and their fragments run in either order: he is
      // put away as this quest's 10 means him to be until its 120 brings him to the battle.
      const alduin = alias(sim, ALDUIN);
      if (await sim.enabled(alduin)) {
        await sim.native(sim.runtime.referenceHandle(alduin), 'ObjectReference', 'Disable', [
          false,
        ]);
      }
      expect(await sim.enabled(alduin)).toBe(false);
      const doors = await sim.position(STAGE_12_TRIGGER);
      expect(doors).toBeDefined();
      if (!doors) return;
      // The trigger's half nearer the hall (it reaches 275 units either side of its middle;
      // MQ304SetStage160 begins 256 units short of it towards the doors).
      await sim.walkPath([doors[0], doors[1] + 150, doors[2]], 60, 100);
      expect(await sim.until(() => sim.stageDone(MQ305, 12), 3)).toBe(true);
      expect(sim.stageDone(MQ304, 160)).toBe(false);
      expect(sim.activate(HALL_EXIT)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(SOVNGARDE);
      const outside = await sim.position(STAGE_15_TRIGGER);
      expect(outside && (await sim.walkPath(outside, 90, 100))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ305, 15), 5)).toBe(true);
      // The heroes at their markers in the line (the scene's travel packages done) is 20.
      expect(await sim.until(() => sim.stageDone(MQ305, 20), 90)).toBe(true);
      for (const hero of [GORMLAITH, FELLDIR, HAKON]) {
        expect(lines, `hero ${String(hero)}`).toContain(
          `${INTRO}: #${String(hero + 1)} package done`,
        );
      }
      const line = await sim.position(SHOUT_BATTLE_MARKER);
      expect(line && (await sim.walkPath(line, 60, 400))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ305, 30), 5)).toBe(true);
      expect(await sim.until(() => lines.includes(`${INTRO}: #11 said`), 15)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      atTheLine = await sim.save('MQ305 30');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // "Clear Skies - combine our Shouts!": the player's Clear Skies at the mist (a bank's
  // MQSovngardeShoutTrigger OnHit: MQ305Script's IncrementShoutCount) and the heroes answer with
  // theirs (their Shout packages), 60; Alduin restores it (ClearShoutCount: the banks' activate
  // parent turns them on again) and they call for another. Three times: 60, 80 and 100 (the hall's
  // doors locked, "Defeat Alduin"), and with the mist gone Alduin comes (120: he is enabled at his
  // battle marker, no longer essential but protected, his landing marker forced); 140 the last of
  // the mist goes.
  it('has the player and the heroes clear the mist with Clear Skies (30-140)', async () => {
    if (!atTheLine) return;
    const sim = await loadSim(atTheLine);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      expect(await sim.equip(await sim.formId('SHOU', 'ClearSkiesShout'))).toBe(true);
      const mist = await sim.position(MIST);
      expect(mist).toBeDefined();
      if (!mist) return;
      /** The scene waits for the player's Shout (its phases "Pause to wait for player to shout",
       * "Loop until player shouts", "Wait for player to shout at mist", and the third such). */
      const waiting = (): boolean =>
        /phase (9|10|16|23)\b/.test(
          lines.filter((line) => line.startsWith(`${INTRO}: phase `)).at(-1) ?? '',
        );
      const rounds: number[] = [];
      for (const stage of [60, 80, 100]) {
        expect(await sim.until(waiting, 120), `waiting for ${String(stage)}`).toBe(true);
        expect(await mistClearCount(sim)).toBe(0);
        let shouts = 0;
        for (; shouts < 4 && !sim.stageDone(MQ305, stage); shouts++) {
          sim.look(mist);
          await sim.step(0.2);
          await shoutAll(sim);
          // A Shout's cooldown (Clear Skies' three words) before the next one, if needed.
          await sim.until(() => sim.stageDone(MQ305, stage), 15);
        }
        rounds.push(shouts);
        expect(sim.stageDone(MQ305, stage), `stage ${String(stage)}`).toBe(true);
      }
      expect(rounds.every((shouts) => shouts >= 1)).toBe(true);
      // The heroes' Clear Skies each time (the scene's Shout packages: phases 11, 17 and 24).
      for (const action of [33, 34, 35, 36, 38, 40, 37, 39, 41]) {
        expect(lines, `#${String(action)}`).toContain(`${INTRO}: #${String(action)} package done`);
      }
      // 100's fragment completes the first objective and shows the second.
      expect(await sim.until(() => objective(sim, 20).displayed, 5)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ305, 120), 15)).toBe(true);
      const alduin = alias(sim, ALDUIN);
      // 120's fragment moves him to his battle marker first, then enables him.
      let come = false;
      for (let second = 0; second < 10 && !come; second++) {
        await sim.step(1);
        come = await sim.enabled(alduin);
      }
      expect(come).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ305, 140), 30)).toBe(true);
      expect(sim.world.stage.flight.isFlying(alduin)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      alduinComes = await sim.save('MQ305 140');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Alduin fights them all from the air (MQ304AlduinFaction names the heroes' faction an enemy,
  // and they his: a faction both are in, FavorExcludedFaction, does not make them allies). The
  // player's Dragonrend brings him down (MQAlduinIgnoreDragonrend is 0 since 120); there the
  // player's blow lands. Protected, he dies only by the player's hand; the rest of a fight that a
  // first level's fists do not win stands in as one blow of theirs for what is left of his health
  // (TODO(M13): the player's own blows). His death (the alias's OnDeath) is 190: the outro scene
  // begins, the intro's ends. His own FXAlduinScript tears his soul from him (its earthquake, then
  // the soul's explosion: MQKillDragonFaction), and the outro's first phase sees it: 200, the
  // quest's completion (MQ306's 5).
  it('has the player bring Alduin down with Dragonrend, and he dies (140-200)', async () => {
    if (!alduinComes) return;
    const sim = await loadSim(alduinComes);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const alduin = alias(sim, ALDUIN);
      // The heroes take up the fight with him.
      for (const hero of [GORMLAITH, FELLDIR, HAKON]) {
        const reference = alias(sim, hero);
        expect(
          await sim.until(() => sim.world.stage.combat.targetOf(reference) === alduin, 30),
          `hero ${String(hero)}`,
        ).toBe(true);
      }
      expect(await sim.equip(await sim.formId('SHOU', 'DragonrendShout'))).toBe(true);
      let shouts = 0;
      for (; shouts < 30 && sim.world.stage.flight.state(alduin) !== 0; shouts++) {
        const at = await sim.position(alduin);
        expect(at).toBeDefined();
        if (!at) return;
        sim.look(at);
        await sim.step(0.2);
        await shoutAll(sim);
        await sim.step(3);
      }
      expect(sim.world.stage.flight.state(alduin)).toBe(0);
      const at = await sim.position(alduin);
      expect(at && (await sim.walkPath(at, 30, 400))).toBe(true);
      const before = (await sim.runtime.actors.value(alduin, ActorValue.health)).current;
      let landed = false;
      for (let swing = 0; swing < 8 && !landed; swing++) {
        ({ landed } = await sim.swingAt(alduin, 200));
      }
      expect(landed).toBe(true);
      const left = (await sim.runtime.actors.value(alduin, ActorValue.health)).current;
      expect(left).toBeLessThan(before);
      expect(sim.stageDone(MQ305, 190)).toBe(false);
      await sim.runtime.actors.damage(alduin, ActorValue.health, left, PLAYER_REF);
      expect(await sim.runtime.actors.isDead(alduin)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ305, 190), 5)).toBe(true);
      expect(await sim.until(() => !sim.runtime.scenes.isPlaying(INTRO_SCENE), 10)).toBe(true);
      expect(await sim.until(() => lines.includes(`${OUTRO}: phase 1`), 30)).toBe(true);
      // The soul's explosion some 16 s on (the earthquake's waits), and the outro sees it.
      expect(await sim.until(() => sim.stageDone(MQ305, 200), 60)).toBe(true);
      expect(
        await sim.runtime.actors.factionRank(alduin, MQ_KILL_DRAGON_FACTION),
      ).toBeGreaterThanOrEqual(0);
      expect(lines).toContain(`${OUTRO}: phase 1 completes`);
      // 200's fragment: every objective complete, MQ306's 5.
      expect(await sim.until(() => sim.stageDone(MQ306, 5), 5)).toBe(true);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      // Gone in the end (its cleanup state disables him).
      let gone = false;
      for (let second = 0; second < 30 && !gone; second++) {
        await sim.step(1);
        gone = !(await sim.enabled(alduin));
      }
      expect(gone).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      alduinFallen = await sim.save('MQ305 200');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The heroes come up, Tsun comes to the player and speaks (210), the lost souls and the heroes
  // praise them. "I'm ready to return to Tamriel." is 220 (Hun Kaal Zoor: Call of Valor) and 250:
  // Tsun's Shout sends them back (MQ305TsunReturnShout, the outro's last phase); the scene's end
  // is 260, the player on the Throat of the World (TamrielMarker), and 300 ends MQ304 and MQ305.
  it('has Tsun send the player back to Skyrim (210-300)', async () => {
    if (!alduinFallen) return;
    const sim = await loadSim(alduinFallen);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const tsun = alias(sim, TSUN);
      expect(await sim.until(() => sim.stageDone(MQ305, 210), 120)).toBe(true);
      expect(await sim.until(() => lines.includes(`${OUTRO}: phase 6`), 60)).toBe(true);
      const near = await sim.position(tsun);
      expect(near && (await sim.walkPath(near, 30, 300))).toBe(true);
      expect(await sim.talk(tsun)).toContain("I'm ready to return to Tamriel.");
      await sim.choose(/ready to return to Tamriel/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MQ305, 250), 5)).toBe(true);
      expect(sim.stageDone(MQ305, 220)).toBe(true);
      const callOfValor = await sim.runtime.casting.shout(
        await sim.formId('SHOU', 'CallOfValorShout'),
      );
      expect(callOfValor && sim.runtime.casting.wordsKnown(PLAYER_REF, callOfValor)).toBe(3);
      expect(await sim.until(() => sim.stageDone(MQ305, 260), 60)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(OUTRO_SCENE)).toBe(false);
      expect(lines).toContain(`${OUTRO}: #28 package done`);
      expect(await sim.until(() => sim.stageDone(MQ305, 300), 30)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
      expect(sim.stageDone(MQ304, 300)).toBe(true);
      expect(sim.isRunning(MQ305)).toBe(false);
      expect(sim.isRunning(MQ306)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
