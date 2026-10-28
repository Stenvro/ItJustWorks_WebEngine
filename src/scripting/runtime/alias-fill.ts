// Filling a quest's aliases as it starts (Creation Kit: "Quest Alias Tab"): in order, each by
// its fill type: a specific reference or location, a unique actor, another quest's alias, a
// created reference, a location's reference of a location reference type, a reference's
// location, a matching reference or location (by its conditions: persistent references and
// unique actors anywhere, or those in the loaded area, the closest or one at random, or those
// linked to another alias's reference), or the story manager event's data.
//
// What may fill a searched alias: not a reference another quest reserved (unless the alias
// allows reserved ones, takes another quest's alias, or belongs to a quest that starts with a
// new game), not one already in this quest's aliases (unless that alias allows reuse), not a
// dead, disabled or destroyed one (unless the alias allows it), not a cleared location (unless
// allowed, and then uncleared ones first). Conditions run on what fills the alias, but for
// unique actors, location alias references and created references on the player. A filled
// alias also fills the alias it is forced into, may reserve what fills it, disables it
// ("initially disabled") and gives it the alias's inventory.
// Specific references are not held to the dead and disabled checks: 86 aliases of quests that
// start with the game name disabled references without "allow disabled" (e.g. Riften's
// Imperial gate guards), and those quests run in the game. Platform-independent.
// Notes: docs/scripting.md ("Quests").

import type { LocationRecord } from '../../world/actor-stats-records.ts';
import { AliasFlag, type QuestAlias, type QuestRecord } from '../../world/quest-records.ts';
import { ConditionRunOn } from '../conditions.ts';
import { ObjectHandle } from '../values.ts';
import { Fn } from './condition-values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

const key = (quest: number, alias: number): string => `${String(quest)}:${String(alias)}`;

/**
 * Candidates of a search checked at once: their records are read side by side (one by one, a
 * search over every persistent reference waited on thousands of reads in a row). Once read,
 * checking one is work on the main thread only (conditions over cached records): a batch is
 * kept small enough to stay within a slice.
 */
const SEARCH_BATCH = 64;

/**
 * How long a search works before it lets a frame be drawn (ms). The engine fills aliases off
 * its main loop (a quest starts over several frames; Papyrus waits on Start); a search over the
 * loaded area's 2,000 references in one go held a frame up for 60–80 ms as a scene's quests
 * started (docs/scripting.md, "Quests"). TODO(M13): the engine's own share per frame.
 */
const SEARCH_SLICE_MS = 4;

/** The candidates `test` takes, in their order; checked a batch at a time. */
async function filterInBatches(
  runtime: ScriptRuntime,
  candidates: readonly number[],
  test: (candidate: number) => Promise<boolean>,
): Promise<number[]> {
  const scheduler = runtime.vm.scheduler;
  const taken: number[] = [];
  let since = scheduler.now();
  for (let start = 0; start < candidates.length; start += SEARCH_BATCH) {
    since = await scheduler.giveWay(since, SEARCH_SLICE_MS);
    const batch = candidates.slice(start, start + SEARCH_BATCH);
    const results = await Promise.all(batch.map(test));
    batch.forEach((candidate, i) => {
      if (results[i]) taken.push(candidate);
    });
  }
  return taken;
}

interface FillContext {
  readonly record: QuestRecord;
  /** A quest that starts with a new game: every alias allows reserved references. */
  readonly allowReserved: boolean;
  readonly filled: Map<number, number>;
}

export class AliasFiller {
  readonly #runtime: ScriptRuntime;
  /** References and locations in an alias that reserves them: by whom ("quest:alias"). */
  readonly #reserved = new Map<number, Set<string>>();
  random: () => number = Math.random;
  /** The alias each quest that failed to start could not fill (for reports). */
  readonly failures = new Map<number, QuestAlias>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  location(formId: number): Promise<LocationRecord | undefined> {
    return this.#runtime.location(formId);
  }

  /** Whether an alias that reserves it holds a reference or location now (for reports). */
  reserved(value: number): boolean {
    return (this.#reserved.get(value)?.size ?? 0) > 0;
  }

  /**
   * A loaded save's quest holds its aliases again (their fills are in its state): the
   * reservations of those that reserve what they hold are made again.
   */
  restored(record: QuestRecord, filled: ReadonlyMap<number, number>): void {
    for (const alias of record.aliases) {
      const value = filled.get(alias.id);
      if (value !== undefined && (alias.flags & AliasFlag.reserves) !== 0)
        this.#reserve(value, record.formId, alias.id);
    }
  }

  #reserve(value: number, quest: number, alias: number): void {
    const by = this.#reserved.get(value) ?? new Set<string>();
    by.add(key(quest, alias));
    this.#reserved.set(value, by);
  }

  /** An alias let go of what filled it (its reservation ends). */
  released(quest: number, alias: number, filled: number): void {
    this.#reserved.get(filled)?.delete(key(quest, alias));
  }

  /** Fills a quest's aliases in order; false if one that must be filled stays empty. */
  async fillAll(record: QuestRecord, allowReserved: boolean): Promise<boolean> {
    const runtime = this.#runtime;
    const filled = runtime.state.quest(record.formId).aliases;
    filled.clear();
    const context: FillContext = { record, allowReserved, filled };
    this.failures.delete(record.formId);
    for (const alias of record.aliases) {
      const value = await this.#fill(alias, context);
      if (value === undefined) {
        if ((alias.flags & AliasFlag.optional) === 0 && alias.fill.kind !== 'none') {
          this.failures.set(record.formId, alias);
          return false;
        }
        continue;
      }
      this.#set(record.formId, alias.id, value);
      if (alias.forcedInto !== undefined) this.#set(record.formId, alias.forcedInto, value);
      if ((alias.flags & AliasFlag.reserves) !== 0) this.#reserve(value, record.formId, alias.id);
      if (!alias.location) {
        if ((alias.flags & AliasFlag.initiallyDisabled) !== 0)
          await runtime.setEnabled(value, false);
        // Its inventory is given as it fills (and kept when it leaves).
        for (const { item, count } of alias.items) {
          await runtime.addItem(value, runtime.formHandle(item), Math.max(1, count), true);
        }
      }
    }
    return true;
  }

  #set(quest: number, alias: number, value: number): void {
    const aliases = this.#runtime.state.quest(quest).aliases;
    const previous = aliases.get(alias);
    if (previous !== undefined) this.#runtime.aliasCleared(quest, alias, previous);
    aliases.set(alias, value);
    this.#runtime.aliasFilled(quest, alias, value);
  }

  async #fill(alias: QuestAlias, context: FillContext): Promise<number | undefined> {
    const runtime = this.#runtime;
    const { record } = context;
    const fill = alias.fill;
    const onPlayer = (): Promise<boolean> =>
      this.#holds(alias, runtime.referenceHandle(PLAYER_REF), context);
    switch (fill.kind) {
      case 'forced':
        return (await this.#holds(alias, this.#subject(alias, fill.form), context))
          ? fill.form
          : undefined;
      case 'uniqueActor': {
        const actor = await runtime.forms.uniqueReference(fill.npc);
        return actor !== undefined && (await onPlayer()) ? actor : undefined;
      }
      case 'external': {
        const other = runtime.state.quests.get(fill.quest);
        const value = other?.running ? other.aliases.get(fill.alias) : undefined;
        if (value === undefined) return undefined;
        return (await this.#holds(alias, this.#subject(alias, value), context)) ? value : undefined;
      }
      case 'created': {
        if (!(await onPlayer())) return undefined;
        // A new reference of the base, at or in the alias it names (filled before it).
        const at = context.filled.get(fill.alias);
        return runtime.createReference(fill.base, at, fill.inside);
      }
      case 'locationReference': {
        if (!(await onPlayer())) return undefined;
        const location = context.filled.get(fill.location);
        const references =
          location === undefined ? [] : ((await this.location(location))?.references ?? []);
        for (const candidate of references) {
          if (candidate.type !== fill.referenceType) continue;
          if (await this.#eligible(alias, candidate.reference, context)) return candidate.reference;
        }
        return undefined;
      }
      case 'referenceLocation': {
        const reference = context.filled.get(fill.alias);
        let location = reference === undefined ? undefined : await runtime.locationOf(reference);
        // A keyword picks the first location up the parents that has it.
        for (let depth = 0; location !== undefined && fill.keyword !== 0 && depth < 16; depth++) {
          const found: LocationRecord | undefined = await this.location(location);
          if (!found || found.keywords.includes(fill.keyword)) break;
          location = found.parent;
        }
        if (location === undefined) return undefined;
        return (await this.#eligible(alias, location, context, false)) ? location : undefined;
      }
      case 'fromEvent': {
        // The event's data member ("R1", "L1", ...), if the event that started it has it.
        const event = runtime.state.quest(record.formId).event;
        const value = event?.type === fill.event ? event.forms.get(fill.data) : undefined;
        if (value === undefined) return undefined;
        return (await this.#eligible(alias, value, context)) ? value : undefined;
      }
      case 'matching':
        return alias.location
          ? this.#matchLocation(alias, context)
          : this.#matchReference(alias, fill.nearAlias, context);
      case 'none':
        return undefined;
    }
  }

  #subject(alias: QuestAlias, value: number): ObjectHandle {
    return alias.location
      ? new ObjectHandle(value, 'location')
      : this.#runtime.referenceHandle(value);
  }

  #holds(alias: QuestAlias, subject: ObjectHandle, context: FillContext): Promise<boolean> {
    const event = this.#runtime.state.quests.get(context.record.formId)?.event;
    return this.#runtime.conditionsHold(alias.conditions, subject, event, {
      quest: context.record.formId,
    });
  }

  /** Whether a searched alias may take a reference or location (its conditions included). */
  async #eligible(
    alias: QuestAlias,
    value: number,
    context: FillContext,
    conditions = true,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const flags = alias.flags;
    const reserved = this.#reserved.get(value);
    if (
      reserved &&
      reserved.size > 0 &&
      (flags & AliasFlag.allowReserved) === 0 &&
      !context.allowReserved
    ) {
      return false;
    }
    // Already in this quest: only from an alias that allows reuse.
    for (const [other, filled] of context.filled) {
      if (filled !== value) continue;
      const otherAlias = context.record.aliases.find((entry) => entry.id === other);
      if (!otherAlias || (otherAlias.flags & AliasFlag.allowReuse) === 0) return false;
    }
    if (alias.location) {
      // The engine counts its bosses as it asks (once a game hour: location-clearing.ts).
      const cleared = await runtime.locationClearing.isCleared(value);
      if (cleared && (flags & AliasFlag.allowCleared) === 0) return false;
    } else {
      if ((flags & AliasFlag.allowDisabled) === 0 && !(await runtime.isEnabled(value)))
        return false;
      if (
        (flags & AliasFlag.allowDestroyed) === 0 &&
        runtime.state.references.get(value)?.destroyed
      )
        return false;
      if ((flags & AliasFlag.allowDead) === 0 && (await runtime.actors.isDead(value))) return false;
    }
    return !conditions || this.#holds(alias, this.#subject(alias, value), context);
  }

  /** Find Matching Reference. */
  async #matchReference(
    alias: QuestAlias,
    nearAlias: number | undefined,
    context: FillContext,
  ): Promise<number | undefined> {
    const runtime = this.#runtime;
    let candidates: number[];
    if (nearAlias !== undefined) {
      // References linked (without a keyword) to the other alias's reference, either way.
      const near = context.filled.get(nearAlias);
      candidates = near === undefined ? [] : await this.#linkedWith(near);
    } else if ((alias.flags & AliasFlag.inLoadedArea) !== 0) {
      candidates = [...(runtime.world.loadedReferences?.() ?? [])];
    } else {
      candidates = await this.#persistentCandidates(alias);
    }
    const eligible = await filterInBatches(runtime, candidates, (candidate) =>
      this.#eligible(alias, candidate, context),
    );
    if (eligible.length === 0) return undefined;
    if ((alias.flags & AliasFlag.closest) !== 0) {
      const player = await runtime.placement(PLAYER_REF);
      if (player) {
        let best: { reference: number; distance: number } | undefined;
        for (const reference of eligible) {
          const at = await runtime.placement(reference);
          if (!at) continue;
          const distance = Math.hypot(
            at.position[0] - player.position[0],
            at.position[1] - player.position[1],
            at.position[2] - player.position[2],
          );
          if (!best || distance < best.distance) best = { reference, distance };
        }
        if (best) return best.reference;
      }
    }
    return eligible[Math.floor(this.random() * eligible.length)];
  }

  /** References whose link without a keyword is `reference`, and the one it links to. */
  async #linkedWith(reference: number): Promise<number[]> {
    const runtime = this.#runtime;
    const found = new Set<number>();
    const own = await runtime.linkedReference(reference, 0);
    if (own !== undefined) found.add(own);
    for (const candidate of (await runtime.persistentIndex()).linkedTo.get(reference) ?? []) {
      found.add(candidate);
    }
    return [...found];
  }

  /**
   * Persistent references and unique actors (what can be found outside the loaded area),
   * narrowed by a GetIsID or GetIsReference condition the alias must meet.
   */
  async #persistentCandidates(alias: QuestAlias): Promise<number[]> {
    const index = await this.#runtime.persistentIndex();
    for (let i = 0; i < alias.conditions.length; i++) {
      const condition = alias.conditions[i];
      const previous = alias.conditions[i - 1];
      // Only a condition that every match must meet narrows the search (not in an OR group).
      if (!condition || condition.or || previous?.or) continue;
      if (
        condition.runOn !== ConditionRunOn.subject ||
        condition.operator !== 0 ||
        condition.comparand !== 1
      )
        continue;
      if (condition.function === Fn.getIsReference) return [condition.form];
      if (condition.function === Fn.getIsId) {
        const byBase = index.byBase.get(condition.form) ?? [];
        return condition.form === PLAYER_REF || condition.form === 0x7 ? [PLAYER_REF] : byBase;
      }
    }
    return index.all;
  }

  /**
   * Find Matching Location: any location that meets the conditions, uncleared ones first, and
   * that has a reference of each type the quest's later aliases must take from it (a
   * location alias reference that is not optional). Without that look ahead a random pick
   * could dead-end the quest: FreeformCaravansA's conditions ask for a BossContainer, but its
   * MapMarker alias needs a map marker, which Dragonborn's Damphall Mine has not (1 of its 26
   * matches; the quest then did not start at random). TODO(M13): whether the engine looks
   * ahead so or tries the next match; UESP lists Damphall Mine among the amulet's places.
   */
  async #matchLocation(alias: QuestAlias, context: FillContext): Promise<number | undefined> {
    const runtime = this.#runtime;
    const needed = context.record.aliases.flatMap((other) =>
      other.fill.kind === 'locationReference' &&
      other.fill.location === alias.id &&
      (other.flags & AliasFlag.optional) === 0
        ? [other.fill.referenceType]
        : [],
    );
    const fresh: number[] = [];
    const cleared: number[] = [];
    const matches = await filterInBatches(
      runtime,
      runtime.forms.db.formIdsOfType('LCTN'),
      async (location) => {
        if (!(await this.#eligible(alias, location, context))) return false;
        if (needed.length === 0) return true;
        const references = (await this.location(location))?.references ?? [];
        return needed.every((type) => references.some((entry) => entry.type === type));
      },
    );
    for (const location of matches) {
      (runtime.state.locations.get(location)?.cleared ? cleared : fresh).push(location);
    }
    const pool = fresh.length > 0 ? fresh : cleared;
    return pool[Math.floor(this.random() * pool.length)];
  }
}
