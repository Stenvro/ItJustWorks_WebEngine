// What the crosshair offers on a reference (docs/ui.md, "Activation prompts"), observed in the
// original: which references the crosshair takes at all, and each base type's own prompt
// text (its verb over the reference's name, and a third line for an empty or locked one).
//
// The crosshair takes a reference only when it has a name (its display name: an alias's, else
// the base's FULL) and its base is no static (STAT) or static collection (SCOL); a light (LIGH)
// only when it can be carried. Each base type then writes its own prompt, or none:
//
// - an activator (ACTI, TACT): its RNAM verb, else sActivate; an ash pile (linked to the actor
//   it was) sSearch, with sEmpty under it when the actor has nothing;
// - a door: sOpen, or sClose while it is open or opening; a load door is named after where it
//   leads; locked without the player holding its key: sUnlock, its lock's level under it;
// - a container: sSearch; owned (taking from it a crime) sStealFrom; locked sUnlock (its level
//   under it, the key not asked); in a follower's command mode sTakeAll. sEmpty under one with
//   nothing in it. One that shows its owner (CONT DATA 0x4) is named "Owner's Name";
// - a book: sRead, a spell tome sTake (sSteal when owned);
// - flora with an ingredient not yet harvested: sSteal when owned, else its RNAM (an
//   activator's text), else sActivate; a tree (TREE) with one: sHarvest or sSteal;
// - furniture: its model's first marker a sleep marker: sFurnitureSleep (" (sOwned)" after the
//   name when the player may not use it); a sit marker without the Special Furniture keyword
//   (DOBJ SPFK): sSit; else, and for every workbench, sUse;
// - a projectile reference that can be picked up, and every other base (items, movable
//   statics, ...): sTake or sSteal, " (count)" after the name for a stack;
// - an actor: one an actor commands (a summon) only "Commander's Name"; dead, sSearch (sEmpty
//   under it when it carries nothing); a horse the player may ride sRide, or sSteal; sneaking,
//   one whose race allows pickpocketing (and not the player's teammate) sPickpocket, any other
//   (not a teammate) nothing; else sTalk when it may talk to the player (Actor.AllowPCDialogue,
//   else its race's Allow PC Dialogue), else nothing.
//
// The third line is the HUD's diamond marker and the word (InterfaceStrings' marker image).
// Platform-independent.

/** What a prompt's verb is: a game setting's text, or a record's own text (RNAM). */
export type PromptVerb = { readonly setting: string } | { readonly text: string };

/** What the crosshair shows on a reference. */
export interface ActivationPrompt {
  readonly verb: PromptVerb;
  /** The reference's name as the prompt shows it (with an owner, a count, "(Owned)"). */
  readonly name: string;
  /** A third line's game setting (sEmpty, a lock level's sLockLevelName...), if any. */
  readonly detail?: string;
  /** A game setting whose text follows the name in brackets (an owned bed's sOwned). */
  readonly nameSuffix?: string;
  /** Doing it is a crime (the verb is the red sSteal, sStealFrom). */
  readonly crime?: boolean;
}

/** Base types the crosshair never takes. */
const NEVER = new Set(['STAT', 'SCOL']);

/** Whether the crosshair takes a reference: a name, not a static; a light only if carried. */
export function crosshairTakes(baseType: string, name: string, carryable = false): boolean {
  if (name === '' || NEVER.has(baseType)) return false;
  return baseType !== 'LIGH' || carryable;
}

/** What the prompt rule reads of a placed object. */
export interface ObjectPromptFacts {
  /** The base's record type (ACTI, DOOR, CONT, ...). */
  readonly baseType: string;
  /** Its display name (empty: none). */
  readonly name: string;
  /** XCNT: how many it is (a stack shows "(n)"). */
  readonly count?: number;
  /** Taking or using it is a crime (owned, and the player may not). */
  readonly crime?: boolean;
  /** ACTI, TACT, FLOR RNAM: its own verb. */
  readonly activateText?: string;
  /** LIGH: Can Be Carried. */
  readonly carryable?: boolean;
  /** FLOR, TREE: its ingredient (PFIG) is there to harvest (not harvested since it grew). */
  readonly harvestable?: boolean;
  /** BOOK: a spell tome (it teaches a spell). */
  readonly teachesSpell?: boolean;
  /** DOOR, CONT: its lock now (`level`: its sLockLevelName setting). */
  readonly lock?: { readonly level: string; readonly playerHasKey: boolean };
  /** DOOR: open or opening now; a load door's destination name. */
  readonly open?: boolean;
  readonly destination?: string;
  /** CONT: nothing in it; its owner's name when it shows its owner (CONT DATA 0x4). */
  readonly empty?: boolean;
  readonly shownOwner?: string;
  /** FURN: its first marker's type; a workbench; the Special Furniture keyword. */
  readonly furniture?: {
    readonly firstMarker: 'sit' | 'sleep' | 'lean' | undefined;
    readonly workbench: boolean;
    readonly special: boolean;
  };
  /** ACTI: an ash pile, the actor it was carrying nothing (`empty`). */
  readonly ashPile?: { readonly empty: boolean };
  /** PROJ: it can be picked up (an arrow). */
  readonly pickUp?: boolean;
  /** A follower's command mode is on (containers: Take All). */
  readonly favor?: boolean;
}

const take = (facts: ObjectPromptFacts, name: string): ActivationPrompt =>
  facts.crime === true
    ? { verb: { setting: 'sSteal' }, name, crime: true }
    : { verb: { setting: 'sTake' }, name };

/** The prompt of a placed object, or undefined where the crosshair shows nothing. */
export function objectPrompt(facts: ObjectPromptFacts): ActivationPrompt | undefined {
  const { name } = facts;
  if (!crosshairTakes(facts.baseType, name, facts.carryable)) return undefined;
  switch (facts.baseType) {
    case 'ACTI':
    case 'TACT': {
      if (facts.ashPile) {
        return {
          verb: { setting: 'sSearch' },
          name,
          ...(facts.ashPile.empty && { detail: 'sEmpty' }),
        };
      }
      return { verb: verbOf(facts.activateText), name };
    }
    case 'DOOR': {
      const named = facts.destination ?? name;
      if (facts.lock && !facts.lock.playerHasKey) {
        return { verb: { setting: 'sUnlock' }, name: named, detail: facts.lock.level };
      }
      if (facts.destination !== undefined) return { verb: { setting: 'sOpen' }, name: named };
      return { verb: { setting: facts.open === true ? 'sClose' : 'sOpen' }, name };
    }
    case 'CONT': {
      const named = facts.shownOwner ? `${facts.shownOwner}'s ${name}` : name;
      const verb =
        facts.favor === true && !facts.lock && facts.crime !== true
          ? 'sTakeAll'
          : facts.crime === true
            ? 'sStealFrom'
            : facts.lock
              ? 'sUnlock'
              : 'sSearch';
      const detail = facts.empty === true ? 'sEmpty' : facts.lock?.level;
      return {
        verb: { setting: verb },
        name: named,
        ...(detail !== undefined && { detail }),
        ...(verb === 'sStealFrom' && { crime: true }),
      };
    }
    case 'BOOK':
      return facts.teachesSpell === true ? take(facts, name) : { verb: { setting: 'sRead' }, name };
    case 'FLOR':
      if (facts.harvestable !== true) return undefined;
      if (facts.crime === true) return { verb: { setting: 'sSteal' }, name, crime: true };
      return { verb: verbOf(facts.activateText), name };
    case 'TREE':
      if (facts.harvestable !== true) return undefined;
      return facts.crime === true
        ? { verb: { setting: 'sSteal' }, name, crime: true }
        : { verb: { setting: 'sHarvest' }, name };
    case 'FURN': {
      const furniture = facts.furniture;
      if (!furniture || furniture.workbench) return { verb: { setting: 'sUse' }, name };
      if (furniture.firstMarker === 'sleep') {
        return {
          verb: { setting: 'sFurnitureSleep' },
          name,
          ...(facts.crime === true && { nameSuffix: 'sOwned' }),
        };
      }
      if (furniture.firstMarker === 'sit' && !furniture.special)
        return { verb: { setting: 'sSit' }, name };
      return { verb: { setting: 'sUse' }, name };
    }
    case 'PROJ':
      if (facts.pickUp !== true) return undefined;
      return take(facts, counted(name, facts.count));
    default:
      return take(facts, counted(name, facts.count));
  }
}

/** A record's own verb (RNAM), else sActivate. */
function verbOf(text: string | undefined): PromptVerb {
  return text !== undefined && text !== '' ? { text } : { setting: 'sActivate' };
}

/** A stack's name: "Name (n)" from two up. */
function counted(name: string, count: number | undefined): string {
  return count !== undefined && count >= 2 ? `${name} (${count})` : name;
}

/** What the prompt rule reads of an actor. */
export interface ActorPromptFacts {
  /** Its display name (empty: none). */
  readonly name: string;
  readonly dead: boolean;
  /** Dead and carrying nothing. */
  readonly empty?: boolean;
  /** The name of the actor that commands it (a summon's, a reanimated corpse's), if any. */
  readonly commander?: string;
  /** The language writes "Commander's Name" (English), else "Commander - Name". */
  readonly possessive?: boolean;
  /** A mount the player may ride now; riding it is stealing it. */
  readonly rideable?: boolean;
  readonly stealsRide?: boolean;
  /** The player sneaks. */
  readonly sneaking: boolean;
  /** Its race's Allow Pickpocket. */
  readonly pickpocketable: boolean;
  /** The player's teammate (a follower). */
  readonly teammate: boolean;
  /** It may talk to the player (Actor.AllowPCDialogue, else its race's Allow PC Dialogue). */
  readonly talks: boolean;
}

/** The prompt of an actor, or undefined where the crosshair shows nothing. */
export function actorPrompt(facts: ActorPromptFacts): ActivationPrompt | undefined {
  const { name } = facts;
  if (name === '') return undefined;
  // One an actor commands shows only whose it is (no verb, not even a dead one's search).
  if (facts.commander !== undefined && facts.commander !== '') {
    const label =
      facts.possessive === false ? `${facts.commander} - ${name}` : `${facts.commander}'s ${name}`;
    return { verb: { text: '' }, name: label };
  }
  if (facts.dead) {
    return {
      verb: { setting: 'sSearch' },
      name,
      ...(facts.empty === true && { detail: 'sEmpty' }),
    };
  }
  if (facts.rideable === true) {
    return facts.stealsRide === true
      ? { verb: { setting: 'sSteal' }, name, crime: true }
      : { verb: { setting: 'sRide' }, name };
  }
  if (facts.sneaking && !facts.teammate) {
    return facts.pickpocketable ? { verb: { setting: 'sPickpocket' }, name } : undefined;
  }
  return facts.talks ? { verb: { setting: 'sTalk' }, name } : undefined;
}
