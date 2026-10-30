// The beast forms' perk trees (Dawnguard): the werewolf's on the AVIF AVHealRatePowerMod (named
// "Werewolf"), the vampire lord's on AVMagickaRateMod ("Vampire Lord"). While the player is in a
// beast form (Game.SetBeastForm), the skills menu shows that form's tree alone. Which form is the
// player's race's, by the default objects WerewolfRace (DOBJ RIWR) and VampireRace (RIVR). Its
// perks are bought with the form's own perk points: the globals the default objects
// WerewolfAvailablePerks (AVWP: DLC1WerewolfPerkPoints) and VampireAvailablePerks (AVVP:
// DLC1VampirePerkPoints) name, which the feeding scripts raise (DLC1WerewolfFeedPointsScript,
// DLC1PlayerVampireChangeScript). The same scripts keep the progress to the next point in the
// actor values WerewolfPerks and VampirePerks (feed or blood points over the next perk's, × 100):
// the tree's meter. Platform-independent.
//
// Any other race shows the ring (no case in the data: the werebear, DLC2WerebearBeastRace, has no
// default object, and no script of the load order makes the player one, only Torkild and the
// tribal werebears).

import { actorValueIndex } from '../world/actor-values.ts';

export interface BeastTree {
  /** Which form. */
  readonly form: 'werewolf' | 'vampireLord';
  /** The editor id of the AVIF holding the tree (not the actor value's own name's). */
  readonly avif: string;
  /** The default object (DOBJ use) naming the global that counts the form's perk points. */
  readonly pointsGlobal: string;
  /** The actor value holding the progress to the next perk point (0..100). */
  readonly progress: number;
}

const index = (name: string): number => {
  const value = actorValueIndex(name);
  if (value === undefined) throw new Error(`no actor value ${name}`);
  return value;
};

export const WEREWOLF_TREE: BeastTree = {
  form: 'werewolf',
  avif: 'AVHealRatePowerMod',
  pointsGlobal: 'AVWP',
  progress: index('WerewolfPerks'),
};
export const VAMPIRE_LORD_TREE: BeastTree = {
  form: 'vampireLord',
  avif: 'AVMagickaRateMod',
  pointsGlobal: 'AVVP',
  progress: index('VampirePerks'),
};

/** The default objects (DOBJ uses) of the beast races and the trees they show. */
const BEAST_RACES: readonly (readonly [string, BeastTree])[] = [
  ['RIWR', WEREWOLF_TREE],
  ['RIVR', VAMPIRE_LORD_TREE],
];

/**
 * The tree the skills menu shows instead of the ring: the beast form's the player is in (their
 * race, `defaultObject` the load order's DOBJ), undefined out of a beast form.
 */
export function beastTree(
  beastForm: boolean,
  race: number | undefined,
  defaultObject: (use: string) => number | undefined,
): BeastTree | undefined {
  if (!beastForm || race === undefined) return undefined;
  for (const [use, tree] of BEAST_RACES) if (defaultObject(use) === race) return tree;
  return undefined;
}
