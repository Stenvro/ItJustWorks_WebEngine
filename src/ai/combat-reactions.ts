// How one actor regards another in a fight (CommonLibSSE FIGHT_REACTION: neutral, enemy, ally,
// friend; docs/ai.md, "Combat AI"): what the combat AI weighs against an actor's aggression
// (who it attacks on sight) and assistance (whom it helps), and what IsHostileToActor,
// GetShouldAttack and GetFactionRelation answer.
//
// Callers ask `reactionsOf(runtime).reaction(actor, other)`: the rules below that crime does not
// weigh (summons and the commanded, the player's teammates, those attacked on sight), then crime
// and factions' `runtime.crime.reaction` (factions, relationships, frenzy, bounties and guards:
// src/scripting/runtime/crime-engine.ts). `combatReaction` (tests and tools) asks the same
// rules of plain facts, with the factions' and relationships' rule of the running game
// (src/gameplay/factions.ts `reaction` and `factionTies`, as CrimeEngine.reaction) and without
// frenzy, a script's combat or guards. The rules, most plausible where undocumented (TODO(M13)):
//
// - one's summons, reanimated and commanded actors (the magic system's commander) are its allies
//   and share its reactions; the player's teammates are the player's allies and each other's;
// - one that scripts set to be attacked on sight (SetAttackActorOnSight) is everyone's enemy;
// - else factions and relationships (docs/gameplay.md, "Factions and reactions"): a relationship
//   (RELA, SetRelationshipRank) of enemy or worse, or a faction of the actor set as the player's
//   enemy (SetPlayerEnemy) towards the player: an enemy; a relationship of friend or better, or
//   a friend combat reaction: a friend; an ally reaction: an ally; an enemy reaction: an enemy;
//   a shared faction: an ally; else neutral. The combat reactions are those (FACT XNAM: 0 neutral,
//   1 enemy, 2 ally, 3 friend; scripts' SetAlly / SetEnemy over them) of each faction the actor
//   is a member of (rank 0 or more) towards each faction the other is a member of, never the
//   other's towards the actor's (one way; where the other's name one of the actor's an enemy, a
//   faction they share makes no alliance). A faction both are in that names a reaction to
//   itself counts by that reaction as any other pair of their factions, its membership adding
//   nothing (BanditFaction: its own ally; MQ101TemporaryFriendsFaction: its own friend, neutral
//   from MQ101 stage 270); one that names none makes its members allies unless it is Special
//   Combat (FACT DATA 0x2: the town, crime and guard factions name none). TODO(M13): the
//   precedence is inferred.
//
// Platform-independent.

import { RaceFlag2 } from './race-combat-records.ts';
import { factionTies, reaction as regard, type FactionFacts } from '../gameplay/factions.ts';
import { CrimeFlag } from '../gameplay/crime.ts';
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
export interface ReactionFacts extends FactionFacts {
  /** The factions an actor is in, with its rank (−1: listed, not a member yet). */
  factionsOf(actor: number): Promise<ReadonlyMap<number, number>>;
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

/**
 * Whether an actor fighting the player (or fleeing them) counts as a threat to them: not one
 * of a Non-Hostile race (RACE DATA Flags 2; 13 races: the deer, elk, foxes, goats, cows,
 * chickens, hares, the pets). Such an animal keeps no one from waiting or fast travelling,
 * plays no combat music and shows as no enemy on the compass. TODO(M13): the plain reading of
 * the flag's name; what else the engine gates by it is not documented.
 */
export function threatensPlayer(raceFlags2: number): boolean {
  return (raceFlags2 & RaceFlag2.nonHostile) === 0;
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

/**
 * How `actor` regards `other` (FightReaction) by plain facts: the combat-only rules, then the
 * factions' and relationships' rule of the running game (factionTies and reaction, as
 * CrimeEngine.reaction weighs them; without frenzy, a script's combat or guards).
 */
export async function combatReaction(
  facts: ReactionFacts,
  actor: number,
  other: number,
): Promise<number> {
  const name = await combatOnly(facts, actor, other, 0, async (from, to) => {
    const [mine, theirs] = await Promise.all([facts.factionsOf(from), facts.factionsOf(to)]);
    let crimeHostile = false;
    if (to === PLAYER_REF) {
      for (const [faction, rank] of mine) {
        if (rank >= 0 && facts.playerEnemy(faction)) crimeHostile = true;
      }
    }
    return regard({
      ...(await factionTies(facts, mine, theirs)),
      relationshipRank: await facts.relationshipRank(from, to),
      crimeHostile,
    });
  });
  return fightReaction(name);
}

/**
 * The rules crime does not weigh: one's summons and the commanded are its allies and share its
 * reactions, the player's teammates are the player's allies and each other's, one attacked on
 * sight is everyone's enemy; else `rest` (crime and factions').
 */
async function combatOnly(
  facts: ReactionFacts,
  actor: number,
  other: number,
  depth: number,
  rest: (actor: number, other: number) => Promise<ReactionName>,
): Promise<ReactionName> {
  if (actor === other) return 'ally';
  // Summons and the commanded: their commander's allies, with its reactions.
  const mine = facts.commander(actor);
  const theirs = facts.commander(other);
  if (mine === other || theirs === actor || (mine !== undefined && mine === theirs)) return 'ally';
  if (depth < 2) {
    if (mine !== undefined) return combatOnly(facts, mine, other, depth + 1, rest);
    if (theirs !== undefined) return combatOnly(facts, actor, theirs, depth + 1, rest);
  }
  // The player and their teammates.
  const team = (reference: number): boolean =>
    reference === PLAYER_REF || facts.teammate(reference);
  if (team(actor) && team(other) && (facts.teammate(actor) || facts.teammate(other))) {
    return 'ally';
  }
  if (facts.attackedOnSight(other)) return 'hostile';
  return rest(actor, other);
}

/** The facts of the running game (src/scripting/runtime). */
export function reactionFacts(runtime: ScriptRuntime): ReactionFacts {
  return {
    factionsOf: (actor) => runtime.actors.factionsOf(actor),
    factionReaction: (faction, other) => runtime.actors.factionReaction(faction, other),
    specialCombat: async (faction) =>
      (((await runtime.actors.faction(faction))?.flags ?? 0) & CrimeFlag.specialCombat) !== 0,
    playerEnemy: (faction) => runtime.state.factions.get(faction)?.playerEnemy === true,
    relationshipRank: (a, b) => runtime.actors.relationshipRank(a, b),
    teammate: (actor) => runtime.state.actors.get(actor)?.playerTeammate === true,
    commander: (actor) => runtime.magic.commander(actor),
    attackedOnSight: (actor) => runtime.state.actors.get(actor)?.attackOnSight === true,
  };
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
    const crime = (actor: number, other: number): Promise<ReactionName> =>
      runtime.crime.reaction(actor, other);
    reactions = { reaction: (actor, other) => combatOnly(facts, actor, other, 0, crime) };
    known.set(runtime, reactions);
  }
  return reactions;
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
