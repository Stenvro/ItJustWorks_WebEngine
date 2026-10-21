// Condition functions (CTDA) of crime and factions, on the running game (crime-engine.ts): the
// player's crime gold with the subject's crime faction (GetCrimeGold, ...Violent,
// ...Nonviolent, CanPayCrimeGold: DialogueCrimeGuards' lines), guards and arrests (IsGuard,
// GetArrestingActor, GetBribeSuccess), trespassing (IsTrespassing, GetTrespassWarningLevel,
// IsInMyOwnedCell), known crimes (GetCrimeKnown, GetCrime), standing with factions
// (GetPCExpelled, GetPCEnemyofFaction, GetPCInFaction, GetIsCrimeFaction,
// GetInSharedCrimeFaction, GetFactionRelation, GetFactionCombatReaction, GetFactionReaction),
// relationships' associations (HasAssociationType, HasFamilyRelationship,
// HasParentRelationship), ownership (IsOwner, IsCellOwner), stolen goods and horses
// (GetStolenItemValue, ...NoCrime, IsHorseStolen) and jail (GetDaysInJail, IsPCAMurderer).
// Indices: UESP "Skyrim Mod:Function Indices". condition-values.ts asks here for the
// functions it does not value itself. Platform-independent.

import type { CrimeType } from '../../gameplay/crime.ts';
import type { Condition } from '../conditions.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** UESP's function indices of the conditions valued here. */
export const CrimeFn = {
  getCrimeKnown: 119,
  getCrime: 122,
  isGuard: 125,
  getPCInFaction: 132,
  getTrespassWarningLevel: 144,
  isTrespassing: 145,
  isInMyOwnedCell: 146,
  getIsCrimeFaction: 152,
  getFactionReaction: 167,
  isPCAMurderer: 176,
  getPCExpelled: 193,
  getPCEnemyofFaction: 197,
  hasAssociationType: 258,
  hasFamilyRelationship: 259,
  hasParentRelationship: 261,
  isOwner: 278,
  isCellOwner: 280,
  isHorseStolen: 282,
  getStolenItemValueNoCrime: 366,
  getStolenItemValue: 373,
  getCrimeGoldViolent: 375,
  getCrimeGoldNonviolent: 376,
  getFactionCombatReaction: 410,
  getFactionRelation: 449,
  getCrimeGold: 459,
  canPayCrimeGold: 497,
  getDaysInJail: 499,
  getInSharedCrimeFaction: 652,
  getBribeSuccess: 654,
  getIntimidateSuccess: 655,
  getArrestingActor: 657,
} as const;

/** GetFactionRelation's codes: 0 neutral, 1 enemy, 2 ally, 3 friend. */
const RELATION_CODES = { neutral: 0, hostile: 1, ally: 2, friend: 3 } as const;
/** The gold item. */
const GOLD = 0xf;

/**
 * A crime condition's value for a reference (undefined: not one valued here). `quest`: the
 * condition's quest, for parameters that are its aliases (the CTDA's Use aliases flag).
 */
export async function crimeConditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  reference: number | undefined,
  quest: number | undefined,
): Promise<number | undefined> {
  const { state, actors, crime } = runtime;
  const flag = (value: boolean): number => (value ? 1 : 0);
  const form = condition.form;
  /** A parameter that names a reference: an alias's with Use aliases, else the form. */
  const parameter = (raw: number, formId: number): number | undefined => {
    if (condition.useAliases) {
      return quest === undefined ? undefined : state.quests.get(quest)?.aliases.get(raw);
    }
    return formId === 0 ? undefined : formId;
  };
  /** The faction a crime-gold question is about: the one named, else the subject's. */
  const crimeFaction = async (): Promise<number | undefined> =>
    form !== 0 ? form : reference === undefined ? undefined : actors.crimeFaction(reference);
  const base = async (actor: number): Promise<number | undefined> =>
    actor === PLAYER_REF ? PLAYER_BASE : runtime.baseOf(actor);
  switch (condition.function) {
    case CrimeFn.getCrimeGold:
    case CrimeFn.getCrimeGoldViolent:
    case CrimeFn.getCrimeGoldNonviolent: {
      const faction = await crimeFaction();
      if (faction === undefined) return 0;
      const { violent, nonviolent } = crime.bounty(faction);
      return condition.function === CrimeFn.getCrimeGoldViolent
        ? violent
        : condition.function === CrimeFn.getCrimeGoldNonviolent
          ? nonviolent
          : violent + nonviolent;
    }
    case CrimeFn.canPayCrimeGold: {
      const faction = await crimeFaction();
      if (faction === undefined) return 1;
      const { violent, nonviolent } = crime.bounty(faction);
      return flag((await runtime.itemCount(PLAYER_REF, GOLD)) >= violent + nonviolent);
    }
    case CrimeFn.isGuard:
      return reference === undefined ? undefined : flag(await crime.isGuard(reference));
    case CrimeFn.getArrestingActor:
      return flag(reference !== undefined && state.crime.arrestingGuard === reference);
    case CrimeFn.getBribeSuccess:
      // The player can pay what the subject's bribe takes (GetBribeAmount).
      return reference === undefined
        ? undefined
        : flag((await runtime.itemCount(PLAYER_REF, GOLD)) >= (await crime.bribeAmount(reference)));
    // The player's intimidation of the subject succeeds (the perks: Intimidation).
    case CrimeFn.getIntimidateSuccess:
      return reference === undefined ? undefined : flag(await crime.intimidateSucceeds(reference));
    case CrimeFn.isTrespassing:
      return flag(
        reference === PLAYER_REF &&
          (await crime.trespassing((await runtime.placement(PLAYER_REF))?.cell)),
      );
    case CrimeFn.getTrespassWarningLevel:
      return reference === PLAYER_REF ? state.crime.trespassWarnings : 0;
    case CrimeFn.isInMyOwnedCell: {
      if (reference === undefined) return undefined;
      const cell = (await runtime.placement(reference))?.cell;
      if (cell === undefined) return 0;
      const owner = await runtime.cellOwner(cell);
      if (owner.actor !== undefined) return flag(owner.actor === (await base(reference)));
      return flag(
        owner.faction !== undefined && (await actors.factionRank(reference, owner.faction)) >= 0,
      );
    }
    case CrimeFn.getCrimeKnown: {
      // GetCrimeKnown(crime type, criminal): a crime of the type by the criminal against the
      // subject is known.
      const criminal = parameter(condition.param2, condition.form2);
      return flag(
        criminal !== undefined &&
          crime.ledger.known(condition.raw1 as CrimeType, criminal, reference),
      );
    }
    case CrimeFn.getCrime: {
      // GetCrime(criminal, crime type): the subject was the victim of that crime by them.
      const criminal = parameter(condition.raw1, form);
      return flag(
        criminal !== undefined &&
          crime.ledger.known(condition.param2 as CrimeType, criminal, reference),
      );
    }
    case CrimeFn.getIsCrimeFaction:
      return reference === undefined
        ? undefined
        : flag((await actors.crimeFaction(reference)) === form);
    case CrimeFn.getInSharedCrimeFaction: {
      const other = parameter(condition.raw1, form) ?? PLAYER_REF;
      if (reference === undefined) return undefined;
      const [mine, theirs] = await Promise.all([
        actors.crimeFaction(reference),
        actors.crimeFaction(other),
      ]);
      if (mine === undefined || theirs === undefined) return 0;
      return flag(mine === theirs || (await crime.crimeGroup(mine)).includes(theirs));
    }
    case CrimeFn.getPCInFaction:
      return flag((await actors.factionRank(PLAYER_REF, form)) >= 0);
    case CrimeFn.getPCExpelled:
      return flag(state.factions.get(form)?.playerExpelled === true);
    case CrimeFn.getPCEnemyofFaction:
      return flag(state.factions.get(form)?.playerEnemy === true);
    case CrimeFn.getFactionRelation: {
      // How the subject regards the other (the player when none is named).
      const other = parameter(condition.raw1, form) ?? PLAYER_REF;
      if (reference === undefined) return undefined;
      return RELATION_CODES[await crime.reaction(reference, other)];
    }
    case CrimeFn.getFactionCombatReaction:
      // GetFactionCombatReaction(faction, faction): the first's combat reaction to the second.
      return (await actors.factionReaction(form, condition.form2)) ?? 0;
    case CrimeFn.getFactionReaction: {
      // The first faction's reaction modifier to the second (scripts' SetReaction, else XNAM).
      const set = state.factions.get(form)?.reactionModifiers.get(condition.form2);
      if (set !== undefined) return set;
      return (
        (await actors.faction(form))?.reactions.find((entry) => entry.faction === condition.form2)
          ?.modifier ?? 0
      );
    }
    case CrimeFn.hasAssociationType: {
      // HasAssociationType(other, association type).
      const other = parameter(condition.raw1, form);
      if (reference === undefined || other === undefined) return 0;
      const relation = await actors.relationshipRecord(reference, other);
      return flag(relation?.association !== undefined && relation.association === condition.form2);
    }
    case CrimeFn.hasFamilyRelationship: {
      const other = parameter(condition.raw1, form);
      if (reference === undefined || other === undefined) return 0;
      const association = (await actors.relationshipRecord(reference, other))?.association;
      const data =
        association === undefined
          ? undefined
          : (await runtime.forms.record(association))?.fields.first('DATA');
      // ASTP DATA 0x1: a family association.
      return flag(((data?.[0] ?? 0) & 0x1) !== 0);
    }
    case CrimeFn.hasParentRelationship: {
      // The other is the subject's parent: their RELA's parent, of a parent-child association.
      const other = parameter(condition.raw1, form);
      if (reference === undefined || other === undefined) return 0;
      const relation = await actors.relationshipRecord(reference, other);
      if (relation?.association === undefined) return 0;
      const editorId = (await runtime.forms.record(relation.association))?.editorId ?? '';
      return flag(
        /parent/i.test(editorId) && relation.parent === (await actors.relationshipBase(other)),
      );
    }
    case CrimeFn.isOwner: {
      // IsOwner(owner): the subject reference's owner (an actor base or a faction) is it; none
      // named: the player.
      if (reference === undefined) return undefined;
      const owner = await crime.ownerOf(reference);
      const named = form === 0 ? PLAYER_BASE : form;
      return flag(owner.actor === named || owner.faction === named);
    }
    case CrimeFn.isCellOwner: {
      // IsCellOwner(cell, owner).
      const owner = await runtime.cellOwner(form);
      return flag(owner.actor === condition.form2 || owner.faction === condition.form2);
    }
    case CrimeFn.isHorseStolen:
      return flag(reference !== undefined && state.crime.stolenHorses.has(reference));
    case CrimeFn.getStolenItemValue:
    case CrimeFn.getStolenItemValueNoCrime:
      return crime.stolenValue(PLAYER_REF, form, condition.function === CrimeFn.getStolenItemValue);
    case CrimeFn.getDaysInJail:
      return runtime.stats.get('days jailed') ?? 0;
    case CrimeFn.isPCAMurderer:
      return flag((runtime.stats.get('murders') ?? 0) > 0);
    default:
      return undefined;
  }
}
