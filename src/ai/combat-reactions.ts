// How one actor regards another in a fight (CommonLibSSE FIGHT_REACTION: neutral, enemy, ally,
// friend; docs/ai.md, "Combat AI"): what the combat AI weighs against an actor's aggression
// (who it attacks on sight) and assistance (whom it helps), and what IsHostileToActor,
// GetShouldAttack and GetFactionRelation answer.
//
// Callers ask `reactionsOf(runtime).reaction(actor, other)`: the rules below that crime does not
// weigh (summons and the commanded, the player's teammates, those attacked on sight), then crime
// and factions' `runtime.crime.reaction` (factions, relationships, frenzy, bounties and guards:
// src/scripting/runtime/crime-engine.ts). `combatReaction` keeps all of the rules on its own
// (without crime) for tests and tools. The rules, most plausible where undocumented (TODO(M13)):
//
// - one's summons, reanimated and commanded actors (the magic system's commander) are its allies
//   and share its reactions; the player's teammates are the player's allies and each other's;
// - one that scripts set to be attacked on sight (SetAttackActorOnSight) is everyone's enemy;
// - a relationship (RELA, SetRelationshipRank) other than acquaintance or rival decides: ally
//   (3) and lover (4) ally, friend and confidant (1, 2) friend, foe and worse (−2 .. −4) enemy;
// - else the factions: the combat reactions (FACT XNAM: 0 neutral, 1 enemy, 2 ally, 3 friend;
//   scripts' SetAlly / SetEnemy over them) of each faction the actor is a member of (rank 0 or
//   more) towards each faction the other is a member of, the closest bond winning (ally, then
//   friend, then enemy, then neutral). Vanilla factions list themselves (BanditFaction: ally
//   to BanditFaction), so faction-mates are not allies by themselves. Where the actor's factions
//   name none of the other's, the other's towards the actor's count. A crime faction set as the
//   player's enemy (SetPlayerEnemy) is an enemy faction to the player.
//
// Platform-independent.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

/** FACT XNAM combat reactions (CommonLibSSE FIGHT_REACTION). */
export const FightReaction = {
  neutral: 0,
  enemy: 1,
  ally: 2,
  friend: 3,
} as const;

/** What reactions are made of (the running game's factions, relationships and effects). */
export interface ReactionFacts {
  /** The factions an actor is in, with its rank (−1: listed, not a member yet). */
  factionsOf(actor: number): Promise<ReadonlyMap<number, number>>;
  /** A faction's combat reaction to another (FightReaction), if it names it. */
  factionReaction(faction: number, other: number): Promise<number | undefined>;
  /** A crime faction scripts set as the player's enemy (SetPlayerEnemy). */
  playerEnemy(faction: number): boolean;
  /** GetRelationshipRank: 4 lover .. 0 acquaintance .. −4 archnemesis. */
  relationshipRank(a: number, b: number): Promise<number>;
  /** A teammate of the player (SetPlayerTeammate). */
  teammate(actor: number): boolean;
  /** Who summoned, reanimated or commands it (the magic system). */
  commander(actor: number): number | undefined;
  /** Scripts set it to be attacked on sight (SetAttackActorOnSight). */
  attackedOnSight(actor: number): boolean;
}

/** How bonds rank against each other when an actor's factions disagree: the closest wins. */
const BOND = [1, 2, 4, 3] as const;

/** The closer of two reactions (ally, then friend, then enemy, then neutral). */
export function closerBond(a: number, b: number): number {
  return (BOND[b] ?? 0) > (BOND[a] ?? 0) ? b : a;
}

/** A relationship rank's reaction (undefined: acquaintances and rivals leave it to factions). */
export function relationshipReaction(rank: number): number | undefined {
  if (rank >= 3) return FightReaction.ally;
  if (rank >= 1) return FightReaction.friend;
  if (rank <= -2) return FightReaction.enemy;
  return undefined;
}

/** How `actor` regards `other` (FightReaction). */
export async function combatReaction(
  facts: ReactionFacts,
  actor: number,
  other: number,
): Promise<number> {
  return reactionWith(facts, actor, other, 0);
}

async function reactionWith(
  facts: ReactionFacts,
  actor: number,
  other: number,
  depth: number,
): Promise<number> {
  if (actor === other) return FightReaction.ally;
  // Summons and the commanded: their commander's allies, with its reactions.
  const mine = facts.commander(actor);
  const theirs = facts.commander(other);
  if (mine === other || theirs === actor || (mine !== undefined && mine === theirs)) {
    return FightReaction.ally;
  }
  if (depth < 2) {
    if (mine !== undefined) return reactionWith(facts, mine, other, depth + 1);
    if (theirs !== undefined) return reactionWith(facts, actor, theirs, depth + 1);
  }
  // The player and their teammates.
  const team = (reference: number): boolean =>
    reference === PLAYER_REF || facts.teammate(reference);
  if (team(actor) && team(other) && (facts.teammate(actor) || facts.teammate(other))) {
    return FightReaction.ally;
  }
  if (facts.attackedOnSight(other)) return FightReaction.enemy;
  const related = relationshipReaction(await facts.relationshipRank(actor, other));
  if (related !== undefined) return related;
  const [own, others] = await Promise.all([facts.factionsOf(actor), facts.factionsOf(other)]);
  const found = await factionsReaction(facts, own, others, other === PLAYER_REF);
  if (found !== undefined) return found;
  return (
    (await factionsReaction(facts, others, own, actor === PLAYER_REF)) ?? FightReaction.neutral
  );
}

/** The closest bond any of `own` factions has to any of `others` (undefined: none named). */
async function factionsReaction(
  facts: ReactionFacts,
  own: ReadonlyMap<number, number>,
  others: ReadonlyMap<number, number>,
  towardsPlayer: boolean,
): Promise<number | undefined> {
  let found: number | undefined;
  for (const [faction, rank] of own) {
    if (rank < 0) continue;
    if (towardsPlayer && facts.playerEnemy(faction)) {
      found = found === undefined ? FightReaction.enemy : closerBond(found, FightReaction.enemy);
    }
    for (const [other, otherRank] of others) {
      if (otherRank < 0) continue;
      const reaction = await facts.factionReaction(faction, other);
      if (reaction === undefined) continue;
      found = found === undefined ? reaction : closerBond(found, reaction);
    }
  }
  return found;
}

/** The facts of the running game (src/scripting/runtime). */
export function reactionFacts(runtime: ScriptRuntime): ReactionFacts {
  return {
    factionsOf: (actor) => runtime.actors.factionsOf(actor),
    factionReaction: (faction, other) => runtime.actors.factionReaction(faction, other),
    playerEnemy: (faction) => runtime.state.factions.get(faction)?.playerEnemy === true,
    relationshipRank: (a, b) => runtime.actors.relationshipRank(a, b),
    teammate: (actor) => runtime.state.actors.get(actor)?.playerTeammate === true,
    commander: (actor) => runtime.magic.commander(actor),
    attackedOnSight: (actor) => runtime.state.actors.get(actor)?.attackOnSight === true,
  };
}

/** A reaction by name, as crime and factions (M11) give it. */
export type ReactionName = 'hostile' | 'neutral' | 'ally' | 'friend';

/** FightReaction of a reaction by name. */
export function fightReaction(name: ReactionName): number {
  switch (name) {
    case 'hostile':
      return FightReaction.enemy;
    case 'ally':
      return FightReaction.ally;
    case 'friend':
      return FightReaction.friend;
    default:
      return FightReaction.neutral;
  }
}

/** What the combat AI asks of crime and factions (M11's `runtime.crime`, by the same name). */
export interface ActorReactions {
  /** How `actor` regards `other`. */
  reaction(actor: number, other: number): Promise<ReactionName>;
}

const known = new WeakMap<ScriptRuntime, ActorReactions>();

/** The reactions of the running game: the combat-only rules, then crime and factions'. */
export function reactionsOf(runtime: ScriptRuntime): ActorReactions {
  let reactions = known.get(runtime);
  if (!reactions) {
    const facts = reactionFacts(runtime);
    reactions = { reaction: (actor, other) => withCrime(runtime, facts, actor, other, 0) };
    known.set(runtime, reactions);
  }
  return reactions;
}

/** The commander, teammate and attacked-on-sight rules (reactionWith's), else crime's. */
async function withCrime(
  runtime: ScriptRuntime,
  facts: ReactionFacts,
  actor: number,
  other: number,
  depth: number,
): Promise<ReactionName> {
  if (actor === other) return 'ally';
  const mine = facts.commander(actor);
  const theirs = facts.commander(other);
  if (mine === other || theirs === actor || (mine !== undefined && mine === theirs)) return 'ally';
  if (depth < 2) {
    if (mine !== undefined) return withCrime(runtime, facts, mine, other, depth + 1);
    if (theirs !== undefined) return withCrime(runtime, facts, actor, theirs, depth + 1);
  }
  const team = (reference: number): boolean =>
    reference === PLAYER_REF || facts.teammate(reference);
  if (team(actor) && team(other) && (facts.teammate(actor) || facts.teammate(other))) {
    return 'ally';
  }
  if (facts.attackedOnSight(other)) return 'hostile';
  return runtime.crime.reaction(actor, other);
}

/** FightReaction of how `actor` regards `other` in the running game (reactionsOf). */
export async function reactionOf(
  runtime: ScriptRuntime,
  actor: number,
  other: number,
): Promise<number> {
  return fightReaction(await reactionsOf(runtime).reaction(actor, other));
}

/** CLAS DATA flags (byte 35; xEdit wbDefinitionsTES5 CLAS: Guard). */
export const ClassFlag = { guard: 0x1 } as const;

/** Whether a class (CLAS DATA) is a guard's (IsGuard). */
export function isGuardClass(data: Uint8Array | undefined): boolean {
  return data !== undefined && data.length >= 36 && ((data[35] ?? 0) & ClassFlag.guard) !== 0;
}
