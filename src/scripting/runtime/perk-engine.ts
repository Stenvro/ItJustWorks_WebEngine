// The perk system on the running game (docs/gameplay.md, "Perks"). An actor holds perks from
// its base (NPC_ PRKR, through its spell list template; the player's 0x7 holds the skill boost
// perks), from scripts and the skills menu (Actor.AddPerk / RemovePerk: GameState actor perks),
// and from the magic effects on it (MGEF DATA's perk: an amulet's, a Rested bonus, Dragonhide)
// while they are active. Races hold none (RACE has no perk list). A held perk's entries
// (src/world/perk-records.ts) act: an ability entry's spell is the actor's while it holds it
// (the magic system's lasting effects), a quest entry sets its stage as the perk is added, and
// its entry point entries change the values the systems ask for (applyEntryPoint: every held
// entry of that entry point whose rank the actor reaches, in priority order, each whose
// conditions hold on their tab's subject: the owner, the weapon, the target ... the caller
// passes). The entry point functions (EPMagic_SpellHasSkill, EPAlchemyEffectHasKeyword,
// IsAttackType, ...) read what the caller is doing (PerkContext). Where each system asks:
// docs/gameplay.md ("Perks"). Activate's choices run their perk's script fragment (PERK
// VMAD: the werewolf's Feed), Set Activate Label names the prompt, Allow Mount Actor lets the
// player ride a tamed dragon (src/shell/actor-mounts.ts). Entry points no system asks yet:
// Mod Ingredients Harvested (TODO(M11): harvesting flora), Mod Player
// Magic Slowdown (TODO(M11): Slow Time's clock), Mod Bow Zoom and Mod Falling Damage
// (TODO(M13): the bow's zoom, falling damage). Platform-independent.

import {
  applyEntryFunction,
  ENTRY_POINTS,
  EntryFunction,
  EntryPoint,
  orderEntries,
  type ConditionSubject,
} from '../../gameplay/perk-entry-points.ts';
import { parsePerk, type EntryPointEntry, type PerkRecord } from '../../world/perk-records.ts';
import type { Condition } from '../conditions.ts';
import { ObjectHandle } from '../values.ts';
import { globalValue } from './condition-values.ts';
import type { ScriptRuntime } from './runtime.ts';

/** Condition functions only perk entries use (UESP "Skyrim Mod:Function Indices"). */
export const PerkFn = {
  getLockLevel: 65,
  hasBeenEaten: 127,
  epAlchemyGetMakingPoison: 500,
  epAlchemyEffectHasKeyword: 501,
  epTemperingItemIsEnchanted: 659,
  epTemperingItemHasKeyword: 660,
  epModSkillUsageIsAdvanceSkill: 681,
  epModSkillUsageAdvanceObjectHasKeyword: 691,
  epModSkillUsageIsAdvanceAction: 692,
  epMagicSpellHasKeyword: 693,
  epMagicSpellHasSkill: 696,
  isAttackType: 697,
  spellHasCastingPerk: 713,
  isUnlockedDoor: 718,
  isPoison: 721,
} as const;

/**
 * What the caller is doing, for the entry point functions: the magic item cast or made (its
 * keywords and school: EPMagic_*), the effect of a potion being made and whether it is a
 * poison (EPAlchemy*), the skill used and what for (EPModSkillUsage_*), the attack's type
 * (its ATKD keyword: IsAttackType), the item tempered (EPTempering*).
 */
export interface PerkContext {
  readonly spell?: number;
  readonly alchemyEffect?: number;
  readonly makingPoison?: boolean;
  readonly advanceSkill?: number;
  readonly advanceObject?: number;
  readonly advanceAction?: number;
  readonly attackType?: number;
  readonly temperingItem?: number;
}

/** A perk an actor holds, its rank, and where it comes from. */
export interface HeldPerk {
  readonly perk: number;
  /** Ranks held (1: its first); entries of a higher PRKE rank wait for more. */
  readonly rank: number;
  readonly from: 'base' | 'added' | 'effect';
}

/** An activation choice a perk adds (the Activate entry point: Feed, Harvest Blood, ...). */
export interface ActivateChoice {
  readonly perk: number;
  readonly label: string;
  readonly spell: number | undefined;
  readonly runImmediately: boolean;
  readonly replaceDefault: boolean;
  readonly fragment: number;
}

/** What a tab's subject is: a reference (actors, the locked one) or a base form. */
const REFERENCE_SUBJECTS: ReadonlySet<ConditionSubject> = new Set([
  'owner',
  'target',
  'attacker',
  'lockedReference',
]);

export class PerkEngine {
  readonly #runtime: ScriptRuntime;
  readonly #records = new Map<number, Promise<PerkRecord | undefined>>();
  /** Actors (corpses) the player has fed on with Cannibalism (HasBeenEaten). TODO(M12): saved. */
  readonly eaten = new Set<number>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** A perk's record, read once. */
  record(formId: number): Promise<PerkRecord | undefined> {
    let pending = this.#records.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'PERK' ? parsePerk(record) : undefined));
      this.#records.set(formId, pending);
    }
    return pending;
  }

  // --- Held perks -----------------------------------------------------------------------------

  /** The perks an actor holds now: its base's, those added (less those removed), its effects'. */
  async held(actor: number): Promise<HeldPerk[]> {
    const runtime = this.#runtime;
    const info = await runtime.actors.info(actor);
    const set = runtime.state.actors.get(actor)?.perks;
    const held = new Map<number, HeldPerk>();
    for (const perk of info?.spells.perks ?? []) {
      if (set?.get(perk) === false) continue;
      held.set(perk, { perk, rank: info?.spells.perkRanks.get(perk) ?? 1, from: 'base' });
    }
    for (const [perk, has] of set ?? []) {
      if (has && !held.has(perk)) held.set(perk, { perk, rank: 1, from: 'added' });
    }
    for (const perk of await this.#effectPerks(actor)) {
      if (!held.has(perk)) held.set(perk, { perk, rank: 1, from: 'effect' });
    }
    return [...held.values()];
  }

  /** The perks the active magic effects on an actor give it (MGEF DATA perk). */
  async #effectPerks(actor: number): Promise<number[]> {
    const magic = this.#runtime.magic;
    const perks: number[] = [];
    for (const [, entry] of magic.effectsOn(actor)) {
      if (entry.inactive === true) continue;
      const perk = (await magic.effect(entry.effect))?.perk;
      if (perk !== undefined) perks.push(perk);
    }
    return perks;
  }

  /** HasPerk: whether it holds a perk (from any source). */
  async has(actor: number, perk: number): Promise<boolean> {
    if (await this.#runtime.actors.hasPerk(actor, perk)) return true;
    return (await this.#effectPerks(actor)).includes(perk);
  }

  /**
   * AddPerk (scripts, the skills menu): it holds the perk from now on; its quest entries set
   * their stages, its abilities become the actor's (the magic system's lasting effects).
   */
  async add(actor: number, perk: number): Promise<void> {
    const runtime = this.#runtime;
    const had = await runtime.actors.hasPerk(actor, perk);
    runtime.actors.setPerk(actor, perk, true);
    if (had) return;
    const record = await this.record(perk);
    for (const entry of record?.entries ?? []) {
      if (entry.kind === 'quest' && entry.rank === 0)
        await runtime.quests.setStage(entry.quest, entry.stage);
    }
    if (record?.entries.some((entry) => entry.kind === 'ability'))
      await runtime.magic.syncLasting(actor);
  }

  /** RemovePerk: it no longer holds it (its abilities go). */
  async remove(actor: number, perk: number): Promise<void> {
    const runtime = this.#runtime;
    const had = await runtime.actors.hasPerk(actor, perk);
    runtime.actors.setPerk(actor, perk, false);
    if (!had) return;
    const record = await this.record(perk);
    if (record?.entries.some((entry) => entry.kind === 'ability'))
      await runtime.magic.syncLasting(actor);
  }

  /** The ability spells of the perks it holds (each held perk's ability entries). */
  async abilities(actor: number): Promise<{ spell: number; perk: number }[]> {
    const spells: { spell: number; perk: number }[] = [];
    for (const { perk, rank } of await this.held(actor)) {
      for (const entry of (await this.record(perk))?.entries ?? []) {
        if (entry.kind === 'ability' && entry.rank < rank)
          spells.push({ spell: entry.spell, perk });
      }
    }
    return spells;
  }

  // --- Entry points ---------------------------------------------------------------------------

  /** The entries of an entry point an actor holds (its ranks), in the order they run. */
  async entries(
    actor: number,
    entryPoint: number,
  ): Promise<{ entry: EntryPointEntry; perk: number }[]> {
    const found: { entry: EntryPointEntry; perk: number; priority: number }[] = [];
    for (const { perk, rank } of await this.held(actor)) {
      for (const entry of (await this.record(perk))?.entries ?? []) {
        if (entry.kind !== 'entryPoint' || entry.entryPoint !== entryPoint) continue;
        if (entry.rank >= rank) continue;
        found.push({ entry, perk, priority: entry.priority });
      }
    }
    return orderEntries(found);
  }

  /** Whether an actor holds any entry of an entry point (callers that run often ask first). */
  async hasEntryPoint(actor: number, entryPoint: number): Promise<boolean> {
    return (await this.entries(actor, entryPoint)).length > 0;
  }

  /**
   * The value an entry point gives: `value` changed by every held entry whose conditions hold
   * (`targets`: the subjects of the entry point's tabs after the owner, in order; a tab whose
   * subject is missing fails its conditions).
   */
  async apply(
    entryPoint: number,
    owner: number,
    value: number,
    targets: readonly (number | undefined)[] = [],
    context: PerkContext = {},
  ): Promise<number> {
    let result = value;
    for (const { entry } of await this.entries(owner, entryPoint)) {
      if (!(await this.#holds(entry, owner, targets, context))) continue;
      result = await this.#applyValue(entry, owner, result);
    }
    return result;
  }

  /** apply(), with the tabs' subjects as arguments: (entry point, owner, value, ...targets). */
  applyEntryPoint(
    entryPoint: number,
    owner: number,
    value: number,
    ...targets: (number | undefined)[]
  ): Promise<number> {
    return this.apply(entryPoint, owner, value, targets);
  }

  /** Select Spell entry points (Apply Combat Hit Spell, ...): the last entry that holds picks. */
  async selectSpell(
    entryPoint: number,
    owner: number,
    targets: readonly (number | undefined)[] = [],
    context: PerkContext = {},
  ): Promise<number | undefined> {
    let spell: number | undefined;
    for (const { entry } of await this.entries(owner, entryPoint)) {
      if (entry.function !== EntryFunction.selectSpell || entry.data.type !== 'spell') continue;
      if (await this.#holds(entry, owner, targets, context)) spell = entry.data.spell;
    }
    return spell;
  }

  /** Select Text / Set Text entry points (graph variables, activation labels): the last one. */
  async selectText(
    entryPoint: number,
    owner: number,
    targets: readonly (number | undefined)[] = [],
    context: PerkContext = {},
  ): Promise<string | undefined> {
    let text: string | undefined;
    for (const { entry } of await this.entries(owner, entryPoint)) {
      const picks =
        entry.function === EntryFunction.selectText || entry.function === EntryFunction.setText;
      if (!picks || entry.data.type !== 'text') continue;
      if (await this.#holds(entry, owner, targets, context)) text = entry.data.text;
    }
    return text;
  }

  /** Every Select Text entry that holds (Set Boolean Graph Variable: each names a variable). */
  async texts(
    entryPoint: number,
    owner: number,
    targets: readonly (number | undefined)[] = [],
  ): Promise<string[]> {
    const texts: string[] = [];
    for (const { entry } of await this.entries(owner, entryPoint)) {
      if (entry.data.type !== 'text') continue;
      if (await this.#holds(entry, owner, targets, {})) texts.push(entry.data.text);
    }
    return texts;
  }

  /** Add Leveled List entries that hold (Add Leveled List On Death): their lists. */
  async leveledLists(
    entryPoint: number,
    owner: number,
    targets: readonly (number | undefined)[] = [],
  ): Promise<number[]> {
    const lists: number[] = [];
    for (const { entry } of await this.entries(owner, entryPoint)) {
      if (entry.function !== EntryFunction.addLeveledList || entry.data.type !== 'leveledList')
        continue;
      if (await this.#holds(entry, owner, targets, {})) lists.push(entry.data.list);
    }
    return lists;
  }

  /** The choices the Activate entry point adds to activating a target (Feed, Eat, ...). */
  async activateChoices(owner: number, target: number): Promise<ActivateChoice[]> {
    const choices: ActivateChoice[] = [];
    for (const { entry, perk } of await this.entries(owner, EntryPoint.activate)) {
      if (entry.data.type !== 'activateChoice') continue;
      if (!(await this.#holds(entry, owner, [target], {}))) continue;
      const { spell, label, runImmediately, replaceDefault, fragment } = entry.data;
      choices.push({ perk, label, spell, runImmediately, replaceDefault, fragment });
    }
    return choices;
  }

  /**
   * An actor activates a target its perks add choices to (the Activate entry point, in
   * priority order): a Run Immediately choice is taken at once (the werewolf's Feed on a
   * corpse); otherwise a message box offers the choices' labels, then the default activation
   * (`defaultLabel`: Talk, Search ...) unless a choice replaces it (UESP "Perk Entry Point").
   * A choice taken casts its spell from the actor on the target and runs its fragment (the
   * perk's PRKF_ script: FragmentN(akTargetRef, akActor)). Resolves whether the default
   * activation goes on. Without a world to ask (Node), the first choice is taken.
   */
  async activate(actor: number, target: number, defaultLabel: string): Promise<boolean> {
    const choices = await this.activateChoices(actor, target);
    if (choices.length === 0) return true;
    const immediate = choices.find((choice) => choice.runImmediately);
    if (immediate) {
      await this.takeChoice(immediate, actor, target);
      return !immediate.replaceDefault;
    }
    const keepsDefault = !choices.some((choice) => choice.replaceDefault);
    const buttons = choices.map((choice) => choice.label || defaultLabel);
    if (keepsDefault) buttons.push(defaultLabel);
    const base = await this.#runtime.baseOf(target);
    const record = base === undefined ? undefined : await this.#runtime.forms.record(base);
    const name = record?.text('FULL') ?? '';
    const asked = this.#runtime.world.messageBox?.(name, buttons);
    const chosen = asked ? await asked : 0;
    const choice = choices[chosen];
    if (!choice) return keepsDefault && chosen === choices.length;
    await this.takeChoice(choice, actor, target);
    return false;
  }

  /** A perk's activation choice taken: its spell on the target, its script fragment. */
  async takeChoice(choice: ActivateChoice, actor: number, target: number): Promise<void> {
    const runtime = this.#runtime;
    if (choice.spell !== undefined) await runtime.magic.cast(choice.spell, actor, target);
    const attachments = await runtime.forms.attachments(choice.perk);
    for (const fragment of attachments?.fragments ?? []) {
      if (fragment.stage !== choice.fragment) continue;
      // On its own thread, as the game queues it (the werewolf's Feed waits for its idle).
      runtime.detach(
        runtime.vm.call(new ObjectHandle(choice.perk, fragment.script), fragment.function, [
          runtime.referenceHandle(target),
          runtime.actorHandle(actor),
        ]),
      );
    }
  }

  // --- What systems ask often -------------------------------------------------------------------

  /**
   * The factors a trader's perks put on its prices with a vendor (Mod Buy Prices, Mod Sell
   * Prices: Haggling, Allure, Fortify Barter through the skill boost perks).
   */
  async barterFactors(trader: number, vendor: number): Promise<{ buy: number; sell: number }> {
    return {
      buy: await this.apply(EntryPoint.modBuyPrices, trader, 1, [vendor]),
      sell: await this.apply(EntryPoint.modSellPrices, trader, 1, [vendor]),
    };
  }

  /**
   * Whether an actor's perks keep it from activating a target (Filter Activation above 0: a
   * werewolf opens no doors, a quest's blocked activators).
   */
  async activationFiltered(actor: number, target: number): Promise<boolean> {
    return (await this.apply(EntryPoint.filterActivation, actor, 0, [target])) > 0;
  }

  /** The label an actor's perks give activating a target (Set Activate Label: Feed). */
  activateLabel(actor: number, target: number): Promise<string | undefined> {
    return this.selectText(EntryPoint.setActivateLabel, actor, [target]);
  }

  /** Whether an actor's perks let it ride a target (Allow Mount Actor: a tamed dragon). */
  async mayMount(actor: number, target: number): Promise<boolean> {
    return (await this.apply(EntryPoint.allowMountActor, actor, 0, [target])) > 0;
  }

  // --- Conditions and functions -----------------------------------------------------------------

  async #applyValue(entry: EntryPointEntry, owner: number, value: number): Promise<number> {
    let actorValue = 0;
    if (entry.data.type === 'actorValue')
      actorValue = (await this.#runtime.actors.value(owner, entry.data.actorValue)).current;
    return applyEntryFunction(value, entry.function, entry.data, {
      actorValue: () => actorValue,
      random: Math.random,
    });
  }

  /** Whether an entry's conditions hold, each tab on its subject. */
  async #holds(
    entry: EntryPointEntry,
    owner: number,
    targets: readonly (number | undefined)[],
    context: PerkContext,
  ): Promise<boolean> {
    const tabs = ENTRY_POINTS[entry.entryPoint]?.tabs ?? ['owner'];
    for (const [tab, conditions] of entry.conditions.entries()) {
      if (conditions.length === 0) continue;
      const kind = tabs[tab];
      const subject = tab === 0 ? owner : targets[tab - 1];
      if (kind === undefined || subject === undefined) return false;
      if (!(await this.#tabHolds(conditions, subject, kind, owner, context))) return false;
    }
    return true;
  }

  /** One tab's conditions on its subject, grouped as the engine does (ORs bind tighter). */
  async #tabHolds(
    conditions: readonly Condition[],
    subject: number,
    kind: ConditionSubject,
    owner: number,
    context: PerkContext,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const handle: ObjectHandle = REFERENCE_SUBJECTS.has(kind)
      ? runtime.referenceHandle(subject)
      : runtime.formHandle(subject);
    const target = owner === subject ? undefined : runtime.referenceHandle(owner);
    let result = true;
    let group: boolean | undefined;
    for (const condition of conditions) {
      const own = await this.#perkFunction(condition, subject, kind, context);
      const holds =
        own === undefined
          ? await runtime.conditionsHold([{ ...condition, or: false }], handle, undefined, {
              ...(target && { target }),
            })
          : compare(condition, own, await this.#comparand(condition));
      if (condition.or) group = (group ?? false) || holds;
      else {
        result = result && (group === undefined ? holds : group || holds);
        group = undefined;
      }
    }
    return group === undefined ? result : result && group;
  }

  async #comparand(condition: Condition): Promise<number> {
    if (typeof condition.comparand === 'number') return condition.comparand;
    return globalValue(this.#runtime, condition.comparand.global);
  }

  /** The value of a function only perk entries use (undefined: an ordinary function). */
  async #perkFunction(
    condition: Condition,
    subject: number,
    kind: ConditionSubject,
    context: PerkContext,
  ): Promise<number | undefined> {
    const runtime = this.#runtime;
    const flag = (value: boolean): number => (value ? 1 : 0);
    // The magic item: the spell tab's subject, else what the caller casts or makes.
    const spellId = kind === 'spell' || kind === 'enchantment' ? subject : context.spell;
    const spell = async () => (spellId === undefined ? undefined : runtime.magic.item(spellId));
    switch (condition.function) {
      case PerkFn.epMagicSpellHasKeyword: {
        const item = await spell();
        if (!item) return 0;
        if (item.keywords.includes(condition.form)) return 1;
        for (const effect of item.effects) {
          if ((await runtime.magic.effect(effect.effect))?.keywords.includes(condition.form))
            return 1;
        }
        return 0;
      }
      case PerkFn.epMagicSpellHasSkill: {
        const item = await spell();
        const main = item && (await runtime.casting.mainEffect(item));
        return flag(main?.skill === condition.raw1);
      }
      case PerkFn.spellHasCastingPerk:
        return kind === 'spell' || context.spell !== undefined
          ? flag((await spell())?.castingPerk === condition.form)
          : undefined;
      case PerkFn.epAlchemyEffectHasKeyword: {
        const effect =
          context.alchemyEffect === undefined
            ? undefined
            : await runtime.magic.effect(context.alchemyEffect);
        return flag(effect?.keywords.includes(condition.form) === true);
      }
      case PerkFn.epAlchemyGetMakingPoison:
        return flag(context.makingPoison === true);
      case PerkFn.epModSkillUsageIsAdvanceSkill:
        return flag(context.advanceSkill === condition.raw1);
      case PerkFn.epModSkillUsageIsAdvanceAction:
        return flag(context.advanceAction === condition.raw1);
      case PerkFn.epModSkillUsageAdvanceObjectHasKeyword:
        return flag(
          context.advanceObject !== undefined &&
            (await runtime.hasKeyword(context.advanceObject, condition.form)),
        );
      case PerkFn.epTemperingItemIsEnchanted: {
        const item = context.temperingItem ?? (kind === 'item' ? subject : undefined);
        const record = item === undefined ? undefined : await runtime.forms.record(item);
        return flag(record?.formIdField('EITM') !== undefined);
      }
      case PerkFn.epTemperingItemHasKeyword: {
        const item = context.temperingItem ?? (kind === 'item' ? subject : undefined);
        return flag(item !== undefined && (await runtime.hasKeyword(item, condition.form)));
      }
      // The attack being made: its attack data's type keyword (ATKD).
      case PerkFn.isAttackType:
        return flag(context.attackType !== undefined && context.attackType === condition.form);
      case PerkFn.getLockLevel:
        return (await runtime.lock(subject)).level;
      case PerkFn.isUnlockedDoor: {
        const base = await runtime.baseOf(subject);
        const door = (await runtime.forms.record(base ?? subject))?.type === 'DOOR';
        return flag(door && !(await runtime.lock(subject)).locked);
      }
      case PerkFn.hasBeenEaten:
        return flag(this.eaten.has(subject));
      case PerkFn.isPoison: {
        const item = await runtime.magic.item(subject);
        return flag(item?.kind === 'poison');
      }
      default:
        return undefined;
    }
  }
}

const OPERATORS = [
  (a: number, b: number) => a === b,
  (a: number, b: number) => a !== b,
  (a: number, b: number) => a > b,
  (a: number, b: number) => a >= b,
  (a: number, b: number) => a < b,
  (a: number, b: number) => a <= b,
] as const;

function compare(condition: Condition, value: number, comparand: number): boolean {
  return OPERATORS[condition.operator]?.(value, comparand) ?? false;
}
