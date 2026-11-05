// Integration test: MQ202 "A Cornered Rat" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const MQ201 = 0x35d5f;
const MQ202 = 0x36191;
const TG01 = 0x1f326;
/** MQ202's Brynjolf alias. */
const BRYNJOLF = 52;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
/** The Bee and Barb's door from Riften's street, the inn, and Keerava (KeeravaRef). */
const BEE_AND_BARB_DOOR = 0x42279;
const BEE_AND_BARB = 0x16bdf;
const KEERAVA = 0x19dc8;
/** The Bee and Barb's door to the street. */
const BEE_AND_BARB_EXIT = 0x16c3c;
/** The Ratway's door off Riften's canal, the Ratway (RiftenRatway01), its door to the Ragged
 * Flagon (TGRatwayDoorBeforeTG02) and the Flagon. */
const RATWAY_DOOR = 0x48fa0;
const RATWAY = 0x3b698;
const RATWAY_TO_FLAGON = 0xa1e20;
const RAGGED_FLAGON = 0x16bcf;
/** MQ202's Vekel and Gissur aliases. */
const VEKEL = 54;
const GISSUR = 61;
const GOLD = 0xf;
/** MQ202's FlagonAmbush1 to 3 aliases (the Thalmor agents Gissur fetches). */
const FLAGON_AMBUSH_1 = 63;
const FLAGON_AMBUSH_2 = 64;
const FLAGON_AMBUSH_3 = 65;
/** The Flagon's door to the Ratway Vaults (DoorRaggedFlagonToRW02), the Vaults
 * (RiftenRatway02), their door to the Ratway Warrens, the Warrens (RiftenEsbernsVault) and
 * Esbern's door (MQ202EsbernsDoorREF). */
const FLAGON_TO_VAULTS = 0xa3ddd;
const RATWAY_VAULTS = 0xa1bfd;
const VAULTS_TO_WARRENS = 0xa3db0;
const WARRENS = 0x3b696;
const ESBERNS_DOOR = 0x3b8b6;
/** MQ202's Esbern alias. */
const ESBERN = 51;
/** MQ202EsbernOpenDoorScene; MQ202SetStage170 (inside Esbern's door); MQ203. */
const OPEN_DOOR_SCENE = 0x3bca9;
const STAGE_170 = 0x6debb;
const MQ203 = 0x36192;
/** MQ202EsbernExplainScene; MQ202's FinalAmbush1 and 2 aliases. */
const EXPLAIN_SCENE = 0x31900;
const FINAL_AMBUSH_1 = 73;
const FINAL_AMBUSH_2 = 74;
/** MQ202's Delphine alias. */
const DELPHINE = 44;
/** The doors back: the Warrens' to the Vaults, the Vaults' to the Flagon, the Flagon's to the
 * Ratway (DoorRaggedFlagonToRatwayBeforeTG02), the Ratway's to Riften's canal. */
const WARRENS_TO_VAULTS = 0x3b8b2;
const VAULTS_TO_FLAGON = 0xa3d84;
const FLAGON_TO_RATWAY = 0x16d2e;
const RATWAY_TO_RIFTEN = 0xa3de1;
/** RiverwoodMapMarker, the Sleeping Giant Inn's door from the street and the inn. */
const RIVERWOOD_MARKER = 0x162a4;
const INN_DOOR = 0x13424;
const SLEEPING_GIANT = 0x133c6;

/** The game with the player in Riften, sent to the Ratway (stage 20). */
let afterBrynjolf: Uint8Array | undefined;
/** The game with Vekel's word had and Gissur's ambush in the Flagon fought off (stage 70). */
let afterFlagon: Uint8Array | undefined;
/** The game with Esbern's door unlocked and open (stage 160). */
let afterDoor: Uint8Array | undefined;
/** The game with Esbern found, packed and the last ambush fought off (stage 200). */
let afterEsbern: Uint8Array | undefined;

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows; the
 * sim has no aimed attacks yet).
 */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
}

/** How near the player's blows reach (units), and how long they take to fell someone (seconds). */
const BLOW_REACH = 300;
const BLOWS_SECONDS = 6;

/**
 * A fight as the player fights it: they go at the nearest of those fighting them, and each falls
 * after a few seconds within reach of their blows (TODO(M13): the player's own blows). The first
 * of Gissur's Thalmor to die ends his scene (its actors' Death End), which ends the packages of
 * those it brought: one that has not detected the player by then stays out of this fight, and goes
 * home or stays in the Ratway. TODO(M13): whether an ally who does not itself detect the target
 * joins a fight it sees was not read; ours keeps out until it does.
 */
async function fightPlayersWay(
  sim: Sim,
  seconds: number,
  inReach: Map<number, number>,
): Promise<void> {
  const until = sim.time + seconds;
  // Under half a step, a step takes none: the clock would stand still here.
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    let nearest: readonly [number, number, number] | undefined;
    let nearestAway = Infinity;
    for (const staged of sim.actors()) {
      const actor = staged.reference;
      if (actor === PLAYER_REF || staged.dead) continue;
      if (sim.world.stage.combat.targetOf(actor) !== PLAYER_REF) continue;
      const away = (await sim.distance(actor, PLAYER_REF)) ?? Infinity;
      if (away < BLOW_REACH) {
        const since = inReach.get(actor) ?? sim.time;
        inReach.set(actor, since);
        if (sim.time - since >= BLOWS_SECONDS) await sim.kill(actor, PLAYER_REF);
      } else if (away < nearestAway) {
        nearest = await sim.position(actor);
        nearestAway = away;
      }
    }
    if (nearest) await sim.walkPath([...nearest], Math.min(2, until - sim.time), BLOW_REACH / 2);
    // Nobody to go at, or a walk that found no way, returns without a step: time goes on.
    if (sim.time === started) await sim.step(Math.min(1, until - sim.time));
  }
}

/** Whether an actor is dead, on the stage or away. */
function isDead(sim: Sim, actor: number): boolean {
  return sim.actor(actor)?.dead ?? sim.runtime.state.actor(actor).dead ?? false;
}

/** The player walks to a point a few seconds at a time, fighting off those who attack. */
async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach: number,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (sim.time < until) {
    const started = sim.time;
    const there = await sim.walkPath([...target], Math.min(5, until - sim.time), reach);
    await fendOff(sim);
    if (there) return true;
    // A walk that found no way returns without a step: time goes on while it asks again.
    if (sim.time === started) await sim.step(0.5);
  }
  return false;
}

describe.skipIf(!hasGamedata())('MQ202 A Cornered Rat', () => {
  // MQ202's own start for a game that skips ahead (stage 0 sets 1: MQ201 played to its end,
  // which sets 10). In Riften, asking after the old man: Brynjolf, at his stall in the market,
  // wants a job done first ("Actually, I'm looking for this old guy hiding out in Riften.":
  // TG00's crossover; his own word on Esbern needs TG00 done, and with TG01 begun MQ202's update
  // sets 20). Keerava, the Bee and Barb's innkeeper, sends the player down to the Ragged
  // Flagon in the Ratway (20).
  it('has the player ask around Riften for Esbern: Brynjolf, then Keerava (10-20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ202, 0);
      expect(await sim.until(() => sim.stageDone(MQ202, 1), 60)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 250), 60)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ202, 10), 30)).toBe(true);
      await sim.step(30);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      const brynjolf = sim.runtime.state.quest(MQ202).aliases.get(BRYNJOLF) ?? 0;
      const at = await sim.position(brynjolf);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.converse(brynjolf, [/looking for this old guy/])).toContainEqual(
        expect.stringMatching(/just wanted some information/),
      );
      expect(sim.stageDone(MQ202, 20)).toBe(false);
      expect(sim.stage(TG01)).toBe(0);
      const door = await sim.position(BEE_AND_BARB_DOOR);
      expect(door && (await sim.walkPath(door, 120, 120))).toBe(true);
      expect(sim.activate(BEE_AND_BARB_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(BEE_AND_BARB);
      await sim.step(2);
      const keerava = await sim.position(KEERAVA);
      expect(keerava && (await sim.walkPath(keerava, 60, 150))).toBe(true);
      await sim.converse(KEERAVA, [/old guy/]);
      expect(sim.stageDone(MQ202, 20)).toBe(true);
      afterBrynjolf = await sim.save('MQ202 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Down to the Ratway by its door off Riften's canal, past the thugs who live there (those
  // who attack fall to the player's blows), to the Ragged Flagon. Vekel the Man, asked about the
  // old man, knows nothing until bribed or persuaded. Found 2026-11-03: Gissur's Thalmor agents
  // follow the first of them (MQ202FlagonAmbushFollowLeader) while away; asked only as the
  // schedules came round, they stayed in the Ratway as he went into the Flagon.
  it('has Vekel tell of the Ratway Warrens and Gissur bring the Thalmor (50-70)', async () => {
    if (!afterBrynjolf) return;
    const sim = await loadSim(afterBrynjolf);
    try {
      expect(sim.activate(BEE_AND_BARB_EXIT)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const door = await sim.position(RATWAY_DOOR);
      expect(door && (await sim.walkPath(door, 120, 120))).toBe(true);
      expect(sim.activate(RATWAY_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(RATWAY);
      const flagonDoor = await sim.position(RATWAY_TO_FLAGON);
      expect(flagonDoor && (await walkFighting(sim, flagonDoor, 180, 100))).toBe(true);
      expect(sim.activate(RATWAY_TO_FLAGON)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(RAGGED_FLAGON);
      const vekel = sim.runtime.state.quest(MQ202).aliases.get(VEKEL) ?? 0;
      const at = await sim.position(vekel);
      expect(at && (await walkFighting(sim, at, 60, 150))).toBe(true);
      // The gold the player has made on the way (TODO(M13): a played game's purse).
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(GOLD), 200, true);
      // "Lot of old guys around": Gissur, at his table, hears it (CheckForGissurOverhearing:
      // 60, MQ202GissurSummonThalmorStart). The bribe ("Maybe this will help your memory.")
      // and "Where does he live?" tell of the Warrens (50).
      expect(await sim.converse(vekel, [/old guy/, /help your memory/])).toContainEqual(
        expect.stringMatching(/Where does he live/),
      );
      expect(sim.stageDone(MQ202, 60)).toBe(true);
      expect(sim.stageDone(MQ202, 50)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBeLessThan(200);
      // Gissur leaves the Flagon for the Ratway, where the Thalmor agents wait (65:
      // MQ202GissurSummonThalmor); they come back with him and fight (70). The first of them to
      // die ends the scene; how many reach the Flagon by then goes by the timing of the fight.
      const quest = sim.runtime.state.quest(MQ202);
      const thalmor = [GISSUR, FLAGON_AMBUSH_1, FLAGON_AMBUSH_2, FLAGON_AMBUSH_3].map(
        (alias) => quest.aliases.get(alias) ?? 0,
      );
      const inReach = new Map<number, number>();
      const fought = (): boolean =>
        thalmor.some((a) => isDead(sim, a)) &&
        !thalmor.some((a) => !isDead(sim, a) && sim.world.stage.combat.targetOf(a) === PLAYER_REF);
      for (let second = 0; second < 300 && !fought(); second += 2) {
        await fightPlayersWay(sim, 2, inReach);
      }
      expect(sim.stageDone(MQ202, 65)).toBe(true);
      expect(sim.stageDone(MQ202, 70)).toBe(true);
      expect(fought()).toBe(true);
      afterFlagon = await sim.save('MQ202 70');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Through the Flagon's back door to the Ratway Vaults, where more Thalmor lie in wait (5
  // enabled them), and the thugs who live there; on to the Ratway Warrens. Esbern's door is shut;
  // knocked on, its slot opens and he talks through it. Found 2026-11-03: a script's Activate of
  // an actor by the player (MQ202EsbernsDoorScript's Esbern.Activate) opened no conversation;
  // and the player's ways took the navmesh's ledge-up link under the Warrens' drop-down room,
  // 260 units up a wall.
  it("has Esbern talk through his door's slot and let the player in (100-160)", async () => {
    if (!afterFlagon) return;
    const sim = await loadSim(afterFlagon);
    try {
      const back = await sim.position(FLAGON_TO_VAULTS);
      expect(back && (await walkFighting(sim, back, 90, 100))).toBe(true);
      expect(sim.activate(FLAGON_TO_VAULTS)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(RATWAY_VAULTS);
      const on = await sim.position(VAULTS_TO_WARRENS);
      let reached = false;
      for (let leg = 0; leg < 30 && on && !reached; leg++) {
        reached = await walkFighting(sim, on, 10, 100);
      }
      expect(reached).toBe(true);
      // Across MQ202SetStage100 on the way.
      expect(sim.stageDone(MQ202, 100)).toBe(true);
      expect(sim.activate(VAULTS_TO_WARRENS)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(WARRENS);
      // Up the Warrens' far stair to his door (the drop-down room's ledge is no way up).
      const esbernsDoor = await sim.position(ESBERNS_DOOR);
      expect(esbernsDoor && (await walkFighting(sim, esbernsDoor, 120, 100))).toBe(true);
      // MQ202EsbernsDoorScript: the slot opens and the player activates Esbern through it.
      const esbern = sim.runtime.state.quest(MQ202).aliases.get(ESBERN) ?? 0;
      const talks = (): number =>
        sim.menus().filter((menu) => menu.menu === 'Dialogue Menu' && menu.reference === esbern)
          .length;
      const before = talks();
      expect(sim.activate(ESBERNS_DOOR)).toBe(true);
      expect(await sim.until(() => talks() > before, 5)).toBe(true);
      // "Go away!" "Esbern? Open the door. I'm a friend." (130: the Warrens' objective, 50)
      // "It's okay. Delphine sent me." "Delphine said to remember the 30th of Frostfall." (150:
      // MQ202EsbernOpenDoorScene, his locks one after another).
      await sim.converse(esbern, [
        /^Open the door/,
        /I'm a friend/,
        /Delphine sent me/,
        /30th of Frostfall/,
      ]);
      expect(sim.stageDone(MQ202, 130)).toBe(true);
      expect(sim.stageDone(MQ202, 150)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(OPEN_DOOR_SCENE)).toBe(true);
      // The last lock: the door opens (160).
      expect(await sim.until(() => sim.stageDone(MQ202, 160), 60)).toBe(true);
      await sim.step(2);
      expect([1, 2]).toContain(await sim.runtime.openState(ESBERNS_DOOR));
      afterDoor = await sim.save('MQ202 160');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // In through the open door (MQ202SetStage170: 170; his escort in done, he shuts the door
  // behind them: 175) and Esbern's ForceGreet: "So Delphine keeps up the fight". The end of the
  // world, Alduin, the Dragonborn: told the player is Dragonborn, he takes heart ("We must go,
  // quickly now."): 180, MQ202EsbernExplainScene (he packs his things) and MQ203 begun. The
  // scene's end (200) brings the last Thalmor in on them.
  it('has Esbern let the player in and hear that they are Dragonborn (170-200)', async () => {
    if (!afterDoor) return;
    const sim = await loadSim(afterDoor);
    try {
      const esbern = sim.runtime.state.quest(MQ202).aliases.get(ESBERN) ?? 0;
      const inside = await sim.position(STAGE_170);
      expect(inside && (await sim.walkPath(inside, 30, 40))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ202, 170), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ202, 175), 60)).toBe(true);
      // His ForceGreet (MQ202EsbernForceGreetInitial): "So Delphine keeps up the fight".
      expect(await sim.listen(esbern, 60)).toEqual([expect.stringMatching(/hopeless/)]);
      expect(await sim.choose(/hopeless/)).toContainEqual(expect.stringMatching(/literal end/));
      expect(await sim.choose(/literal end/)).toEqual([expect.stringMatching(/I'm Dragonborn/)]);
      await sim.choose(/I'm Dragonborn/);
      expect(sim.stageDone(MQ202, 180)).toBe(true);
      expect(sim.stage(MQ203)).toBe(10);
      expect(sim.runtime.scenes.isPlaying(EXPLAIN_SCENE)).toBe(true);
      // He gathers his things (the scene's search packages and lines); its end sets 200: the
      // last Thalmor come for them through the Warrens, and Esbern is the player's teammate.
      for (let second = 0; second < 240 && !sim.stageDone(MQ202, 200); second += 2) {
        await sim.step(2);
        await fendOff(sim);
      }
      expect(sim.stageDone(MQ202, 200)).toBe(true);
      // Its fragment moves a Gissur still alive first (MoveTo takes its time).
      expect(
        await sim.until(() => sim.runtime.state.actor(esbern).playerTeammate === true, 30),
      ).toBe(true);
      const quest = sim.runtime.state.quest(MQ202);
      const ambush = [FINAL_AMBUSH_1, FINAL_AMBUSH_2].map((alias) => quest.aliases.get(alias) ?? 0);
      for (let second = 0; second < 240 && !ambush.every((a) => isDead(sim, a)); second += 2) {
        await sim.step(2);
        await fendOff(sim);
      }
      expect(ambush.every((actor) => isDead(sim, actor))).toBe(true);
      expect(sim.actor(esbern)?.dead).not.toBe(true);
      afterEsbern = await sim.save('MQ202 200');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back the way they came, Esbern following (MQ203 10: "Escort Esbern to Riverwood"): out of
  // the Warrens, through the Vaults, the Flagon and the Ratway to Riften, then on to Riverwood
  // and the Sleeping Giant, where Delphine waits.
  it('has the player bring Esbern to Delphine in Riverwood (MQ203 10)', async () => {
    if (!afterEsbern) return;
    const sim = await loadSim(afterEsbern);
    try {
      const esbern = sim.runtime.state.quest(MQ202).aliases.get(ESBERN) ?? 0;
      const delphine = sim.runtime.state.quest(MQ202).aliases.get(DELPHINE) ?? 0;
      await sim.step(2);
      // A door the way passes, the player through it.
      const through = async (door: number, cell: number | undefined): Promise<void> => {
        const at = await sim.position(door);
        expect(at && (await walkFighting(sim, at, 240, 100))).toBe(true);
        expect(sim.activate(door)).toBe(true);
        await sim.world.settle();
        await sim.step(3);
        if (cell !== undefined) {
          expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
        }
        // He comes through each door with the player (a follower: MQ203's follow package).
        const space = async (reference: number): Promise<number | undefined> => {
          const placed = await sim.runtime.placement(reference);
          return placed?.world ?? placed?.cell;
        };
        expect(await space(esbern)).toBe(await space(PLAYER_REF));
      };
      expect(sim.package(esbern)?.procedure).toBe('Follow');
      await through(WARRENS_TO_VAULTS, RATWAY_VAULTS);
      await through(VAULTS_TO_FLAGON, RAGGED_FLAGON);
      await through(FLAGON_TO_RATWAY, RATWAY);
      await through(RATWAY_TO_RIFTEN, undefined);
      // On to Riverwood (fast travel: he comes along).
      await sim.fastTravel(RIVERWOOD_MARKER);
      await sim.step(3);
      expect(await sim.distance(PLAYER_REF, esbern)).toBeLessThan(400);
      // Into the Sleeping Giant with him: MQ203 takes over (20: Delphine and Esbern meet), and
      // MQ202 is done (300: the Ratway's Thalmor and Shavari cleared away, the quest stopped).
      await through(INN_DOOR, SLEEPING_GIANT);
      expect(await sim.until(() => sim.stageDone(MQ203, 20), 20)).toBe(true);
      expect(sim.stageDone(MQ202, 300)).toBe(true);
      expect(sim.isRunning(MQ202)).toBe(false);
      expect((await sim.runtime.placement(delphine))?.cell).toBe(SLEEPING_GIANT);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
