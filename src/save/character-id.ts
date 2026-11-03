// The character a save belongs to, as observed in the original: each character has an id, a
// random u32 drawn as the game first needs one (one not already used by a character of the
// saves known), kept with the game and written into every save's file name
// ("Save3_<id as 8 hex digits>_<modded>_<name>_..."). The Load list groups the saves by it:
// one entry per character, named as its saves name the player. Naming the player in the race
// menu keeps the id while the name is the one the id goes by (or the player was never named);
// another name draws a new id, so a new character's saves are listed apart from the old one's.
// Platform-independent.

import type { SaveHeader } from './save-codec.ts';

/** A new character id: a random u32, never 0 (0 is "none"), not one of `used`. */
export function drawCharacterId(
  used: ReadonlySet<number> = new Set(),
  random: () => number = Math.random,
): number {
  for (;;) {
    const id = Math.floor(random() * 0x100000000) >>> 0;
    if (id !== 0 && !used.has(id)) return id;
  }
}

/**
 * The character id after the player is named in the race menu: the current one while its
 * name is the new one, or while the player was never named; else a new one.
 */
export function namedCharacterId(
  current: number | undefined,
  currentName: string | undefined,
  name: string,
  random?: () => number,
): number {
  if (current !== undefined && current !== 0 && (currentName === undefined || currentName === name))
    return current;
  return drawCharacterId(current === undefined ? new Set() : new Set([current]), random);
}

/** The id an original save's file name carries ("Save1_51FF9A07_0_..."), if it has one. */
export function characterIdOfEssName(fileName: string): number | undefined {
  const match = /^[^_]+_([0-9A-Fa-f]{8})_[01]_/.exec(fileName);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 16);
}

/**
 * The key the Load list groups a save under: its character id, or for a save made before the
 * id was kept, the player's name.
 */
export function characterKey(header: Pick<SaveHeader, 'characterId' | 'playerName'>): string {
  return header.characterId !== undefined
    ? `id:${header.characterId.toString(16)}`
    : `name:${header.playerName}`;
}
