// Integration test: TG02 "Loud and Clear" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.
//
// TODO(M13): Goldenglow (40-50) is not played yet. Found 2026-11-18: from the shore where fast
// travel puts the player (GoldenglowMapMarkerRef), the player's way to the estate's bee hives
// finds no path (they stand on the navmesh at the lake's edge, 5,900 units off, and walk no
// further); the estate is reached over the water, and the player's ways do not swim.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TG02 = 0x2154e;

/** TG02's Brynjolf and Mercer Frey aliases. */
const BRYNJOLF = 0;
const MERCER = 1;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
/** The Ratway's door off Riften's canal, the Ratway, its door to the Ragged Flagon and the
 * Flagon. */
const RATWAY_DOOR = 0x48fa0;
const RATWAY = 0x3b698;
const RATWAY_TO_FLAGON = 0xa1e20;
const RAGGED_FLAGON = 0x16bcf;
/** The Flagon's door to the Cistern, the Guild's home (RiftenThievesGuildHeadquarters). */
const FLAGON_TO_CISTERN = 0x25d83;
const CISTERN = 0x16bd0;

/** The alias's reference in TG02. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(TG02).aliases.get(id) ?? 0;
}

/** Those fighting the player fall to the player's blows (TODO(M13): the player's own blows). */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
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
    if (sim.time === started) await sim.step(0.5);
  }
  return false;
}

/** The player walks to a door and goes through it. */
async function through(sim: Sim, door: number, cell?: number): Promise<void> {
  const at = await sim.position(door);
  expect(at && (await walkFighting(sim, at, 240, 100))).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  if (cell !== undefined) expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
}

/**
 * The player follows an actor a while: walking after it, and through the door it took (`doors`:
 * the door the way leaves each place by, by the place's form id).
 */
async function follow(
  sim: Sim,
  leader: number,
  seconds: number,
  done: () => boolean,
  doors: ReadonlyMap<number, number>,
): Promise<void> {
  const until = sim.time + seconds;
  while (sim.time < until && !done()) {
    const [here, there] = await Promise.all([
      sim.runtime.placement(PLAYER_REF),
      sim.runtime.placement(leader),
    ]);
    const space = (p: typeof here): number | undefined => p?.cell ?? p?.world;
    const door = doors.get(space(here) ?? 0);
    if (there && space(there) !== space(here) && door !== undefined) {
      await through(sim, door);
      continue;
    }
    const started = sim.time;
    const at = await sim.position(leader);
    if (at) await sim.walkPath(at, 2, 150);
    // A walk that found no way (or was there already) takes no step: time goes on.
    if (sim.time === started) await sim.step(0.5);
  }
}

describe.skipIf(!hasGamedata())('TG02 Loud and Clear', () => {
  // TG02's own start for a game that skips ahead (0: TG00 and TG01 done, Brynjolf at his
  // start): 10, "Follow Brynjolf". In the Flagon he leads the player into the Cistern, the
  // Guild's home (20), where Mercer Frey questions the newcomer (TG02IntroScene) and Brynjolf
  // gives the Goldenglow job (40).
  it('has Brynjolf bring the player to Mercer Frey in the Cistern (10-40)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.step(5);
      void sim.runtime.quests.setStage(TG02, 0);
      expect(await sim.until(() => sim.stage(TG02) === 10, 30)).toBe(true);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, RATWAY_DOOR, RATWAY);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      const at = await sim.position(brynjolf);
      expect(at && (await walkFighting(sim, at, 90, 150))).toBe(true);
      expect(sim.package(brynjolf)?.procedure).toBe('Escort');
      await follow(
        sim,
        brynjolf,
        120,
        () => sim.stageDone(TG02, 20),
        new Map([[RAGGED_FLAGON, FLAGON_TO_CISTERN]]),
      );
      expect(sim.stageDone(TG02, 20)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(CISTERN);
      // Brynjolf presents the newcomer; Mercer questions them, then forcegreets the player
      // (TG02IntroScene's last phase): the rules. "Yes, I understand." starts TG02IntroScene02,
      // whose end sets 30.
      const mercer = alias(sim, MERCER);
      expect(await sim.listen(mercer, 120)).toContain('Yes, I understand.');
      await sim.choose(/Rules\?/);
      expect(await sim.choose(/Yes, I understand/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(TG02, 30), 180)).toBe(true);
      // Brynjolf's forcegreet: the cut (35), the Goldenglow job, its catch (40).
      expect(await sim.listen(brynjolf, 30)).toEqual(['So how do I get my cut of the spoils?']);
      await sim.choose(/cut of the spoils/);
      expect(sim.stage(TG02)).toBe(35);
      await sim.choose(/Goldenglow job/);
      await sim.choose(/catch/);
      await sim.choose(/Makes sense/);
      await sim.choose(/Aringoth/);
      expect(sim.stage(TG02)).toBe(40);
      sim.goodbye();
      // Saved as the next segment would load it (TODO(M13): Goldenglow, see the file's head).
      expect((await sim.save('TG02 40')).length).toBeGreaterThan(0);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
