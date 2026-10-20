// The rules of shouts (UESP "Skyrim:Shouts", "Skyrim:Dragon Souls"; the records SHOU and WOOP):
//
// - A shout has up to three words (SHOU SNAM: the word, the spell it casts at that many words,
//   the voice's recovery seconds). An actor shouts as many words as it knows in a row from the
//   first, each needing the one before: the player the words learned (Game.TeachWord, a word
//   wall) and unlocked with a dragon soul (Game.UnlockWord, the magic menu), NPCs all of them.
// - The voice key tapped shouts the first word; held, more: from fShoutTime1 (0.2 s) two, from
//   fShoutTime2 (0.9 s) three (TODO(M13): the settings read as the hold time per word, inferred
//   from their names and values; the graph's shout animations are what the player sees).
// - The shout casts its spell of that many words (runtime.magic) and the voice recovers for that
//   word's recovery time × (1 − ShoutRecoveryMult): the Blessing of Talos's 0.2 is "reduced 20%"
//   (TODO(M13): the actor value read as a share taken off, from the effect's text). Until it has
//   recovered, no shout (the HUD's shout meter flashes); powers share the voice but not its
//   recovery.
// - Unlocking a word costs one dragon soul (the DragonSouls actor value): the first learned and
//   locked word of the shout (sConfirmSpendSoul; sFailSpendSoul without a soul).
//
// Platform-independent. Notes: docs/gameplay.md ("Casting and shouts").

import type { ShoutWord } from '../../world/spell-records.ts';

/** fShoutTime1, fShoutTime2: seconds the voice key is held for a second and a third word. */
export interface ShoutSettings {
  readonly time1: number;
  readonly time2: number;
}

export const SHOUT_DEFAULTS: ShoutSettings = { time1: 0.2, time2: 0.9 };

/**
 * How many words an actor can shout of a shout: its words in order while each is known (the
 * player's learned and unlocked; `known` answers per word).
 */
export function wordsAvailable(
  words: readonly Pick<ShoutWord, 'word'>[],
  known: (word: number) => boolean,
): number {
  let count = 0;
  for (const entry of words) {
    if (!known(entry.word)) break;
    count++;
  }
  return count;
}

/** How many words the voice key held for `seconds` shouts, of `available`. */
export function wordsByHold(
  seconds: number,
  available: number,
  settings: ShoutSettings = SHOUT_DEFAULTS,
): number {
  if (available <= 0) return 0;
  const wanted = seconds >= settings.time2 ? 3 : seconds >= settings.time1 ? 2 : 1;
  return Math.min(wanted, available);
}

/** Seconds the voice recovers after `words` words of a shout (ShoutRecoveryMult taken off). */
export function shoutRecovery(
  words: readonly Pick<ShoutWord, 'recovery'>[],
  count: number,
  recoveryMult: number,
): number {
  const word = words[Math.min(count, words.length) - 1];
  if (!word) return 0;
  return Math.max(0, word.recovery) * Math.max(0, 1 - recoveryMult);
}

/** The HUD's shout meter (0..100: full once the voice has recovered). */
export function shoutMeterPercent(remaining: number, total: number): number {
  if (!(total > 0) || remaining <= 0) return 100;
  return Math.max(0, Math.min(100, 100 * (1 - remaining / total)));
}

/**
 * The word a dragon soul unlocks of a shout: the first learned word that is locked (undefined:
 * none). `learned` answers false for words not learned, true for unlocked ones and 'locked'.
 */
export function wordToUnlock(
  words: readonly Pick<ShoutWord, 'word'>[],
  learned: (word: number) => boolean | 'locked',
): number | undefined {
  for (const entry of words) {
    const state = learned(entry.word);
    if (state === 'locked') return entry.word;
    if (!state) return undefined;
  }
  return undefined;
}
