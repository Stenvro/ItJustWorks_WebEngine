// The Dawnguard line's simulations (tests/sim-<quest>.int.test.ts) share the player's ways through
// it: the fights the player wins as they go, and the steps of a quest a later one starts from
// (Bloodline begins where Awakening ends, with Serana out of her coffin). Each step plays as the
// player plays it; the quests' own sims assert what happens on the way.

import { PLAYER_REF, SIM_STEP, type Sim } from './sim.ts';

type Vec3 = [number, number, number];

/** DLC1VQ01 "Awakening" and DLC1VQ02 "Bloodline". */
export const VQ01 = 0x200352a;
export const VQ02 = 0x2002f65;
/** DLC1VQ01's Tolan and Serana aliases. */
export const VQ01_TOLAN = 0;
export const VQ01_SERANA = 1;
/** The map marker at Dimhollow Crypt and its door from Tamriel; the crypt's two cells. */
export const DIMHOLLOW_MARKER = 0x2002f6f;
export const DIMHOLLOW_DOOR = 0x2002f6e;
export const CRYPT_01 = 0x2000eb8;
export const CRYPT_02 = 0x2000eb7;
/** The door from the first cell to the second; where the vampires hold Tolan (Stage15SceneMarker1). */
export const CRYPT_01_DOOR = 0x20010c9;
export const STAGE15_MARKER = 0x200d076;
/** DLC1VQ01AdalvaldCaptiveMarker and the book by it (the quest's Book alias). */
export const ADALVALD_MARKER = 0x200fb22;
export const VQ01_BOOK = 0x200d072;
/** The spike the player lays a hand on (VQ01PuzzleQuestTargetButton) and the coffin's activator. */
export const SPIKE = 0x2006892;
export const COFFIN = 0x200f7f4;
/**
 * The five braziers in their order (brazierID 1 to 5), each with the marker the player pushes it
 * from: a brazier moves away from whichever of its two markers the player stands nearer, and 1 and
 * 4 are solved out, 2, 3 and 5 in (DLC1VQ01PuzzleBrazierScript).
 */
export const BRAZIERS: readonly (readonly [number, number])[] = [
  [0x2003e88, 0x2003e8d],
  [0x2003e8f, 0x2003e93],
  [0x2003e90, 0x2003e95],
  [0x2003e91, 0x2003e98],
  [0x2003e92, 0x2003e9a],
];

/** A quest alias's reference. */
export function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/**
 * Those fighting the player, or those the player came to help (`friends`), fall to the player's
 * blows (TODO(M13): the player's own blows, where the fight is not what the segment tests).
 */
export async function fendOff(sim: Sim, friends: readonly number[] = []): Promise<number> {
  let fallen = 0;
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead || friends.includes(actor)) continue;
    const target = sim.world.stage.combat.targetOf(actor);
    if (target === PLAYER_REF || (target !== undefined && friends.includes(target))) {
      await sim.kill(actor, PLAYER_REF);
      fallen += 1;
    }
  }
  return fallen;
}

/** The player makes their way to a point, what comes at them falling as they go (fendOff). */
export async function walkFighting(
  sim: Sim,
  target: Vec3,
  seconds: number,
  reach = 200,
  friends: readonly number[] = [],
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(target, Math.min(5, until - sim.time), reach);
    await fendOff(sim, friends);
    if (there) return true;
    // A walk that found no way returns without a step: time goes on while it asks again.
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

/** Walks to a reference (fighting); false if it has no place or the way was not made. */
export async function walkToFighting(
  sim: Sim,
  reference: number,
  seconds: number,
  reach = 200,
  friends: readonly number[] = [],
): Promise<boolean> {
  const at = await sim.position(reference);
  return at !== undefined && (await walkFighting(sim, at, seconds, reach, friends));
}

/** Goes through a load door the player stands at, its place loaded. */
export async function goThrough(sim: Sim, door: number): Promise<boolean> {
  if (!sim.activate(door)) return false;
  await sim.world.settle();
  await sim.step(2);
  return true;
}

/** Isran's errand given (DLC1VQ01 10, a game that skips ahead), to Dimhollow's door. */
export async function toDimhollow(sim: Sim): Promise<boolean> {
  void sim.runtime.quests.setStage(VQ01, 10);
  if (!(await sim.until(() => sim.stageDone(VQ01, 10), 30))) return false;
  await sim.step(1);
  await sim.fastTravel(DIMHOLLOW_MARKER);
  await sim.step(2);
  return walkToFighting(sim, DIMHOLLOW_DOOR, 120);
}

/**
 * Into the crypt, past the vampires who hold Tolan (15), and through its first cell to the door
 * of the second, into it.
 */
export async function throughCrypt01(sim: Sim): Promise<boolean> {
  if (!(await goThrough(sim, DIMHOLLOW_DOOR))) return false;
  const tolan = alias(sim, VQ01, VQ01_TOLAN);
  if (!(await walkToFighting(sim, STAGE15_MARKER, 240, 300, [tolan]))) return false;
  await sim.step(5);
  await fendOff(sim, [tolan]);
  if (!(await walkToFighting(sim, CRYPT_01_DOOR, 400, 150, [tolan]))) return false;
  return goThrough(sim, CRYPT_01_DOOR);
}

/** Down to Adalvald's chamber (the vampires there fall), and the book by him taken. */
export async function toAdalvald(sim: Sim): Promise<boolean> {
  if (!(await walkToFighting(sim, ADALVALD_MARKER, 300, 250))) return false;
  await sim.step(10);
  await fendOff(sim);
  if (!(await walkToFighting(sim, VQ01_BOOK, 60, 120))) return false;
  const taken = sim.activate(VQ01_BOOK);
  await sim.step(2);
  return taken;
}

/**
 * On to the coffin's chamber: the player's hand on the spike (19), each brazier pushed to its
 * place in turn, and the coffin opened (20, 30).
 */
export async function openCoffin(sim: Sim): Promise<boolean> {
  if (!(await walkToFighting(sim, SPIKE, 300, 150))) return false;
  if (!sim.activate(SPIKE)) return false;
  await sim.step(8);
  for (const [brazier, stand] of BRAZIERS) {
    if (!(await walkToFighting(sim, stand, 60, 60))) return false;
    if (!sim.activate(brazier)) return false;
    await sim.step(6);
  }
  await sim.step(10);
  if (!(await walkToFighting(sim, COFFIN, 60, 150))) return false;
  if (!sim.activate(COFFIN)) return false;
  return sim.until(() => sim.stageDone(VQ01, 30), 30);
}

/**
 * Serana, out of her coffin, speaks to the player: what they say leads her to ask for their help
 * home ("Where do you need to go?": DLC1VQ01 200, Bloodline's 5), and she comes along.
 */
export async function hearSerana(sim: Sim): Promise<boolean> {
  const serana = alias(sim, VQ01, VQ01_SERANA);
  let topics = await sim.listen(serana, 60);
  if (!topics?.includes('Who were you expecting?')) return false;
  await sim.choose(/Who were you expecting/);
  await sim.choose(/What do you mean, "like you"/);
  topics = await sim.choose(/The Dawnguard would want me to kill you/);
  if (!topics.includes('Where do you need to go?')) return false;
  await sim.choose(/Where do you need to go/);
  sim.goodbye();
  await sim.step(2);
  return sim.stageDone(VQ01, 200);
}
