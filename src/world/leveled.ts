// Leveled lists: picking an entry for a level, with a seeded generator so that the same
// reference always gets the same picks. Platform-independent.

import { LeveledFlag, type LeveledList } from './actor-records.ts';

/** A small deterministic generator (mulberry32): the same reference always looks the same. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks one entry of a leveled list for an actor or item of `level`: among the entries up to
 * that level, the highest level's (or, with "calculate from all levels", any of them), at
 * random; nothing for its chance of none. TODO(M13): the engine's exact draw (it is
 * documented only as "random among the eligible entries").
 */
export function pickLeveled(
  list: LeveledList,
  level: number,
  random: () => number,
): number | undefined {
  if (list.chanceNone > 0 && random() * 100 < list.chanceNone) return undefined;
  const eligible = list.entries.filter((entry) => entry.level <= level);
  if (eligible.length === 0) return undefined;
  const top = Math.max(...eligible.map((entry) => entry.level));
  const choices =
    (list.flags & LeveledFlag.allLevels) !== 0
      ? eligible
      : eligible.filter((entry) => entry.level === top);
  return choices[Math.floor(random() * choices.length)]?.formId;
}
