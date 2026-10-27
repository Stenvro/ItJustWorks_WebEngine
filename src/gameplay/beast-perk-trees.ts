// The beast forms' perk trees (Dawnguard): the werewolf's on the AVIF AVHealRatePowerMod (named
// "Werewolf"), the vampire lord's on AVMagickaRateMod ("Vampire Lord"). While the player is in a beast form (Game.SetBeastForm, their
// race the form's), the skills menu shows that form's tree alone, its perks bought with the form's
// own points (the actor values WerewolfPerks, VampirePerks) instead of the player's perk points.
// Platform-independent.
//
// TODO(M13): that the werebear (DLC2WerebearBeastRace) takes the werewolf's tree, and the meter of
// the form's progress to its next perk, are not read from the engine.

import { actorValueIndex } from '../world/actor-values.ts';

export interface BeastTree {
  /** Which form. */
  readonly form: 'werewolf' | 'vampireLord';
  /** The editor id of the AVIF holding the tree (not the actor value's own name's). */
  readonly avif: string;
  /** The actor value counting the form's perk points. */
  readonly points: number;
}

const index = (name: string): number => {
  const value = actorValueIndex(name);
  if (value === undefined) throw new Error(`no actor value ${name}`);
  return value;
};

const WEREWOLF: BeastTree = {
  form: 'werewolf',
  avif: 'AVHealRatePowerMod',
  points: index('WerewolfPerks'),
};
const VAMPIRE_LORD: BeastTree = {
  form: 'vampireLord',
  avif: 'AVMagickaRateMod',
  points: index('VampirePerks'),
};

/** The beast races (editor ids, lower case) and their trees. */
export const BEAST_TREES: ReadonlyMap<string, BeastTree> = new Map([
  ['werewolfbeastrace', WEREWOLF],
  ['dlc2werebearbeastrace', WEREWOLF],
  ['dlc1vampirebeastrace', VAMPIRE_LORD],
]);

/** The tree the skills menu shows instead of the ring: the beast form's the player is in. */
export function beastTree(
  beastForm: boolean,
  raceEditorId: string | undefined,
): BeastTree | undefined {
  if (!beastForm || raceEditorId === undefined) return undefined;
  return BEAST_TREES.get(raceEditorId.toLowerCase());
}
