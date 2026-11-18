// Integration test: Helgen Keep to the cave's exit and on to Riverwood on both routes of MQ101 and
// MQ102, with a player who plays as a real player does (tests/helpers/follower.ts): they walk after
// the guide and stand when near, fall behind now and then, and either fight by button presses or
// leave the fighting to the guide. They are never put anywhere and kill no one by fiat; they go
// ahead by the quest's marker only where the guide stands beside them and nothing goes on (past
// the bear Ralof follows the player). The guide must wait, lead, fight and go on as in the
// original at every step: the barracks' fight, the torture room, the caves, the bear, the exit and
// the walk to Riverwood. Each case goes on from the save the one before took. Skipped without game
// data.
//
// Found 2026-11-18: on Hadvar's route with a player who does not fight, Hadvar stood for good
// blocking in the storeroom: a bash out of the block with his stamina spent (the idle tree's
// BashFail) was taken for an attack that never ended (src/gameplay/combat/attacks.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Follower, type FollowStyle } from './helpers/follower.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102A (Hadvar's route) and MQ102B (Ralof's): the friend's part of MQ102. */
const MQ102A = 0x2bf9c;
const MQ102B = 0x2610a;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** HelgenKeep01toExteriorExitREF: the cave's way out into Tamriel (an automatic door). */
const CAVE_EXIT = 0x91608;
/** RalofRef and HadvarRef (MQ101's Ralof and Hadvar aliases, then MQ102's route quest's). */
const RALOF = 0x2bf9e;
const HADVAR = 0x2bfa2;
/** Gunjar's body (MQ101CorpseSons01), lying in the keep (Ralof's route loots it at 255). */
const GUNJAR = 0xb1694;
/** MQ101's WardenContainer alias (Hadvar's route opens it at 255; its OnOpen sets 257). */
const WARDEN_CONTAINER = 62;

/** Where the game stands: MQ101's and MQ102's stages and the scenes' phases. */
function progress(sim: Sim): string {
  const scenes = sim.runtime.scenes
    .snapshot()
    .map((playing) => `${playing.scene.toString(16)}:${String(playing.phase)}`)
    .join(' ');
  return `MQ101 ${String(sim.stage(MQ101))} MQ102 ${String(sim.stage(MQ102))} ${scenes}`;
}

/** The stalls the follower saw, for a case's message. */
function stalls(follower: Follower): string {
  return follower.stalls.map((s) => `${String(s.at)}s ${s.what}`).join('\n');
}

/**
 * The player gears up as the route's guide tells them (stage 255): Gunjar's body on Ralof's route,
 * the warden's chest on Hadvar's: walked to, opened, everything taken, weapons and armor put on.
 * True once done.
 */
async function gearUp(sim: Sim, follower: Follower, from: number): Promise<boolean> {
  const at = await sim.position(from);
  const me = await sim.position(PLAYER_REF);
  if (!at || !me) return false;
  if (Math.hypot(at[0] - me[0], at[1] - me[1]) > 110) {
    await follower.tick([at[0], at[1], at[2]]);
    return false;
  }
  if (!sim.activate(from)) return false;
  await sim.step(0.5);
  for (const [item, count] of await sim.runtime.inventory(from)) {
    await sim.take(from, item, count);
    const type = (await sim.runtime.forms.db.get(item))?.type;
    if (type === 'WEAP' || type === 'ARMO') await sim.equip(item);
  }
  return true;
}

/** One route's play: the guide, the gear's source, the route's quest, how the player plays. */
interface Route {
  readonly name: string;
  /** Its saves' name (FOLLOW_SAVES). */
  readonly tag: string;
  readonly entryStage: number;
  /** MQ101KeepIntroSceneB (Ralof's) or MQ101KeepIntroSceneA (Hadvar's). */
  readonly introScene: number;
  readonly guide: number;
  readonly gear: (sim: Sim) => number;
  readonly friendQuest: number;
  readonly style: FollowStyle;
  /** Only into the keep and through its first fight (the guide fights it alone). */
  readonly firstFightOnly?: boolean;
}

const ROUTES: readonly Route[] = [
  {
    name: 'Ralof’s route, a player who fights and falls behind',
    tag: 'ralof',
    entryStage: 220,
    introScene: 0x4e1e2,
    guide: RALOF,
    gear: () => GUNJAR,
    friendQuest: MQ102B,
    style: { fights: true, lagEvery: 45, lagFor: 10 },
  },
  {
    name: 'Hadvar’s route, a player who does not fight and falls behind',
    tag: 'hadvar',
    entryStage: 210,
    introScene: 0x20167,
    guide: HADVAR,
    gear: (sim) => sim.runtime.state.quest(MQ101).aliases.get(WARDEN_CONTAINER) ?? 0,
    friendQuest: MQ102A,
    style: { fights: false, lagEvery: 40, lagFor: 12 },
  },
  // Found 2026-11-09 in play: the player could not get past the keep's first fight.
  {
    name: 'Ralof’s route, a player who does not fight',
    tag: 'ralof-unarmed',
    entryStage: 220,
    introScene: 0x4e1e2,
    guide: RALOF,
    gear: () => GUNJAR,
    friendQuest: MQ102B,
    style: { fights: false, lagEvery: 0, lagFor: 0 },
    firstFightOnly: true,
  },
];

for (const route of ROUTES) {
  describe.skipIf(!hasGamedata())(`Helgen Keep to Riverwood (${route.name})`, () => {
    /** The save the case before left (taken: a case that fails leaves none to the next). */
    let saved: Uint8Array | undefined;
    // For looking into a case: FOLLOW_SAVES (a folder outside the repository) keeps each case's
    // save there, and FOLLOW_FROM=n starts the case after the n-th from its save.
    const dir = process.env.FOLLOW_SAVES;
    const tag = route.tag;
    const keep = async (sim: Sim, n: number): Promise<void> => {
      saved = await sim.save();
      if (dir) writeFileSync(`${dir}/${tag}-${String(n)}.sav`, saved);
    };
    const take = (n: number): Uint8Array | undefined => {
      let bytes = saved;
      saved = undefined;
      if (!bytes && dir && process.env.FOLLOW_FROM === String(n)) {
        bytes = new Uint8Array(readFileSync(`${dir}/${tag}-${String(n)}.sav`));
      }
      return bytes;
    };

    /** Plays the route until `done` or `seconds` of play; the follower, for its stalls. */
    async function play(sim: Sim, done: () => boolean, seconds: number): Promise<Follower> {
      sim.runtime.debug.immortal = true;
      const guide = (): number => route.guide;
      const follower = new Follower(sim, guide, route.style, () => progress(sim));
      follower.door = await sim.position(CAVE_EXIT);
      let geared = sim.stageDone(MQ101, 257);
      const until = sim.time + seconds;
      while (sim.time < until && !done()) {
        if (!geared && sim.stageDone(MQ101, 255)) {
          geared = await gearUp(sim, follower, route.gear(sim));
          continue;
        }
        await follower.tick();
      }
      return follower;
    }

    /** A case that goes on from the save the one before left, to a stage. */
    function segment(
      title: string,
      n: number,
      quest: number,
      stage: number,
      seconds: number,
      also: readonly (readonly [number, number])[] = [],
    ): void {
      it(
        title,
        async () => {
          const start = take(n);
          expect(start).toBeDefined();
          if (!start) return;
          const sim = await loadSim(start);
          try {
            const follower = await play(sim, () => sim.stageDone(quest, stage), seconds);
            for (const [q, s] of [...also, [quest, stage] as const]) {
              expect(sim.stageDone(q, s), stalls(follower)).toBe(true);
            }
            await keep(sim, n + 1);
          } finally {
            await sim.close();
          }
        },
        1_200_000,
      );
    }

    it('goes into the keep with the guide, gears up and gets through the barracks’ fight and door (stages 250 to 305)', async () => {
      const sim = await openSim({ opening: true });
      try {
        await sim.step(1);
        for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
        // As MQ101SetStage220 (210) does when the player walks in with the guide.
        void sim.runtime.quests.setStage(MQ101, route.entryStage);
        // The player ran after the guide through the town to the keep (their hands still bound:
        // no fighting or activating until the guide frees them at 240).
        sim.runtime.controls.movement = sim.runtime.controls.looking = true;
        await sim.step(0.5);
        await sim.openInterior(KEEP);
        for (const playing of sim.runtime.scenes.snapshot()) {
          if (playing.scene !== route.introScene) sim.runtime.scenes.stop(playing.scene);
        }
        const follower = await play(sim, () => sim.stageDone(MQ101, 305), 420);
        expect(sim.stageDone(MQ101, 305), stalls(follower)).toBe(true);
        // The guide fought the barracks' soldiers (stage 270 on), the player's fight or not.
        const soldiers = [173, 174].map((alias) =>
          sim.runtime.state.quest(MQ101).aliases.get(alias),
        );
        const hits = sim
          .events('hit')
          .filter((hit) => hit.aggressor === route.guide && soldiers.includes(hit.target));
        expect(hits.length).toBeGreaterThan(0);
        await keep(sim, 1);
      } finally {
        await sim.close();
      }
    }, 900_000);

    if (route.firstFightOnly) return;
    segment(
      'follows the guide through the storeroom, the torture room and over the bridge (stage 500)',
      1,
      MQ101,
      500,
      900,
    );
    segment(
      'follows the guide through the caves, past the spiders and the bear (stage 800)',
      2,
      MQ101,
      800,
      600,
    );
    segment('follows the guide out of the cave (MQ102 15, MQ101 900)', 3, MQ101, 900, 400, [
      [MQ102, 15],
    ]);
    segment(
      'walks with the guide to Riverwood (the route’s stage 35)',
      4,
      route.friendQuest,
      35,
      900,
    );
  });
}
