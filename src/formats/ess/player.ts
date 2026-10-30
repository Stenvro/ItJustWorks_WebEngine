// The player's own data in its ACHR change form, after the actor's (docs/formats/ess.md
// "The player"): the player character's state the original saves beside an actor's, in the
// original's order, read to its end. Platform-independent.

import type { EssReader } from './ess-reader.ts';
import type { RefIdResolver } from './global-data.ts';

/** A skill's progress (CommonLibSSE's PlayerSkills::Data::SkillData and legendary count). */
export interface EssSkillProgress {
  readonly level: number;
  readonly xp: number;
  readonly levelThreshold: number;
  /** Times the skill was made legendary. */
  readonly legendary: number;
}

/** A quest stage in the player's quest log: the quest, the stage and its log entry's flags. */
export interface EssQuestLogEntry {
  readonly quest: number;
  readonly stage: number;
  readonly flags: number;
}

/** A quest objective the player holds: the quest, the objective's index and its instance. */
export interface EssPlayerObjective {
  readonly quest: number;
  readonly index: number;
  readonly instance: number;
}

/** The player camera's state (the original's PlayerCamera). */
export interface EssPlayerCamera {
  /**
   * The camera state the player was in, by the original's order: 0 first person, 1 auto
   * vanity, 2 VATS, 3 free, 4 iron sights, 5 furniture, 6 transition, 7 tween menu, 8
   * animated, 9 third person, 10 mount, 11 bleedout, 12 dragon.
   */
  readonly state: number;
  /** The third person camera's offset from the player's (x, y, z), as the player left it. */
  readonly thirdPersonOffset: readonly [number, number, number];
  /** The world and first person fields of view (degrees). */
  readonly worldFov: number;
  readonly firstPersonFov: number;
}

/** What the player's data says. */
export interface EssPlayerData {
  /** The experience towards the next character level, and what that level needs. */
  readonly xp: number;
  readonly levelThreshold: number;
  /** The 18 skills' progress, in skill order (one-handed to enchanting). */
  readonly skills: readonly EssSkillProgress[];
  /** The quest stages in the player's journal (its quest log). */
  readonly questLog: readonly EssQuestLogEntry[];
  /** The quest objectives the player holds. */
  readonly objectives: readonly EssPlayerObjective[];
  readonly camera: EssPlayerCamera;
  /** The perks the player has, with the rank of each (CommonLibSSE's PerkRankData). */
  readonly perks: readonly { readonly perk: number; readonly rank: number }[];
}

/**
 * Reads the player's own data (after the actor's data of the player's change form) to its end,
 * in the original's order.
 */
export function readPlayerData(reader: EssReader, resolve: RefIdResolver): EssPlayerData {
  const form = (): number => resolve(reader.refId());
  const u8s = (count: number): void => {
    reader.skip(count);
  };
  const u32s = (count: number): void => {
    reader.skip(4 * count);
  };
  /** A vsval count, then that many entries. */
  const list = <T>(entry: () => T): T[] => {
    const out: T[] = [];
    for (let n = reader.vsval(), i = 0; i < n; i++) out.push(entry());
    return out;
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
  list(() => {
    reader.skip(4 + 8);
  });
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
  // The player's recent velocities: a vector and a game time each.
  list(() => {
    reader.skip(12);
    u32s(1);
  });
  // Forms and references: what the player is in or talking to, the conversation running, ...
  for (let i = 0; i < 8; i++) form();
  // The player's last actions (u32 kind, u32, the object); a count the original writes after
  // the entries (it reserves one byte and widens it), so it reads as any vsval count.
  list(() => {
    u32s(2);
    form();
  });
  const questLog = list(() => ({ quest: form(), stage: reader.u16(), flags: reader.u8() }));
  const objectives = list(() => {
    const quest = form();
    const index = reader.u32();
    const instance = reader.u32();
    reader.u32();
    return { quest, index, instance };
  });
  u32s(5);
  const camera = readCamera(reader, form);
  list(() => {
    form();
    u32s(4);
  });
  form();
  u32s(2);
  form();
  u32s(1);
  // The factions whose owners treat the player as a friend: (faction, two u32).
  list(() => {
    form();
    u32s(2);
  });
  const perks = list(() => ({ perk: form(), rank: reader.u8() }));
  list(form); // the same perks, as a list of forms
  list(() => {
    form();
    u32s(1);
  });
  u8s(1);
  // A byte, 0xFF: none; else a u16 follows.
  if (reader.u8() !== 0xff) reader.u16();
  form();
  reader.skip(12);
  u32s(1);
  for (let i = 0; i < 3; i++) form();
  // The face's tints: three forms, u32, then the tint masks and the overlay tint masks (u32
  // count: tint index u16, colour u32, alpha f32 each), a form.
  for (let i = 0; i < 3; i++) form();
  u32s(1);
  for (let k = 0; k < 2; k++) {
    for (let n = reader.u32(), i = 0; i < n; i++) {
      reader.u16();
      u32s(2);
    }
  }
  form();
  u32s(1);
  form();
  list(() => {
    form();
    reader.skip(8);
  });
  u8s(6);
  list(() => reader.u32());
  form();
  form();
  u8s(1);
  // Form ids written as reference ids, each with two u32.
  list(() => {
    form();
    u32s(2);
  });
  u32s(1);
  u8s(3);
  u32s(1);
  form();
  u8s(1);
  // Whether a transformation's saved state follows (a werewolf's or a vampire lord's): the
  // forms the player had before it.
  if (reader.u8() !== 0) for (let i = 0; i < 8; i++) form();
  u32s(1);
  u8s(3);
  u32s(1);
  u8s(1);
  return { xp, levelThreshold, skills, questLog, objectives, camera, perks };
}

/** The player camera: its switches and fields of view, every state's own data, the state. */
function readCamera(reader: EssReader, form: () => number): EssPlayerCamera {
  reader.skip(2);
  const worldFov = reader.f32();
  const firstPersonFov = reader.f32();
  // First person: three floats and two bytes.
  reader.skip(12 + 2);
  // The third person state and the states built on it (mount, bleedout, dragon): its offset,
  // a float, two more, a byte, a u32 and a node name; mount and dragon add a byte, the
  // reference they follow and a u32.
  const thirdPerson = (): [number, number, number] => {
    const offset = reader.vec3();
    reader.skip(4 + 8 + 1 + 4);
    reader.wstring();
    return offset;
  };
  const thirdPersonOffset = thirdPerson();
  // Written in the original's order: the states with no data (auto vanity, VATS, free, iron
  // sights, furniture, tween menu), mount, transition (no data), bleedout, animated (a third
  // person state), dragon.
  const ridden = (): void => {
    thirdPerson();
    reader.u8();
    form();
    reader.u32();
  };
  ridden();
  thirdPerson();
  thirdPerson();
  ridden();
  const state = reader.u32();
  for (let n = reader.u32(), i = 0; i < n; i++) reader.u32(); // the states stacked under it
  reader.skip(4 + 4 + 1);
  return {
    state,
    thirdPersonOffset,
    worldFov,
    firstPersonFov,
  };
}
