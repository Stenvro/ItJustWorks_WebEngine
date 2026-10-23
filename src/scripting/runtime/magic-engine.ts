// The magic system's effects on actors (docs/gameplay.md, "Magic effects"): a magic item
// (src/world/magic-records.ts) applied to a target puts each of its effect items on it as an
// active effect (GameState.activeEffects), as strong as it was cast (dual casting) and resisted
// (the effect's resist value, Magic Resistance; the player's capped at fPlayerMaxResistance),
// unless the target's level is above what the effect reaches (Calm, Fear, Reanimate, ...). An
// effect from the same item, effect item, caster and source replaces the one there (No Recast:
// it is not cast again); an effect dispels those it counters (ESCE) and, with Dispel with
// Keywords, those sharing a keyword. Its conditions (the effect item's and the magic effect's,
// on the target; "target" is the caster) are evaluated as it is applied and about each second:
// while they fail it is inactive, its scripts finished. Each archetype does its part on the game
// state (src/gameplay/magic/effect-rules.ts has the rules): value modifiers as temporary
// modifiers, damage or restores at once or each second; cures dispel; summons, reanimated
// corpses, bound weapons, hazards are made and taken away; Calm, Frenzy, Fear, Rally, Paralysis,
// Invisibility, Etherealize, Slow Time leave the state the AI, the world and the clock read.
// Abilities, diseases and worn enchantments last while the actor has them (`prepare`: actors as
// they load, the player). Its scripts run as an ActiveMagicEffect (OnEffectStart, OnEffectFinish);
// the target gets OnMagicEffectApply. What the world shows (sounds, shaders, art, lights) goes
// through WorldBridge.magicEffect. Potions, food, ingredients and poisons are used through
// `useItem`. Platform-independent.

import {
  actsAtOnce,
  castStrength,
  DUAL_CASTING_POWER,
  isLastingKind,
  isValueEffect,
  LEVEL_CAPPED,
  magicResistanceApplies,
  MagicValue,
  PLAYER_MAX_RESISTANCE,
  resistanceMultiplier,
  soulGemFor,
  soulSize,
  TARGET_VALUES,
  UNITS_PER_FOOT,
  valueAmount,
  valueMode,
  valueSign,
} from '../../gameplay/magic/effect-rules.ts';
import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { DefaultObjects } from '../../world/default-objects.ts';
import {
  EffectArchetype,
  EffectFlag,
  effectSound,
  EffectSound,
  parseMagicEffect,
  type MagicEffectRecord,
} from '../../world/magic-effects.ts';
import {
  Delivery,
  MagicSpellFlag,
  parseMagicItem,
  parseSoulGem,
  type MagicItemRecord,
  type SoulGemRecord,
} from '../../world/magic-records.ts';
import { ObjectHandle } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ActiveEffectState, ActorMagicState, Vec3 } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

/** What the world shows of an effect on an actor (WorldBridge.magicEffect). */
export interface MagicEffectShown {
  /** It begins (or becomes active again), or it ends (or becomes inactive). */
  readonly event: 'start' | 'stop';
  /** Its ActiveMagicEffect's key. */
  readonly key: string;
  /** MGEF, and its archetype. */
  readonly effect: number;
  readonly archetype: number;
  readonly target: number;
  readonly caster: number | undefined;
  /** EFSH on the target: as it hits, or while it lasts with `persist`. */
  readonly shader: number | undefined;
  /** ARTO and RFCT on the target. */
  readonly art: number | undefined;
  readonly visuals: number | undefined;
  /** LIGH of a Light effect (Candlelight), on the target. */
  readonly light: number | undefined;
  /** Its visuals last as long as it does (FX Persist). */
  readonly persist: boolean;
  /** Seconds it lasts (0: until it ends). */
  readonly duration: number;
  /** Its magnitude, and its area in feet (Detect Life's reach). */
  readonly magnitude: number;
  readonly area: number;
  /** Its associated form (Guide: Clairvoyance's trail hazard). */
  readonly associated: number | undefined;
}

/** How a magic item is applied. */
export interface ApplyOptions {
  /** Who casts it (none: a trap, a RemoteCast without blame). */
  readonly caster?: number | undefined;
  /** Dual cast: the power of fMagicDualCastingEffectivenessBase. */
  readonly dual?: boolean;
  /** The enchanted object it came by (a weapon struck with, armor worn, a staff). */
  readonly source?: number | undefined;
  /** Its effects last until they are taken away (abilities, diseases, worn enchantments). */
  readonly lasting?: boolean;
  /** Only these effect items, by index (an ingredient eaten: its first). */
  readonly effects?: readonly number[];
  /**
   * The share of the magnitude its effects at once (no duration) give: a concentration spell's
   * hit between two sprays, what passes a ward (src/scripting/runtime/casting-engine.ts).
   */
  readonly scale?: number;
  /**
   * A concentration spell held: its effects without a duration that do not act at once (wards,
   * Recover effects, Calm, ...) last this many seconds (kept on by `extendHeld` while it is
   * held), its effects at once act by `scale`.
   */
  readonly hold?: number;
  /** Where a Target Location spell landed: what it makes (summons, hazards) stands there. */
  readonly at?: Vec3 | undefined;
}

/** What the AI reads of the effects on an actor (src/shell/actor-combat-ai.ts acts on them). */
export interface MagicAiState {
  /** Calm: it will not fight. Frenzy: it attacks anyone. */
  readonly calmed: boolean;
  readonly frenzied: boolean;
  /** Fear and Turn Undead: it flees. Rally: it fights on. */
  readonly fleeing: boolean;
  readonly rallied: boolean;
  /** The actor that summoned, reanimated or commands it. */
  readonly commander: number | undefined;
  readonly paralyzed: boolean;
  readonly invisible: boolean;
  readonly ethereal: boolean;
}

/** ActorTypeNPC and ActorTypeUndead (Skyrim.esm KYWD): black souls; Turn Undead's targets. */
const ACTOR_TYPE_NPC = 0x13794;
const ACTOR_TYPE_UNDEAD = 0x13796;

/**
 * How often lasting effects, conditions and cloaks are looked at (seconds). TODO(M13): the
 * engine's interval for active effects' conditions is not documented.
 */
const PULSE_SECONDS = 1;

/** Archetypes whose hostile Health effect harms a destructible object (Fire Damage, ...). */
const HEALTH_DAMAGING: ReadonlySet<number> = new Set([
  EffectArchetype.valueModifier,
  EffectArchetype.dualValueModifier,
  EffectArchetype.peakValueModifier,
  EffectArchetype.absorb,
]);

/** The player's own pace in slowed time (UESP "Skyrim:Slow Time": "only slowed to 70%"). */
const PLAYER_SLOWED_PACE = 0.7;

/** GetRandomPercent (UESP function index 77). */
const GET_RANDOM_PERCENT = 77;

/**
 * A summon stands this far in front of who summons it (units). TODO(M13): the engine's
 * placement (SummonPlacementEffect). A Target Location spell's summon stands where it landed.
 */
const SUMMON_DISTANCE = 128;

/**
 * How many creatures an actor may have summoned at once (the oldest goes when another comes),
 * before its perks (Mod Commanded Actor Limit: Twin Souls adds one).
 */
const SUMMON_LIMIT = 1;

/** Archetypes that make an actor or an object for as long as they last. */
const MAKERS: ReadonlySet<number> = new Set([
  EffectArchetype.summonCreature,
  EffectArchetype.reanimate,
  EffectArchetype.boundWeapon,
  EffectArchetype.spawnHazard,
  EffectArchetype.spawnScriptedRef,
]);

/** The ActiveMagicEffect handle of an effect's key ("<hex form id>:-1"). */
function handleOf(key: string): ObjectHandle {
  const [formId = '0'] = key.split(':');
  return new ObjectHandle(Number.parseInt(formId, 16), 'activemagiceffect');
}

export class MagicEngine {
  readonly #runtime: ScriptRuntime;
  /** Magic effects read (resolved: the per-frame work looks them up without waiting). */
  readonly #effects = new Map<number, MagicEffectRecord | undefined>();
  readonly #pendingEffects = new Map<number, Promise<MagicEffectRecord | undefined>>();
  readonly #items = new Map<number, Promise<MagicItemRecord | undefined>>();
  /** Actors whose lasting effects follow what they have (the loaded ones and the player). */
  readonly #prepared = new Set<number>();
  /** Effects that ended whose OnEffectFinish still runs: their scripts still read them. */
  readonly #finishing = new Map<string, ActiveEffectState>();
  /** Each effect's script work in order (finish, reset, start again). */
  readonly #scripts = new Map<string, Promise<void>>();
  readonly #ending = new Set<string>();
  /** The value changes of effects that act each second, in order. */
  #changes: Promise<void> = Promise.resolve();
  #pulseWait = 0;
  #pulsing = false;
  #defaults: Promise<DefaultObjects> | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /**
   * Follows the equip system: what an actor equips or takes off changes its worn enchantments'
   * effects at once (EquipmentEngine.listeners).
   */
  listen(): void {
    this.#runtime.equipment.listeners.add((change) => {
      this.#runtime.detach(this.syncLasting(change.actor));
    });
  }

  /** The ActiveMagicEffect objects with scripts on an actor (they hear its events). */
  scriptedOn(actor: number): ObjectHandle[] {
    const handles: ObjectHandle[] = [];
    for (const [key, entry] of this.effectsOn(actor)) {
      if (!entry.inactive && this.#effects.get(entry.effect)?.scripted) handles.push(handleOf(key));
    }
    return handles;
  }

  // --- Records --------------------------------------------------------------------------------

  /** A magic effect (MGEF), read once. */
  effect(formId: number): Promise<MagicEffectRecord | undefined> {
    let pending = this.#pendingEffects.get(formId);
    if (!pending) {
      pending = this.#runtime.forms.record(formId).then((record) => {
        const effect = record?.type === 'MGEF' ? parseMagicEffect(record) : undefined;
        this.#effects.set(formId, effect);
        return effect;
      });
      this.#pendingEffects.set(formId, pending);
    }
    return pending;
  }

  /** A magic item (SPEL, SCRL, ENCH, ALCH, INGR), read once. */
  item(formId: number): Promise<MagicItemRecord | undefined> {
    let pending = this.#items.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record ? parseMagicItem(record) : undefined));
      this.#items.set(formId, pending);
    }
    return pending;
  }

  // --- What is on an actor -------------------------------------------------------------------

  /** The effects on an actor (active and inactive), by key. */
  /**
   * Whether an effect is taking a target's health now (sNoWaitTakingHealthDamage): a
   * detrimental value modifier of Health that still runs (poison, fire, frost over time).
   */
  async damagingHealth(target: number): Promise<boolean> {
    for (const [, active] of this.effectsOn(target)) {
      if (active.inactive === true || active.lasting === true) continue;
      if (active.duration <= 0 || active.elapsed >= active.duration) continue;
      const effect = await this.effect(active.effect);
      if (effect?.actorValue !== ActorValue.health) continue;
      if ((effect.flags & EffectFlag.detrimental) === 0) continue;
      const archetype = effect.archetype;
      // Damage over time (poison, fire): a peak value modifier lowers the maximum instead
      // (Survival Mode's hunger takes none: waiting stays allowed).
      if (
        archetype === EffectArchetype.valueModifier ||
        archetype === EffectArchetype.dualValueModifier
      ) {
        return true;
      }
    }
    return false;
  }

  effectsOn(target: number): [string, ActiveEffectState][] {
    const found: [string, ActiveEffectState][] = [];
    for (const entry of this.#runtime.state.activeEffects) {
      if (entry[1].target === target && !this.#ending.has(entry[0])) found.push(entry);
    }
    return found;
  }

  /** An effect as its scripts see it: on an actor, or ending while OnEffectFinish runs. */
  scriptEffect(key: string): ActiveEffectState | undefined {
    return this.#runtime.state.activeEffects.get(key) ?? this.#finishing.get(key);
  }

  /** HasMagicEffect: an active effect of the magic effect on the actor. */
  hasEffect(target: number, effect: number): boolean {
    return this.effectsOn(target).some(([, entry]) => entry.effect === effect && !entry.inactive);
  }

  /** HasMagicEffectWithKeyword / HasMagicEffectKeyword: an active effect with the keyword. */
  async hasEffectKeyword(target: number, keyword: number): Promise<boolean> {
    for (const [, entry] of this.effectsOn(target)) {
      if (entry.inactive) continue;
      if ((await this.effect(entry.effect))?.keywords.includes(keyword)) return true;
    }
    return false;
  }

  /** IsSpellTarget: an effect of the magic item on the actor. */
  isSpellTarget(target: number, item: number): boolean {
    return this.effectsOn(target).some(([, entry]) => entry.item === item);
  }

  /** The active effects of an archetype on an actor. */
  #archetypeOn(target: number, archetype: number): [string, ActiveEffectState][] {
    return this.effectsOn(target).filter(
      ([, entry]) => !entry.inactive && this.#effects.get(entry.effect)?.archetype === archetype,
    );
  }

  /**
   * The share of a hostile effect's magnitude its target keeps through its resistances: the
   * effect's resist value (Resist Fire, Poison, ...) and Magic Resistance on hostile spells, each
   * as resistanceMultiplier has it (the player's capped at fPlayerMaxResistance); 1 for an item
   * that ignores resistance.
   */
  async resistedShare(
    item: MagicItemRecord,
    effect: MagicEffectRecord,
    target: number,
  ): Promise<number> {
    const runtime = this.#runtime;
    const ignores = item.type === 'SPEL' && (item.flags & MagicSpellFlag.ignoreResistance) !== 0;
    let left = 1;
    const cap =
      target === PLAYER_REF
        ? await this.#setting('fPlayerMaxResistance', PLAYER_MAX_RESISTANCE)
        : undefined;
    if (!ignores && effect.resistValue >= 0) {
      const resist = (await runtime.actors.value(target, effect.resistValue)).current;
      left *= resistanceMultiplier(resist, cap);
    }
    if (magicResistanceApplies(item.kind, effect, ignores)) {
      const resist = (await runtime.actors.value(target, MagicValue.magicResist)).current;
      left *= resistanceMultiplier(resist, cap);
    }
    return left;
  }

  /**
   * How much of an item's effect (by index) would take hold on a target from a caster, as the
   * combat AI foresees it: 0 where its conditions fail on the target (Turn Undead on the
   * living), its level cap leaves it out or the target is ethereal; else the share its
   * resistances leave a hostile one (resistedShare).
   */
  async foresee(
    item: MagicItemRecord,
    index: number,
    target: number,
    caster: number | undefined,
  ): Promise<number> {
    const runtime = this.#runtime;
    const entry = item.effects[index];
    const effect = entry && (await this.effect(entry.effect));
    if (!entry || !effect) return 0;
    const hostile = (effect.flags & (EffectFlag.hostile | EffectFlag.detrimental)) !== 0;
    if (hostile && caster !== target && this.aiState(target).ethereal) return 0;
    if (LEVEL_CAPPED.has(effect.archetype) && entry.magnitude > 0) {
      if ((await runtime.actors.level(target)) > entry.magnitude) return 0;
    }
    const conditions = [...entry.conditions, ...effect.conditions].filter(
      (condition) => condition.function !== GET_RANDOM_PERCENT,
    );
    if (
      conditions.length > 0 &&
      !(await runtime.conditionsHold(conditions, runtime.actorHandle(target), undefined, {
        ...(caster !== undefined && { target: runtime.actorHandle(caster) }),
      }))
    )
      return 0;
    return hostile ? this.resistedShare(item, effect, target) : 1;
  }

  /** The creatures an actor's summonings and reanimations made that stand now (the AI asks). */
  async summonsOf(caster: number): Promise<number[]> {
    const runtime = this.#runtime;
    const made: number[] = [];
    for (const [, entry] of runtime.state.activeEffects) {
      if (entry.inactive || entry.made === undefined) continue;
      if ((entry.caster ?? entry.target) !== caster) continue;
      const archetype = this.#effects.get(entry.effect)?.archetype;
      if (archetype !== EffectArchetype.summonCreature && archetype !== EffectArchetype.reanimate)
        continue;
      if (!(await runtime.actors.isDead(entry.made))) made.push(entry.made);
    }
    return made;
  }

  /** Whether an item's effects are on an actor now (a buff the AI need not cast again). */
  hasItemOn(actor: number, item: number): boolean {
    return this.effectsOn(actor).some(([, entry]) => entry.item === item && !entry.inactive);
  }

  /** What the AI reads of an actor's effects (the combat AI acts on them). */
  aiState(actor: number): MagicAiState {
    const has = (archetype: number): boolean => this.#archetypeOn(actor, archetype).length > 0;
    return {
      calmed: has(EffectArchetype.calm),
      frenzied: has(EffectArchetype.frenzy),
      fleeing: has(EffectArchetype.demoralize) || has(EffectArchetype.turnUndead),
      rallied: has(EffectArchetype.rally),
      commander: this.commander(actor),
      paralyzed: has(EffectArchetype.paralysis),
      invisible: has(EffectArchetype.invisibility),
      ethereal: has(EffectArchetype.etherealize),
    };
  }

  /** Who summoned, reanimated or commands an actor (IsCommandedActor), if anyone. */
  commander(actor: number): number | undefined {
    for (const [, entry] of this.#runtime.state.activeEffects) {
      if (entry.made !== actor || entry.inactive) continue;
      const archetype = this.#effects.get(entry.effect)?.archetype;
      if (archetype === EffectArchetype.summonCreature) return entry.caster ?? entry.target;
      if (archetype === EffectArchetype.reanimate) return entry.caster;
    }
    for (const [, entry] of this.#archetypeOn(actor, EffectArchetype.commandSummoned)) {
      if (entry.caster !== undefined) return entry.caster;
    }
    return undefined;
  }

  /**
   * How fast the world's time runs (Slow Time on the player: its magnitude, the slowest). The
   * frame's clock (animations, physics, AI, sounds) runs at it (src/shell/time-flow.ts); the
   * player keeps a pace of their own (playerPace).
   */
  timeMultiplier(): number {
    return this.#slowest()?.magnitude ?? 1;
  }

  /** The strongest Slow Time on the player (its magnitude and the spell that cast it). */
  #slowest(): ActiveEffectState | undefined {
    let slowest: ActiveEffectState | undefined;
    for (const [, entry] of this.#archetypeOn(PLAYER_REF, EffectArchetype.slowTime)) {
      if (entry.magnitude > 0 && entry.magnitude < (slowest?.magnitude ?? 1)) slowest = entry;
    }
    return slowest;
  }

  /**
   * The player's own pace in slowed time (UESP "Skyrim:Slow Time": 70 % of theirs, however
   * slow the world), through their perks over the spell that slowed it (Mod Player Magic
   * Slowdown: Quick Reflexes keeps it whole); never slower than the world. TODO(M13): how
   * fVATSPlayerMagicTimeSlowdownMult (0.6) comes in.
   */
  async playerPace(): Promise<number> {
    const slowest = this.#slowest();
    if (!slowest) return 1;
    const spell = slowest.item;
    const pace = await this.#runtime.perks.apply(
      EntryPoint.modPlayerMagicSlowdown,
      PLAYER_REF,
      PLAYER_SLOWED_PACE,
      [spell],
      spell === undefined ? {} : { spell },
    );
    return Math.min(1, Math.max(slowest.magnitude, pace));
  }

  /**
   * Whether an active Detect Life effect shows an actor: its effect item's and magic effect's
   * conditions on the actor, the effect's target (its caster) as their target (the Detect Life
   * spells' variants: friends or enemies, the living or the undead). TODO(M13): the Creation
   * Kit's rule for Detect Life's conditions is taken from the vanilla spells' use.
   */
  async detects(key: string, actor: number): Promise<boolean> {
    const runtime = this.#runtime;
    const entry = runtime.state.activeEffects.get(key);
    if (!entry || entry.inactive) return false;
    if (await runtime.actors.isDead(actor)) return false;
    const item = entry.item === undefined ? undefined : await this.item(entry.item);
    const effect = await this.effect(entry.effect);
    const conditions = [
      ...(item?.effects[entry.index ?? 0]?.conditions ?? []),
      ...(effect?.conditions ?? []),
    ];
    if (conditions.length === 0) return true;
    return runtime.conditionsHold(conditions, runtime.actorHandle(actor), undefined, {
      target: runtime.actorHandle(entry.target),
    });
  }

  /** The poison on an actor's weapon, if any (its hits deliver it: src/shell/actor-combat.ts). */
  poisonOf(actor: number): ActorMagicState['poison'] {
    return this.#runtime.state.actorMagic.get(actor)?.poison;
  }

  // --- Applying -------------------------------------------------------------------------------

  /**
   * Spell.Cast, Scroll.Cast, RemoteCast, DoCombatSpellApply: a spell cast by a source at a
   * target. An aimed, target actor or target location spell the world can fly leaves the source
   * as its projectile (WorldBridge.launchSpell; its impact delivers it:
   * src/scripting/runtime/casting-engine.ts); else it is delivered at once: a Self spell on its
   * caster, a Target Location spell without a target at the caster's feet, an aimed one without
   * a target only flies (the world's castSpell). Scripts' casts cost no magicka (Creation Kit:
   * Cast); the target's wards and Spell Absorption, its OnHit, the caster's skill: deliver.
   */
  async cast(
    spell: number,
    source: number,
    target: number | undefined,
    blame?: number,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const item = await this.item(spell);
    if (
      item &&
      item.delivery !== Delivery.self &&
      item.delivery !== Delivery.touch &&
      runtime.world.launchSpell?.(spell, source, target, blame) === true
    ) {
      return true;
    }
    runtime.world.castSpell?.(spell, source, target);
    if (!item) return false;
    const on =
      item.delivery === Delivery.self
        ? source
        : (target ?? (item.delivery === Delivery.targetLocation ? source : undefined));
    if (on === undefined) return false;
    const caster = blame ?? source;
    const delivered = await runtime.casting.scripted(caster, item);
    return (await runtime.casting.deliver(delivered, on)) > 0;
  }

  /** Whether a magic item has a hostile effect (its hits are hits: OnHit, wards). */
  async hostile(item: MagicItemRecord): Promise<boolean> {
    for (const entry of item.effects) {
      if (((await this.effect(entry.effect))?.flags ?? 0) & EffectFlag.hostile) return true;
    }
    return false;
  }

  /**
   * A concentration spell still held: its effects on a target from the caster that last while
   * it is held (ApplyOptions.hold) last `seconds` more. Returns the effect items kept on (by
   * index), which are not applied again (a ward keeps what it has grown).
   */
  extendHeld(target: number, item: number, caster: number, seconds: number): Set<number> {
    const kept = new Set<number>();
    for (const [, entry] of this.effectsOn(target)) {
      if (entry.item !== item || entry.caster !== caster || entry.index === undefined) continue;
      if (entry.lasting || entry.duration <= 0) continue;
      entry.duration = Math.max(entry.duration, entry.elapsed + seconds);
      kept.add(entry.index);
    }
    return kept;
  }

  /**
   * A magic item's effects put on a target (each effect item that holds; see the module's
   * comment). Returns how many were applied.
   */
  async apply(item: MagicItemRecord, target: number, options: ApplyOptions = {}): Promise<number> {
    let applied = 0;
    for (let index = 0; index < item.effects.length; index++) {
      if (options.effects && !options.effects.includes(index)) continue;
      if (await this.#applyEffect(item, index, target, options)) applied++;
    }
    return applied;
  }

  /** A number game setting, or the engine's value where the load order has none. */
  async #setting(name: string, fallback: number): Promise<number> {
    const value = await this.#runtime.gameSetting(name);
    return typeof value === 'number' ? value : fallback;
  }

  /** An actor's name (its leveled base's FULL). */
  async #name(reference: number): Promise<string> {
    const runtime = this.#runtime;
    const base =
      (await runtime.actors.info(reference))?.leveled ?? (await runtime.baseOf(reference));
    return (
      (base === undefined ? undefined : (await runtime.forms.record(base))?.text('FULL')) ?? ''
    );
  }

  async #applyEffect(
    item: MagicItemRecord,
    index: number,
    target: number,
    options: ApplyOptions,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const itemEffect = item.effects[index];
    const effect = itemEffect && (await this.effect(itemEffect.effect));
    if (!itemEffect || !effect) return false;
    const caster = options.caster;
    const lasting = options.lasting ?? false;
    const dual =
      (options.dual ?? false) &&
      item.type === 'SPEL' &&
      (item.flags & MagicSpellFlag.noDualCastModification) === 0;
    const power = dual
      ? await this.#setting('fMagicDualCastingEffectivenessBase', DUAL_CASTING_POWER)
      : 1;
    let { magnitude, duration } = castStrength(itemEffect, effect, power);
    // The caster's perks (Mod Spell Magnitude / Duration, ActiveEffect AdjustForPerks: the
    // spell tab the item, the target tab the one it lands on; Augmented Flames, Necromage,
    // Fortify <school> through the skill boost perks), then the target's (Mod Incoming Spell
    // Magnitude / Duration: Elemental Protection).
    if (caster !== undefined) {
      const tabs = [item.formId, target];
      const context = { spell: item.formId };
      const perks = runtime.perks;
      magnitude = await perks.apply(EntryPoint.modSpellMagnitude, caster, magnitude, tabs, context);
      duration = await perks.apply(EntryPoint.modSpellDuration, caster, duration, tabs, context);
    }
    if (target !== caster && (await runtime.actors.isActor(target))) {
      const tabs = [item.formId];
      const context = { spell: item.formId };
      const perks = runtime.perks;
      magnitude = await perks.apply(
        EntryPoint.modIncomingSpellMagnitude,
        target,
        magnitude,
        tabs,
        context,
      );
      duration = await perks.apply(
        EntryPoint.modIncomingSpellDuration,
        target,
        duration,
        tabs,
        context,
      );
    }
    if (lasting) duration = 0;
    if (options.hold !== undefined && duration === 0 && !lasting && !actsAtOnce(effect))
      duration = options.hold;
    if (options.scale !== undefined && duration === 0) magnitude *= Math.max(0, options.scale);

    // Objects: their scripts hear of it; locks open or close (Lock, Open); destructible ones
    // take its health damage.
    if (!(await runtime.actors.isActor(target))) {
      await this.#onObject(effect, target, magnitude, duration, caster);
      return false;
    }
    const dead = await runtime.actors.isDead(target);
    if (dead && effect.archetype !== EffectArchetype.reanimate) return false;
    const hostile = (effect.flags & (EffectFlag.hostile | EffectFlag.detrimental)) !== 0;
    // The ethereal take no harm (Become Ethereal: UESP "Skyrim:Become Ethereal").
    if (hostile && caster !== target && this.aiState(target).ethereal) return false;

    // A level-capped effect reaches actors up to its magnitude's level.
    if (LEVEL_CAPPED.has(effect.archetype) && magnitude > 0) {
      if ((await runtime.actors.level(target)) > magnitude) {
        await this.#refused('sMagicEffectResisted', target, item, caster);
        return false;
      }
    }

    // Resistances (not of what an actor has: abilities, diseases): the effect's resist value,
    // and Magic Resistance on hostile spells.
    if (hostile && !lasting) {
      const left = await this.resistedShare(item, effect, target);
      if (left < 1) {
        // Without a magnitude, resistance is the chance of resisting it all (UESP
        // "Skyrim:Magic Resistance": Paralysis).
        const resisted = magnitude === 0 ? Math.random() >= left : left <= 0;
        if (resisted) {
          await this.#refused('sMagicEffectNotApplied', target, item, caster);
          return false;
        }
        magnitude *= left;
      }
    }

    // What it counters and, with Dispel with Keywords, what shares a keyword with it.
    for (const [key, other] of this.effectsOn(target)) {
      const otherEffect = await this.effect(other.effect);
      const counters = effect.counterEffects.includes(other.effect);
      const shares =
        (effect.flags & EffectFlag.dispelWithKeywords) !== 0 &&
        otherEffect !== undefined &&
        other.effect !== effect.formId &&
        otherEffect.keywords.some((keyword) => effect.keywords.includes(keyword));
      if (counters || shares) await this.end(key);
    }
    // The same effect of the same item from the same caster: replaced (No Recast: kept).
    for (const [key, other] of this.effectsOn(target)) {
      if (
        other.item === item.formId &&
        other.index === index &&
        other.caster === caster &&
        other.source === options.source
      ) {
        if ((effect.flags & EffectFlag.noRecast) !== 0) return false;
        await this.end(key);
      }
    }

    const handle = new ObjectHandle(runtime.state.nextEffect++, 'activemagiceffect');
    const key = handle.key;
    const entry: ActiveEffectState = {
      effect: effect.formId,
      target,
      caster,
      elapsed: 0,
      duration,
      magnitude,
      item: item.formId,
      index,
      ...(options.source !== undefined && { source: options.source }),
      area: itemEffect.area,
      ...(lasting && { lasting }),
      ...(dual && { dual }),
      ...(options.at && { at: options.at }),
    };
    runtime.state.activeEffects.set(key, entry);
    const holds = await this.#conditionsHold(key, entry);
    if (!runtime.state.activeEffects.has(key)) return false;
    // An effect at once whose conditions fail does nothing.
    if (!holds && duration === 0 && !lasting) {
      runtime.state.activeEffects.delete(key);
      return false;
    }
    entry.inactive = !holds;
    // The hub tells it (TESMagicEffectApplyEvent: OnMagicEffectApply).
    runtime.events.emit('magicEffectApply', { caster, target, effect: effect.formId });
    if (holds) await this.#activate(key, entry, effect);
    // Effects at once end as they have acted.
    if (duration === 0 && !lasting) await this.end(key);
    return true;
  }

  /** A spell that fails on a target: the player hears of it (sMagicEffectResisted, ...). */
  async #refused(
    setting: 'sMagicEffectResisted' | 'sMagicEffectNotApplied',
    target: number,
    item: MagicItemRecord,
    caster: number | undefined,
  ): Promise<void> {
    if (caster !== PLAYER_REF || target === PLAYER_REF) return;
    const text = await this.#runtime.gameSetting(setting);
    if (typeof text !== 'string') return;
    // "%s is too powerful for %s." / "%s resisted %s.": the target, then the spell.
    const names = [await this.#name(target), item.name];
    this.#runtime.world.notification?.(text.replace(/%s/g, () => names.shift() ?? ''));
  }

  /**
   * An effect on an object: its scripts hear of it; Open and Lock work on its lock; a hostile
   * effect lowering Health (Fire, Frost, Shock Damage) takes a destructible object's health
   * (destruction-engine.ts), its magnitude for each second it lasts (a fire bolt's at once, a
   * concentration's by the time held). TODO(M13): over its duration instead of at once.
   */
  async #onObject(
    effect: MagicEffectRecord,
    target: number,
    magnitude: number,
    duration: number,
    caster: number | undefined,
  ): Promise<void> {
    const runtime = this.#runtime;
    // The hub tells it (TESMagicEffectApplyEvent: OnMagicEffectApply).
    runtime.events.emit('magicEffectApply', { caster, target, effect: effect.formId });
    if (effect.archetype === EffectArchetype.open) {
      const lock = await runtime.lock(target);
      // A lock up to the magnitude's level opens; one only its key opens does not.
      if (lock.locked && lock.level < 255 && lock.level <= magnitude)
        await runtime.setLocked(target, false);
    } else if (effect.archetype === EffectArchetype.lock) {
      await runtime.setLocked(target, true);
    } else if (
      effect.actorValue === ActorValue.health &&
      (effect.flags & (EffectFlag.hostile | EffectFlag.detrimental)) !== 0 &&
      HEALTH_DAMAGING.has(effect.archetype) &&
      magnitude > 0
    ) {
      await runtime.destruction.damage(target, duration > 0 ? magnitude * duration : magnitude, {
        external: true,
        source: caster,
      });
    }
  }

  /** Whether an effect's conditions hold now: its effect item's and its magic effect's. */
  async #conditionsHold(key: string, entry: ActiveEffectState): Promise<boolean> {
    const runtime = this.#runtime;
    const item = entry.item === undefined ? undefined : await this.item(entry.item);
    const effect = await this.effect(entry.effect);
    let conditions = [
      ...(item?.effects[entry.index ?? 0]?.conditions ?? []),
      ...(effect?.conditions ?? []),
    ];
    // A disease's chance (GetRandomPercent) is the chance of catching it, rolled as it is
    // caught (contractDisease), not while it lasts. TODO(M13): inferred from the vanilla
    // diseases' effects (GetRandomPercent <= 2 with the Survival Mode global).
    if (item?.kind === 'disease')
      conditions = conditions.filter((condition) => condition.function !== GET_RANDOM_PERCENT);
    if (conditions.length === 0) return true;
    return runtime.conditionsHold(conditions, runtime.actorHandle(entry.target), undefined, {
      ...(entry.caster !== undefined && { target: runtime.actorHandle(entry.caster) }),
      effectKey: key,
    });
  }

  // --- An effect's life -------------------------------------------------------------------

  /** It acts: its archetype's part, what the world shows, its scripts start. */
  async #activate(key: string, entry: ActiveEffectState, effect: MagicEffectRecord): Promise<void> {
    const runtime = this.#runtime;
    entry.inactive = false;
    const target = entry.target;
    if (isValueEffect(effect)) await this.#valueStart(entry, effect);
    await this.#archetypeStart(key, entry, effect);
    // The image space while it lasts on the player (Night Eye's, a poison's tint).
    if (target === PLAYER_REF && effect.imageSpaceModifier !== undefined)
      runtime.world.imageSpace?.(effect.imageSpaceModifier, 'apply', 1, undefined, target);
    this.#show('start', key, entry, effect);
    const hit = effectSound(effect, EffectSound.onHit);
    if (hit !== undefined) runtime.world.playSound?.(hit, target);
    if (effect.scripted) {
      const handle = handleOf(key);
      this.#scriptWork(key, async () => {
        await runtime.vm.startInitialize(handle);
        runtime.detach(
          runtime.vm.sendEvent(handle, 'OnEffectStart', [
            runtime.actorHandle(target),
            runtime.actorHandleOrNone(entry.caster),
          ]),
        );
      });
    }
  }

  /** It stops acting (it ends, or its conditions fail): all it did is taken back. */
  async #deactivate(key: string, entry: ActiveEffectState, ending: boolean): Promise<void> {
    const runtime = this.#runtime;
    const effect = await this.effect(entry.effect);
    entry.inactive = true;
    this.#takeBack(entry);
    if (effect?.archetype === EffectArchetype.peakValueModifier)
      this.#settlePeak(entry.target, entry.effect);
    if (effect) await this.#archetypeEnd(entry, effect, ending);
    // The paralysed get up once no paralysis is left on them.
    if (
      effect?.archetype === EffectArchetype.paralysis &&
      this.#archetypeOn(entry.target, EffectArchetype.paralysis).length === 0
    )
      runtime.world.paralyze?.(entry.target, false);
    if (effect?.archetype === EffectArchetype.grabActor)
      runtime.world.grabActor?.(entry.caster, entry.target, false);
    if (entry.target === PLAYER_REF && effect?.imageSpaceModifier !== undefined)
      runtime.world.imageSpace?.(effect.imageSpaceModifier, 'remove', 0);
    if (effect) this.#show('stop', key, entry, effect);
    if (effect?.scripted) {
      const handle = handleOf(key);
      if (ending) this.#finishing.set(key, entry);
      this.#scriptWork(key, async () => {
        try {
          await runtime.vm.sendEvent(handle, 'OnEffectFinish', [
            runtime.actorHandle(entry.target),
            runtime.actorHandleOrNone(entry.caster),
          ]);
        } finally {
          runtime.vm.reset(handle);
          if (ending) this.#finishing.delete(key);
        }
      });
    }
  }

  /** An effect's script work, after what it had started (finish, reset, start again). */
  #scriptWork(key: string, work: () => Promise<void>): void {
    const next = (this.#scripts.get(key) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        this.#runtime.warn(
          `magic effect scripts: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.#scripts.set(key, next);
    void next.then(() => {
      if (this.#scripts.get(key) === next) this.#scripts.delete(key);
    });
  }

  /** Ends an effect (it ran out, was dispelled or cured): it stops acting, then it is gone. */
  async end(key: string): Promise<void> {
    const runtime = this.#runtime;
    const entry = runtime.state.activeEffects.get(key);
    if (!entry || this.#ending.has(key)) return;
    this.#ending.add(key);
    try {
      if (!entry.inactive) await this.#deactivate(key, entry, true);
      // An inactive one's scripts finished as it became inactive; what it made goes now.
      else {
        const effect = await this.effect(entry.effect);
        if (effect) await this.#archetypeEnd(entry, effect, true);
      }
    } finally {
      runtime.state.activeEffects.delete(key);
      this.#ending.delete(key);
    }
  }

  #show(
    event: 'start' | 'stop',
    key: string,
    entry: ActiveEffectState,
    effect: MagicEffectRecord,
  ): void {
    this.#runtime.world.magicEffect?.({
      event,
      key,
      effect: effect.formId,
      archetype: effect.archetype,
      target: entry.target,
      caster: entry.caster,
      shader: (effect.flags & EffectFlag.noHitEffect) !== 0 ? undefined : effect.hitShader,
      art: (effect.flags & EffectFlag.noHitEffect) !== 0 ? undefined : effect.hitEffectArt,
      visuals: effect.hitVisuals,
      light: effect.archetype === EffectArchetype.light ? effect.associatedItem : undefined,
      persist: (effect.flags & EffectFlag.fxPersist) !== 0,
      duration: entry.duration,
      magnitude: entry.magnitude,
      area: entry.area ?? 0,
      associated: effect.associatedItem,
    });
  }

  // --- Value modifiers ------------------------------------------------------------------------

  async #valueStart(entry: ActiveEffectState, effect: MagicEffectRecord): Promise<void> {
    const runtime = this.#runtime;
    if (effect.actorValue < 0) return;
    const mode = valueMode(effect, entry.duration, entry.lasting ?? false);
    if (mode === 'perSecond') return;
    if (mode === 'once') {
      await this.#change(entry, effect, valueSign(effect) * entry.magnitude);
      return;
    }
    if (effect.archetype === EffectArchetype.peakValueModifier) {
      this.#settlePeak(entry.target, entry.effect);
      return;
    }
    // Accumulate Magnitude (wards) grows each second (update).
    if (effect.archetype === EffectArchetype.accumulateMagnitude) return;
    const goal = TARGET_VALUES.get(effect.archetype);
    if (goal !== undefined) {
      // Calm, Frenzy, Fear, Rally: the AI value set to its target while it lasts.
      const now = (await runtime.actors.value(entry.target, effect.actorValue)).current;
      this.#add(entry, entry.target, effect.actorValue, goal - now);
      return;
    }
    const amount = valueSign(effect) * valueAmount(effect, entry.magnitude);
    this.#add(entry, entry.target, effect.actorValue, amount);
    this.#addSecond(entry, effect, amount);
    // Absorb's caster gains what its target loses.
    if (effect.archetype === EffectArchetype.absorb && entry.caster !== undefined)
      this.#add(entry, entry.caster, effect.actorValue, -amount);
  }

  /** A temporary modifier of an effect (taken back as it stops: #takeBack). */
  #add(entry: ActiveEffectState, actor: number, value: number, amount: number): void {
    if (amount === 0 || value < 0) return;
    this.#runtime.actors.modifyTemporary(actor, value, amount);
    const applied = (entry.applied ??= []);
    const same = applied.find((part) => part.actor === actor && part.value === value);
    if (same) same.amount += amount;
    else applied.push({ actor, value, amount });
  }

  /** Dual Value Modifier's second actor value: its weight's share of the change. */
  #addSecond(entry: ActiveEffectState, effect: MagicEffectRecord, amount: number): void {
    if (
      effect.secondActorValue >= 0 &&
      (effect.archetype === EffectArchetype.dualValueModifier ||
        effect.archetype === EffectArchetype.enhanceWeapon)
    ) {
      this.#add(entry, entry.target, effect.secondActorValue, amount * effect.secondValueWeight);
    }
  }

  #takeBack(entry: ActiveEffectState): void {
    for (const part of entry.applied ?? [])
      this.#runtime.actors.modifyTemporary(part.actor, part.value, -part.amount);
    delete entry.applied;
  }

  /**
   * Peak Value Modifier: of the active effects of one magic effect on an actor, only the
   * strongest changes its value (CommonLibSSE PeakValueModifierEffect: Compare, its chain).
   */
  #settlePeak(target: number, effectId: number): void {
    const effect = this.#effects.get(effectId);
    if (!effect) return;
    const group = this.effectsOn(target).filter(
      ([, entry]) => entry.effect === effectId && !entry.inactive,
    );
    let best: ActiveEffectState | undefined;
    for (const [, entry] of group) {
      this.#takeBack(entry);
      if (!best || entry.magnitude > best.magnitude) best = entry;
    }
    if (best && effect.actorValue >= 0)
      this.#add(
        best,
        target,
        effect.actorValue,
        valueSign(effect) * valueAmount(effect, best.magnitude),
      );
  }

  /**
   * Damage or a restore of an effect's actor value (and Dual Value Modifier's second; Absorb's
   * caster gains it): damage to Health from a caster names it as the killer; the invulnerable
   * take none.
   */
  async #change(
    entry: ActiveEffectState,
    effect: MagicEffectRecord,
    amount: number,
  ): Promise<void> {
    if (amount === 0 || effect.actorValue < 0) return;
    await this.#modify(entry.target, effect.actorValue, amount, entry.caster);
    if (
      effect.secondActorValue >= 0 &&
      (effect.archetype === EffectArchetype.dualValueModifier ||
        effect.archetype === EffectArchetype.enhanceWeapon)
    ) {
      await this.#modify(
        entry.target,
        effect.secondActorValue,
        amount * effect.secondValueWeight,
        entry.caster,
      );
    }
    if (
      effect.archetype === EffectArchetype.absorb &&
      entry.caster !== undefined &&
      entry.caster !== entry.target &&
      amount < 0
    ) {
      await this.#modify(entry.caster, effect.actorValue, -amount, undefined);
    }
  }

  async #modify(
    actor: number,
    value: number,
    amount: number,
    killer: number | undefined,
  ): Promise<void> {
    const actors = this.#runtime.actors;
    if (amount < 0) {
      if (value === ActorValue.health && (await actors.isInvulnerable(actor))) return;
      if (await actors.isDead(actor)) return;
      await actors.damage(actor, value, -amount, killer);
    } else {
      actors.restore(actor, value, amount);
    }
  }

  // --- The other archetypes -------------------------------------------------------------------

  async #archetypeStart(
    key: string,
    entry: ActiveEffectState,
    effect: MagicEffectRecord,
  ): Promise<void> {
    const runtime = this.#runtime;
    const target = entry.target;
    switch (effect.archetype) {
      case EffectArchetype.cureDisease:
        await this.#cure(target, (item) => item.kind === 'disease', true);
        break;
      case EffectArchetype.curePoison:
        await this.#cure(target, (item) => item.kind === 'poison' || item.kind === 'spellPoison');
        break;
      case EffectArchetype.cureAddiction:
        await this.#cure(target, (item) => item.kind === 'addiction', true);
        break;
      case EffectArchetype.cureParalysis:
        for (const [other] of this.#archetypeOn(target, EffectArchetype.paralysis))
          await this.end(other);
        break;
      case EffectArchetype.dispel:
        // TODO(M13): no vanilla effect dispels; the spells' effects up to its magnitude go
        // (Oblivion's Dispel: UESP "Oblivion:Dispel").
        for (const [other, effectOn] of this.effectsOn(target)) {
          const item = effectOn.item === undefined ? undefined : await this.item(effectOn.item);
          if (
            other !== key &&
            !effectOn.lasting &&
            item?.type === 'SPEL' &&
            effectOn.magnitude <= entry.magnitude
          )
            await this.end(other);
        }
        break;
      case EffectArchetype.summonCreature:
        await this.#summon(entry, effect);
        break;
      case EffectArchetype.reanimate:
        // A corpse up to the level rises to fight for its caster (until the effect ends).
        if (await runtime.actors.isDead(target)) {
          await runtime.actors.resurrect(target);
          entry.made = target;
          // The caster's perks give the risen a spell (Apply Reanimate Spell: Dark Souls).
          const caster = entry.caster;
          const spell =
            caster === undefined
              ? undefined
              : await runtime.perks.selectSpell(
                  EntryPoint.applyReanimateSpell,
                  caster,
                  [entry.item, target],
                  entry.item === undefined ? {} : { spell: entry.item },
                );
          const item = spell === undefined ? undefined : await this.item(spell);
          if (item) await this.apply(item, target, { caster: target });
        }
        break;
      case EffectArchetype.banish:
        // A summoned creature up to the level goes back (its summoning ends).
        for (const [other, summoning] of runtime.state.activeEffects) {
          if (
            summoning.made === target &&
            this.#effects.get(summoning.effect)?.archetype === EffectArchetype.summonCreature
          ) {
            await this.end(other);
          }
        }
        break;
      case EffectArchetype.boundWeapon: {
        // The bound weapon in its hand while it lasts (the equip system gives it to it).
        const weapon = effect.associatedItem;
        if (weapon === undefined) break;
        await runtime.equipment.equip(target, weapon, { silent: true });
        entry.made = weapon;
        break;
      }
      case EffectArchetype.spawnHazard:
      case EffectArchetype.spawnScriptedRef: {
        // A hazard (HAZD) or an object at the target, or where a Target Location spell landed,
        // while it lasts; a hazard burns, freezes or heals there (the hazard engine: its
        // lifetime, its spell on those within its radius, cast by the caster).
        const made = effect.associatedItem;
        if (made !== undefined) {
          entry.made = await runtime.placeAt(made, target, 1);
          if (entry.at) runtime.move(entry.made, [...entry.at]);
          if (effect.archetype === EffectArchetype.spawnHazard)
            await runtime.hazards.track(entry.made, made, entry.caster ?? target, {
              duration: entry.duration,
              ...(entry.area !== undefined && { area: entry.area }),
            });
        }
        break;
      }

      case EffectArchetype.disarm: {
        // Its weapons leave its hands (UESP "Skyrim:Disarm": up to the magnitude's level, the
        // level cap above): the right hand's falls from the hand into the world, a reference
        // anyone can pick up; a dual wielder's left goes into its inventory; bound weapons stay.
        let dropped = false;
        for (const hand of ['right', 'left'] as const) {
          const weapon = await runtime.equipment.weapon(target, hand);
          if (weapon === undefined || this.#bound(target, weapon)) continue;
          if (!(await runtime.equipment.unequip(target, weapon, { hand }))) continue;
          dropped = true;
          if (hand === 'right') await this.#dropWeapon(target, weapon);
        }
        if (dropped) {
          if (target === PLAYER_REF) {
            const text = await runtime.gameSetting('sPlayerDisarmedMessage');
            if (typeof text === 'string') runtime.world.notification?.(text);
          }
        }
        break;
      }
      case EffectArchetype.stagger:
        // A stagger by its magnitude, weighed against the target's mass (src/shell/
        // actor-combat.ts staggerEffect); a knock-down is its scripts' (Unrelenting Force's
        // third word: VoicePushEffectScript's PushActorAway).
        if (entry.magnitude > 0 && !(await runtime.actors.isDead(target)))
          runtime.world.stagger?.(target, entry.magnitude, entry.caster);
        break;
      case EffectArchetype.paralysis:
        // It falls as its ragdoll and lies while it lasts (src/shell/actor-knockdowns.ts).
        runtime.world.paralyze?.(target, true);
        break;
      case EffectArchetype.grabActor:
        // Vampiric Grip: its target hangs as its ragdoll before the caster while it lasts.
        if (!(await runtime.actors.isDead(target)))
          runtime.world.grabActor?.(entry.caster, target, true);
        break;
      // A werewolf fed on the corpse (PlayerWerewolfFeedVictimSpell, the Feed perk's choice):
      // it is eaten (HasBeenEaten: no one feeds on it again).
      case EffectArchetype.werewolfFeed:
        runtime.state.actor(target).eaten = true;
        break;
      // Cloaks act each second (#pulse); Soul Trap as its target dies (died). Concussion,
      // Telekinesis, Grab Actor, Light, Detect Life, Guide, Disguise, Werewolf, Vampire Lord,
      // Slow Time, Etherealize, Command Summoned, Script: their state is the effect itself
      // (aiState, timeMultiplier) and their scripts; what they show (lights, Detect Life's
      // shader, Clairvoyance's trail) the world's magicEffect shows (src/shell/actor-effects.ts).
      // Telekinesis: the player's cast takes hold of the object aimed at
      // (src/shell/player-casting.ts).
      default:
        break;
    }
  }

  /** Whether a weapon in an actor's hands is a bound one (a Bound Weapon effect's on it). */
  #bound(actor: number, weapon: number): boolean {
    return this.#archetypeOn(actor, EffectArchetype.boundWeapon).some(
      ([, entry]) => entry.made === weapon,
    );
  }

  /**
   * A disarmed weapon leaves its holder's items and falls from its hand (the WEAPON node; its
   * place without one): a new reference of it in the world, which the world drops and anyone
   * may pick up.
   */
  async #dropWeapon(actor: number, weapon: number): Promise<void> {
    const runtime = this.#runtime;
    await runtime.removeItem(actor, runtime.formHandle(weapon), 1, true, undefined);
    const dropped = await runtime.placeAt(weapon, actor, 1);
    const hand = runtime.world.nodePlacement?.(actor, 'WEAPON');
    const at = hand?.position ?? (await runtime.placement(actor))?.position;
    if (!at) return;
    runtime.move(dropped, [at[0], at[1], at[2] + (hand ? 0 : 64)]);
    runtime.world.moved?.(dropped);
  }

  async #archetypeEnd(
    entry: ActiveEffectState,
    effect: MagicEffectRecord,
    ending: boolean,
  ): Promise<void> {
    const runtime = this.#runtime;
    const made = entry.made;
    if (made === undefined || !MAKERS.has(effect.archetype)) return;
    // What an effect made goes only as it ends (not while its conditions fail).
    if (!ending) return;
    delete entry.made;
    switch (effect.archetype) {
      case EffectArchetype.spawnHazard:
        runtime.hazards.remove(made);
        break;
      case EffectArchetype.summonCreature:
      case EffectArchetype.spawnScriptedRef: {
        // The summon fades out (fSummonedCreatureFadeOutSeconds) and is gone.
        const state = runtime.state.reference(made);
        state.deleted = true;
        runtime.world.enableChanged?.(made, false);
        break;
      }
      case EffectArchetype.reanimate:
        // The corpse falls again (its scripts turn it to ash).
        await runtime.actors.kill(made, undefined, true);
        break;
      case EffectArchetype.boundWeapon:
        await runtime.equipment.unequip(entry.target, made);
        await runtime.removeItem(entry.target, runtime.formHandle(made), 1, true, undefined);
        break;
    }
  }

  /**
   * Cures: the effects of the magic items it cures end; a disease (or addiction) the actor had
   * as a spell is gone from its spells.
   */
  async #cure(
    target: number,
    cures: (item: MagicItemRecord) => boolean,
    spells = false,
  ): Promise<void> {
    for (const [key, entry] of this.effectsOn(target)) {
      const item = entry.item === undefined ? undefined : await this.item(entry.item);
      if (!item || !cures(item)) continue;
      if (spells && item.type === 'SPEL')
        await this.#runtime.actors.removeSpell(target, item.formId);
      await this.end(key);
    }
  }

  /** Summon Creature: its creature at the summoner's side, commanded by it while it lasts. */
  async #summon(entry: ActiveEffectState, effect: MagicEffectRecord): Promise<void> {
    const runtime = this.#runtime;
    const creature = effect.associatedItem;
    if (creature === undefined) return;
    const summoner = entry.caster ?? entry.target;
    // Beyond the summoner's limit the oldest summon goes.
    const summons = [...runtime.state.activeEffects].filter(
      ([, other]) =>
        other !== entry &&
        other.made !== undefined &&
        (other.caster ?? other.target) === summoner &&
        this.#effects.get(other.effect)?.archetype === EffectArchetype.summonCreature,
    );
    const limit = Math.round(
      await runtime.perks.apply(EntryPoint.modCommandedActorLimit, summoner, SUMMON_LIMIT, [
        entry.item,
      ]),
    );
    for (const [key] of summons.slice(0, Math.max(0, summons.length - limit + 1)))
      await this.end(key);
    const made = await runtime.placeAt(creature, summoner, 1);
    const at = await runtime.placement(summoner);
    if (at && entry.at) {
      // Where its Target Location spell landed, facing the summoner.
      const heading = Math.atan2(at.position[0] - entry.at[0], at.position[1] - entry.at[1]);
      runtime.move(made, [...entry.at], [0, 0, heading], at.cell, at.world);
    } else if (at) {
      const heading = at.rotation[2];
      const position: Vec3 = [
        at.position[0] + Math.sin(heading) * SUMMON_DISTANCE,
        at.position[1] + Math.cos(heading) * SUMMON_DISTANCE,
        at.position[2],
      ];
      runtime.move(made, position, [0, 0, heading + Math.PI], at.cell, at.world);
    }
    entry.made = made;
  }

  // --- Dispelling -------------------------------------------------------------------------

  /** ActiveMagicEffect.Dispel, a script's end of an effect. */
  dispel(key: string): Promise<void> {
    return this.end(key);
  }

  /** Actor.DispelSpell: the spell's effects on the actor end (true if it had any). */
  async dispelSpell(target: number, item: number): Promise<boolean> {
    const found = this.effectsOn(target).filter(
      ([, entry]) => entry.item === item && !entry.lasting,
    );
    for (const [key] of found) await this.end(key);
    return found.length > 0;
  }

  /**
   * Actor.DispelAllSpells: every effect on it but those it has (abilities, diseases, worn
   * enchantments). TODO(M13): whether potions' effects go too.
   */
  async dispelAll(target: number): Promise<void> {
    for (const [key, entry] of this.effectsOn(target)) if (!entry.lasting) await this.end(key);
  }

  /** The actor attacked, cast or activated: its invisibility ends (UESP "Skyrim:Invisibility"). */
  acted(actor: number): void {
    for (const [key] of this.#archetypeOn(actor, EffectArchetype.invisibility))
      this.#runtime.detach(this.end(key));
  }

  /**
   * An actor died: the caster of a Soul Trap on it takes its soul; its effects end but those
   * that stay on the dead (No Death Dispel); what it summoned or raised goes, and a summon
   * that dies ends its summoning.
   */
  async died(actor: number): Promise<void> {
    const runtime = this.#runtime;
    for (const [, entry] of this.#archetypeOn(actor, EffectArchetype.soulTrap)) {
      if (entry.caster !== undefined && (await this.trapSoul(entry.caster, actor))) break;
    }
    for (const [key, entry] of this.effectsOn(actor)) {
      const effect = await this.effect(entry.effect);
      if (((effect?.flags ?? 0) & EffectFlag.noDeathDispel) === 0) await this.end(key);
    }
    for (const [key, entry] of [...runtime.state.activeEffects]) {
      if (entry.made === undefined) continue;
      const archetype = this.#effects.get(entry.effect)?.archetype;
      const summoner =
        archetype === EffectArchetype.summonCreature
          ? (entry.caster ?? entry.target)
          : archetype === EffectArchetype.reanimate
            ? entry.caster
            : undefined;
      if (entry.made === actor || (summoner !== undefined && summoner === actor))
        await this.end(key);
    }
  }

  /**
   * Actor.TrapSoul and Soul Trap: a dead actor's soul goes into the trapper's smallest empty
   * soul gem that holds it (its filled form, SLGM NAM0, in its place), with the Soul Captured
   * sound (DOBJ SCSD). True if it was trapped.
   */
  async trapSoul(trapper: number, victim: number): Promise<boolean> {
    const runtime = this.#runtime;
    if (!(await runtime.actors.isActor(victim))) return false;
    // TODO(M13): undead, Dwarven constructs and the like have no soul (HelpSoulGems) by a rule
    // not documented; the NPC keyword for a black soul.
    const npc = await runtime.hasKeyword(victim, ACTOR_TYPE_NPC);
    const levels = {
      lesser: await this.#setting('iLesserSoulActorLevel', 4),
      common: await this.#setting('iCommonSoulActorLevel', 16),
      greater: await this.#setting('iGreaterSoulActorLevel', 28),
      grand: await this.#setting('iGrandSoulActorLevel', 38),
    };
    const size = soulSize(await runtime.actors.level(victim), npc, levels);
    const gems: SoulGemRecord[] = [];
    for (const [formId, count] of await runtime.inventory(trapper)) {
      if (count <= 0) continue;
      const record = await runtime.forms.record(formId);
      const gem = record && parseSoulGem(record);
      if (gem?.filled !== undefined) gems.push(gem);
    }
    const gem = soulGemFor(gems, size, npc);
    if (gem?.filled === undefined) return false;
    await runtime.removeItem(trapper, runtime.formHandle(gem.formId), 1, true, undefined);
    await runtime.addItem(trapper, runtime.formHandle(gem.filled), 1, true);
    this.#defaults ??= DefaultObjects.read(runtime.forms.db);
    const sound = (await this.#defaults).get('SCSD');
    if (sound !== undefined) runtime.world.playSound?.(sound, trapper);
    return true;
  }

  // --- Lasting effects ---------------------------------------------------------------------

  /**
   * An actor's lasting effects follow what it has from now on (an actor that loads, the
   * player): its abilities (its own and its perks'), diseases and addictions, the constant enchantments of what it
   * wears and their equip abilities.
   */
  async prepare(actor: number): Promise<void> {
    this.#prepared.add(actor);
    await this.syncLasting(actor);
  }

  /** An actor left the loaded area: its lasting effects stay as they are. */
  unloaded(actor: number): void {
    if (actor !== PLAYER_REF) this.#prepared.delete(actor);
  }

  /** Its lasting effects made to match what it has now (added, and taken away). */
  async syncLasting(actor: number): Promise<void> {
    const runtime = this.#runtime;
    if (!(await runtime.actors.isActor(actor)) || (await runtime.actors.isDead(actor))) return;
    const wanted = new Map<string, { item: MagicItemRecord; source: number | undefined }>();
    const want = (item: MagicItemRecord, source: number | undefined): void => {
      wanted.set(`${String(item.formId)}:${String(source)}`, { item, source });
    };
    for (const spell of await runtime.actors.spells(actor)) {
      const item = await this.item(spell);
      if (item?.type === 'SPEL' && isLastingKind(item.kind)) want(item, undefined);
    }
    // The abilities of the perks it holds (perk-engine.ts: Merchant, Fence, Agent of Mara ...).
    for (const { spell } of await runtime.perks.abilities(actor)) {
      const item = await this.item(spell);
      if (item?.type === 'SPEL') want(item, undefined);
    }
    // Everything it has equipped (the equip system: what it wears and holds).
    await runtime.equipment.of(actor);
    const worn = new Set(runtime.state.actors.get(actor)?.equipped ?? []);
    for (const object of worn) {
      const enchantment = (await runtime.forms.record(object))?.formIdField('EITM');
      const item = enchantment === undefined ? undefined : await this.item(enchantment);
      if (item?.type !== 'ENCH') continue;
      if (item.castType === 0) want(item, object);
      // An enchantment's equip abilities are its wearer's (MGEF Equip Ability).
      for (const entry of item.effects) {
        const ability = (await this.effect(entry.effect))?.equipAbility;
        const abilityItem = ability === undefined ? undefined : await this.item(ability);
        if (abilityItem) want(abilityItem, object);
      }
    }
    const have = new Set<string>();
    for (const [key, entry] of this.effectsOn(actor)) {
      if (!entry.lasting) continue;
      const id = `${String(entry.item)}:${String(entry.source)}`;
      if (wanted.has(id)) have.add(id);
      else await this.end(key);
    }
    for (const [id, { item, source }] of wanted) {
      if (!have.has(id)) await this.apply(item, actor, { caster: actor, lasting: true, source });
    }
  }

  // --- Items used ---------------------------------------------------------------------------

  /**
   * An actor uses an item: a potion drunk or food eaten (its effects on the actor, its sound;
   * its addiction by chance), an ingredient eaten (its first effect, which the player then
   * knows: UESP "Skyrim:Ingredients"), a poison put on the weapon (applyPoison). The item is
   * used up (`remove`: from its inventory); the actor's scripts get OnObjectEquipped.
   */
  async useItem(
    actor: number,
    formId: number,
    options: { readonly remove?: boolean } = {},
  ): Promise<'used' | 'poisoned' | 'not used'> {
    const runtime = this.#runtime;
    const item = await this.item(formId);
    if (!item || (item.type !== 'ALCH' && item.type !== 'INGR')) return 'not used';
    if (item.kind === 'poison') {
      return (await this.applyPoison(actor, formId, options)) ? 'poisoned' : 'not used';
    }
    // Carried: the equip system uses one up and tells its scripts (EquipmentEngine.use), its
    // effects come back here (consumed); made for the moment (an NPC's meal): told and applied.
    if (options.remove ?? true) {
      if (!(await runtime.equipment.use(actor, formId))) return 'not used';
    } else {
      await runtime.equipment.used(actor, formId);
      await this.consumed(actor, formId);
    }
    const sound = item.potion?.useSound;
    if (sound !== undefined) runtime.world.playSound?.(sound, actor);
    return 'used';
  }

  /**
   * A potion, food or an ingredient used up (EquipmentEngine.use): its effects on the actor (an
   * ingredient's first: UESP "Skyrim:Ingredients"), its addiction by chance; the world shows
   * the casting (castSpell). A poison is not drunk (applyPoison puts it on the weapon).
   */
  async consumed(actor: number, formId: number): Promise<void> {
    const runtime = this.#runtime;
    const item = await this.item(formId);
    if (!item || item.kind === 'poison' || (item.type !== 'ALCH' && item.type !== 'INGR')) return;
    runtime.world.castSpell?.(formId, actor, actor);
    if (item.type === 'INGR') {
      await this.apply(item, actor, { caster: actor, effects: [0] });
      return;
    }
    await this.apply(item, actor, { caster: actor });
    const addiction = item.potion?.addiction;
    if (addiction !== undefined && Math.random() < (item.potion?.addictionChance ?? 0))
      await runtime.actors.addSpell(actor, addiction);
  }

  /**
   * A poison put on an actor's weapon, for its next hits (one dose; the perks' Mod Poison Dose
   * Count: Concentrated Poison's two): the player is asked first (sPoisonConfirmMessage + the weapon's
   * name, sPoisonBowConfirmMessage for a bow), told when no weapon is out
   * (sPoisonNoWeaponMessage) or the weapon is poisoned already (sPoisonAlreadyPoisonedMessage).
   */
  async applyPoison(
    actor: number,
    poison: number,
    options: { readonly remove?: boolean } = {},
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const weapon =
      (await runtime.equipment.weapon(actor, 'right')) ??
      (await runtime.equipment.weapon(actor, 'left'));
    const dnam =
      weapon === undefined ? undefined : (await runtime.forms.record(weapon))?.fields.first('DNAM');
    // A bow or a crossbow (WEAP DNAM animation type 7, 9).
    const bow = dnam !== undefined && (dnam[0] === 7 || dnam[0] === 9);
    const notify = async (setting: string): Promise<void> => {
      const text = await runtime.gameSetting(setting);
      if (actor === PLAYER_REF && typeof text === 'string') runtime.world.notification?.(text);
    };
    if (weapon === undefined) {
      await notify('sPoisonNoWeaponMessage');
      return false;
    }
    const magic = runtime.state.actorMagic.get(actor) ?? {};
    if (magic.poison && magic.poison.charges > 0) {
      await notify('sPoisonAlreadyPoisonedMessage');
      return false;
    }
    if (actor === PLAYER_REF && runtime.world.messageBox) {
      const question = await runtime.gameSetting(
        bow ? 'sPoisonBowConfirmMessage' : 'sPoisonConfirmMessage',
      );
      const name = (await runtime.forms.record(weapon))?.text('FULL') ?? '';
      const [yes, no] = await Promise.all([
        runtime.gameSetting('sYes'),
        runtime.gameSetting('sNo'),
      ]);
      const chosen = await runtime.world.messageBox(
        `${typeof question === 'string' ? question : ''}${name}?`,
        [typeof yes === 'string' ? yes : 'Yes', typeof no === 'string' ? no : 'No'],
      );
      if (chosen !== 0) return false;
    }
    if (options.remove ?? true) {
      if ((await runtime.itemCount(actor, poison)) <= 0) return false;
      await runtime.removeItem(actor, runtime.formHandle(poison), 1, true, undefined);
    }
    // As many hits as the perks give it (Mod Poison Dose Count: Concentrated Poison, two).
    const charges = Math.max(
      1,
      Math.round(
        await runtime.perks.apply(EntryPoint.modPoisonDoseCount, actor, 1, [weapon, poison]),
      ),
    );
    magic.poison = { weapon, poison, charges };
    runtime.state.actorMagic.set(actor, magic);
    return true;
  }

  /**
   * A weapon's hit on a target (src/shell/actor-combat.ts): its enchantment's effects
   * (fire and forget, from the attacker, while its charge lasts: each hit uses some, the
   * crafting engine's) and the poison on it.
   */
  async weaponHit(attacker: number, target: number, weapon: number | undefined): Promise<void> {
    const runtime = this.#runtime;
    if (weapon !== undefined) {
      const enchantment = (await runtime.forms.record(weapon))?.formIdField('EITM');
      const item = enchantment === undefined ? undefined : await this.item(enchantment);
      if (
        item?.type === 'ENCH' &&
        item.kind === 'enchantment' &&
        item.castType !== 0 &&
        (await runtime.crafting.useCharge(attacker, weapon))
      )
        await this.apply(item, target, { caster: attacker, source: weapon });
    }
    const magic = runtime.state.actorMagic.get(attacker);
    const poison = magic?.poison;
    if (magic && poison && (poison.weapon === undefined || poison.weapon === weapon)) {
      const item = await this.item(poison.poison);
      if (
        item &&
        (await this.apply(item, target, { caster: attacker })) > 0 &&
        target === PLAYER_REF
      ) {
        const text = await runtime.gameSetting('sPoisoned');
        if (typeof text === 'string') runtime.world.notification?.(text);
      }
      poison.charges--;
      if (poison.charges <= 0) delete magic.poison;
    }
  }

  /**
   * A disease caught (a diseased creature's hit: src/shell/actor-combat.ts): unless the target's Disease
   * Resistance resists it (its percentage as a chance), it has the disease from now on (a
   * spell it has, until cured). True if it caught it.
   */
  async contractDisease(target: number, disease: number): Promise<boolean> {
    const runtime = this.#runtime;
    const item = await this.item(disease);
    if (item?.kind !== 'disease' || (await runtime.actors.hasSpell(target, disease))) return false;
    const resist = (await runtime.actors.value(target, MagicValue.diseaseResist)).current;
    if (Math.random() * 100 < resist) return false;
    // Its effects' chance (GetRandomPercent conditions) of catching it.
    const chances = item.effects.flatMap((entry) =>
      entry.conditions.filter((condition) => condition.function === GET_RANDOM_PERCENT),
    );
    const first = item.effects[0] && (await this.effect(item.effects[0].effect));
    chances.push(...(first?.conditions ?? []).filter((c) => c.function === GET_RANDOM_PERCENT));
    if (chances.length > 0 && !(await runtime.conditionsHold(chances, runtime.actorHandle(target))))
      return false;
    await runtime.actors.addSpell(target, disease);
    await this.syncLasting(target);
    return true;
  }

  // --- Time ---------------------------------------------------------------------------------

  /**
   * Every frame: effects last on (their durations count real seconds; game time passing in a
   * wait counts as the real seconds it stands for), those that act each second act, wards
   * grow, those that ran out end; about each second lasting effects follow what actors have,
   * conditions are looked at again and cloaks reach those near.
   */
  update(seconds: number): void {
    if (seconds <= 0) return;
    const ended: string[] = [];
    const changes: { entry: ActiveEffectState; effect: MagicEffectRecord; amount: number }[] = [];
    for (const [key, entry] of this.#runtime.state.activeEffects) {
      if (this.#ending.has(key)) continue;
      const before = entry.elapsed;
      entry.elapsed += seconds;
      const effect = this.#effects.get(entry.effect);
      if (!entry.inactive && effect && isValueEffect(effect) && effect.actorValue >= 0) {
        const span =
          entry.duration > 0 ? Math.max(0, Math.min(seconds, entry.duration - before)) : seconds;
        const mode = valueMode(effect, entry.duration, entry.lasting ?? false);
        if (mode === 'perSecond' && span > 0) {
          changes.push({ entry, effect, amount: valueSign(effect) * entry.magnitude * span });
        } else if (effect.archetype === EffectArchetype.accumulateMagnitude) {
          // A ward grows by its magnitude each second up to it. TODO(M13): the engine's rate.
          const now = entry.applied?.[0]?.amount ?? 0;
          const grow = Math.min(entry.magnitude - now, entry.magnitude * seconds);
          if (grow > 0) this.#add(entry, entry.target, effect.actorValue, grow);
        }
      }
      if (!entry.lasting && entry.duration > 0 && entry.elapsed >= entry.duration) ended.push(key);
    }
    if (changes.length > 0) {
      this.#changes = this.#changes.then(async () => {
        for (const change of changes)
          await this.#change(change.entry, change.effect, change.amount);
      });
      this.#runtime.detach(this.#changes);
    }
    for (const key of ended) this.#runtime.detach(this.end(key));
    this.#pulseWait -= seconds;
    if (this.#pulseWait <= 0 && !this.#pulsing) {
      this.#pulseWait = PULSE_SECONDS;
      this.#pulsing = true;
      this.#runtime.detach(
        this.#pulse().finally(() => {
          this.#pulsing = false;
        }),
      );
    }
  }

  async #pulse(): Promise<void> {
    const runtime = this.#runtime;
    for (const actor of [...this.#prepared]) await this.syncLasting(actor);
    for (const [key, entry] of [...runtime.state.activeEffects]) {
      if (this.#ending.has(key) || !runtime.state.activeEffects.has(key)) continue;
      const effect = await this.effect(entry.effect);
      if (!effect) continue;
      const holds = await this.#conditionsHold(key, entry);
      if (!runtime.state.activeEffects.has(key) || this.#ending.has(key)) continue;
      if (holds && entry.inactive) await this.#activate(key, entry, effect);
      else if (!holds && !entry.inactive) await this.#deactivate(key, entry, false);
      if (!entry.inactive && effect.archetype === EffectArchetype.cloak)
        await this.#cloak(entry, effect);
    }
  }

  /**
   * A cloak: its spell (MGEF's associated SPEL) on every actor within its magnitude in feet of
   * its wearer, each second. TODO(M13): the radius read as the magnitude (the vanilla cloaks'
   * areas are 0).
   */
  async #cloak(entry: ActiveEffectState, effect: MagicEffectRecord): Promise<void> {
    const runtime = this.#runtime;
    const spell =
      effect.associatedItem === undefined ? undefined : await this.item(effect.associatedItem);
    const center = runtime.world.livePlacement?.(entry.target)?.position;
    if (!spell || !center) return;
    const radius = Math.max(entry.magnitude, entry.area ?? 0) * UNITS_PER_FOOT;
    for (const reference of runtime.world.loadedReferences?.() ?? []) {
      if (reference === entry.target) continue;
      const at = runtime.world.livePlacement?.(reference)?.position;
      if (!at || Math.hypot(at[0] - center[0], at[1] - center[1], at[2] - center[2]) > radius)
        continue;
      if (!(await runtime.actors.isActor(reference)) || (await runtime.actors.isDead(reference)))
        continue;
      await this.apply(spell, reference, { caster: entry.target });
    }
  }

  /** IsUndead: the actor has the ActorTypeUndead keyword (Creation Kit: IsUndead). */
  isUndead(actor: number): Promise<boolean> {
    return this.#runtime.hasKeyword(actor, ACTOR_TYPE_UNDEAD);
  }
}
