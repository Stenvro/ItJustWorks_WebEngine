// The combat inventory's score of a spell (observed in the original). A spell's item has one
// caster, by its effect, and a score, the sum over its effects of:
//
//   what it does × its seconds (a concentration spell's fCombatMagicConcentrationScoreDuration,
//   else its duration, at least 1, plus half its taper's seconds × weight unless it has no
//   duration or no magnitude) × the share the target keeps (a hostile effect with a resist value)
//   × the weight of the effect's kind.
//
// What it does is its magnitude, for a summons, a bound weapon, invisibility and paralysis its
// cost. A Script effect is not weighed so: it adds its MGEF's Script Effect AI Score, whatever
// its magnitude, seconds, cost or the target's resistances (VoiceStormCallEmptyAIScriptEffect,
// "Script Effect for AI use of Storm Call": 50; a script effect without one adds nothing). An
// effect of no kind adds nothing. Of the effects whose kind has a caster, the one adding the
// most (the first of equals) gives the item its caster, also where it adds nothing: a spell
// whose one effect is a Script effect without an AI score has the Script caster and a score of
// 0. The combat inventory then weighs the item by the style's mult for its kind, doubled
// (fCombatInventoryRangedScoreMult) when it reaches past fCombatRangedDistance, and takes its
// items by their scores; one scoring nothing is never weighed, so it is never taken up.
//
// The kinds are told by the effect's archetype and, where the archetype has one, its actor value,
// by whether the spell is cast on its caster and whether the effect is hostile: in a spell cast
// on its caster only effects that are not hostile have a kind, in one sent out the hostile ones
// (and a summons or a reanimation). Its second actor value (a dual value modifier) counts by its
// own row, by its weight.

import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';

/** What a caster does for the actor (CombatMagicCaster…); offensive is the hands' attack. */
export type SpellCaster =
  | 'offensive'
  | 'stagger'
  | 'disarm'
  | 'turn'
  | 'paralyze'
  | 'script'
  | 'restore'
  | 'ward'
  | 'summon'
  | 'cloak'
  | 'light'
  | 'invisibility'
  | 'bound'
  | 'armor'
  | 'reanimate';

/** The actor values the rows name (UESP "Actor Value Codes"). */
const HEALTH = 24;
const MAGICKA = 25;
const STAMINA = 26;
const DAMAGE_RESIST = 39;
const WARD_POWER = 63;

const VALUE_KINDS: ReadonlySet<number> = new Set([
  EffectArchetype.valueModifier,
  EffectArchetype.dualValueModifier,
  EffectArchetype.absorb,
  EffectArchetype.accumulateMagnitude,
  EffectArchetype.peakValueModifier,
]);

interface Kind {
  /** Its caster; none: it adds to the score but gives the item none. */
  readonly caster?: SpellCaster;
  readonly weight: number;
  /** Scored by its cost, not its magnitude. */
  readonly byCost?: boolean;
  /** A Script effect: its MGEF's AI score, as it stands. */
  readonly byAiScore?: boolean;
}

/** An effect's kind in a spell not cast on its caster. */
function aimedKind(archetype: number, value: number, hostile: boolean): Kind | undefined {
  if (hostile) {
    if (VALUE_KINDS.has(archetype)) {
      if (value === HEALTH) return { caster: 'offensive', weight: 1 };
      if (value === MAGICKA) return { weight: 0.5 };
      if (value === STAMINA) return { weight: 0.33 };
      return undefined;
    }
    if (archetype === EffectArchetype.stagger) return { caster: 'stagger', weight: 10 };
    if (archetype === EffectArchetype.disarm) return { caster: 'disarm', weight: 10 };
    if (archetype === EffectArchetype.commandSummoned) return { caster: 'turn', weight: 10 };
    if (archetype === EffectArchetype.banish) return { caster: 'turn', weight: 5 };
    if (archetype === EffectArchetype.turnUndead) return { caster: 'turn', weight: 3 };
    if (archetype === EffectArchetype.paralysis) {
      return { caster: 'paralyze', weight: 20, byCost: true };
    }
    if (archetype === EffectArchetype.script) {
      return { caster: 'script', weight: 1, byAiScore: true };
    }
    return undefined;
  }
  if (archetype === EffectArchetype.summonCreature) {
    return { caster: 'summon', weight: 1, byCost: true };
  }
  if (archetype === EffectArchetype.reanimate) return { caster: 'reanimate', weight: 10 };
  return undefined;
}

/** An effect's kind in a spell cast on its caster (a hostile effect has none there). */
function selfKind(archetype: number, value: number, hostile: boolean): Kind | undefined {
  if (hostile) return undefined;
  if (VALUE_KINDS.has(archetype)) {
    if (value === HEALTH) return { caster: 'restore', weight: 1 };
    if (value === MAGICKA) return { caster: 'restore', weight: 0.33 };
    if (value === STAMINA) return { weight: 0.1 };
    if (value === WARD_POWER) return { caster: 'ward', weight: 1 };
    if (value === DAMAGE_RESIST) return { caster: 'armor', weight: 1 };
    return undefined;
  }
  if (archetype === EffectArchetype.summonCreature) {
    return { caster: 'summon', weight: 1, byCost: true };
  }
  if (archetype === EffectArchetype.cloak) return { caster: 'cloak', weight: 1 };
  if (archetype === EffectArchetype.light) return { caster: 'light', weight: 1 };
  if (archetype === EffectArchetype.invisibility) {
    return { caster: 'invisibility', weight: 1, byCost: true };
  }
  if (archetype === EffectArchetype.boundWeapon) {
    return { caster: 'bound', weight: 1, byCost: true };
  }
  if (archetype === EffectArchetype.script) return { caster: 'script', weight: 1, byAiScore: true };
  return undefined;
}

/** One of a spell's effects as the score reads it. */
export interface ScoredEffect {
  readonly archetype: number;
  readonly actorValue: number;
  /** A dual value modifier's second actor value (else below 0) and its weight. */
  readonly secondActorValue: number;
  readonly secondValueWeight: number;
  readonly flags: number;
  readonly taperDuration: number;
  readonly taperWeight: number;
  readonly magnitude: number;
  readonly duration: number;
  /** Its share of the spell's cost. */
  readonly cost: number;
  /** Its MGEF's Script Effect AI Score (what a Script effect adds); none: 0. */
  readonly aiScore?: number;
  /** Its MGEF's AI Delay Time (seconds; what the Script caster waits after casting it). */
  readonly aiDelay?: number;
  /** The share the target keeps through its resistances (0 .. 1; a hostile effect's). */
  readonly kept: number;
  /** Whether a resource the effect drains counts: the target has it to lose. */
  readonly drains?: (value: number) => boolean;
}

export interface SpellToScore {
  /** Self-delivered. */
  readonly self: boolean;
  readonly concentration: boolean;
  readonly effects: readonly ScoredEffect[];
}

export interface SpellScore {
  readonly score: number;
  /**
   * The caster of its strongest effect a caster serves (also one adding nothing); none: no item
   * of the combat inventory. An item scoring nothing is made but never weighed.
   */
  readonly caster: SpellCaster | undefined;
}

/** fCombatMagicConcentrationScoreDuration where no setting is read. */
const CONCENTRATION_SECONDS = 3;

/** The combat inventory's score of a spell, before the style's mult (see the head). */
export function combatSpellScore(
  spell: SpellToScore,
  concentrationSeconds = CONCENTRATION_SECONDS,
): SpellScore {
  const { score, caster } = weigh(spell, concentrationSeconds);
  return { score, caster };
}

/**
 * The AI Delay Time the Script caster of a spell waits after casting it: that of the Script
 * effect that gave the spell its caster (observed in the original: the delay of the item's
 * strongest effect is noted as the cast starts). Undefined: its caster is not the Script caster.
 */
export function scriptCasterDelay(
  spell: SpellToScore,
  concentrationSeconds = CONCENTRATION_SECONDS,
): number | undefined {
  const { caster, effect } = weigh(spell, concentrationSeconds);
  return caster === 'script' ? (effect?.aiDelay ?? 0) : undefined;
}

/** The score, the caster and the effect that gave it. */
function weigh(
  spell: SpellToScore,
  concentrationSeconds: number,
): SpellScore & { readonly effect: ScoredEffect | undefined } {
  let score = 0;
  // Below nothing: an effect adding nothing still gives its caster.
  let best = -1;
  let caster: SpellCaster | undefined;
  let strongest: ScoredEffect | undefined;
  const count = (counted: number, kind: Kind, effect: ScoredEffect): void => {
    score += counted;
    if (counted > best && kind.caster !== undefined) {
      best = counted;
      caster = kind.caster;
      strongest = effect;
    }
  };
  const add = (effect: ScoredEffect, value: number, weight: number): void => {
    const hostile = (effect.flags & EffectFlag.hostile) !== 0;
    const kind = spell.self
      ? selfKind(effect.archetype, value, hostile)
      : aimedKind(effect.archetype, value, hostile);
    if (!kind) return;
    if (kind.byAiScore === true) {
      count((effect.aiScore ?? 0) * kind.weight, kind, effect);
      return;
    }
    let seconds = spell.concentration ? concentrationSeconds : Math.max(1, effect.duration);
    if (
      (effect.flags & (EffectFlag.noDuration | EffectFlag.noMagnitude)) === 0 &&
      effect.taperDuration > 0
    ) {
      seconds += effect.taperDuration * effect.taperWeight * 0.5;
    }
    let amount = seconds * (kind.byCost === true ? effect.cost : effect.magnitude) * weight;
    if (hostile) amount *= effect.kept;
    if (!(effect.drains?.(value) ?? true) && !spell.self && value !== HEALTH) amount = 0;
    count(amount * kind.weight, kind, effect);
  };
  for (const effect of spell.effects) {
    add(effect, effect.actorValue, 1);
    if (effect.archetype === EffectArchetype.dualValueModifier && effect.secondActorValue >= 0) {
      add(effect, effect.secondActorValue, effect.secondValueWeight);
    }
  }
  return { score, caster, effect: strongest };
}

/** The casters whose spell is sent against the target, and the Script caster. */
const SHOUT_CASTERS: ReadonlySet<SpellCaster> = new Set<SpellCaster>([
  'offensive',
  'stagger',
  'disarm',
  'turn',
  'paralyze',
  'script',
]);

/**
 * Whether the shout in an actor's voice is an option of its fight, by the score and the caster
 * of its word's spell. Observed in the original: the combat inventory makes a shout's item as it
 * makes a spell's, by the spell's score and the caster that gives it, and weighs only items
 * scoring more than nothing; neither a hostile effect nor the delivery decides it. So Storm
 * Call's words and Alduin's Firestorm (AlduinFirestormShout: DragonVoiceStormCall), self spells,
 * are his by their Script caster alone: their hostile Stagger area and the storm's hazard are of
 * no kind in a self spell, and VoiceStormCallEmptyAIScriptEffect ("Script Effect for AI use of
 * Storm Call", AI score 50) is what gives them a score. A word whose spell is one Script effect
 * without an AI score has the Script caster and scores nothing, so it is never taken up: Clear
 * Skies' (VoiceClearSkiesSelf1-3; Sovngarde's heroes, Clear Skies in their voices from MQ305's
 * mist, fight Alduin with their weapons) and the dragons' Unrelenting Force
 * (DragonUnrelentingForceShout: DragonVoiceUnrelentingForce is one aimed, hostile Script effect).
 * TODO(M13): whether a dragon's fight on the ground shouts that one some other way than by its
 * combat inventory is not known (ours: its flight picks among the shouts it knows); a word whose
 * caster is one of the others (Restore, Ward, Cloak, Summon, ...) is not shouted yet: ours has
 * the hands' casters only for those.
 */
export function shoutOffered(score: SpellScore): boolean {
  return score.caster !== undefined && SHOUT_CASTERS.has(score.caster) && score.score > 0;
}

/** What the Script caster asks before it casts. */
export interface ScriptCasterState {
  /** Seconds since the actor's combat AI last started a cast by its Script caster; none: never. */
  readonly sinceCast: number | undefined;
  /** The AI Delay Time noted with that cast (its spell's, not that of the one asked about). */
  readonly delay: number;
  /** The one it lands on (the caster of a self spell, else the target) carries it already. */
  readonly carried: boolean;
}

/**
 * The Script caster's own check (observed in the original). As its cast starts, an actor's
 * combat AI notes the time and the AI Delay Time of the Script effect that gave the spell its
 * caster: one note for all its Script casts. Another Script cast, of whatever spell, starts only
 * once more than that delay has passed since, and not while the one the spell lands on carries
 * the spell already (not asked of a concentration spell). Storm Call's script effect has an AI
 * delay of 60 s and lasts as long as the storm on the shouter, so a dragon does not call a
 * second storm into its first, nor one within a minute of the last. TODO(M13): the original
 * also asks that the caster can pay for the spell and that its strongest effect's conditions
 * hold on the one it lands on; ours leaves those to the cast itself.
 */
export function scriptCasterReady(state: ScriptCasterState): boolean {
  if (state.carried) return false;
  return state.sinceCast === undefined || state.sinceCast > state.delay;
}
