// The player's own data in its ACHR change form, after the actor's (docs/formats/ess.md
// "The player"): the player character's state the original saves beside an actor's, in the
// original's order, read as far as its skills' experience. Platform-independent.

import type { EssReader } from './ess-reader.ts';

/** A skill's progress (CommonLibSSE's PlayerSkills::Data::SkillData and legendary count). */
export interface EssSkillProgress {
  readonly level: number;
  readonly xp: number;
  readonly levelThreshold: number;
  /** Times the skill was made legendary. */
  readonly legendary: number;
}

/** What the player's data says that the importer uses. */
export interface EssPlayerData {
  /** The experience towards the next character level, and what that level needs. */
  readonly xp: number;
  readonly levelThreshold: number;
  /** The 18 skills' progress, in skill order (one-handed to enchanting). */
  readonly skills: readonly EssSkillProgress[];
}

/**
 * Reads the player's own data (after the actor's data of the player's change form) as far as
 * its layout is known: through the skills' experience and the list after them.
 */
export function readPlayerData(reader: EssReader): EssPlayerData {
  const u8s = (count: number): void => {
    reader.skip(count);
  };
  const u32s = (count: number): void => {
    reader.skip(4 * count);
  };
  u8s(1);
  u32s(1);
  u8s(2);
  u32s(2);
  u8s(1);
  u32s(1);
  u8s(4);
  u32s(1);
  reader.skip(12);
  u32s(2);
  u8s(2);
  // Timed entries: a u32 and the milliseconds since it (u64).
  for (let n = reader.vsval(), i = 0; i < n; i++) reader.skip(4 + 8);
  u32s(1);
  u8s(1);
  u32s(3);
  u8s(2);
  u32s(3 + 4);
  u32s(1); // a game time, relative to the save's
  u8s(2);
  u32s(2 + 7);
  // The skills' experience: the character level's, then per skill (a count, 18) its level,
  // experience and threshold, and its legendary count.
  const xp = reader.f32();
  const levelThreshold = reader.f32();
  const skills: EssSkillProgress[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    skills.push({
      level: reader.f32(),
      xp: reader.f32(),
      levelThreshold: reader.f32(),
      legendary: reader.u32(),
    });
  }
  reader.skip(12);
  u32s(1); // a game time
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    reader.skip(12);
    u32s(1); // a game time
  }
  // TODO(M13): what follows (eight references, then the player's lists: timers, map
  // markers, teammates, ... in the original's order) does not read to its end on the saves
  // read: one part has a layout other than the one observed in the original's save code.
  return { xp, levelThreshold, skills };
}
