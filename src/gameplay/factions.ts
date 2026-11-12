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
   * the other's: scripts' SetAlly / SetEnemy first, else XNAM), CombatReaction values. A faction
   * both are in that names a reaction to itself is among them as any other pair, and its
   * membership adds nothing (`sameFaction`): some name themselves enemies to set their members
   * on each other (DA02CultistsAreEnemies, WE19BanditFaction), and MQ101TemporaryFriendsFaction,
   * its own friend while the opening's Imperials and Stormcloaks must not fight, is set neutral
   * to itself by MQ101 stage 270's SetEnemy(itself, true, true) so that the keep's two sides
   * (CWImperialFactionNPC and CWSonsFactionNPC, enemies) fight.
   */
  readonly factionReactions: readonly number[];
  /**
   * They share a faction that names no reaction to itself and is not Special Combat (FACT DATA
   * 0x2): its members are allies. The town, crime and guard factions name none
   * (TownWhiterunFaction, CrimeFactionWhiterun, IsGuardFaction, CWImperialFactionNPC): Whiterun's
   * citizens and guards help each other by them.
   */
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
  /**
   * A script made the actor hostile to the other (StartCombat: its combatTargets, until
   * StopCombat or its combat ends; TODO(M13): how long the engine keeps it is not documented).
   */
  readonly scriptHostile?: boolean;
}

/**
 * How an actor regards another (Creation Kit: Faction "Combat Reaction", Relationship ranks;
 * CommonLibSSE Actor::GetFactionReaction): itself a friend; frenzied, a crime against them, a
 * script's combat or a relationship of enemy or worse: hostile; else its closest tie: a friend
 * (friend reaction or a relationship of friend or better), an ally (ally reaction), hostile
 * where a faction of its regards one of theirs as an enemy, an ally where they share a faction
 * (`sameFaction`), else neutral. A shared faction weighs less than a named enmity (inferred,
 * TODO(M13)): the data needs it so. Sovngarde's heroes and Alduin share FavorExcludedFaction, a
 * list of those left out of favors, and MQ304AlduinFaction names MQAncientHeroFaction an enemy;
 * MQ305 has them fight. TODO(M13): inferred: the engine's precedence between a faction's enmity
 * and another's friendship, and that a shared faction's reaction to itself goes before the
 * alliance its membership makes.
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
  if (inputs.factionReactions.includes(CombatReaction.ally)) return 'ally';
  if (inputs.factionReactions.includes(CombatReaction.enemy)) return 'hostile';
  return inputs.sameFaction ? 'ally' : 'neutral';
}

/** What the ties between two actors' factions are read from (the running game's factions). */
export interface FactionFacts {
  /**
   * A faction's combat reaction to another (CombatReaction: a script's SetAlly / SetEnemy, else
   * XNAM), if it names one.
   */
  factionReaction(faction: number, other: number): Promise<number | undefined>;
  /** Whether a faction is Special Combat (FACT DATA 0x2). */
  specialCombat(faction: number): Promise<boolean>;
}

/**
 * The ties between an actor's factions and another's (each faction to its rank; −1: listed,
 * not a member yet), as `reaction` weighs them: the combat reactions of each of the actor's
 * factions towards each of the other's (`factionReactions`; a faction both are in that names a
 * reaction to itself among them as any other pair), and whether they share a faction that names
 * no reaction to itself and is not Special Combat (`sameFaction`). The reactions go one way: only
 * the actor's own factions say how it regards the other, never the other's towards it (the data
 * is built so: 123 XNAM reactions are named on one side only, and DLC2CultistAmbush, whose
 * location is a town or a capital, places DLC2LvlCultistNonHostile cultists in
 * DLC2CultistFaction, which names IsGuardFaction an enemy, unaggressive (Aggression 0,
 * WEPlayerFriend, dunPrisonerFaction) until its stage 10 turns them on the player and so on the
 * guards (WEPlayerEnemy, Aggression 1); were the guards to read the cultists' enmity as their
 * own, they would fall on the cultists as they come, and that turn would mean nothing). Where the
 * other's factions name one of the actor's an enemy, a faction they share makes no alliance
 * (inferred, TODO(M13): Sovngarde's heroes and Alduin share FavorExcludedFaction, and only
 * MQ304AlduinFaction names MQAncientHeroFaction, an enemy; the heroes, who name none of
 * Alduin's, would otherwise stand by as his allies while he fights the player they help). The
 * one rule of the running game's reactions (CrimeEngine.reaction) and of the combat AI's tests
 * and tools (combatReaction).
 */
export async function factionTies(
  facts: FactionFacts,
  mine: ReadonlyMap<number, number>,
  theirs: ReadonlyMap<number, number>,
): Promise<Pick<ReactionInputs, 'factionReactions' | 'sameFaction'>> {
  const factionReactions: number[] = [];
  let sameFaction = false;
  for (const [faction, rank] of mine) {
    if (rank < 0) continue;
    if (
      !sameFaction &&
      (theirs.get(faction) ?? -1) >= 0 &&
      (await facts.factionReaction(faction, faction)) === undefined &&
      !(await facts.specialCombat(faction))
    ) {
      sameFaction = true;
    }
    for (const [other, otherRank] of theirs) {
      if (otherRank < 0) continue;
      const value = await facts.factionReaction(faction, other);
      if (value !== undefined) factionReactions.push(value);
    }
  }
  if (sameFaction && !factionReactions.includes(CombatReaction.enemy)) {
    search: for (const [other, otherRank] of theirs) {
      if (otherRank < 0) continue;
      for (const [faction, rank] of mine) {
        if (rank < 0) continue;
        if ((await facts.factionReaction(other, faction)) === CombatReaction.enemy) {
          sameFaction = false;
          break search;
        }
      }
    }
  }
  return { factionReactions, sameFaction };
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

/** The favor points a relationship rank stands for (the iFavor* thresholds; below friend none). */
export function rankFavorPoints(rank: number, settings: FavorSettings): number {
  if (rank >= RelationshipRank.lover) return settings.favorLover;
  if (rank >= RelationshipRank.ally) return settings.favorAlly;
  if (rank >= RelationshipRank.confidant) return settings.favorConfidant;
  if (rank >= RelationshipRank.friend) return settings.favorFriend;
  return 0;
}

/**
 * Whether an actor does the player a favor of a cost (a commanded follower's: the favor cost a
 * reference carries, REFR XFVC): its price, iCrimeFavorBaseValue + the cost × fCrimeFavorMult
 * (0 and 1: the cost itself), within the favor points its relationship with the player stands
 * for (rankFavorPoints). A favor without a cost is always done. Inferred, TODO(M13): the original
 * reads the two settings only in its check of a favor's cost against the relationship rank; the
 * comparison's form is not read. Vanilla gives a cost to two references (MQ102RikkeWaitMarker
 * 25, a table 10).
 */
export function doesFavor(
  relationshipRank: number,
  cost: number,
  settings: FavorSettings & { readonly favorBaseValue: number; readonly favorMult: number },
): boolean {
  if (!(cost > 0)) return true;
  const price = settings.favorBaseValue + cost * settings.favorMult;
  return price <= rankFavorPoints(relationshipRank, settings);
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
