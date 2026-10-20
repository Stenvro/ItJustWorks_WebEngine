// Actors as scripts see them: the base a reference came down to (leveled lists and templates
// resolved once, as for its look), its level, its actor values (the record's base, scripts'
// permanent modifiers and damage), factions and ranks, relationships (RELA, and those scripts
// set), spells and perks, its race and sex, being essential or protected (its base's flags,
// or an alias's), and dying. Platform-independent. Notes: docs/scripting.md ("Actors").

import { NpcFlag, parseLeveledList, RaceFlag, TemplateFlag } from '../../world/actor-records.ts';
import {
  parseFaction,
  parseNpcStats,
  parseRaceStats,
  parseRelationship,
  type FactionRecord,
  type FactionVendor,
  type NpcStats,
  type RaceStats,
} from '../../world/actor-stats-records.ts';
import { resolveActorTemplates } from '../../world/actor-templates.ts';
import { ActorValue, actorValueIndex, SKILL_COUNT } from '../../world/actor-values.ts';
import { RecordFlag } from '../../formats/esm/record.ts';
import { AliasFlag } from '../../world/quest-records.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

export interface ActorInfo {
  readonly reference: number;
  /** GetActorBase: the NPC_ or LVLN the reference names (a created one's base). */
  readonly base: number;
  /** GetLeveledActorBase: the NPC_ it came down to. */
  readonly leveled: number;
  /** Each part from the NPC_ that gives it (TemplateFlag). */
  readonly stats: NpcStats;
  readonly traits: NpcStats;
  readonly factions: NpcStats;
  readonly spells: NpcStats;
  readonly ai: NpcStats;
  readonly baseData: NpcStats;
  readonly keywords: NpcStats;
  readonly inventory: NpcStats;
}

export interface ActorValueNow {
  readonly base: number;
  /** Base and permanent modifiers. */
  readonly max: number;
  /** Max less damage. */
  readonly current: number;
}

/** DNAM's calculated value, or (none stored) the race's starting value and the offset. */
const calculated = (stored: number, starting: number | undefined, offset: number): number =>
  stored > 0 ? stored : (starting ?? 0) + offset;

const pairKey = (a: number, b: number): string =>
  a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;

export class ActorEngine {
  readonly #runtime: ScriptRuntime;
  readonly #infos = new Map<number, Promise<ActorInfo | undefined>>();
  readonly #npcs = new Map<number, Promise<NpcStats | undefined>>();
  readonly #races = new Map<number, Promise<RaceStats | undefined>>();
  readonly #factions = new Map<number, Promise<FactionRecord | undefined>>();
  #relationships: Promise<Map<string, number>> | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** An NPC_'s own stats (ActorBase natives). */
  baseStats(formId: number): Promise<NpcStats | undefined> {
    return this.#npc(formId);
  }

  #npc(formId: number): Promise<NpcStats | undefined> {
    let pending = this.#npcs.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'NPC_' ? parseNpcStats(record) : undefined));
      this.#npcs.set(formId, pending);
    }
    return pending;
  }

  race(formId: number): Promise<RaceStats | undefined> {
    let pending = this.#races.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'RACE' ? parseRaceStats(record) : undefined));
      this.#races.set(formId, pending);
    }
    return pending;
  }

  faction(formId: number): Promise<FactionRecord | undefined> {
    let pending = this.#factions.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'FACT' ? parseFaction(record) : undefined));
      this.#factions.set(formId, pending);
    }
    return pending;
  }

  /** What a reference is as an actor (undefined if it is not one). */
  info(reference: number): Promise<ActorInfo | undefined> {
    let pending = this.#infos.get(reference);
    if (!pending) {
      pending = this.#resolve(reference);
      this.#infos.set(reference, pending);
    }
    return pending;
  }

  /** Forgets a reference's resolved base (a reset: it is generated again). */
  forget(reference: number): void {
    this.#infos.delete(reference);
  }

  async #resolve(reference: number): Promise<ActorInfo | undefined> {
    const runtime = this.#runtime;
    const base = await runtime.baseOf(reference);
    if (base === undefined) return undefined;
    const type = (await runtime.forms.record(base))?.type;
    if (type !== 'NPC_' && type !== 'LVLN') return undefined;
    // Leveled actors are picked at their encounter's level by their level modifier, kept for
    // the reference (its look picks the same: src/shell/actors.ts).
    const level = reference === PLAYER_REF ? 1 : await runtime.progression.leveledLevel(reference);
    const templates = await resolveActorTemplates(
      (id) => runtime.forms.record(id),
      base,
      reference,
      level,
      async (record) => (await runtime.leveledList(record.formId)) ?? parseLeveledList(record),
    );
    if (!templates) return undefined;
    const part = async (flag: number): Promise<NpcStats | undefined> =>
      this.#npc(templates.part(flag));
    const [stats, traits, factions, spells, ai, baseData, keywords, inventory] = await Promise.all([
      part(TemplateFlag.stats),
      part(TemplateFlag.traits),
      part(TemplateFlag.factions),
      part(TemplateFlag.spells),
      part(TemplateFlag.aiData),
      part(TemplateFlag.baseData),
      part(TemplateFlag.keywords),
      part(TemplateFlag.inventory),
    ]);
    if (!stats || !traits || !factions || !spells || !ai || !baseData || !keywords || !inventory)
      return undefined;
    return {
      reference,
      base,
      leveled: templates.placed,
      stats,
      traits,
      factions,
      spells,
      ai,
      baseData,
      keywords,
      inventory,
    };
  }

  async isActor(reference: number): Promise<boolean> {
    return (await this.info(reference)) !== undefined;
  }

  // --- Level ----------------------------------------------------------------------------------

  async playerLevel(): Promise<number> {
    const set = this.#runtime.state.actors.get(PLAYER_REF)?.level;
    if (set !== undefined) return set;
    return (await this.#npc(PLAYER_BASE))?.level ?? 1;
  }

  /**
   * Its level: fixed, or the level it follows (its encounter's, a follower's the player's)
   * times its multiplier within its calc min and max (progression-engine.ts).
   */
  async level(reference: number): Promise<number> {
    const set = this.#runtime.state.actors.get(reference)?.level;
    if (set !== undefined) return set;
    if (reference === PLAYER_REF) return this.playerLevel();
    const info = await this.info(reference);
    return info ? this.#runtime.progression.levelOf(reference, info) : 1;
  }

  // --- Race and sex ---------------------------------------------------------------------------

  /**
   * An actor's race: as Actor.SetRace set it, else its base's (the player's: the race menu's
   * choice, GameState.playerAppearance).
   */
  async raceOf(reference: number): Promise<number | undefined> {
    const state = this.#runtime.state;
    const set = state.actors.get(reference)?.race;
    if (set !== undefined) return set;
    if (reference === PLAYER_REF && state.playerAppearance) return state.playerAppearance.race;
    return (await this.info(reference))?.traits.race;
  }

  async isFemale(reference: number): Promise<boolean> {
    const appearance = this.#runtime.state.playerAppearance;
    if (reference === PLAYER_REF && appearance) return appearance.sex === 1;
    const traits = (await this.info(reference))?.traits;
    return traits !== undefined && (traits.flags & NpcFlag.female) !== 0;
  }

  /** An actor base's race (ActorBase.GetRace): the Player base's is the race menu's choice. */
  async baseRace(formId: number): Promise<number | undefined> {
    const appearance = this.#runtime.state.playerAppearance;
    if (formId === PLAYER_BASE && appearance) return appearance.race;
    return (await this.#npc(formId))?.race;
  }

  /** An actor base's sex (ActorBase.GetSex): 0 male, 1 female, −1 not an actor base. */
  async baseSex(formId: number): Promise<number> {
    const appearance = this.#runtime.state.playerAppearance;
    if (formId === PLAYER_BASE && appearance) return appearance.sex;
    const stats = await this.#npc(formId);
    return stats === undefined ? -1 : (stats.flags & NpcFlag.female) !== 0 ? 1 : 0;
  }

  /** The player's name: as chosen in the race menu, else the Player record's (FULL). */
  async playerName(): Promise<string> {
    const chosen = this.#runtime.state.playerName;
    if (chosen !== undefined) return chosen;
    return (await this.#runtime.forms.record(PLAYER_BASE))?.text('FULL') ?? '';
  }

  async isChild(reference: number): Promise<boolean> {
    const race = await this.raceOf(reference);
    const record = race === undefined ? undefined : await this.#runtime.forms.record(race);
    const data = record?.fields.first('DATA');
    return data !== undefined && data.length >= 36 && ((data[32] ?? 0) & RaceFlag.child) !== 0;
  }

  // --- Actor values -----------------------------------------------------------------------

  /** An actor value's index by name; undefined (with a warning) for an unknown name. */
  actorValue(name: string): number | undefined {
    const index = actorValueIndex(name);
    if (index === undefined) this.#runtime.warn(`unknown actor value "${name}"`);
    return index;
  }

  /** The record's base value of an actor value (before scripts). */
  async #recordBase(reference: number, index: number): Promise<number> {
    const info = await this.info(reference);
    if (!info) return 0;
    const ai = info.ai.aiData;
    const race = await this.race((await this.raceOf(reference)) ?? 0);
    // Auto-calculated actors' skills and attributes follow their level, class and race.
    const stat = index >= ActorValue.firstSkill && index <= ActorValue.stamina;
    const auto = stat ? await this.#runtime.progression.autoCalculated(reference, info) : undefined;
    if (index >= ActorValue.firstSkill && index < ActorValue.firstSkill + SKILL_COUNT) {
      const skill = index - ActorValue.firstSkill;
      return (
        (auto?.skills[skill] ?? info.stats.skills[skill] ?? 0) +
        (info.stats.skillOffsets[skill] ?? 0)
      );
    }
    if (auto && index === ActorValue.health) return auto.health;
    if (auto && index === ActorValue.magicka) return auto.magicka;
    if (auto && index === ActorValue.stamina) return auto.stamina;
    switch (index) {
      case ActorValue.aggression:
        return ai.aggression;
      case ActorValue.confidence:
        return ai.confidence;
      case ActorValue.energy:
        return ai.energy;
      case ActorValue.morality:
        return ai.morality;
      case ActorValue.mood:
        return ai.mood;
      case ActorValue.assistance:
        return ai.assistance;
      // Not auto-calculated: the Creation Kit's values (DNAM), else the race's and the offset.
      case ActorValue.health:
        return calculated(info.stats.health, race?.startingHealth, info.stats.healthOffset);
      case ActorValue.magicka:
        return calculated(info.stats.magicka, race?.startingMagicka, info.stats.magickaOffset);
      case ActorValue.stamina:
        return calculated(info.stats.stamina, race?.startingStamina, info.stats.staminaOffset);
      case ActorValue.healRate:
        return race?.healthRegen ?? 0;
      case ActorValue.magickaRate:
        return race?.magickaRegen ?? 0;
      case ActorValue.staminaRate:
        return race?.staminaRegen ?? 0;
      case ActorValue.speedMult:
        return info.stats.speedMult;
      case ActorValue.carryWeight:
        return race?.baseCarryWeight ?? 0;
      case ActorValue.unarmedDamage:
        return race?.unarmedDamage ?? 0;
      case ActorValue.mass:
        return race?.baseMass ?? 0;
      // UESP: 100 for the player and 0 for NPCs; the rate 5.
      case ActorValue.voicePoints:
        return reference === PLAYER_REF ? 100 : 0;
      case ActorValue.voiceRate:
        return 5;
      case ActorValue.healRateMult:
      case ActorValue.magickaRateMult:
      case ActorValue.staminaRateMult:
        return 100;
      default:
        return 0;
    }
  }

  async value(reference: number, index: number): Promise<ActorValueNow> {
    const own = this.#runtime.state.actors.get(reference)?.values.get(index);
    const base = own?.base ?? (await this.#recordBase(reference, index));
    const max = base + (own?.modifier ?? 0);
    return { base, max, current: max - (own?.damage ?? 0) };
  }

  #own(reference: number, index: number): { base?: number; modifier: number; damage: number } {
    const values = this.#runtime.state.actor(reference).values;
    let own = values.get(index);
    if (!own) {
      own = { modifier: 0, damage: 0 };
      values.set(index, own);
    }
    return own;
  }

  /** SetActorValue: a new base. */
  setBase(reference: number, index: number, value: number): void {
    this.#own(reference, index).base = value;
  }

  /** ModActorValue: a permanent modifier. */
  modify(reference: number, index: number, amount: number): void {
    this.#own(reference, index).modifier += amount;
  }

  /** DamageActorValue: damage (health at 0 is death, unless essential: TODO(M11) bleedout). */
  async damage(reference: number, index: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    const own = this.#own(reference, index);
    own.damage += amount;
    if (index === ActorValue.health && (await this.value(reference, index)).current <= 0) {
      if (!(await this.isEssential(reference))) await this.kill(reference, undefined);
    }
  }

  /** RestoreActorValue: damage healed, up to none. */
  restore(reference: number, index: number, amount: number): void {
    const own = this.#own(reference, index);
    own.damage = Math.max(0, own.damage - Math.max(0, amount));
  }

  /** ForceActorValue: the current value set (through the damage). */
  async force(reference: number, index: number, value: number): Promise<void> {
    const now = await this.value(reference, index);
    const own = this.#own(reference, index);
    own.damage = Math.max(0, now.max - value);
    if (value > now.max) own.modifier += value - now.max;
  }

  // --- Factions -------------------------------------------------------------------------------

  /** Its rank in a faction: −2 not a member, −1 listed but not a member yet, else the rank. */
  async factionRank(reference: number, faction: number): Promise<number> {
    const set = this.#runtime.state.actors.get(reference)?.factions.get(faction);
    if (set !== undefined) return set;
    const info = await this.info(reference);
    return info?.factions.factions.get(faction) ?? -2;
  }

  /** Every faction it is in (its record's and those scripts set) with its rank. */
  async factionsOf(reference: number): Promise<Map<number, number>> {
    const ranks = new Map((await this.info(reference))?.factions.factions ?? []);
    for (const [faction, rank] of this.#runtime.state.actors.get(reference)?.factions ?? []) {
      if (rank === -2) ranks.delete(faction);
      else ranks.set(faction, rank);
    }
    return ranks;
  }

  /**
   * It offers its services now (GetOffersServicesNow): it is in a vendor faction (rank 0 or
   * more) whose hours (VENV) include the game's hour now (hours past midnight wrap) and whose
   * conditions hold on it. TODO(M10): the vendor's location and radius.
   */
  async offersServicesNow(reference: number): Promise<boolean> {
    return (await this.vendorFaction(reference)) !== undefined;
  }

  /**
   * The vendor faction an actor trades for now (see offersServicesNow), if any; with `now`
   * false, its vendor faction at any hour.
   */
  async vendorFaction(
    reference: number,
    now = true,
  ): Promise<{ readonly faction: number; readonly vendor: FactionVendor } | undefined> {
    const hour = this.#runtime.gameHour;
    for (const [formId, rank] of await this.factionsOf(reference)) {
      if (rank < 0) continue;
      const vendor = (await this.faction(formId))?.vendor;
      if (!vendor) continue;
      if (!now) return { faction: formId, vendor };
      const { startHour, endHour } = vendor;
      const open =
        startHour <= endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour;
      if (!open) continue;
      const self = this.#runtime.referenceHandle(reference);
      if (await this.#runtime.conditionsHold(vendor.conditions, self))
        return { faction: formId, vendor };
    }
    return undefined;
  }

  setFactionRank(reference: number, faction: number, rank: number): void {
    this.#runtime.state.actor(reference).factions.set(faction, rank);
  }

  async removeFromAllFactions(reference: number): Promise<void> {
    for (const faction of (await this.factionsOf(reference)).keys())
      this.setFactionRank(reference, faction, -2);
  }

  async crimeFaction(reference: number): Promise<number | undefined> {
    const set = this.#runtime.state.actors.get(reference)?.crimeFaction;
    if (set !== undefined) return set ?? undefined;
    return (await this.info(reference))?.factions.crimeFaction;
  }

  /** A faction's combat reaction to another: scripts' (SetAlly, SetEnemy), else its XNAM's. */
  async factionReaction(faction: number, other: number): Promise<number | undefined> {
    const set = this.#runtime.state.factions.get(faction)?.reactions.get(other);
    if (set !== undefined) return set;
    return (await this.faction(faction))?.reactions.find((reaction) => reaction.faction === other)
      ?.combat;
  }

  // --- Relationships ----------------------------------------------------------------------

  #loadRelationships(): Promise<Map<string, number>> {
    this.#relationships ??= (async () => {
      const ranks = new Map<string, number>();
      for (const formId of this.#runtime.forms.db.formIdsOfType('RELA')) {
        const record = await this.#runtime.forms.record(formId);
        const relationship = record && !record.deleted ? parseRelationship(record) : undefined;
        if (relationship)
          ranks.set(pairKey(relationship.parent, relationship.child), relationship.rank);
      }
      return ranks;
    })();
    return this.#relationships;
  }

  /** The NPC_ relationships are kept for (the player's is 0x7). */
  async #relationshipBase(reference: number): Promise<number | undefined> {
    if (reference === PLAYER_REF) return PLAYER_BASE;
    return (await this.info(reference))?.leveled;
  }

  /** GetRelationshipRank: 4 lover .. 0 acquaintance .. −4 archnemesis. */
  async relationshipRank(a: number, b: number): Promise<number> {
    const [first, second] = await Promise.all([
      this.#relationshipBase(a),
      this.#relationshipBase(b),
    ]);
    if (first === undefined || second === undefined) return 0;
    const key = pairKey(first, second);
    return (
      this.#runtime.state.relationships.get(key) ?? (await this.#loadRelationships()).get(key) ?? 0
    );
  }

  async setRelationshipRank(a: number, b: number, rank: number): Promise<void> {
    const [first, second] = await Promise.all([
      this.#relationshipBase(a),
      this.#relationshipBase(b),
    ]);
    if (first !== undefined && second !== undefined)
      this.#runtime.state.relationships.set(pairKey(first, second), rank);
  }

  /** The highest or lowest rank it has with anyone (RELA and scripts'). */
  async extremeRelationshipRank(reference: number, highest: boolean): Promise<number> {
    const base = await this.#relationshipBase(reference);
    if (base === undefined) return 0;
    const ranks: number[] = [];
    const add = (key: string, rank: number): void => {
      if (key.split(':').includes(String(base))) ranks.push(rank);
    };
    for (const [key, rank] of await this.#loadRelationships()) add(key, rank);
    for (const [key, rank] of this.#runtime.state.relationships) add(key, rank);
    if (ranks.length === 0) return 0;
    return highest ? Math.max(...ranks) : Math.min(...ranks);
  }

  // --- Spells and perks ---------------------------------------------------------------------

  async hasSpell(reference: number, spell: number): Promise<boolean> {
    const set = this.#runtime.state.actors.get(reference)?.spells.get(spell);
    if (set !== undefined) return set;
    const info = await this.info(reference);
    if (info?.spells.spells.includes(spell)) return true;
    const race = await this.race((await this.raceOf(reference)) ?? 0);
    return race?.spells.includes(spell) ?? false;
  }

  /** Every spell and shout it has: its base's and race's, with what scripts added or removed. */
  async spells(reference: number): Promise<number[]> {
    const info = await this.info(reference);
    const race = await this.race((await this.raceOf(reference)) ?? 0);
    const all = new Set([...(info?.spells.spells ?? []), ...(race?.spells ?? [])]);
    for (const [spell, has] of this.#runtime.state.actors.get(reference)?.spells ?? []) {
      if (has) all.add(spell);
      else all.delete(spell);
    }
    return [...all];
  }

  /** AddSpell / AddShout: false if it had it. */
  async addSpell(reference: number, spell: number): Promise<boolean> {
    if (await this.hasSpell(reference, spell)) return false;
    this.#runtime.state.actor(reference).spells.set(spell, true);
    return true;
  }

  async removeSpell(reference: number, spell: number): Promise<boolean> {
    if (!(await this.hasSpell(reference, spell))) return false;
    this.#runtime.state.actor(reference).spells.set(spell, false);
    return true;
  }

  async hasPerk(reference: number, perk: number): Promise<boolean> {
    const set = this.#runtime.state.actors.get(reference)?.perks.get(perk);
    if (set !== undefined) return set;
    return (await this.info(reference))?.spells.perks.includes(perk) ?? false;
  }

  setPerk(reference: number, perk: number, has: boolean): void {
    this.#runtime.state.actor(reference).perks.set(perk, has);
  }

  // --- What it wears ----------------------------------------------------------------------------

  /** What it wears: its armor and clothing (and shield), as the equip system has dressed it. */
  worn(reference: number): Promise<number[]> {
    return this.#runtime.equipment.worn(reference);
  }

  // --- Essential, protected, dead -----------------------------------------------------------

  async #baseFlag(
    reference: number,
    flag: number,
    key: 'essential' | 'protected' | 'invulnerable',
  ): Promise<boolean> {
    const info = await this.info(reference);
    if (!info) return false;
    const set = this.#runtime.state.actorBases.get(info.base)?.[key];
    if (set !== undefined) return set;
    return (info.baseData.flags & flag) !== 0;
  }

  /** Essential: its base, or an alias that holds it (Creation Kit: the alias's Essential flag). */
  async isEssential(reference: number): Promise<boolean> {
    if (await this.#baseFlag(reference, NpcFlag.essential, 'essential')) return true;
    return this.#aliasFlag(reference, AliasFlag.essential);
  }

  async isProtected(reference: number): Promise<boolean> {
    if (await this.#baseFlag(reference, NpcFlag.protected, 'protected')) return true;
    return this.#aliasFlag(reference, AliasFlag.protected);
  }

  async isInvulnerable(reference: number): Promise<boolean> {
    return this.#baseFlag(reference, NpcFlag.invulnerable, 'invulnerable');
  }

  async #aliasFlag(reference: number, flag: number): Promise<boolean> {
    for (const { quest, alias } of this.#runtime.aliasesHolding(reference)) {
      const record = await this.#runtime.forms.alias(quest, alias);
      if (record && (record.flags & flag) !== 0) return true;
    }
    return false;
  }

  async isGhost(reference: number): Promise<boolean> {
    const set = this.#runtime.state.actors.get(reference)?.ghost;
    if (set !== undefined) return set;
    return (((await this.info(reference))?.baseData.flags ?? 0) & NpcFlag.ghost) !== 0;
  }

  /** Dead: killed, or placed dead (ACHR "starts dead"). */
  async isDead(reference: number): Promise<boolean> {
    const set = this.#runtime.state.actors.get(reference)?.dead;
    if (set !== undefined) return set;
    const flags = this.#runtime.indexedFlags(reference);
    if (flags !== undefined) {
      return this.#runtime.isIndexedActor(reference) && (flags & RecordFlag.startsDead) !== 0;
    }
    const record = await this.#runtime.forms.record(reference);
    return record?.type === 'ACHR' && (record.flags & RecordFlag.startsDead) !== 0;
  }

  /** Kill: it dies (OnDying, then OnDeath to it and its aliases). */
  async kill(reference: number, killer: number | undefined, silent = false): Promise<void> {
    if (await this.isDead(reference)) return;
    const state = this.#runtime.state.actor(reference);
    state.dead = true;
    if (killer !== undefined) state.killer = killer;
    const base = await this.#runtime.baseOf(reference);
    if (base !== undefined) {
      const counts = this.#runtime.state.deadCounts;
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    this.#own(reference, ActorValue.health).damage = (
      await this.value(reference, ActorValue.health)
    ).max;
    // Silent: no death cry or alarm (TODO(M10): detection and crime).
    this.#runtime.world.killed?.(reference, killer, silent);
    const by = killer === undefined ? null : this.#runtime.actorHandle(killer);
    await this.#runtime.sendEvent(reference, 'OnDying', [by]);
    await this.#runtime.sendEvent(reference, 'OnDeath', [by]);
    // TODO(M11): the story manager's kill event (crime status, relationship rank).
  }

  async resurrect(reference: number): Promise<void> {
    const state = this.#runtime.state.actor(reference);
    state.dead = false;
    delete state.killer;
    this.#own(reference, ActorValue.health).damage = 0;
    this.#runtime.world.resurrected?.(reference);
    await this.#runtime.sendEvent(reference, 'OnResurrect');
  }
}
