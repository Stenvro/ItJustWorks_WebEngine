// The beast forms' engine part (the werewolf and the vampire lord, docs/gameplay.md "Beast
// forms"). The change itself is the vanilla scripts' (PlayerWerewolfChangeScript,
// DLC1PlayerVampireChangeScript: the race, the controls, the howls and spells, the feeding and
// the timer that changes the player back); the engine gives them:
//
// - The Werewolf and Vampire Lord archetypes (WerewolfChangeEffect, DLC1VampireChangeEffect; their
//   associated item the beast race, xEdit's MGEF definition): on the player the beast form starts
//   as the effect takes hold (Game.SetBeastForm's flag). From the data: WerewolfChangeEffectScript's
//   first-change branch (the Companions' PlayerIsWerewolfVirgin) calls SetBeastForm(false) and
//   returns before anything of the scripts' own has turned it on.
// - The menus a form keeps shut: the werewolf's the inventory, magic and favorites (UESP
//   "Skyrim:Werewolf": no items, no spells); the vampire lord's the inventory alone, its magic
//   and favorites menus listing only the default object VampireSpells (DOBJ RIVS:
//   DLC1VampireSpellsPowers, Revert Form among them, which the player can reach no other way).
// - The skills menu's tree for the form (beast-perk-trees.ts).
//
// The HUD has no meter of a beast form's own: hudmenu.swf's elements and callbacks name none (its
// modes: HorseMode, WarHorseMode, StealthMode, ...); the form's meters are the beast race's
// health, magicka and stamina. Platform-independent.

import { beastTree } from './beast-perk-trees.ts';

export type BeastForm = 'werewolf' | 'vampireLord';

/** The default object (DOBJ use) naming the form list of the vampire lord's spells and powers. */
export const VAMPIRE_SPELLS = 'RIVS';

/**
 * The beast form the player is in: the form's race's by the default objects WerewolfRace (RIWR)
 * and VampireRace (RIVR); undefined out of a beast form. In a beast form whose race has not
 * changed yet (the change's first seconds), 'changing'.
 */
export function beastFormOf(
  beastForm: boolean,
  race: number | undefined,
  defaultObject: (use: string) => number | undefined,
): BeastForm | 'changing' | undefined {
  if (!beastForm) return undefined;
  return beastTree(beastForm, race, defaultObject)?.form ?? 'changing';
}

/** The menus each form keeps shut (a change under way: as the werewolf's). */
const SHUT: Readonly<Record<BeastForm | 'changing', ReadonlySet<string>>> = {
  werewolf: new Set(['Inventory', 'Magic', 'Favorites']),
  changing: new Set(['Inventory', 'Magic', 'Favorites']),
  vampireLord: new Set(['Inventory']),
};

/** Whether a menu (by its name: "Inventory", "Magic", ...) stays shut in a form. */
export function beastMenuShut(form: BeastForm | 'changing' | undefined, menu: string): boolean {
  return form !== undefined && SHUT[form].has(menu);
}

/**
 * Whether the magic and favorites menus list a spell or shout in a form: the vampire lord's only
 * those of its list (RIVS); out of a beast form, everything. TODO(M13): whether the werewolf's
 * howls are chosen in a menu of the original (its magic menu stays shut here).
 */
export function beastListed(
  form: BeastForm | 'changing' | undefined,
  formId: number,
  vampireSpells: ReadonlySet<number>,
): boolean {
  if (form === undefined) return true;
  return form === 'vampireLord' && vampireSpells.has(formId);
}
