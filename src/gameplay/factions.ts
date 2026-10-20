// Factions as gameplay (docs/gameplay.md, "Crime and factions"): how one actor regards another
// (the Creation Kit's Faction "Interfaction Relations": XNAM combat reactions neutral, enemy,
// ally, friend; its Relationship ranks, RELA; UESP "Skyrim:Factions", "Skyrim:Relationships"),
// the favor that raises a relationship (the iFavor* settings: favor points for friend,
// confidant, ally, lover), and who lets a crime pass (friends overlook minor ones). The combat
// AI (docs/m10-plan.md 5.2) asks `reaction` who is hostile to whom. Platform-independent.

/** FACT XNAM combat reactions (and Faction.SetAlly / SetEnemy's). */
export const CombatReaction = { neutral: 0, enemy: 1, ally: 2, friend: 3 } as const;
export type CombatReaction = (typeof CombatReaction)[keyof typeof CombatReaction];

/** How one actor regards another. */
export type Reaction = 'hostile' | 'neutral' | 'ally' | 'friend';

/** GetRelationshipRank's ranks (RELA: lover 4 .. acquaintance 0 .. archnemesis −4). */
export const RelationshipRank = {
  lover: 4,
  ally: 3,
  confidant: 2,
  friend: 1,
  acquaintance: 0,
  rival: -1,
  foe: -2,
  enemy: -3,
  archnemesis: -4,
} as const;

/** What `reaction` weighs between an actor and another. */
export interface ReactionInputs {
  /** The same actor. */
  readonly self?: boolean;
  /**
   * The combat reactions between their factions (each of the actor's factions towards each of
   * the other's: scripts' SetAlly / SetEnemy first, else XNAM), CombatReaction values.
   */
  readonly factionReactions: readonly number[];
  /** They share a faction that is not Special Combat (its members fight each other). */
  readonly sameFaction: boolean;
  /** GetRelationshipRank between them. */
  readonly relationshipRank: number;
  /** The actor is frenzied (Aggression 3: Frenzy) and attacks anyone. */
  readonly frenzied?: boolean;
  /**
   * Crime makes the actor hostile to the other: a faction of the actor made the other (the
   * player) its enemy (SetPlayerEnemy), or its guards are to attack them (resisting arrest, a
   * bounty with an attack-on-sight faction: crime's guardResponse).
   */
  readonly crimeHostile?: boolean;
  /** A script made the actor hostile to the other (StartCombat; TODO(M10) 5.2 sets it). */
  readonly scriptHostile?: boolean;
}

/**
 * How an actor regards another (Creation Kit: Faction "Combat Reaction", Relationship ranks;
 * CommonLibSSE Actor::GetFactionReaction): itself a friend; frenzied, a crime against them, a
 * script's combat or a relationship of enemy or worse: hostile; else its closest tie: a friend
 * (friend reaction or a relationship of friend or better), an ally (ally reaction, a shared
 * faction), hostile where a faction of its regards one of theirs as an enemy, else neutral.
 * TODO(M13): the engine's precedence between a faction's enmity and another's friendship.
 */
export function reaction(inputs: ReactionInputs): Reaction {
  if (inputs.self) return 'friend';
  if (inputs.frenzied || inputs.crimeHostile || inputs.scriptHostile) return 'hostile';
  if (inputs.relationshipRank <= RelationshipRank.enemy) return 'hostile';
  if (
    inputs.relationshipRank >= RelationshipRank.friend ||
    inputs.factionReactions.includes(CombatReaction.friend)
  ) {
    return 'friend';
  }
  if (inputs.sameFaction || inputs.factionReactions.includes(CombatReaction.ally)) return 'ally';
  if (inputs.factionReactions.includes(CombatReaction.enemy)) return 'hostile';
  return 'neutral';
}

/**
 * Whether an actor of an aggression attacks one it regards so on sight (Creation Kit: the
 * Aggression actor value: 0 unaggressive, 1 aggressive attacks enemies, 2 very aggressive
 * enemies and neutrals, 3 frenzied anyone).
 */
export function attacksOnSight(aggression: number, regard: Reaction): boolean {
  if (aggression >= 3) return true;
  if (aggression >= 2) return regard === 'hostile' || regard === 'neutral';
  if (aggression >= 1) return regard === 'hostile';
  return false;
}

/**
 * Whether a crime against an actor goes unreported because the criminal is its friend (UESP
 * "Skyrim:Crime": friends overlook minor crimes): a relationship of friend or better lets
 * trespassing, stealing and pickpocketing pass; an ally (or a lover) overlooks an assault too;
 * murder no one overlooks.
 */
export function overlooksCrime(
  relationshipRank: number,
  violent: boolean,
  murder: boolean,
): boolean {
  if (murder) return false;
  if (violent) return relationshipRank >= RelationshipRank.ally;
  return relationshipRank >= RelationshipRank.friend;
}

/** The iFavor* settings: favor points at which a relationship reaches a rank. */
export interface FavorSettings {
  readonly favorFriend: number;
  readonly favorConfidant: number;
  readonly favorAlly: number;
  readonly favorLover: number;
}

/**
 * The relationship rank favor points reach (iFavorFriendValue 25, iFavorConfidantValue 50,
 * iFavorAllyValue 100), at least the rank there was: favors and gifts raise a relationship,
 * they never lower it. Lover (iFavorLoverValue 500) is marriage's, which its scripts set
 * (RelationshipMarriage). TODO(M13): the engine's use of the points.
 */
export function rankFromFavor(
  points: number,
  rank: number,
  settings: Omit<FavorSettings, 'favorLover'>,
): number {
  if (points < settings.favorFriend) return rank;
  const reached =
    points >= settings.favorAlly
      ? RelationshipRank.ally
      : points >= settings.favorConfidant
        ? RelationshipRank.confidant
        : RelationshipRank.friend;
  return Math.max(rank, reached);
}
