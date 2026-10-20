// The equip system in the running game: what each actor holds and wears (ActorState.equipment,
// by the rules of src/gameplay/equipment.ts). An actor is dressed from its records as its
// inventory is first read: the armor of its outfit (its own, its base's, its record's: the
// items join its inventory as the outfit's), then, for NPCs, what it carries that suits it
// best (armor better than what covers the same slots, its best weapon, a shield beside a
// one-handed weapon, ammunition for its bow). Scripts (EquipItem, EquipSpell, SetOutfit, ...),
// the player's menus and the AI change it; the actor's scripts hear OnObjectEquipped and
// OnObjectUnequipped, the item's own OnEquipped and OnUnequipped. What it holds and wears gives
// its stats: armor rating and the damage it takes off, its weapons' damage, its carry weight.
// Combat, magic and perks read them here. Platform-independent.
// Notes: docs/gameplay.md ("Equipment").

import {
  armorDamageReduction,
  armorPieceRating,
  armorSettings,
  armorSkillMultiplier,
  equipItem,
  equippedItemType,
  holds,
  loadoutForms,
  menuEquipState,
  oneHanded,
  overEncumbered,
  raceCanUse,
  unequipItem,
  weaponDamage,
  weaponNodes,
  weaponSettings,
  weaponSkillMultiplier,
  type ArmorSettings,
  type Equippable,
  type Hand,
  type ReadSetting,
  type WeaponNodes,
  type WeaponSettings,
} from '../../gameplay/equipment.ts';
import { temperLevelOfHealth } from '../../gameplay/crafting.ts';
import { armorSkill } from '../../gameplay/inventory.ts';
import { EquipmentFlag, parseRaceCombat } from '../../ai/race-combat-records.ts';
import { BipedSlot, LeveledFlag, parseOutfit, slotBit } from '../../world/actor-records.ts';
import { ActorValue, actorValueIndex } from '../../world/actor-values.ts';
import { meshPath, pickLeveled, seededRandom } from '../../world/actors.ts';
import { DefaultObjects } from '../../world/default-objects.ts';
import {
  EquipSlots,
  EquipSlotUse,
  parseEquipSlot,
  raceEquipSlots,
  type OwnSlot,
} from '../../world/equip-slots.ts';
import {
  AmmoFlag,
  ArmorType,
  parseItem,
  WeaponFlag2,
  WeaponType,
  type ItemRecord,
} from '../../world/item-records.ts';
import { parseSpell, SpellType } from '../../world/spell-records.ts';
import type { Value } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { EquipmentState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

/** How an item is equipped. */
export interface EquipRequest {
  /** The hand asked for (the menus' left or right button, EquipSpell's source). */
  readonly hand?: Hand;
  /** EquipItem's abPreventRemoval: only scripts take it off again. */
  readonly preventRemoval?: boolean;
  /** EquipItem's abSilent: an item it is given to equip comes without a notice. */
  readonly silent?: boolean;
}

/** How an item is taken off. */
export interface UnequipRequest {
  /** From one hand only (a two-handed item leaves both). */
  readonly hand?: Hand;
  /** UnequipItem's abPreventEquip: it does not equip it again by itself. */
  readonly preventEquip?: boolean;
  /** The player in a menu: an item a script equipped to stay stays. */
  readonly byPlayer?: boolean;
}

/**
 * What perks, smithing and the like add to the stats. TODO(M11): the perk system fills
 * `armorPerks` (the perk entry point Mod Armor Rating: Custom Fit, Well Fitted, Matching Set,
 * Agile Defender, Juggernaut) and `weaponPerks` (Mod Attack Damage: Armsman, Barbarian,
 * Overdraw); NPCs' improved items (TODO(M11): the leveled lists' and merchants' tempered goods).
 */
export interface EquipmentModifiers {
  /** A worn piece's multiplier by perks (1: none). */
  armorPerks(actor: number, armor: ItemRecord): Promise<number>;
  /** A weapon's perk effects (the 1 + perk effects factor; 1: none). */
  weaponPerks(actor: number, weapon: ItemRecord): Promise<number>;
  /** How far an item is improved (0 none, 1 Fine .. 6 Legendary). */
  temperLevel(actor: number, item: number): number;
}

/** An actor's armor now. */
export interface ArmorRatingNow {
  /** The rating the inventory shows: its pieces' and its armor effects' (DamageResist). */
  readonly rating: number;
  /** Pieces of armor worn (light and heavy armor and shields: not clothing or jewelry). */
  readonly pieces: number;
  /** The share of physical damage it takes off (0..fMaxArmorRating / 100). */
  readonly reduction: number;
}

/** What a hand holds as a weapon, for combat (5.1, 5.2) and the menus. */
export interface WeaponStats {
  /** The weapon (undefined: unarmed, the race's unarmed damage). */
  readonly weapon: number | undefined;
  readonly hand: Hand;
  /** WeaponType (hand to hand when unarmed). */
  readonly weaponType: number;
  /** Its damage as the menus show it, with the actor's skill, perks and improvements. */
  readonly damage: number;
  /** A bow's or crossbow's shot: its damage and its ammunition's, by the same multipliers. */
  readonly shotDamage: number;
  readonly baseDamage: number;
  readonly speed: number;
  readonly reach: number;
  readonly stagger: number;
  readonly critDamage: number;
  readonly critMult: number;
  /** The skill it uses (an actor value index; -1 none). */
  readonly skill: number;
  readonly ammo: number | undefined;
  readonly ammoDamage: number;
  /** Its world model (meshes\ path) and first-person model (a STAT). */
  readonly model: string | undefined;
  readonly firstPersonModel: number | undefined;
  /** Where it hangs sheathed and drawn. */
  readonly nodes: WeaponNodes;
  /** A bound weapon (WEAP Flags2). */
  readonly bound: boolean;
}

/** A change to an actor's equipment, for those listening (combat's drawn weapons). */
export interface EquipmentChange {
  readonly actor: number;
  readonly equipped: readonly number[];
  readonly unequipped: readonly number[];
  /** What it wears changed (its look is made again). */
  readonly worn: boolean;
}

/** An outfit's leveled lists nest; vanilla's are a few levels deep. */
const MAX_DEPTH = 8;

/** The seed of an actor's outfit picks: the same as its look's (src/world/actors.ts). */
const OUTFIT_SEED = 0x5bd1e995;

/** The actor values of the skills' fortifications by items and potions (UESP: Fortify Skill). */
const SKILL_MOD = actorValueIndex('OneHandedMod') ?? 0;
const SKILL_POWER_MOD = actorValueIndex('OneHandedPowerMod') ?? 0;
const DAMAGE_RESIST = actorValueIndex('DamageResist') ?? 0;

/** The settings armor and weapon stats read. */
const SETTINGS = [
  'fArmorScalingFactor',
  'fArmorBaseFactor',
  'fMaxArmorRating',
  'fArmorRatingBase',
  'fArmorRatingMax',
  'fArmorRatingPCMax',
  'fDamagePCSkillMin',
  'fDamagePCSkillMax',
  'fDamageSkillMin',
  'fDamageSkillMax',
] as const;

/** The mirror an actor's equipment keeps for readers of a set. */
const mirror = (equipped: ReadonlySet<number>): Set<number> => equipped as Set<number>;

export class EquipmentEngine {
  readonly #runtime: ScriptRuntime;
  /** Every form the system has read, as it sees it (the rules read them synchronously). */
  readonly #described = new Map<number, Equippable | undefined>();
  readonly #items = new Map<number, ItemRecord | undefined>();
  readonly #races = new Map<
    number,
    Promise<{ slots: ReadonlySet<OwnSlot>; equipment: number } | undefined>
  >();
  #slots: Promise<EquipSlots> | undefined;
  #settings: Promise<{ armor: ArmorSettings; weapon: WeaponSettings }> | undefined;
  readonly #describe = (formId: number): Equippable | undefined => this.#described.get(formId);
  /** Listeners to every change (combat's drawn weapons). */
  readonly listeners = new Set<(change: EquipmentChange) => void>();
  /** What perks and smithing add (the player's improvements: GameState.itemHealth). */
  modifiers: EquipmentModifiers;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    this.modifiers = {
      armorPerks: () => Promise.resolve(1),
      weaponPerks: () => Promise.resolve(1),
      // TODO(M11): per item (ExtraHealth), not per base: GameState.itemHealth.
      temperLevel: (actor, item) =>
        actor === PLAYER_REF ? temperLevelOfHealth(runtime.state.itemHealth.get(item) ?? 1) : 0,
    };
  }

  // --- What the system reads ------------------------------------------------------------------

  /** The load order's equip slots (EQUP) and the engine's own (the default objects). */
  slots(): Promise<EquipSlots> {
    this.#slots ??= (async () => {
      const db = this.#runtime.forms.db;
      const defaults = await DefaultObjects.read(db);
      const records = [];
      for (const formId of db.formIdsOfType('EQUP')) {
        const record = await this.#runtime.forms.record(formId);
        if (record && !record.deleted) records.push(parseEquipSlot(record));
      }
      return new EquipSlots(records, {
        left: defaults.get(EquipSlotUse.leftHand),
        right: defaults.get(EquipSlotUse.rightHand),
        voice: defaults.get(EquipSlotUse.voice),
        potion: defaults.get(EquipSlotUse.potion),
      });
    })();
    return this.#slots;
  }

  async #readSettings(): Promise<{ armor: ArmorSettings; weapon: WeaponSettings }> {
    this.#settings ??= (async () => {
      const values = new Map<string, number>();
      for (const name of SETTINGS) {
        const value = await this.#runtime.gameSetting(name);
        if (typeof value === 'number') values.set(name, value);
      }
      const read: ReadSetting = (name) => values.get(name);
      return { armor: armorSettings(read), weapon: weaponSettings(read) };
    })();
    return this.#settings;
  }

  /** An item's record as the item menus read it (undefined: not an item). */
  async item(formId: number): Promise<ItemRecord | undefined> {
    if (!this.#items.has(formId)) {
      const record = await this.#runtime.forms.record(formId);
      this.#items.set(formId, record ? parseItem(record) : undefined);
    }
    return this.#items.get(formId);
  }

  /** What a form is to the equip system: where it goes, its slots (undefined: not equippable). */
  async describe(formId: number): Promise<Equippable | undefined> {
    if (this.#described.has(formId)) return this.#described.get(formId);
    const record = await this.#runtime.forms.record(formId);
    const slots = await this.slots();
    let described: Equippable | undefined;
    const base = { formId, type: record?.type ?? '', slots: 0, anyHand: false, counted: true };
    switch (record?.type) {
      case 'WEAP': {
        const weapon = (await this.item(formId))?.weapon;
        const weaponType = weapon?.weaponType ?? WeaponType.handToHand;
        const place = slots.place(record.formIdField('ETYP')) ?? 'right';
        described = {
          ...base,
          place,
          weaponType,
          anyHand: place === 'either' || (place === 'right' && oneHanded(weaponType)),
        };
        break;
      }
      case 'ARMO': {
        const item = await this.item(formId);
        // A shield's slot (Shield: the left hand) and its biped slot; the rest by biped slots.
        const place = slots.place(item?.equipType);
        described = {
          ...base,
          place: place === 'left' || place === 'right' ? place : 'body',
          slots: item?.armor?.slots ?? 0,
        };
        break;
      }
      case 'AMMO':
        described = { ...base, place: 'ammo' };
        break;
      case 'LIGH':
        // A carried light is a torch: held in the left hand (CommonLibSSE: TESObjectLIGH's
        // own equip slot).
        described = (await this.item(formId)) ? { ...base, place: 'left' } : undefined;
        break;
      case 'SCRL': {
        const place = slots.place(record.formIdField('ETYP')) ?? 'either';
        described = { ...base, place, anyHand: place === 'either' };
        break;
      }
      case 'SPEL': {
        const spell = parseSpell(record);
        const castable =
          spell.spellType === SpellType.spell ||
          spell.spellType === SpellType.power ||
          spell.spellType === SpellType.lesserPower ||
          spell.spellType === SpellType.voice;
        // Spells name their hand (ETYP; the Creation Kit's default is EitherHand), powers the
        // voice; abilities, diseases and the like are not equipped.
        const place = castable ? (slots.place(spell.equipType) ?? 'either') : 'none';
        described = { ...base, place, anyHand: place === 'either', counted: false };
        break;
      }
      case 'SHOU':
        described = { ...base, place: 'voice', counted: false };
        break;
      case 'ALCH':
      case 'INGR':
        described = { ...base, place: 'potion' };
        break;
      default:
        described = undefined;
    }
    this.#described.set(formId, described);
    return described;
  }

  /** A race's places (RACE QNAM) and the equipment its members can use (VNAM). */
  #race(
    race: number | undefined,
  ): Promise<{ slots: ReadonlySet<OwnSlot>; equipment: number } | undefined> {
    if (race === undefined) return Promise.resolve(undefined);
    let pending = this.#races.get(race);
    if (!pending) {
      pending = (async () => {
        const record = await this.#runtime.forms.record(race);
        if (record?.type !== 'RACE') return undefined;
        const slots = await this.slots();
        return {
          slots: slots.ownSlots(raceEquipSlots(record)),
          equipment: parseRaceCombat(record).equipment,
        };
      })();
      this.#races.set(race, pending);
    }
    return pending;
  }

  async #actorRace(
    actor: number,
  ): Promise<{ slots: ReadonlySet<OwnSlot>; equipment: number } | undefined> {
    return this.#race(await this.#runtime.actors.raceOf(actor));
  }

  // --- An actor's equipment ---------------------------------------------------------------------

  /**
   * An actor's equipment, dressed from its records first if it has not been (its inventory is
   * read: src/scripting/runtime/runtime.ts calls initialize).
   */
  async of(actor: number): Promise<EquipmentState> {
    const state = this.#runtime.state.actor(actor).equipment;
    if (!state.ready) await this.#runtime.inventory(actor);
    return state;
  }

  /**
   * Dresses an actor from its records as its inventory (`items`) is first read: its outfit's
   * armor joins its items and is worn; an NPC then takes up what it carries that suits it best.
   * Quiet: no events (it was dressed so when it came into the game).
   */
  async initialize(actor: number, items: Map<number, number>): Promise<void> {
    const state = this.#runtime.state.actor(actor).equipment;
    if (state.ready) return;
    state.ready = true;
    const outfit = await this.#outfitNow(actor, false);
    await this.#putOn(actor, outfit, items, true);
    if (actor !== PLAYER_REF) await this.#takeUpBest(actor, items, true);
    this.#sync(actor);
  }

  /** The outfit an actor wears now: its own (Actor.SetOutfit), its base's, its record's. */
  async #outfitNow(actor: number, asleep: boolean): Promise<number | undefined> {
    const runtime = this.#runtime;
    const own = runtime.state.actors.get(actor);
    const info = await runtime.actors.info(actor);
    const bases = info ? [info.base, info.leveled] : [];
    const baseOutfit = (sleep: boolean): number | undefined => {
      for (const base of bases) {
        const set = runtime.state.actorBases.get(base);
        const outfit = sleep ? set?.sleepOutfit : set?.outfit;
        if (outfit !== undefined) return outfit;
      }
      return undefined;
    };
    if (asleep) {
      const sleep = own?.sleepOutfit ?? baseOutfit(true) ?? info?.inventory.sleepOutfit;
      if (sleep !== undefined) return sleep;
    }
    return own?.outfit ?? baseOutfit(false) ?? info?.inventory.outfit;
  }

  /** An outfit's armor (its leveled items picked at the actor's level), in order. */
  async #outfitPieces(actor: number, outfit: number | undefined): Promise<number[]> {
    const runtime = this.#runtime;
    const record = outfit === undefined ? undefined : await runtime.forms.record(outfit);
    if (record?.type !== 'OTFT') return [];
    const level = await runtime.actors.level(actor);
    const random = seededRandom(actor ^ OUTFIT_SEED);
    const pieces: number[] = [];
    const add = async (item: number, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      const entry = await runtime.forms.record(item);
      if (entry?.type === 'ARMO') {
        pieces.push(item);
      } else if (entry?.type === 'LVLI') {
        const list = await runtime.leveledList(item);
        if (!list) return;
        if ((list.flags & LeveledFlag.useAll) !== 0) {
          for (const e of list.entries) if (e.level <= level) await add(e.formId, depth + 1);
        } else {
          const picked = pickLeveled(list, level, random);
          if (picked !== undefined) await add(picked, depth + 1);
        }
      }
    };
    for (const item of parseOutfit(record)) await add(item, 0);
    return pieces;
  }

  /** Puts an outfit on: its pieces join the actor's items (as the outfit's) and are worn. */
  async #putOn(
    actor: number,
    outfit: number | undefined,
    items: Map<number, number>,
    quiet: boolean,
  ): Promise<void> {
    const state = this.#runtime.state.actor(actor).equipment;
    state.outfit = outfit;
    for (const piece of await this.#outfitPieces(actor, outfit)) {
      items.set(piece, (items.get(piece) ?? 0) + 1);
      state.outfitItems.set(piece, (state.outfitItems.get(piece) ?? 0) + 1);
      await this.#apply(actor, piece, {}, quiet);
    }
  }

  /**
   * An NPC takes up what it carries that suits it best: armor better than what covers the same
   * slots (or for free slots), a weapon of the kinds its race can use (melee first, one-handed
   * beside a shield it has; else a bow or crossbow; else a staff), the one that does the most
   * damage with its skill, a shield beside a one-handed weapon, the best ammunition for its bow
   * or crossbow. Items scripts locked stay, items it must not equip are left. TODO(M13): the
   * engine's own choice is undocumented (UESP, followers: they wear what has a higher rating
   * than what they wear in its slots); combat chooses by its combat style (TODO(M10) 5.2).
   */
  async #takeUpBest(actor: number, items: Map<number, number>, quiet: boolean): Promise<void> {
    const state = this.#runtime.state.actor(actor).equipment;
    const race = await this.#actorRace(actor);
    const equipment = race?.equipment ?? -1;
    const carried: { item: Equippable; record: ItemRecord }[] = [];
    for (const [formId, count] of items) {
      if (count <= 0 || state.prevented.has(formId)) continue;
      const item = await this.describe(formId);
      const record = item && (await this.item(formId));
      if (item && record && raceCanUse(equipment, item)) carried.push({ item, record });
    }
    // Armor, the best first.
    const armor = carried
      .filter(({ item }) => item.type === 'ARMO' && item.place === 'body')
      .sort((a, b) => (b.record.armor?.rating ?? 0) - (a.record.armor?.rating ?? 0));
    for (const { item, record } of armor) {
      if (holds(state, item.formId)) continue;
      const covered = state.worn.filter(
        (other) => ((this.#describe(other)?.slots ?? 0) & item.slots) !== 0,
      );
      if (covered.some((other) => state.locked.has(other))) continue;
      let rating = 0;
      for (const other of covered) rating += (await this.item(other))?.armor?.rating ?? 0;
      if (covered.length === 0 || (record.armor?.rating ?? 0) > rating)
        await this.#apply(actor, item.formId, {}, quiet);
    }
    // Its weapon: a melee weapon (one-handed beside a shield it has), else a bow or crossbow,
    // else a staff; of those, the one that does the most damage with its skill.
    const hands = (slot: OwnSlot): boolean => race?.slots.has(slot) ?? true;
    const locked = (hand: Hand): boolean => {
      const held = state[hand];
      return held !== undefined && state.locked.has(held);
    };
    const canShield = hands('left') && !locked('left') && (equipment & EquipmentFlag.shield) !== 0;
    const shields = carried
      .filter(({ item }) => item.type === 'ARMO' && item.place === 'left')
      .sort((a, b) => (b.record.armor?.rating ?? 0) - (a.record.armor?.rating ?? 0));
    const shielded =
      (state.left !== undefined && this.#describe(state.left)?.type === 'ARMO') ||
      (canShield && shields.length > 0);
    if (!locked('right') && hands('right')) {
      const weapons = carried.filter(
        ({ item, record }) =>
          item.type === 'WEAP' &&
          record.weapon !== undefined &&
          (item.place !== 'both' || (hands('left') && !locked('left'))),
      );
      const type = (entry: (typeof weapons)[number]): number => entry.item.weaponType ?? 0;
      const melee = weapons.filter((entry) => type(entry) <= WeaponType.twoHandAxe);
      const oneHandedMelee = melee.filter((entry) => entry.item.place !== 'both');
      const ranged = weapons.filter(
        (entry) => type(entry) === WeaponType.bow || type(entry) === WeaponType.crossbow,
      );
      const staves = weapons.filter((entry) => type(entry) === WeaponType.staff);
      const pool = [
        shielded && oneHandedMelee.length > 0 ? oneHandedMelee : melee,
        ranged,
        staves,
      ].find((list) => list.length > 0);
      let best: { formId: number; damage: number } | undefined;
      for (const { item } of pool ?? []) {
        const damage = await this.weaponDamage(actor, item.formId);
        if (!best || damage > best.damage) best = { formId: item.formId, damage };
      }
      if (best && state.right !== best.formId)
        await this.#apply(actor, best.formId, { hand: 'right' }, quiet);
    }
    // A shield beside a one-handed weapon (or none), if its race can hold one.
    const right = state.right === undefined ? undefined : this.#describe(state.right);
    const shield = shields[0];
    if (right?.place !== 'both' && state.left === undefined && canShield && shield)
      await this.#apply(actor, shield.item.formId, {}, quiet);
    // Ammunition for a bow (arrows: non-bolts) or a crossbow (bolts).
    const weaponType = right?.type === 'WEAP' ? right.weaponType : undefined;
    if (weaponType === WeaponType.bow || weaponType === WeaponType.crossbow) {
      const arrows = weaponType === WeaponType.bow;
      const ammo = carried
        .filter(
          ({ item, record }) =>
            item.place === 'ammo' &&
            (((record.ammoFlags ?? 0) & AmmoFlag.nonBolt) !== 0) === arrows,
        )
        .sort((a, b) => (b.record.ammoDamage ?? 0) - (a.record.ammoDamage ?? 0));
      const best = ammo[0];
      if (best && state.ammo !== best.item.formId)
        await this.#apply(actor, best.item.formId, {}, quiet);
    }
  }

  /**
   * Equips a form on an actor by the rules (no checks of what it has): changes, mirrors and
   * (unless quiet) tells the scripts, the world and the listeners. Returns whether it is
   * equipped now.
   */
  async #apply(
    actor: number,
    formId: number,
    request: EquipRequest,
    quiet = false,
  ): Promise<boolean> {
    const item = await this.describe(formId);
    if (!item) return false;
    const state = this.#runtime.state.actor(actor).equipment;
    for (const held of loadoutForms(state)) await this.describe(held);
    const race = await this.#actorRace(actor);
    const count = item.counted ? await this.#runtime.itemCount(actor, formId) : 2;
    const wornBefore = [...state.worn];
    const wasHeld = { left: state.left, right: state.right, voice: state.voice, ammo: state.ammo };
    const result = equipItem(
      state,
      item,
      { ...(request.hand && { hand: request.hand }), count, ...(race && { slots: race.slots }) },
      this.#describe,
    );
    if (!result.equipped) return false;
    if (request.preventRemoval) state.locked.add(formId);
    state.prevented.delete(formId);
    for (const removed of result.removed) state.locked.delete(removed);
    this.#sync(actor);
    const changed =
      result.removed.length > 0 ||
      wasHeld.left !== state.left ||
      wasHeld.right !== state.right ||
      wasHeld.voice !== state.voice ||
      wasHeld.ammo !== state.ammo ||
      wornBefore.length !== state.worn.length;
    if (!quiet && changed) {
      const worn =
        wornBefore.length !== state.worn.length ||
        wornBefore.some((form) => !state.worn.includes(form));
      await this.#tell(actor, [formId], result.removed, worn);
    }
    return true;
  }

  /** The mirror of an actor's equipment (ActorState.equipped). */
  #sync(actor: number): void {
    const own = this.#runtime.state.actor(actor);
    const set = mirror(own.equipped);
    set.clear();
    for (const form of loadoutForms(own.equipment)) set.add(form);
  }

  /**
   * Tells what changed: the world (what it wears: its look is made again), the listeners, the
   * actor's scripts (OnObjectUnequipped, then OnObjectEquipped: akBaseObject, akReference None)
   * and the items' own (OnUnequipped, OnEquipped with the actor). TODO(M13): items in an
   * inventory run one script instance per base (the game: per item, ExtraDataList).
   */
  async #tell(
    actor: number,
    equipped: readonly number[],
    unequipped: readonly number[],
    worn: boolean,
  ): Promise<void> {
    const runtime = this.#runtime;
    if (worn) runtime.world.equipmentChanged?.(actor);
    const change: EquipmentChange = { actor, equipped, unequipped, worn };
    for (const listener of this.listeners) listener(change);
    const self = runtime.actorHandle(actor);
    const send = async (form: number, actorEvent: string, itemEvent: string): Promise<void> => {
      const args: Value[] = [runtime.formHandle(form), null];
      await runtime.sendEvent(actor, actorEvent, args);
      const type = (await runtime.forms.record(form))?.type;
      if (type !== 'SPEL' && type !== 'SHOU' && (await runtime.forms.attachments(form)))
        await runtime.sendEvent(form, itemEvent, [self]);
    };
    for (const form of unequipped) await send(form, 'OnObjectUnequipped', 'OnUnequipped');
    for (const form of equipped) await send(form, 'OnObjectEquipped', 'OnEquipped');
  }

  // --- Equipping -------------------------------------------------------------------------------

  /**
   * Equips a form on an actor (EquipItem, the menus): an item it does not have is given to it
   * first (Creation Kit: EquipItem adds it); a spell or shout goes by EquipSpell's rules.
   * Potions, food and ingredients are used (use). Returns whether it is equipped now.
   */
  async equip(actor: number, formId: number, request: EquipRequest = {}): Promise<boolean> {
    const runtime = this.#runtime;
    await this.of(actor);
    const item = await this.describe(formId);
    if (!item || item.place === 'none') return false;
    if (item.place === 'potion') return this.use(actor, formId);
    if (item.counted && (await runtime.itemCount(actor, formId)) <= 0)
      await runtime.addItem(actor, runtime.formHandle(formId), 1, request.silent ?? true);
    return this.#apply(actor, formId, request);
  }

  /**
   * Takes a form off an actor (UnequipItem, the menus): from one hand, or from everywhere.
   * The player cannot take off in a menu what a script equipped to stay. Returns whether it
   * was taken off.
   */
  async unequip(actor: number, formId: number, request: UnequipRequest = {}): Promise<boolean> {
    const state = await this.of(actor);
    if (request.byPlayer && state.locked.has(formId)) return false;
    for (const held of loadoutForms(state)) await this.describe(held);
    const wornBefore = state.worn.includes(formId);
    if (!unequipItem(state, formId, this.#describe, request.hand)) return false;
    if (!holds(state, formId)) {
      state.locked.delete(formId);
      if (request.preventEquip) state.prevented.add(formId);
    }
    this.#sync(actor);
    await this.#tell(actor, [], [formId], wornBefore && !state.worn.includes(formId));
    return true;
  }

  /**
   * The menus' choice (the inventory's, the magic menu's, the favorites'): what the hand asked
   * for (else the item's place) holds already comes off; else it is equipped there.
   */
  async toggle(actor: number, formId: number, hand?: Hand): Promise<boolean> {
    const state = await this.of(actor);
    const item = await this.describe(formId);
    if (!item || item.place === 'none') return false;
    const off = (from?: Hand): Promise<boolean> =>
      this.unequip(actor, formId, { byPlayer: true, ...(from && { hand: from }) });
    switch (item.place) {
      case 'potion':
        return this.use(actor, formId);
      case 'body':
      case 'ammo':
      case 'voice':
        return holds(state, formId) ? off() : this.equip(actor, formId);
      case 'both':
        return state.right === formId ? off() : this.equip(actor, formId);
      default: {
        const target: Hand =
          item.place === 'left'
            ? 'left'
            : item.place === 'right' && !item.anyHand
              ? 'right'
              : (hand ?? 'right');
        if (state[target] === formId) return off(target);
        return this.equip(actor, formId, { hand: target });
      }
    }
  }

  /** EquipShout: a shout to the voice. */
  async equipShout(actor: number, shout: number): Promise<boolean> {
    if ((await this.describe(shout))?.type !== 'SHOU') return false;
    await this.of(actor);
    return this.#apply(actor, shout, {});
  }

  /** UnequipAll: every item comes off (spells and shouts stay), locked or not. */
  async unequipAll(actor: number): Promise<void> {
    const state = await this.of(actor);
    for (const form of loadoutForms(state)) {
      const item = await this.describe(form);
      if (item?.counted) await this.unequip(actor, form);
    }
  }

  /** UnequipItemSlot: what is worn over a biped slot (30..61) comes off. */
  async unequipSlot(actor: number, slot: number): Promise<void> {
    const worn = await this.armorInSlot(actor, slot);
    if (worn !== undefined) await this.unequip(actor, worn);
  }

  /**
   * EquipSpell: a spell to a hand (source 0 left, 1 right; 2 the voice: a power) or both (a
   * two-handed spell); a shout goes to the voice.
   */
  async equipSpell(actor: number, spell: number, source: number): Promise<boolean> {
    const item = await this.describe(spell);
    if (!item || item.counted) return false;
    const hand: Hand | undefined = source === 0 ? 'left' : source === 1 ? 'right' : undefined;
    if (source === 2 && item.place !== 'voice') return false;
    await this.of(actor);
    return this.#apply(actor, spell, { ...(hand && { hand }) });
  }

  /** UnequipSpell: from the hand (0 left, 1 right) or the voice (2). */
  async unequipSpell(actor: number, spell: number, source: number): Promise<boolean> {
    const state = await this.of(actor);
    if (source === 2) return state.voice === spell && this.unequip(actor, spell);
    const hand: Hand = source === 0 ? 'left' : 'right';
    return state[hand] === spell && this.unequip(actor, spell, { hand });
  }

  /**
   * Uses an item of the potion slot (a potion, food, an ingredient): one is used up, the
   * actor's scripts hear OnObjectEquipped and the item's OnEquipped, and its effects are cast
   * on the actor (the magic system: WorldBridge.castSpell). An ingredient eaten shows the
   * player its first effect (UESP: "Skyrim:Ingredients").
   */
  async use(actor: number, formId: number): Promise<boolean> {
    const runtime = this.#runtime;
    if ((await this.describe(formId))?.place !== 'potion') return false;
    if ((await runtime.itemCount(actor, formId)) <= 0) return false;
    await runtime.removeItem(actor, runtime.formHandle(formId), 1, true, undefined);
    if (actor === PLAYER_REF && (await runtime.forms.record(formId))?.type === 'INGR') {
      const known = new Set(runtime.state.ingredientEffects.get(formId) ?? []);
      known.add(0);
      runtime.state.ingredientEffects.set(formId, known);
    }
    await this.#tell(actor, [formId], [], false);
    // Its effects on the actor (the magic system; the world shows the casting: castSpell).
    await runtime.magic.consumed(actor, formId);
    return true;
  }

  /**
   * An actor used an item that is not kept equipped (a book read from its inventory): its
   * scripts hear it as equipped (OnObjectEquipped; the item's OnEquipped).
   */
  async used(actor: number, formId: number): Promise<void> {
    await this.#tell(actor, [formId], [], false);
  }

  /** The sound of using a potion or food (ALCH ENIT: Sound - Consume), if it has one. */
  async consumeSound(formId: number): Promise<number | undefined> {
    const record = await this.#runtime.forms.record(formId);
    const enit = record?.type === 'ALCH' ? record.fields.first('ENIT') : undefined;
    const sound = enit && enit.length >= 20 ? record?.formIdAt(enit, 16) : undefined;
    return sound === 0 ? undefined : sound;
  }

  /**
   * The sound of equipping or taking off an item: a weapon's own (WEAP NAM9 / NAM8), else its
   * pick-up or put-down sound (TODO(M13): what the engine plays for armor is undocumented).
   */
  async equipSound(
    formId: number,
    on: boolean,
    defaults: { get(use: string): number | undefined },
  ): Promise<number | undefined> {
    const item = await this.item(formId);
    if (!item) return undefined;
    const own = on ? item.weapon?.equipSound : item.weapon?.unequipSound;
    if (own !== undefined) return own;
    const kind =
      item.type === 'WEAP' || item.type === 'AMMO' ? 'W' : item.type === 'ARMO' ? 'A' : 'G';
    const sound = on ? item.pickUpSound : item.putDownSound;
    return sound ?? defaults.get(`${on ? 'PUS' : 'PDS'}${kind}`);
  }

  // --- What happens to an actor's items --------------------------------------------------------

  /**
   * Items left an actor's inventory (dropped, sold, taken, removed by a script): what it no
   * longer has enough of comes off (a counted item in both hands needs two), and the outfit's
   * share of them shrinks.
   */
  async itemsLeft(actor: number, formId: number): Promise<void> {
    const own = this.#runtime.state.actors.get(actor);
    const state = own?.equipment;
    if (!state?.ready) return;
    const count = await this.#runtime.itemCount(actor, formId);
    const outfit = state.outfitItems.get(formId);
    if (outfit !== undefined) {
      if (count <= 0) state.outfitItems.delete(formId);
      else state.outfitItems.set(formId, Math.min(outfit, count));
    }
    if (!holds(state, formId)) return;
    const item = await this.describe(formId);
    if (!item?.counted) return;
    if (count <= 0) {
      await this.unequip(actor, formId);
    } else if (
      count < 2 &&
      state.left === formId &&
      state.right === formId &&
      item.place !== 'both'
    ) {
      await this.unequip(actor, formId, { hand: 'left' });
    }
  }

  /**
   * Items joined an NPC's inventory (given, traded, added by a script): it takes up what suits it
   * better (as when it was dressed). The player equips by hand.
   */
  async itemsGiven(actor: number, formId: number): Promise<void> {
    if (actor === PLAYER_REF) return;
    const state = this.#runtime.state.actors.get(actor)?.equipment;
    if (!state?.ready) return;
    const item = await this.describe(formId);
    if (!item?.counted || item.place === 'potion') return;
    if (!(await this.#runtime.actors.isActor(actor))) return;
    if (await this.#runtime.actors.isDead(actor)) return;
    await this.#takeUpBest(actor, await this.#runtime.inventory(actor), false);
  }

  /**
   * An actor's outfit changed (Actor.SetOutfit; ActorBase.SetOutfit for those of its base), or
   * it went to sleep or woke (its sleep outfit): what came with the old outfit leaves its
   * inventory and the new one's pieces are worn (Creation Kit: SetOutfit).
   */
  async outfitChanged(actor: number): Promise<void> {
    const state = this.#runtime.state.actor(actor).equipment;
    if (!state.ready) {
      await this.of(actor);
      return;
    }
    const outfit = await this.#outfitNow(actor, state.asleep);
    if (outfit === state.outfit) return;
    const runtime = this.#runtime;
    const items = await runtime.inventory(actor);
    for (const [piece, count] of [...state.outfitItems]) {
      state.outfitItems.delete(piece);
      const have = items.get(piece) ?? 0;
      items.set(piece, Math.max(0, have - count));
      if ((items.get(piece) ?? 0) <= 0 && holds(state, piece)) await this.unequip(actor, piece);
    }
    await this.#putOn(actor, outfit, items, false);
  }

  /** ActorBase.SetOutfit: the actors of that base dressed so far change. */
  async baseOutfitChanged(base: number): Promise<void> {
    for (const [actor, own] of this.#runtime.state.actors) {
      if (!own.equipment.ready || own.outfit !== undefined) continue;
      const info = await this.#runtime.actors.info(actor);
      if (info && (info.base === base || info.leveled === base)) await this.outfitChanged(actor);
    }
  }

  /** An actor sleeps or wakes (its AI): it wears its sleep outfit, if it has one, meanwhile. */
  async sleep(actor: number, asleep: boolean): Promise<void> {
    const state = await this.of(actor);
    if (state.asleep === asleep) return;
    state.asleep = asleep;
    await this.outfitChanged(actor);
  }

  // --- What an actor holds and wears ----------------------------------------------------------

  /** Whether an actor has a form equipped (a form list: any of its forms). */
  async isEquipped(actor: number, formId: number): Promise<boolean> {
    const state = await this.of(actor);
    const record = await this.#runtime.forms.record(formId);
    if (record?.type === 'FLST')
      return (await this.#runtime.formList(formId)).some((form) => holds(state, form));
    return holds(state, formId);
  }

  /** What a hand holds (a weapon, a spell, a scroll, a shield, a torch). */
  async inHand(actor: number, hand: Hand): Promise<number | undefined> {
    return (await this.of(actor))[hand];
  }

  /** GetEquippedWeapon: the weapon in a hand. */
  async weapon(actor: number, hand: Hand): Promise<number | undefined> {
    const held = await this.inHand(actor, hand);
    return held !== undefined && (await this.describe(held))?.type === 'WEAP' ? held : undefined;
  }

  /** GetEquippedShield: the shield in the left hand. */
  async shield(actor: number): Promise<number | undefined> {
    const held = await this.inHand(actor, 'left');
    return held !== undefined && (await this.describe(held))?.type === 'ARMO' ? held : undefined;
  }

  /** The torch in the left hand. */
  async torch(actor: number): Promise<number | undefined> {
    const held = await this.inHand(actor, 'left');
    return held !== undefined && (await this.describe(held))?.type === 'LIGH' ? held : undefined;
  }

  /** GetEquippedSpell: 0 the left hand's, 1 the right's, 2 the voice's (a power). */
  async spell(actor: number, source: number): Promise<number | undefined> {
    const state = await this.of(actor);
    const held =
      source === 0
        ? state.left
        : source === 1
          ? state.right
          : source === 2
            ? state.voice
            : undefined;
    return held !== undefined && (await this.describe(held))?.type === 'SPEL' ? held : undefined;
  }

  /** GetEquippedShout: the shout in its voice. */
  async shout(actor: number): Promise<number | undefined> {
    const voice = (await this.of(actor)).voice;
    return voice !== undefined && (await this.describe(voice))?.type === 'SHOU' ? voice : undefined;
  }

  async ammo(actor: number): Promise<number | undefined> {
    return (await this.of(actor)).ammo;
  }

  /** The armor and clothing it wears (a shield too), in the order put on. */
  async worn(actor: number): Promise<number[]> {
    return [...(await this.of(actor)).worn];
  }

  /** What it wears over any of the biped slots of a mask (GetWornForm). */
  async wornInMask(actor: number, mask: number): Promise<number | undefined> {
    const state = await this.of(actor);
    for (const form of state.worn) {
      if (((await this.describe(form))?.slots ?? 0) & mask) return form;
    }
    return undefined;
  }

  /** GetEquippedArmorInSlot: what it wears over a biped slot (30..61). */
  armorInSlot(actor: number, slot: number): Promise<number | undefined> {
    if (slot < 30 || slot > 61) return Promise.resolve(undefined);
    return this.wornInMask(actor, slotBit(slot));
  }

  /** GetEquippedItemType: the type of what a hand holds (EquippedItemType). */
  async itemType(actor: number, hand: Hand): Promise<number> {
    const held = await this.inHand(actor, hand);
    return equippedItemType(held === undefined ? undefined : await this.describe(held));
  }

  /** The item and magic menus' equip state of a form (MenuEquipState). */
  async menuState(actor: number, formId: number): Promise<number> {
    return menuEquipState(await this.of(actor), formId);
  }

  // --- Stats ------------------------------------------------------------------------------------

  /** The current value of an actor value. */
  async #value(actor: number, index: number): Promise<number> {
    return (await this.#runtime.actors.value(actor, index)).current;
  }

  /** A skill with its fortifications (the skill's Mod and PowerMod actor values). */
  async #skill(actor: number, skill: number): Promise<number> {
    const offset = skill - ActorValue.firstSkill;
    const value = await this.#value(actor, skill);
    if (offset < 0 || offset >= 18) return value;
    const [mod, power] = await Promise.all([
      this.#value(actor, SKILL_MOD + offset),
      this.#value(actor, SKILL_POWER_MOD + offset),
    ]);
    return value + mod + power;
  }

  /**
   * A piece's armor rating for an actor (the menus' card, the rating's sum): its base and
   * improvement by the actor's Light or Heavy Armor skill (UESP "Skyrim:Armor"), times its perks.
   * Clothing and jewelry have none.
   */
  async pieceRating(actor: number, armor: number): Promise<number> {
    const item = await this.item(armor);
    if (!item?.armor) return 0;
    const skill = armorSkill(item);
    if (skill === undefined || item.armor.armorType === ArmorType.clothing)
      return item.armor.rating;
    const { armor: settings } = await this.#readSettings();
    const multiplier = armorSkillMultiplier(
      await this.#skill(actor, skill),
      actor === PLAYER_REF,
      settings,
    );
    const chest = (item.armor.slots & slotBit(BipedSlot.body)) !== 0;
    return armorPieceRating(
      item.armor.rating,
      this.modifiers.temperLevel(actor, armor),
      chest,
      multiplier,
      await this.modifiers.armorPerks(actor, item),
    );
  }

  /**
   * An actor's armor rating: its worn pieces' ratings and its armor effects (the DamageResist
   * actor value: Oakflesh, Stoneflesh, ...), the pieces of armor it wears, and the damage it
   * takes off (UESP "Skyrim:Armor").
   */
  async armorRating(actor: number): Promise<ArmorRatingNow> {
    const { armor: settings } = await this.#readSettings();
    let rating = 0;
    let pieces = 0;
    for (const form of await this.worn(actor)) {
      const item = await this.item(form);
      if (!item?.armor) continue;
      rating += await this.pieceRating(actor, form);
      if (item.armor.armorType !== ArmorType.clothing) pieces++;
    }
    rating += await this.#value(actor, DAMAGE_RESIST);
    return { rating, pieces, reduction: armorDamageReduction(rating, pieces, settings) };
  }

  /**
   * A weapon's damage for an actor (UESP "Skyrim:Weapons"): its base and improvement by the
   * actor's skill, its perks and its skill's fortifications by items (the skill's Mod actor
   * value, percent) and potions (PowerMod).
   */
  async weaponDamage(actor: number, weapon: number, extra = 0): Promise<number> {
    const item = await this.item(weapon);
    if (!item?.weapon) return 0;
    const { weapon: settings } = await this.#readSettings();
    const skill = item.weapon.skill;
    const value = skill >= 0 ? await this.#value(actor, skill) : 0;
    const offset = skill - ActorValue.firstSkill;
    const fortified =
      offset >= 0 && offset < 18
        ? (1 + (await this.#value(actor, SKILL_MOD + offset)) / 100) *
          (1 + (await this.#value(actor, SKILL_POWER_MOD + offset)) / 100)
        : 1;
    return weaponDamage(
      item.weapon.damage + extra,
      this.modifiers.temperLevel(actor, weapon),
      weaponSkillMultiplier(value, actor === PLAYER_REF, settings),
      (await this.modifiers.weaponPerks(actor, item)) * fortified,
    );
  }

  /** What a hand holds as a weapon: its stats, models and nodes (unarmed: the race's). */
  async weaponStats(actor: number, hand: Hand): Promise<WeaponStats> {
    const weapon = await this.weapon(actor, hand);
    const item = weapon === undefined ? undefined : await this.item(weapon);
    const ammo = await this.ammo(actor);
    const ammoItem = ammo === undefined ? undefined : await this.item(ammo);
    const data = item?.weapon;
    const weaponType = data?.weaponType ?? WeaponType.handToHand;
    const ranged = weaponType === WeaponType.bow || weaponType === WeaponType.crossbow;
    const ammoDamage = ranged ? (ammoItem?.ammoDamage ?? 0) : 0;
    const unarmed = await this.#value(actor, ActorValue.unarmedDamage);
    const damage = weapon === undefined ? unarmed : await this.weaponDamage(actor, weapon);
    return {
      weapon,
      hand,
      weaponType,
      damage,
      shotDamage:
        weapon !== undefined && ranged
          ? await this.weaponDamage(actor, weapon, ammoDamage)
          : damage,
      baseDamage: data?.damage ?? unarmed,
      speed: data?.speed ?? 1,
      reach: data?.reach ?? 1,
      stagger: data?.stagger ?? 0,
      critDamage: data?.critDamage ?? 0,
      critMult: data?.critMult ?? 1,
      skill: data?.skill ?? -1,
      ammo: ranged ? ammo : undefined,
      ammoDamage,
      model: item?.model === undefined ? undefined : meshPath(item.model),
      firstPersonModel: data?.firstPersonModel,
      // A two-handed weapon is the right hand's (its nodes too).
      nodes: weaponNodes(
        weaponType,
        weapon !== undefined && this.#describe(weapon)?.place === 'both' ? 'right' : hand,
      ),
      bound: ((data?.flags2 ?? 0) & WeaponFlag2.boundWeapon) !== 0,
    };
  }

  /**
   * The damage the inventory shows: the right hand's weapon (else the left's, else unarmed);
   * a bow's adds its arrows' base damage (UESP "Skyrim:Archery": the menu does not apply the
   * damage multipliers to the arrows').
   */
  async shownDamage(actor: number): Promise<number> {
    const right = await this.weapon(actor, 'right');
    const stats = await this.weaponStats(actor, right !== undefined ? 'right' : 'left');
    return stats.damage + stats.ammoDamage;
  }

  /** What an actor carries, in weight (its items' weights times their counts). */
  async carried(actor: number): Promise<number> {
    let total = 0;
    for (const [base, count] of await this.#runtime.inventory(actor)) {
      if (count <= 0) continue;
      total += ((await this.item(base))?.weight ?? 0) * count;
    }
    return total;
  }

  /** The most it can carry (the CarryWeight actor value). */
  carryWeight(actor: number): Promise<number> {
    return this.#value(actor, ActorValue.carryWeight);
  }

  /** IsOverEncumbered: it carries more than it can (no running, no fast travel). */
  async overEncumbered(actor: number): Promise<boolean> {
    const [carried, limit] = await Promise.all([this.carried(actor), this.carryWeight(actor)]);
    return overEncumbered(carried, limit);
  }
}
