// Crime and factions on the running game (docs/gameplay.md, "Crime and factions"; the rules:
// src/gameplay/crime.ts, src/gameplay/factions.ts): crimes the player commits and their
// witnesses (detection's witness hook names them: `witnesses`), the crime faction each bounty
// goes to (a victim's crime faction, an owner's, the place's location), the bounties
// (FactionState's crime gold), items marked stolen, jail (the hold's jail, its evidence chests,
// serving time, escaping), paying a fine, guards' responses, how actors regard each other for
// combat (`reaction`) and favor. What the stage does about them (barks, alarms, guards walking
// up, the jail's journey) listens here (src/shell/actor-crime.ts). Platform-independent.

import {
  bribeAmount,
  CrimeFlag,
  crimeSettingNames,
  CrimeLedger,
  crimeBounty,
  CrimeType,
  crimeValues,
  guardResponse,
  ignoresCrime,
  intimidates,
  isViolent,
  jailDays,
  jailSkillLosses,
  boundedPickpocketChance,
  pickpocketBaseChance,
  pickpocketUses,
  readCrimeSettings,
  type Crime,
  type CrimeSettings,
  type CrimeValues,
  type GuardResponse,
} from '../../gameplay/crime.ts';
import {
  overlooksCrime,
  rankFromFavor,
  reaction as regard,
  type Reaction,
} from '../../gameplay/factions.ts';
import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { ActorValue, actorValueIndex } from '../../world/actor-values.ts';
import type { FactionCrime } from '../../world/actor-stats-records.ts';
import { parseItem } from '../../world/item-records.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';

/** The acts detection's witnesses see (src/ai/detection-states.ts WitnessedAct). */
export type CrimeAct = 'steal' | 'pickpocket' | 'trespass' | 'attack' | 'murder' | 'lockpick';

/** What crime asks of the stage: who sees an act now. */
export interface CrimeWorld {
  /** The actors that detect `actor` now and so see it do `act` (Detections.witness). */
  witnesses(actor: number, act: CrimeAct, victim: number | undefined): number[];
}

/** What crime tells its listeners (the stage: barks, alarms, the HUD). */
export type CrimeEvent =
  /** A crime was seen: its witnesses react (their line, an alarm to those near). */
  | { readonly kind: 'crime'; readonly crime: Crime; readonly act: CrimeAct }
  /** The last witness of crimes died before they were reported: their bounty is gone. */
  | { readonly kind: 'forgiven'; readonly crimes: readonly Crime[] }
  /** The player was caught pickpocketing (sPickpocketFail): the menu closes. */
  | { readonly kind: 'caught'; readonly victim: number }
  /** The player went to jail, served their time, escaped, or paid. */
  | { readonly kind: 'jailed' | 'released' | 'escaped' | 'paid'; readonly faction: number };

/** The base form of the prison markers (PrisonMarker, a Skyrim.esm marker). */
const PRISON_MARKER = 0x4;
/** IsGuardFaction (Skyrim.esm): its members are guards (IsGuard). */
const IS_GUARD_FACTION = 0x86eee;
/** CLAS DATA @35 flags: Guard (xEdit's TES5 CLAS). */
const CLASS_GUARD = 0x1;
/** The gold item. */
const GOLD = 0xf;
/** The Pickpocket and Speech skills (actor values). */
const PICKPOCKET = actorValueIndex('Pickpocket') ?? 13;
const SPEECH = actorValueIndex('Speechcraft') ?? 17;

/** A form as a script object of a type, or None. */
const formOrNone = (formId: number | undefined, type: string): Value =>
  formId === undefined ? null : new ObjectHandle(formId, type);
/** The actor value DialogueCrimeGuards' SetLastArrestTime keeps a guard's next arrest in. */
const LAST_ARREST = 'Variable03';

/** A crime's stolen-key: the faction it was against and whether it was seen. */
const stolenKey = (faction: number | undefined, witnessed: boolean): string =>
  `${String(faction ?? 0)}:${witnessed ? '1' : '0'}`;

export class CrimeEngine {
  readonly #runtime: ScriptRuntime;
  readonly ledger = new CrimeLedger();
  /** What the stage answers (who witnesses); undefined: nobody sees anything. */
  world: CrimeWorld | undefined;
  readonly #listeners = new Set<(event: CrimeEvent) => void>();
  #settings: Promise<CrimeSettings> | undefined;
  readonly #names = new Map<number, string>();
  readonly #jailMarkers = new Map<number, Promise<number | undefined>>();
  random: () => number = Math.random;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** Listens to crimes; returns the function that stops listening. */
  listen(listener: (event: CrimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: CrimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /** Crime's game settings (the load order's, else the engine's), read once. */
  settings(): Promise<CrimeSettings> {
    this.#settings ??= settingsOf(this.#runtime).then((read) => readCrimeSettings(read));
    return this.#settings;
  }

  // --- Crime factions -------------------------------------------------------------------------

  /** A faction's crime data (FACT JAIL ... CRVA), if it has any. */
  async factionCrime(faction: number): Promise<FactionCrime | undefined> {
    return (await this.#runtime.actors.faction(faction))?.crime;
  }

  /** A crime faction's values (its CRVA, or the defaults). */
  async values(faction: number): Promise<CrimeValues> {
    const record = await this.#runtime.actors.faction(faction);
    return crimeValues(record?.flags ?? 0, record?.crime, await this.settings());
  }

  /** A faction's name (FULL), read once (the journal's bounties). */
  name(faction: number): string | undefined {
    if (!this.#names.has(faction)) {
      this.#names.set(faction, '');
      void this.#runtime.forms.record(faction).then((record) => {
        this.#names.set(faction, record?.text('FULL') ?? record?.editorId ?? '');
      });
    }
    const name = this.#names.get(faction);
    return name === '' ? undefined : name;
  }

  /** The crime faction of a place: its location's or the nearest parent's (LCTN FNAM). */
  async placeCrimeFaction(reference: number): Promise<number | undefined> {
    const location = await this.#runtime.locationOf(reference);
    if (location === undefined) return undefined;
    for (const at of await this.#runtime.locationParents(location)) {
      const faction = (await this.#runtime.location(at))?.crimeFaction;
      if (faction !== undefined) return faction;
    }
    return undefined;
  }

  /**
   * The crime faction a crime goes to: the victim's (Actor.GetCrimeFaction); else an owner's (an
   * NPC_'s CRIF, or an owning faction that tracks crime); else the place's (its location's
   * FNAM). UESP "Skyrim:Crime": crimes are reported to the hold they happen in.
   */
  async crimeFactionFor(options: {
    readonly victim?: number | undefined;
    readonly owner?: { readonly actor: number | undefined; readonly faction: number | undefined };
    readonly place?: number | undefined;
    /** Without the place's faction (actor crimes: victimCrimeFaction). */
    readonly noPlace?: boolean;
  }): Promise<number | undefined> {
    const { actors } = this.#runtime;
    if (options.victim !== undefined && options.victim !== PLAYER_REF) {
      const faction = await actors.crimeFaction(options.victim);
      if (faction !== undefined) return faction;
    }
    const owner = options.owner;
    if (owner?.actor !== undefined) {
      const faction = (await actors.baseStats(owner.actor))?.crimeFaction;
      if (faction !== undefined) return faction;
    }
    if (owner?.faction !== undefined) {
      const record = await actors.faction(owner.faction);
      if (record && (record.flags & CrimeFlag.trackCrime) !== 0) return owner.faction;
    }
    if (options.noPlace === true) return undefined;
    const place = options.place ?? options.victim;
    return place === undefined ? undefined : this.placeCrimeFaction(place);
  }

  /**
   * The crime faction an assault or a murder goes to: the victim's own (Actor.GetCrimeFaction:
   * one set by script, else its base's CRIF; none for a commanded actor, a summon or a raised
   * corpse: CommonLibSSE GetCrimeFactionImpl), else its owner's (the reference's XOWN: an owning
   * NPC_'s CRIF, or an owning faction that tracks crime). Not the place's: a creature nobody
   * owns is no one's to avenge. The data shows the rule: no animal base has a CRIF, while the
   * farms' and inns' chickens, cows and dogs are owned (56 of 102 placed chickens: Lorius Farm,
   * the Windpeak Inn), and attacking those is the crime UESP "Skyrim:Crime" tells of; none of
   * the 69 placed EncWolf is owned. TODO(M13): the owner step is inferred from the data.
   */
  async victimCrimeFaction(victim: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    if (victim === PLAYER_REF || runtime.magic.commander(victim) !== undefined) return undefined;
    const own = await runtime.actors.crimeFaction(victim);
    if (own !== undefined) return own;
    const owner = await runtime.owner(victim);
    if (owner.actor === undefined && owner.faction === undefined) return undefined;
    return this.crimeFactionFor({ owner, noPlace: true });
  }

  /** The factions sharing a crime faction's crimes (its CRGR list, itself first). */
  async crimeGroup(faction: number): Promise<number[]> {
    const list = (await this.factionCrime(faction))?.sharedCrimeFactions;
    const members = list === undefined ? [] : await this.#runtime.formList(list);
    return [faction, ...members.filter((member) => member !== faction)];
  }

  // --- Bounties -------------------------------------------------------------------------------

  /** The player's crime gold with a faction. */
  bounty(faction: number): { readonly violent: number; readonly nonviolent: number } {
    const entry = this.#runtime.state.factions.get(faction);
    return { violent: entry?.crimeGoldViolent ?? 0, nonviolent: entry?.crimeGold ?? 0 };
  }

  /** Every faction the player owes crime gold, with its total (the journal's bounties). */
  bounties(): { faction: number; gold: number }[] {
    const owed: { faction: number; gold: number }[] = [];
    for (const [faction, entry] of this.#runtime.state.factions) {
      const gold = entry.crimeGold + entry.crimeGoldViolent;
      if (gold > 0) owed.push({ faction, gold });
    }
    return owed;
  }

  /**
   * Crime gold added to (or, negative, taken from) a faction: its infamy and the crime stats
   * (Total Lifetime Bounty, Largest Bounty) follow a rise.
   */
  addBounty(faction: number, gold: number, violent: boolean): void {
    const entry = this.#runtime.state.faction(faction);
    if (violent) entry.crimeGoldViolent = Math.max(0, entry.crimeGoldViolent + gold);
    else entry.crimeGold = Math.max(0, entry.crimeGold + gold);
    if (gold <= 0) return;
    if (violent) entry.infamyViolent = (entry.infamyViolent ?? 0) + gold;
    else entry.infamy = (entry.infamy ?? 0) + gold;
    const runtime = this.#runtime;
    runtime.incrementStat('Total Lifetime Bounty', gold);
    const total = entry.crimeGold + entry.crimeGoldViolent;
    if (total > (runtime.stats.get('largest bounty') ?? 0))
      runtime.setStat('Largest Bounty', total);
    this.name(faction);
  }

  #stat(name: string, by = 1): void {
    this.#runtime.incrementStat(name, by);
  }

  // --- Crimes ---------------------------------------------------------------------------------

  /**
   * The player commits a crime: those who see it (detection's witnesses, else `witnesses`)
   * report it to its crime faction, which adds the bounty, unless the faction ignores the type,
   * the victim lets it pass (a friend overlooks minor crimes) or nobody who cares saw it.
   * Witnesses that care: the victim, and those whose crime faction is the crime's or shares its
   * crimes (CRGR), not the player's followers. Crimes by others: TODO(M13) (NPCs' crimes against
   * each other are combat's). Returns the crime as recorded, if anyone saw it.
   */
  async commit(
    type: CrimeType,
    criminal: number,
    options: {
      readonly act: CrimeAct;
      readonly victim?: number | undefined;
      readonly faction?: number | undefined;
      readonly value?: number;
      readonly horse?: boolean;
      readonly witnesses?: readonly number[];
    },
  ): Promise<Crime | undefined> {
    if (criminal !== PLAYER_REF) return undefined;
    const runtime = this.#runtime;
    const { victim } = options;
    const faction =
      options.faction ?? (await this.crimeFactionFor({ victim, place: victim ?? criminal }));
    const seen = options.witnesses ?? this.world?.witnesses(criminal, options.act, victim) ?? [];
    const violent = isViolent(type);
    if (victim !== undefined && victim !== PLAYER_REF) {
      const rank = await runtime.actors.relationshipRank(victim, criminal);
      if (overlooksCrime(rank, violent, type === CrimeType.murder)) return undefined;
    }
    const values = faction === undefined ? undefined : await this.values(faction);
    // A faction that ignores the crime, or one against its own members it does not report
    // (Do Not Report Crimes Against Members), takes no notice.
    if (values && ignoresCrime(values, type)) return undefined;
    if (
      values &&
      faction !== undefined &&
      victim !== undefined &&
      (values.flags & CrimeFlag.doNotReportAgainstMembers) !== 0 &&
      (await runtime.actors.factionRank(victim, faction)) >= 0
    ) {
      return undefined;
    }
    const group = faction === undefined ? [] : await this.crimeGroup(faction);
    const witnesses: number[] = [];
    for (const witness of seen) {
      if (witness === criminal || (await runtime.actors.isDead(witness))) continue;
      if (runtime.state.actors.get(witness)?.playerTeammate === true) continue;
      if (witness !== victim) {
        const own = await runtime.actors.crimeFaction(witness);
        if (own === undefined || !group.includes(own)) continue;
        if (await this.#overlooks(witness, criminal, type)) continue;
      }
      witnesses.push(witness);
    }
    const gold =
      values === undefined
        ? 0
        : crimeBounty(type, values, {
            value: options.value ?? 0,
            horse: options.horse === true,
            settings: await this.settings(),
          });
    const crime = this.ledger.commit({
      type,
      criminal,
      victim,
      faction,
      gold,
      violent,
      witnesses,
      at: runtime.state.gameDaysPassed * 24,
    });
    if (!crime) return undefined;
    if (faction !== undefined && gold > 0) {
      this.addBounty(faction, gold, violent);
      runtime.detach(
        runtime.storyManager.event(
          storyEvent('ADCR', { R1: victim, R2: criminal, F1: faction }, { V1: gold, V2: type }, [
            runtime.referenceHandleOrNone(victim),
            runtime.referenceHandle(criminal),
            formOrNone(faction, 'faction'),
            gold,
            type,
          ]),
        ),
      );
    }
    this.#emit({ kind: 'crime', crime, act: options.act });
    return crime;
  }

  /** A witness overlooks the crime: a friend of the criminal (minor crimes; allies assault). */
  async #overlooks(witness: number, criminal: number, type: CrimeType): Promise<boolean> {
    const rank = await this.#runtime.actors.relationshipRank(witness, criminal);
    return overlooksCrime(rank, isViolent(type), type === CrimeType.murder);
  }

  /** A witness died: the crimes it was the last to see are forgiven (their bounty taken back). */
  witnessDied(actor: number): void {
    const forgiven = this.ledger.witnessDied(actor);
    if (forgiven.length === 0) return;
    for (const crime of forgiven) {
      if (crime.faction !== undefined) this.addBounty(crime.faction, -crime.gold, crime.violent);
    }
    this.#emit({ kind: 'forgiven', crimes: forgiven });
  }

  /** Every game hour or so: crimes older than REPORT_HOURS, or seen by a guard, are reported. */
  async update(): Promise<void> {
    const guards = new Set<number>();
    for (const crime of this.ledger.open()) {
      for (const witness of crime.witnesses) if (await this.isGuard(witness)) guards.add(witness);
    }
    this.ledger.expire(this.#runtime.state.gameDaysPassed * 24, (actor) => guards.has(actor));
  }

  // --- Stealing -------------------------------------------------------------------------------

  /** Whether an actor may take a reference without stealing it (its owner, else its cell's). */
  mayTake(actor: number, reference: number): Promise<boolean> {
    return this.#runtime.mayUse(actor, reference);
  }

  /** Whose a reference is: its owner (XOWN, as scripts left it), else its cell's. */
  async ownerOf(
    reference: number,
  ): Promise<{ actor: number | undefined; faction: number | undefined }> {
    const runtime = this.#runtime;
    const own = await runtime.owner(reference);
    if (own.actor !== undefined || own.faction !== undefined) return own;
    const cell = (await runtime.placement(reference))?.cell;
    return cell === undefined ? own : runtime.cellOwner(cell);
  }

  /**
   * The player stole items (`count` of `base`, now in their inventory) from `from` (the
   * reference taken, or the container): they are marked stolen, the theft (half their value:
   * crimeBounty) is reported if seen. The stats count them (Items Stolen).
   */
  async steal(
    thief: number,
    base: number,
    count: number,
    from: number,
    victim?: number,
  ): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    const owner = await this.ownerOf(from);
    const ownerActor = victim ?? (await this.#ownerReference(owner.actor));
    const faction = await this.crimeFactionFor({ victim: ownerActor, owner, place: from });
    const record = await runtime.forms.record(base);
    const value = (record ? (parseItem(record)?.value ?? 0) : 0) * count;
    const crime = await this.commit(CrimeType.steal, thief, {
      act: 'steal',
      victim: ownerActor,
      faction,
      value,
    });
    if (thief === PLAYER_REF) {
      this.markStolen(thief, base, count, faction, crime !== undefined);
      this.#stat('items stolen', count);
    }
    return crime;
  }

  /**
   * SendStealAlarm: the thief is treated as having stolen a reference (it is not taken): the
   * theft of its value reported by those who see the thief.
   */
  async stealAlarm(thief: number, reference: number): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    const owner = await this.ownerOf(reference);
    const victim = await this.#ownerReference(owner.actor);
    const faction = await this.crimeFactionFor({ victim, owner, place: reference });
    const base = await runtime.baseOf(reference);
    const record = base === undefined ? undefined : await runtime.forms.record(base);
    const value = record ? (parseItem(record)?.value ?? 0) : 0;
    return this.commit(CrimeType.steal, thief, { act: 'steal', victim, faction, value });
  }

  /** The placed actor of an owning NPC_ (unique), if any: the victim of a theft. */
  async #ownerReference(npc: number | undefined): Promise<number | undefined> {
    return npc === undefined ? undefined : this.#runtime.forms.uniqueReference(npc);
  }

  /** `count` of `base` in a container are stolen (from a faction, seen or not). */
  markStolen(
    container: number,
    base: number,
    count: number,
    faction: number | undefined,
    witnessed: boolean,
  ): void {
    if (count <= 0) return;
    const stolen = this.#runtime.state.crime.stolen;
    const items = stolen.get(container) ?? new Map<number, Map<string, number>>();
    stolen.set(container, items);
    const kinds = items.get(base) ?? new Map<string, number>();
    items.set(base, kinds);
    const key = stolenKey(faction, witnessed);
    kinds.set(key, (kinds.get(key) ?? 0) + count);
  }

  /** How many of a container's `base` are stolen. */
  stolenCount(container: number, base: number): number {
    let count = 0;
    for (const n of this.#runtime.state.crime.stolen.get(container)?.get(base)?.values() ?? [])
      count += n;
    return count;
  }

  /** The stolen items a container holds, by base. */
  stolenItems(container: number): Map<number, number> {
    const found = new Map<number, number>();
    for (const base of this.#runtime.state.crime.stolen.get(container)?.keys() ?? []) {
      const count = this.stolenCount(container, base);
      if (count > 0) found.set(base, count);
    }
    return found;
  }

  /** Takes `count` stolen ones of `base` off a container's marks; returns their kinds taken. */
  #unmark(container: number, base: number, count: number): Map<string, number> {
    const taken = new Map<string, number>();
    const items = this.#runtime.state.crime.stolen.get(container);
    const kinds = items?.get(base);
    if (!items || !kinds) return taken;
    let left = count;
    for (const [key, n] of [...kinds]) {
      if (left <= 0) break;
      const moved = Math.min(n, left);
      left -= moved;
      taken.set(key, moved);
      if (n - moved > 0) kinds.set(key, n - moved);
      else kinds.delete(key);
    }
    if (kinds.size === 0) items.delete(base);
    if (items.size === 0) this.#runtime.state.crime.stolen.delete(container);
    return taken;
  }

  /**
   * Items moved (ScriptRuntime.removeItem: `moved` of `base`, of `had`): the stolen ones go last
   * (what is not stolen leaves first) and stay stolen where they go (`to`, if any).
   */
  itemsMoved(from: number, to: number | undefined, base: number, moved: number, had: number): void {
    const stolen = this.stolenCount(from, base);
    if (stolen <= 0) return;
    const clean = Math.max(0, had - stolen);
    const leaving = Math.min(stolen, Math.max(0, moved - clean));
    if (leaving <= 0) return;
    const kinds = this.#unmark(from, base, leaving);
    if (to === undefined) return;
    for (const [key, n] of kinds) {
      const [faction, witnessed] = key.split(':');
      this.markStolen(to, base, n, Number(faction) || undefined, witnessed === '1');
    }
  }

  /** Stolen marks go (sold to a vendor: what it sells again is not stolen; scripts). */
  clearStolen(container: number, base?: number): void {
    const stolen = this.#runtime.state.crime.stolen;
    if (base === undefined) stolen.delete(container);
    else this.#unmark(container, base, Number.MAX_SAFE_INTEGER);
  }

  /** The value of a container's stolen items from a faction, seen or not (GetStolenItemValue*). */
  async stolenValue(container: number, faction: number, witnessed: boolean): Promise<number> {
    let value = 0;
    const key = stolenKey(faction, witnessed);
    for (const [base, kinds] of this.#runtime.state.crime.stolen.get(container) ?? []) {
      const count = kinds.get(key) ?? 0;
      if (count <= 0) continue;
      const record = await this.#runtime.forms.record(base);
      value += (record ? (parseItem(record)?.value ?? 0) : 0) * count;
    }
    return value;
  }

  /** The stolen items of a container go elsewhere (the stolen goods chest), or away. */
  async confiscate(container: number, to: number | undefined): Promise<void> {
    const runtime = this.#runtime;
    for (const [base, count] of this.stolenItems(container)) {
      const have = await runtime.itemCount(container, base);
      const taking = Math.min(have, count);
      this.#unmark(container, base, count);
      if (taking > 0)
        await runtime.removeItem(container, runtime.formHandle(base), taking, true, to);
    }
    this.clearStolen(container);
  }

  // --- Pickpocketing --------------------------------------------------------------------------

  /** The chance (percent) to take (or place) `count` of `base` from (or into) a target's pockets. */
  async pickpocketChance(
    thief: number,
    target: number,
    base: number,
    count: number,
  ): Promise<number> {
    const runtime = this.#runtime;
    const record = await runtime.forms.record(base);
    const item = record && parseItem(record);
    const skill = (await runtime.actors.value(thief, PICKPOCKET)).current;
    const targetSkill = (await runtime.actors.value(target, PICKPOCKET)).current;
    // The thief's perks change it (Mod Pickpocket Chance: Light Fingers, Night Thief on the
    // sleeping, Cutpurse on gold, Keymaster on keys; Fortify Pickpocket through the skill boost
    // perks), within the limits.
    const settings = await this.settings();
    const chance = pickpocketBaseChance(
      {
        skill,
        targetSkill,
        weight: (item?.weight ?? 0) * count,
        value: (item?.value ?? 0) * count,
      },
      settings,
    );
    return boundedPickpocketChance(
      await runtime.perks.apply(EntryPoint.modPickpocketChance, thief, chance, [target, base]),
      settings,
    );
  }

  /**
   * A pickpocket attempt (the container menu in pickpocket mode): by chance the items move
   * (taken: stolen, Pickpocket uses by their value, Pockets Picked and Items Pickpocketed);
   * failing, the target catches the thief (sPickpocketFail): the pickpocket crime, seen by the
   * target and whoever else watches. Returns whether it succeeded.
   */
  async pickpocket(
    thief: number,
    target: number,
    base: number,
    count: number,
    placing = false,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const chance = await this.pickpocketChance(thief, target, base, count);
    const faction = await this.crimeFactionFor({ victim: target });
    if (this.random() * 100 >= chance) {
      const others = this.world?.witnesses(thief, 'pickpocket', target) ?? [];
      await this.commit(CrimeType.pickpocket, thief, {
        act: 'pickpocket',
        victim: target,
        faction,
        witnesses: [target, ...others.filter((actor) => actor !== target)],
      });
      this.#emit({ kind: 'caught', victim: target });
      return false;
    }
    if (placing) {
      await runtime.removeItem(thief, runtime.formHandle(base), count, true, target);
      // A poison placed may act on the target at once (Should Apply Placed Item: Poisoned).
      const poison = await runtime.magic.item(base);
      if (
        poison?.kind === 'poison' &&
        (await runtime.perks.apply(EntryPoint.shouldApplyPlacedItem, thief, 0, [target, base])) !==
          0
      ) {
        await runtime.removeItem(target, runtime.formHandle(base), 1, true, undefined);
        await runtime.magic.apply(poison, target, { caster: thief });
      }
      return true;
    }
    await runtime.removeItem(target, runtime.formHandle(base), count, true, thief);
    // Seen by others than the target: the theft is a crime all the same.
    const others = (this.world?.witnesses(thief, 'pickpocket', target) ?? []).filter(
      (actor) => actor !== target,
    );
    const crime =
      others.length > 0
        ? await this.commit(CrimeType.pickpocket, thief, {
            act: 'pickpocket',
            victim: target,
            faction,
            witnesses: others,
          })
        : undefined;
    if (thief === PLAYER_REF) {
      this.markStolen(thief, base, count, faction, crime !== undefined);
      const record = await runtime.forms.record(base);
      const value = (record ? (parseItem(record)?.value ?? 0) : 0) * count;
      await runtime.progression.useSkill(
        PLAYER_REF,
        PICKPOCKET,
        pickpocketUses(value, await this.settings()),
      );
      this.#stat('pockets picked');
      this.#stat('items pickpocketed', count);
    }
    return true;
  }

  // --- Violence and the rest ------------------------------------------------------------------

  /**
   * An attack on an actor (combat's hits: actor-combat.ts; spells': magic-engine.ts cast): an assault if the victim
   * was not hostile to the attacker (an enemy is fair game) nor already attacked by them;
   * reported to the victim's crime faction (iCrimeGoldAttack). The story manager's Assault
   * Actor event (OnStoryAssaultActor).
   */
  async assault(attacker: number, victim: number): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    if (attacker !== PLAYER_REF || victim === attacker) return undefined;
    if ((await this.reaction(victim, attacker)) === 'hostile') return undefined;
    if (this.ledger.known(CrimeType.attack, attacker, victim)) return undefined;
    // The one hit knows who hit it, seen or not; those who see the attacker too.
    const others = this.world?.witnesses(attacker, 'attack', victim) ?? [];
    const faction = await this.victimCrimeFaction(victim);
    const crime =
      faction === undefined
        ? undefined
        : await this.commit(CrimeType.attack, attacker, {
            act: 'attack',
            victim,
            faction,
            witnesses: [victim, ...others.filter((actor) => actor !== victim)],
          });
    if (crime) this.#stat('assaults');
    runtime.detach(
      runtime.storyManager.event(
        storyEvent(
          'ASSU',
          { R1: victim, R2: attacker, L1: await runtime.locationOf(victim) },
          { V1: crime ? CrimeType.attack : CrimeType.none },
          [
            runtime.referenceHandle(victim),
            runtime.referenceHandle(attacker),
            formOrNone(await runtime.locationOf(victim), 'location'),
            crime ? CrimeType.attack : CrimeType.none,
          ],
        ),
      ),
    );
    return crime;
  }

  /** A murder (combat's kills: through ActorEngine.kill): the killing of one not hostile to the killer. */
  async murder(killer: number, victim: number): Promise<Crime | undefined> {
    if (killer !== PLAYER_REF || victim === killer) return undefined;
    if ((await this.reaction(victim, killer)) === 'hostile') return undefined;
    const faction = await this.victimCrimeFaction(victim);
    if (faction === undefined) return undefined;
    const crime = await this.commit(CrimeType.murder, killer, { act: 'murder', victim, faction });
    if (crime) this.#stat('murders');
    return crime;
  }

  /**
   * An actor died (ActorEngine.kill): it no longer witnesses; killed by the player, a murder if
   * it was no enemy (not a silent kill's: KillSilent raises no alarm); the story manager's Kill
   * Actor event (OnStoryKillActor: crime status 0 no crime, 1 unseen, 2 seen; the relationship
   * rank to its killer).
   */
  async killed(victim: number, killer: number | undefined, silent = false): Promise<void> {
    const runtime = this.#runtime;
    const rank = killer === undefined ? 0 : await runtime.actors.relationshipRank(victim, killer);
    const hostile = killer !== undefined && (await this.reaction(victim, killer)) === 'hostile';
    this.witnessDied(victim);
    const crime = killer === undefined || silent ? undefined : await this.murder(killer, victim);
    // A kill no crime faction cares for (a wild animal, a summon) is no crime at all.
    const status =
      killer === PLAYER_REF && !hostile && (await this.victimCrimeFaction(victim)) !== undefined
        ? crime
          ? 2
          : 1
        : 0;
    const location = await runtime.locationOf(victim);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent('KILL', { R1: victim, R2: killer, L1: location }, { V1: status, V2: rank }, [
          runtime.referenceHandle(victim),
          runtime.referenceHandleOrNone(killer),
          formOrNone(location, 'location'),
          status,
          rank,
        ]),
      ),
    );
  }

  /** The player trespasses in a place (the warnings used up): reported by those who saw it. */
  async trespass(
    trespasser: number,
    place: number,
    witnesses?: readonly number[],
  ): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    const owner = await this.ownerOf(place);
    const victim = await this.#ownerReference(owner.actor);
    const faction = await this.crimeFactionFor({ victim, owner, place });
    const crime = await this.commit(CrimeType.trespass, trespasser, {
      act: 'trespass',
      victim,
      faction,
      ...(witnesses && { witnesses }),
    });
    if (crime) this.#stat('trespasses');
    const location = await runtime.locationOf(trespasser);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent(
          'TRES',
          { R1: victim, R2: trespasser, L1: location },
          { V1: crime ? CrimeType.trespass : CrimeType.none },
          [
            runtime.referenceHandleOrNone(victim),
            runtime.referenceHandle(trespasser),
            formOrNone(location, 'location'),
            crime ? CrimeType.trespass : CrimeType.none,
          ],
        ),
      ),
    );
    return crime;
  }

  /**
   * The player picked an owned lock where someone saw it (UESP "Skyrim:Crime": picking a lock
   * in sight is trespassing). A load door's other side is off limits to them from now on.
   */
  async lockPicked(picker: number, reference: number): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    const owned = !(await runtime.mayUse(picker, reference));
    const destination = await this.#doorDestinationCell(reference);
    if (owned && destination !== undefined) runtime.state.crime.offLimits.add(destination);
    let crime: Crime | undefined;
    // Noticed by the chance the picker's perks leave (Mod Lockpicking Crime Chance, percent:
    // Quick Hands, none).
    const noticed =
      owned &&
      this.random() * 100 <
        (await runtime.perks.apply(EntryPoint.modLockpickingCrimeChance, picker, 100, [reference]));
    if (noticed) {
      const owner = await this.ownerOf(reference);
      const victim = await this.#ownerReference(owner.actor);
      const faction = await this.crimeFactionFor({ victim, owner, place: reference });
      crime = await this.commit(CrimeType.trespass, picker, { act: 'lockpick', victim, faction });
    }
    // The story manager's Pick Lock event (OnStoryPickLock(akActor, akLock, abCrime)).
    runtime.detach(
      runtime.storyManager.event(
        storyEvent('LOCK', { R1: picker, R2: reference }, { V1: crime ? 1 : 0 }, [
          runtime.referenceHandle(picker),
          runtime.referenceHandle(reference),
          crime !== undefined,
        ]),
      ),
    );
    return crime;
  }

  /** The cell a load door leads into (its XTEL door's cell). */
  async #doorDestinationCell(door: number): Promise<number | undefined> {
    const xtel = (await this.#runtime.forms.record(door))?.formIdField('XTEL');
    return xtel === undefined ? undefined : this.#runtime.forms.db.cellOfReference(xtel);
  }

  /**
   * The doors of a place were locked (LockDoors) or unlocked: an interior locked with the
   * player in it is off limits to them (staying, they trespass: warned, then reported,
   * src/shell/actor-crime.ts);
   * unlocked, it is open to them again.
   */
  doorsLocked(cells: Iterable<number>, locked: boolean, playerCell: number | undefined): void {
    const offLimits = this.#runtime.state.crime.offLimits;
    for (const cell of cells) {
      if (!locked) offLimits.delete(cell);
      else if (cell === playerCell) offLimits.add(cell);
    }
  }

  /**
   * A door locked or unlocked as its owner (ObjectReference.Lock's abAsOwner): as the owner's
   * own LockDoors does it, no crime in it. Unlocked, the places on both its sides are open to
   * the player again (no longer off limits: entering is no trespass); locked, the one the player
   * is in becomes off limits (they trespass staying). Without abAsOwner a script's Lock leaves
   * that as it was.
   */
  async lockedAsOwner(door: number, locked: boolean): Promise<void> {
    const runtime = this.#runtime;
    const cells = [
      runtime.forms.db.cellOfReference(door),
      await this.#doorDestinationCell(door),
    ].filter((cell): cell is number => cell !== undefined);
    this.doorsLocked(cells, locked, (await runtime.placement(PLAYER_REF))?.cell);
  }

  /**
   * Whether the player trespasses in a cell now (IsTrespassing): an interior off limits to them
   * (picked into, or locked with them in it) that is owned by others and not public.
   */
  async trespassing(cell: number | undefined): Promise<boolean> {
    if (cell === undefined || !this.#runtime.state.crime.offLimits.has(cell)) return false;
    const runtime = this.#runtime;
    const data = (await runtime.forms.record(cell))?.fields.first('DATA');
    // CELL DATA: 0x1 interior, 0x20 public area.
    if (!data || ((data[0] ?? 0) & 0x1) === 0 || ((data[0] ?? 0) & 0x20) !== 0) return false;
    const owner = await runtime.cellOwner(cell);
    if (owner.actor === undefined && owner.faction === undefined) return false;
    if (owner.actor !== undefined) return owner.actor !== (await runtime.baseOf(PLAYER_REF));
    return (await runtime.actors.factionRank(PLAYER_REF, owner.faction ?? 0)) < 0;
  }

  /** The player rode off on another's horse (Steal Horse: iCrimeGoldStealHorse). */
  async horseTheft(thief: number, horse: number): Promise<Crime | undefined> {
    const runtime = this.#runtime;
    const owner = await this.ownerOf(horse);
    const victim = await this.#ownerReference(owner.actor);
    const faction = await this.crimeFactionFor({ victim, owner, place: horse });
    runtime.state.crime.stolenHorses.add(horse);
    const crime = await this.commit(CrimeType.steal, thief, {
      act: 'steal',
      victim,
      faction,
      horse: true,
    });
    this.#stat('horses stolen');
    return crime;
  }

  /** A werewolf changed in sight (iCrimeGoldWerewolf, the WereTransformCrime lines). */
  async werewolf(actor: number): Promise<Crime | undefined> {
    return this.commit(CrimeType.werewolf, actor, { act: 'attack' });
  }

  /**
   * A vampire fed on a sleeping victim in sight: an assault on it (UESP "Skyrim:Vampirism":
   * caught feeding is a crime). TODO(M13): the engine's crime type for feeding.
   */
  async vampireFeed(vampire: number, victim: number): Promise<Crime | undefined> {
    return this.commit(CrimeType.attack, vampire, { act: 'attack', victim });
  }

  // --- Guards ---------------------------------------------------------------------------------

  /** Whether an actor is a guard (IsGuard): its class says so, or it is in IsGuardFaction. */
  async isGuard(actor: number): Promise<boolean> {
    const runtime = this.#runtime;
    const info = await runtime.actors.info(actor);
    const klass = info?.stats.class;
    if (klass !== undefined) {
      const data = (await runtime.forms.record(klass))?.fields.first('DATA');
      if (data && data.length >= 36 && ((data[35] ?? 0) & CLASS_GUARD) !== 0) return true;
    }
    const isGuard = runtime.forms.db.formIdOf('Skyrim.esm', IS_GUARD_FACTION);
    return isGuard !== undefined && (await runtime.actors.factionRank(actor, isGuard)) >= 0;
  }

  /**
   * What a guard does about the player now (crime's guardResponse): `alarmed` by a crime it
   * learned of. A guard told to wait (DialogueCrimeGuards' SetLastArrestTime: its Variable03
   * actor value, the next day) does not arrest before then.
   */
  async guardResponse(guard: number, alarmed: boolean): Promise<GuardResponse> {
    const runtime = this.#runtime;
    const faction = await runtime.actors.crimeFaction(guard);
    if (faction === undefined) return 'none';
    const entry = runtime.state.factions.get(faction);
    const { violent, nonviolent } = this.bounty(faction);
    const response = guardResponse({
      violent,
      nonviolent,
      alarmed,
      resisting: entry?.resisting === true,
      enemy: entry?.playerEnemy === true,
      values: await this.values(faction),
      ...(await this.#thresholds()),
    });
    if (response !== 'arrest') return response;
    const lastArrest = runtime.actors.actorValue(LAST_ARREST);
    const next =
      lastArrest === undefined ? 0 : (await runtime.actors.value(guard, lastArrest)).current;
    return next > runtime.state.gameDaysPassed ? 'none' : 'arrest';
  }

  async #thresholds(): Promise<{ violentThreshold: number; nonviolentThreshold: number }> {
    const runtime = this.#runtime;
    return {
      violentThreshold: (await runtime.globalNamed('CrimeArrestOnSightViolentThreshold')) ?? 999,
      nonviolentThreshold:
        (await runtime.globalNamed('CrimeArrestOnSightNonViolentThreshold')) ?? 1000,
    };
  }

  /**
   * Whether a crime faction's guards attack the player now: they resist its arrest, or it made
   * them its enemy (the combat AI, 5.2, reads this and `reaction`).
   */
  hostileGuards(faction: number): boolean {
    const entry = this.#runtime.state.factions.get(faction);
    return entry?.resisting === true || entry?.playerEnemy === true;
  }

  /** The player resists a faction's arrest (SetPlayerResistingArrest): its guards attack. */
  resistArrest(faction: number): void {
    this.#runtime.state.faction(faction).resisting = true;
    delete this.#runtime.state.crime.arrestingGuard;
  }

  /**
   * The pursuit ends (StopCombatAlarm on the player: a bribe, a persuasion, a fine paid): no
   * guard is arresting or attacking for resisting any more.
   */
  stopPursuit(): void {
    for (const entry of this.#runtime.state.factions.values()) delete entry.resisting;
    delete this.#runtime.state.crime.arrestingGuard;
  }

  /** The gold a bribe takes (GetBribeAmount): crime's bribeAmount for the actor. */
  async bribeAmount(actor: number): Promise<number> {
    const runtime = this.#runtime;
    const level = await runtime.actors.level(actor);
    const speech = (await runtime.actors.value(PLAYER_REF, SPEECH)).current;
    const faction = (await this.isGuard(actor))
      ? await runtime.actors.crimeFaction(actor)
      : undefined;
    const owed = faction === undefined ? undefined : this.bounty(faction);
    const amount = bribeAmount(
      level,
      speech,
      owed === undefined ? 0 : owed.violent + owed.nonviolent,
      await this.settings(),
    );
    // The player's perks change it (Mod Bribe Amount; no vanilla perk has one).
    const perked = await runtime.perks.apply(EntryPoint.modBribeAmount, PLAYER_REF, amount, [
      actor,
    ]);
    return Math.max(1, Math.round(perked));
  }

  /**
   * Whether the player would intimidate an actor now (GetIntimidateSuccess,
   * WillIntimidateSucceed: crime's intimidates), the perk entry point Mod Player Intimidation
   * (Intimidation doubles it) on the player's side. fIntimidateSpeechcraftCurve: no plugin sets
   * it and its default is not documented: 1. TODO(M13): the engine's default.
   */
  async intimidates(actor: number): Promise<boolean> {
    const actors = this.#runtime.actors;
    const value = async (reference: number, index: number): Promise<number> =>
      (await actors.value(reference, index)).current;
    const curve = await this.#runtime.gameSetting('fIntimidateSpeechcraftCurve');
    return intimidates(
      { level: await actors.level(PLAYER_REF), speech: await value(PLAYER_REF, SPEECH) },
      {
        level: await actors.level(actor),
        speech: await value(actor, SPEECH),
        confidence: await value(actor, ActorValue.confidence),
      },
      typeof curve === 'number' ? curve : 1,
      await this.#runtime.perks.apply(EntryPoint.modPlayerIntimidation, PLAYER_REF, 1, [actor]),
    );
  }

  // --- Paying, jail ---------------------------------------------------------------------------

  /**
   * The player pays a faction's bounty (Faction.PlayerPayCrimeGold): the gold goes, the stolen
   * items too where asked (to its stolen goods chest), and with `goToJail` they are taken to the
   * jail's door (its exterior marker) and let go. The story manager's Pay Fine event; Fines
   * Paid.
   */
  async payFine(faction: number, removeStolen: boolean, goToJail: boolean): Promise<void> {
    const runtime = this.#runtime;
    const { violent, nonviolent } = this.bounty(faction);
    const owed = violent + nonviolent;
    const gold = await runtime.itemCount(PLAYER_REF, GOLD);
    await runtime.removeItem(
      PLAYER_REF,
      runtime.formHandle(GOLD),
      Math.min(owed, gold),
      true,
      undefined,
    );
    const entry = runtime.state.faction(faction);
    entry.crimeGold = 0;
    entry.crimeGoldViolent = 0;
    this.ledger.settle(faction);
    this.stopPursuit();
    this.#stat('fines paid', owed);
    const crime = await this.factionCrime(faction);
    if (removeStolen) await this.confiscate(PLAYER_REF, crime?.stolenGoodsContainer);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent(
          'PFIN',
          { R1: PLAYER_REF, R2: runtime.state.crime.arrestingGuard, F1: faction },
          { V1: owed },
          [
            runtime.referenceHandle(PLAYER_REF),
            runtime.referenceHandleOrNone(runtime.state.crime.arrestingGuard),
            formOrNone(faction, 'faction'),
            owed,
          ],
        ),
      ),
    );
    if (goToJail && crime?.exteriorJailMarker !== undefined)
      await this.#sendPlayerTo(crime.exteriorJailMarker);
    this.#emit({ kind: 'paid', faction });
  }

  /**
   * The interior prison marker of a crime faction's jail: the PrisonMarker in the cell of its
   * evidence chest (PLCN), else in an interior its owner is the faction (or one of its crime
   * group). TODO(M13): the engine's way from a faction to its jail is not documented.
   */
  jailMarker(faction: number): Promise<number | undefined> {
    let pending = this.#jailMarkers.get(faction);
    if (!pending) {
      pending = this.#findJailMarker(faction);
      this.#jailMarkers.set(faction, pending);
    }
    return pending;
  }

  async #findJailMarker(faction: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    const db = runtime.forms.db;
    const crime = await this.factionCrime(faction);
    const markers = (await runtime.persistentIndex()).byBase.get(PRISON_MARKER) ?? [];
    const interior = (marker: number): number | undefined => {
      const cell = db.cellOfReference(marker);
      if (cell === undefined || db.worldOfCell(cell) !== undefined) return undefined;
      return cell;
    };
    const chest = crime?.playerInventoryContainer;
    const chestCell = chest === undefined ? undefined : db.cellOfReference(chest);
    for (const marker of markers) {
      if (chestCell !== undefined && interior(marker) === chestCell) return marker;
    }
    for (const marker of markers) {
      const cell = interior(marker);
      if (cell !== undefined && (await runtime.cellOwner(cell)).faction === faction) return marker;
    }
    // Else the jail of a faction of its crime group with the same exterior marker (the Dark
    // Brotherhood's targets' factions share Falkreath's and Riften's).
    const exterior = crime?.exteriorJailMarker;
    for (const other of exterior === undefined ? [] : await this.crimeGroup(faction)) {
      if (other === faction) continue;
      const theirs = await this.factionCrime(other);
      if (!theirs || theirs.exteriorJailMarker !== exterior || !theirs.playerInventoryContainer)
        continue;
      const theirCell = db.cellOfReference(theirs.playerInventoryContainer);
      for (const marker of markers) {
        if (theirCell !== undefined && interior(marker) === theirCell) return marker;
      }
    }
    // Else the one whose interior's location is nearest up the exterior marker's locations
    // (Winterhold's jail lies in WinterholdHoldLocation, its exterior marker in the town), not
    // the root's (Tamriel).
    const location = exterior === undefined ? undefined : await runtime.locationOf(exterior);
    const chain = location === undefined ? [] : await runtime.locationParents(location);
    let best: { marker: number; rank: number } | undefined;
    for (const marker of markers) {
      const cell = interior(marker);
      if (cell === undefined) continue;
      const at = (await runtime.forms.record(cell))?.formIdField('XLCN');
      const rank = at === undefined ? -1 : chain.indexOf(at);
      if (rank < 0 || (chain.length > 1 && rank === chain.length - 1)) continue;
      if (!best || rank < best.rank) best = { marker, rank };
    }
    return best?.marker;
  }

  /**
   * The player goes to jail (Faction.SendPlayerToJail; the guards' "I submit" lines): their
   * stolen items go to the faction's stolen goods chest, with `removeInventory` the rest to its
   * evidence chest (PLCN) and they wear its jail outfit (JOUT); the bounty is set aside for the
   * days it stands for; they are taken to the jail's prison marker, or (not `realJail`) serve
   * at once. The story manager's Jail event; Times Jailed.
   */
  async jail(faction: number, removeInventory: boolean, realJail: boolean): Promise<void> {
    const runtime = this.#runtime;
    const crime = await this.factionCrime(faction);
    const { violent, nonviolent } = this.bounty(faction);
    const days = jailDays(violent + nonviolent, await this.settings());
    await this.confiscate(PLAYER_REF, crime?.stolenGoodsContainer);
    const evidence = crime?.playerInventoryContainer;
    const taken = removeInventory && evidence !== undefined;
    if (taken) {
      await runtime.equipment.unequipAll(PLAYER_REF);
      await runtime.removeAllItems(PLAYER_REF, evidence);
    }
    if (removeInventory && crime?.jailOutfit !== undefined) await this.#dress(crime.jailOutfit);
    const marker = realJail ? await this.jailMarker(faction) : undefined;
    const cell = marker === undefined ? undefined : runtime.forms.db.cellOfReference(marker);
    runtime.state.crime.jail = { faction, violent, nonviolent, days, cell, inventoryTaken: taken };
    const entry = runtime.state.faction(faction);
    entry.crimeGold = 0;
    entry.crimeGoldViolent = 0;
    this.ledger.settle(faction);
    this.stopPursuit();
    this.#stat('times jailed');
    const guard = runtime.state.crime.arrestingGuard;
    const location = marker === undefined ? undefined : await runtime.locationOf(marker);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent('JAIL', { R1: guard, F1: faction, L1: location }, { V1: violent + nonviolent }, [
          runtime.referenceHandleOrNone(guard),
          formOrNone(faction, 'faction'),
          formOrNone(location, 'location'),
          violent + nonviolent,
        ]),
      ),
    );
    this.#emit({ kind: 'jailed', faction });
    if (marker !== undefined) await this.#sendPlayerTo(marker);
    else await this.serveTime();
  }

  /** The jail outfit's pieces given to the player and worn. */
  async #dress(outfit: number): Promise<void> {
    const runtime = this.#runtime;
    const record = await runtime.forms.record(outfit);
    for (const data of record?.fields.all('INAM') ?? []) {
      for (let at = 0; record && at + 4 <= data.length; at += 4) {
        const piece = record.formIdAt(data, at);
        if (piece === 0) continue;
        await runtime.addItem(PLAYER_REF, runtime.formHandle(piece), 1, true);
        await runtime.equipment.equip(PLAYER_REF, piece);
      }
    }
  }

  /** The player is moved to a marker (MoveTo: the world takes them there). */
  async #sendPlayerTo(marker: number): Promise<void> {
    const runtime = this.#runtime;
    const at = await runtime.placement(marker, false);
    if (!at) return;
    runtime.move(PLAYER_REF, at.position, at.rotation, at.cell, at.world);
  }

  /** Whether the player is in jail now (and where). */
  get jailed(): boolean {
    return this.#runtime.state.crime.jail !== undefined;
  }

  /**
   * The player serves their time (Game.ServeTime: the jail's bed; at once for a jail that is no
   * real one): the days pass, each a skill's progress lost (crime's jailSkillLosses); their
   * items come back from the evidence chest (the stolen ones stay taken); they are let out at
   * the exterior jail marker. The story manager's Served Time event; Days Jailed.
   */
  async serveTime(): Promise<void> {
    const runtime = this.#runtime;
    const jail = runtime.state.crime.jail;
    if (!jail) return;
    delete runtime.state.crime.jail;
    await runtime.world.passTime?.(jail.days * 24);
    const progressed = [...runtime.state.skillExperience]
      .filter(([, experience]) => experience > 0)
      .map(([skill]) => skill);
    for (const skill of jailSkillLosses(jail.days, progressed, this.random))
      runtime.state.skillExperience.set(skill, 0);
    const crime = await this.factionCrime(jail.faction);
    const evidence = crime?.playerInventoryContainer;
    if (jail.inventoryTaken && evidence !== undefined)
      await runtime.removeAllItems(evidence, PLAYER_REF);
    this.#stat('days jailed', jail.days);
    const location = await runtime.locationOf(PLAYER_REF);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent(
          'STIJ',
          { L1: location, F1: jail.faction },
          { V1: jail.violent + jail.nonviolent, V2: jail.days },
          [
            formOrNone(location, 'location'),
            formOrNone(jail.faction, 'faction'),
            jail.violent + jail.nonviolent,
            jail.days,
          ],
        ),
      ),
    );
    if (crime?.exteriorJailMarker !== undefined) await this.#sendPlayerTo(crime.exteriorJailMarker);
    this.#emit({ kind: 'released', faction: jail.faction });
  }

  /**
   * The player left the jail's cell without serving: an escape (iCrimeGoldEscape on top of the
   * bounty set aside, which comes back); their items stay in the evidence chest. The story
   * manager's Escape Jail event (EscapeJailQuest); Jail Escapes.
   */
  async escape(): Promise<void> {
    const runtime = this.#runtime;
    const jail = runtime.state.crime.jail;
    if (!jail) return;
    delete runtime.state.crime.jail;
    if (jail.violent > 0) this.addBounty(jail.faction, jail.violent, true);
    if (jail.nonviolent > 0) this.addBounty(jail.faction, jail.nonviolent, false);
    const values = await this.values(jail.faction);
    const gold = crimeBounty(CrimeType.escape, values);
    if (gold > 0) this.addBounty(jail.faction, gold, false);
    this.#stat('jail escapes');
    const location = await runtime.locationOf(PLAYER_REF);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent('ESJA', { L1: location, F1: jail.faction }, {}, [
          formOrNone(location, 'location'),
          formOrNone(jail.faction, 'faction'),
        ]),
      ),
    );
    this.#emit({ kind: 'escaped', faction: jail.faction });
  }

  // --- How actors regard each other -----------------------------------------------------------

  /**
   * How an actor regards another (src/gameplay/factions.ts reaction): their factions' combat
   * reactions, a shared faction, their relationship, frenzy, and crime (a faction that made the
   * player its enemy, guards to attack them: guardResponse). The combat AI (5.2) asks this;
   * `alarmed`: the actor learned of a crime of the other's just now.
   */
  async reaction(actor: number, other: number, alarmed = false): Promise<Reaction> {
    const runtime = this.#runtime;
    const { actors } = runtime;
    if (actor === other) return 'friend';
    const mine = await actors.factionsOf(actor);
    const theirs = await actors.factionsOf(other);
    const factionReactions: number[] = [];
    let sameFaction = false;
    for (const [faction, rank] of mine) {
      if (rank < 0) continue;
      const record = await actors.faction(faction);
      if (
        (theirs.get(faction) ?? -1) >= 0 &&
        ((record?.flags ?? 0) & CrimeFlag.specialCombat) === 0
      ) {
        sameFaction = true;
      }
      for (const [otherFaction, otherRank] of theirs) {
        if (otherRank < 0) continue;
        const value = await actors.factionReaction(faction, otherFaction);
        if (value !== undefined) factionReactions.push(value);
      }
    }
    const aggression = (await actors.value(actor, ActorValue.aggression)).current;
    return regard({
      factionReactions,
      sameFaction,
      relationshipRank: await actors.relationshipRank(actor, other),
      frenzied: aggression >= 3,
      crimeHostile: other === PLAYER_REF && (await this.#crimeHostile(actor, mine, alarmed)),
      scriptHostile: runtime.state.actors.get(actor)?.combatTargets?.includes(other) === true,
    });
  }

  async #crimeHostile(
    actor: number,
    factions: Map<number, number>,
    alarmed: boolean,
  ): Promise<boolean> {
    const state = this.#runtime.state;
    for (const [faction, rank] of factions) {
      if (rank >= 0 && state.factions.get(faction)?.playerEnemy === true) return true;
    }
    const crimeFaction = await this.#runtime.actors.crimeFaction(actor);
    if (crimeFaction === undefined) return false;
    if (state.factions.get(crimeFaction)?.playerEnemy === true) return true;
    if (await this.isGuard(actor)) return (await this.guardResponse(actor, alarmed)) === 'attack';
    // Others of a faction that attacks rather than arrests (soldiers: CrimeFactionImperial).
    const values = await this.values(crimeFaction);
    if (values.arrest || !values.attackOnSight) return false;
    const { violent, nonviolent } = this.bounty(crimeFaction);
    return alarmed && violent + nonviolent > 0;
  }

  // --- Favor ----------------------------------------------------------------------------------

  /**
   * The player did an actor a favor or gave it a gift worth `points` (ShowGiftMenu's favor
   * points): its relationship with the player rises at the iFavor* thresholds (factions'
   * rankFromFavor), never falls; the story manager's Relationship Change event.
   */
  async favor(actor: number, points: number): Promise<void> {
    const runtime = this.#runtime;
    if (!(points > 0)) return;
    const favor = runtime.state.crime.favor;
    // The player's perks change what it earns (Mod Favor Points; no vanilla perk has one).
    const earned = await runtime.perks.apply(EntryPoint.modFavorPoints, PLAYER_REF, points, [
      actor,
    ]);
    const total = (favor.get(actor) ?? 0) + Math.max(0, earned);
    favor.set(actor, total);
    const before = await runtime.actors.relationshipRank(actor, PLAYER_REF);
    const after = rankFromFavor(total, before, await this.settings());
    if (after === before) return;
    await runtime.actors.setRelationshipRank(actor, PLAYER_REF, after);
    runtime.detach(
      runtime.storyManager.event(
        storyEvent('CHRR', { R1: actor, R2: PLAYER_REF }, { V1: before, V2: after }, [
          runtime.referenceHandle(actor),
          runtime.referenceHandle(PLAYER_REF),
          before,
          after,
        ]),
      ),
    );
  }
}

/** A story manager event's data (members R1, R2, L1, F1, V1, V2; TODO(M13): F1 for forms). */
function storyEvent(
  type: string,
  forms: Readonly<Record<string, number | undefined>>,
  values: Readonly<Record<string, number>>,
  args: StoryEventData['args'],
): StoryEventData {
  return {
    type,
    forms: new Map(
      Object.entries(forms).flatMap(([key, value]): [string, number][] =>
        value === undefined ? [] : [[key, value]],
      ),
    ),
    values: new Map(Object.entries(values)),
    args,
  };
}

/** The runtime's game settings as crime reads them. */
async function settingsOf(
  runtime: ScriptRuntime,
): Promise<{ number(name: string): number | undefined }> {
  const numbers = new Map<string, number>();
  for (const [name] of crimeSettingNames()) {
    const value = await runtime.gameSetting(name);
    if (typeof value === 'number') numbers.set(name, value);
  }
  return { number: (name) => numbers.get(name) };
}
