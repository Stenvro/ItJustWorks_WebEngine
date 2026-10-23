// The equip system's rules: what an actor holds and wears (its loadout: the right and the left
// hand, the voice, the ammo, the armor and clothing worn), where an item goes as it is equipped
// (its equip slot, ETYP: src/world/equip-slots.ts; armor and clothing by their biped slots,
// BOD2), what equipping it takes off, and the stats of what is held and worn: armor rating and
// the damage it takes off, weapon damage, carry weight. The running game keeps each actor's
// loadout and fills it from the records (src/scripting/runtime/equipment-engine.ts).
// Platform-independent. Notes: docs/gameplay.md ("Equipment").

import { EquipmentFlag } from '../ai/race-combat-records.ts';
import type { OwnSlot, SlotPlace } from '../world/equip-slots.ts';
import { WeaponType } from '../world/item-records.ts';
import { temperingIncrease } from './crafting.ts';

export type Hand = 'left' | 'right';

/**
 * Where an item goes: a hand, either hand (one chosen), both hands, the voice, the potion slot
 * (it is used up: potions, food, ingredients), the ammo slot, the body (armor and clothing, by
 * their biped slots), or nowhere (it cannot be equipped).
 */
export type EquipPlace = SlotPlace | 'ammo' | 'body' | 'none';

/** What an item, spell or shout is to the equip system. */
export interface Equippable {
  readonly formId: number;
  /** Its record type (WEAP, ARMO, SPEL, SHOU, LIGH, ...). */
  readonly type: string;
  readonly place: EquipPlace;
  /** The biped slots it covers (BOD2: armor, clothing, a shield). */
  readonly slots: number;
  /**
   * The hand it goes in may be chosen: an either-hand item, and one-handed weapons and staves
   * (the game's menus put them in the hand asked for, though most name the right hand).
   */
  readonly anyHand: boolean;
  /** An item: holding it in both hands takes two of it (spells and shouts are not counted). */
  readonly counted: boolean;
  /** A weapon's animation type (WeaponType). */
  readonly weaponType?: number;
}

/** What an actor holds and wears. */
export interface Loadout {
  right: number | undefined;
  left: number | undefined;
  /** A shout or a power. */
  voice: number | undefined;
  ammo: number | undefined;
  /** Armor and clothing worn (a shield too), in the order put on. */
  readonly worn: number[];
}

export function emptyLoadout(): Loadout {
  return { right: undefined, left: undefined, voice: undefined, ammo: undefined, worn: [] };
}

/** What describes the forms a loadout holds (their slots, their places). */
export type Describe = (formId: number) => Equippable | undefined;

/** Every form a loadout holds. */
export function loadoutForms(loadout: Loadout): Set<number> {
  const forms = new Set<number>(loadout.worn);
  for (const form of [loadout.right, loadout.left, loadout.voice, loadout.ammo])
    if (form !== undefined) forms.add(form);
  return forms;
}

/** Whether a loadout holds a form anywhere. */
export function holds(loadout: Loadout, formId: number): boolean {
  return (
    loadout.right === formId ||
    loadout.left === formId ||
    loadout.voice === formId ||
    loadout.ammo === formId ||
    loadout.worn.includes(formId)
  );
}

/** Empties a hand: a two-handed item leaves both, a shield is no longer worn. */
function clearHand(loadout: Loadout, hand: Hand, describe: Describe): void {
  const held = loadout[hand];
  if (held === undefined) return;
  loadout[hand] = undefined;
  const item = describe(held);
  if (item?.place === 'both') {
    if (loadout.left === held) loadout.left = undefined;
    if (loadout.right === held) loadout.right = undefined;
  }
  if (item?.type === 'ARMO') removeWorn(loadout, held);
}

function removeWorn(loadout: Loadout, formId: number): void {
  const at = loadout.worn.indexOf(formId);
  if (at >= 0) loadout.worn.splice(at, 1);
}

/** Takes a form off wherever the loadout has it. */
function takeOff(loadout: Loadout, formId: number, describe: Describe): void {
  if (loadout.right === formId) clearHand(loadout, 'right', describe);
  if (loadout.left === formId) clearHand(loadout, 'left', describe);
  if (loadout.voice === formId) loadout.voice = undefined;
  if (loadout.ammo === formId) loadout.ammo = undefined;
  removeWorn(loadout, formId);
}

/** Puts on armor (or a shield's body part): what covers any of its biped slots comes off. */
function wear(loadout: Loadout, item: Equippable, describe: Describe): void {
  for (const other of [...loadout.worn]) {
    if (other === item.formId) continue;
    if (((describe(other)?.slots ?? 0) & item.slots) !== 0) takeOff(loadout, other, describe);
  }
  if (!loadout.worn.includes(item.formId)) loadout.worn.push(item.formId);
}

export interface EquipOptions {
  /** The hand asked for (the menus' left or right), for an item that may go in either. */
  readonly hand?: Hand;
  /** How many of it the actor has (a counted item in both hands takes two). */
  readonly count: number;
  /** The places the actor's race has (RACE QNAM); undefined: all of them. */
  readonly slots?: ReadonlySet<OwnSlot>;
}

export interface EquipResult {
  /** It is equipped now (false: it cannot be: no place for it, or its race lacks the place). */
  readonly equipped: boolean;
  /** Forms no longer held (taken off to make room), each once. */
  readonly removed: readonly number[];
}

/** The hands an item goes in, by its place and the hand asked for. */
function targetHands(item: Equippable, hand: Hand | undefined): Hand[] | undefined {
  switch (item.place) {
    case 'both':
      return ['right', 'left'];
    case 'left':
      return ['left'];
    case 'right':
      return [item.anyHand && hand ? hand : 'right'];
    case 'either':
      return [hand ?? 'right'];
    default:
      return undefined;
  }
}

/**
 * Equips an item on a loadout (changed in place): armor takes its biped slots (what covers any
 * of them comes off), a hand item its hands (what they held comes off: a two-handed item from
 * both; a counted item the actor has one of leaves the other hand), a shield the left hand and
 * its biped slot, a shout or power the voice, ammunition the ammo slot.
 */
export function equipItem(
  loadout: Loadout,
  item: Equippable,
  options: EquipOptions,
  describe: Describe,
): EquipResult {
  const before = loadoutForms(loadout);
  const result = (equipped: boolean): EquipResult => {
    const after = loadoutForms(loadout);
    return { equipped, removed: [...before].filter((form) => !after.has(form)) };
  };
  const has = (slot: OwnSlot): boolean => options.slots?.has(slot) ?? true;
  switch (item.place) {
    case 'body':
      wear(loadout, item, describe);
      return result(true);
    case 'ammo':
      if (loadout.ammo !== item.formId) {
        if (loadout.ammo !== undefined) takeOff(loadout, loadout.ammo, describe);
        loadout.ammo = item.formId;
      }
      return result(true);
    case 'voice':
      if (!has('voice')) return result(false);
      if (loadout.voice !== item.formId) loadout.voice = item.formId;
      return result(true);
    case 'potion':
    case 'none':
      return result(false);
    default:
      break;
  }
  let hands = targetHands(item, options.hand);
  if (!hands) return result(false);
  // A race without the hand asked for uses its other hand, if the item may go there.
  if (!hands.every(has)) {
    const other: Hand = hands[0] === 'left' ? 'right' : 'left';
    const flexible = item.place === 'either' || (item.place === 'right' && item.anyHand);
    if (hands.length === 1 && flexible && has(other)) hands = [other];
    else return result(false);
  }
  if (hands.every((hand) => loadout[hand] === item.formId)) return result(true);
  for (const hand of hands) if (loadout[hand] !== item.formId) clearHand(loadout, hand, describe);
  // A counted item the actor has too few of leaves the other hand.
  if (item.counted && item.place !== 'both') {
    const other: Hand = hands[0] === 'left' ? 'right' : 'left';
    if (!hands.includes(other) && loadout[other] === item.formId && options.count < 2)
      clearHand(loadout, other, describe);
  }
  for (const hand of hands) loadout[hand] = item.formId;
  if (item.slots !== 0) wear(loadout, item, describe);
  return result(true);
}

/**
 * Takes a form off a loadout (in place): from one hand when `hand` is given (a two-handed item
 * leaves both; the other hand may still hold the form), else from everywhere. Returns whether
 * anything came off.
 */
export function unequipItem(
  loadout: Loadout,
  formId: number,
  describe: Describe,
  hand?: Hand,
): boolean {
  if (hand === undefined) {
    if (!holds(loadout, formId)) return false;
    takeOff(loadout, formId, describe);
    return true;
  }
  if (loadout[hand] !== formId) return false;
  clearHand(loadout, hand, describe);
  return true;
}

/** The menus' equip states (the row's icon: InventoryDefines). */
export const MenuEquipState = { none: 0, equipped: 1, left: 2, right: 3, both: 4 } as const;

/**
 * A form's equip state as the item and magic menus show it: held in both hands (a two-handed
 * item, a spell in each hand), in the left or the right hand, else worn or equipped (armor,
 * ammo, the voice), else none.
 */
export function menuEquipState(loadout: Loadout, formId: number): number {
  const left = loadout.left === formId;
  const right = loadout.right === formId;
  if (left && right) return MenuEquipState.both;
  if (left) return loadout.worn.includes(formId) ? MenuEquipState.equipped : MenuEquipState.left;
  if (right) return MenuEquipState.right;
  return holds(loadout, formId) ? MenuEquipState.equipped : MenuEquipState.none;
}

/**
 * Actor.GetEquippedItemType's (and the condition's) codes for what a hand holds (Creation Kit,
 * "GetEquippedItemType - Actor"): 0 nothing (hand to hand), 1 sword, 2 dagger, 3 war axe, 4
 * mace, 5 greatsword, 6 battleaxe or warhammer, 7 bow, 8 staff, 9 a spell, 10 a shield, 11 a
 * torch, 12 a crossbow.
 */
export const EquippedItemType = {
  handToHand: 0,
  sword: 1,
  dagger: 2,
  axe: 3,
  mace: 4,
  greatsword: 5,
  battleaxe: 6,
  bow: 7,
  staff: 8,
  spell: 9,
  shield: 10,
  torch: 11,
  crossbow: 12,
} as const;

/** What a hand holding `item` (undefined: empty) counts as. */
export function equippedItemType(
  item: Pick<Equippable, 'type' | 'weaponType'> | undefined,
): number {
  switch (item?.type) {
    case 'WEAP': {
      const type = item.weaponType ?? WeaponType.handToHand;
      if (type === WeaponType.crossbow) return EquippedItemType.crossbow;
      return type >= WeaponType.oneHandSword && type <= WeaponType.staff ? type : 0;
    }
    case 'SPEL':
    case 'SCRL':
      return EquippedItemType.spell;
    case 'ARMO':
      return EquippedItemType.shield;
    case 'LIGH':
      return EquippedItemType.torch;
    default:
      return EquippedItemType.handToHand;
  }
}

/** One-handed weapons and staves: the menus put them in the hand asked for. */
export function oneHanded(weaponType: number): boolean {
  return (
    (weaponType >= WeaponType.oneHandSword && weaponType <= WeaponType.oneHandMace) ||
    weaponType === WeaponType.staff ||
    weaponType === WeaponType.handToHand
  );
}

/** The race's equipment flag (RACE VNAM) of a weapon type. */
const WEAPON_EQUIPMENT: Readonly<Record<number, number>> = {
  [WeaponType.handToHand]: EquipmentFlag.handToHandMelee,
  [WeaponType.oneHandSword]: EquipmentFlag.oneHandSword,
  [WeaponType.oneHandDagger]: EquipmentFlag.oneHandDagger,
  [WeaponType.oneHandAxe]: EquipmentFlag.oneHandAxe,
  [WeaponType.oneHandMace]: EquipmentFlag.oneHandMace,
  [WeaponType.twoHandSword]: EquipmentFlag.twoHandSword,
  [WeaponType.twoHandAxe]: EquipmentFlag.twoHandAxe,
  [WeaponType.bow]: EquipmentFlag.bow,
  [WeaponType.staff]: EquipmentFlag.staff,
  [WeaponType.crossbow]: EquipmentFlag.crossbow,
};

/**
 * Whether a race's members can use an item by its equipment flags (RACE VNAM: weapon types,
 * spells, shields, torches); armor and the rest are not limited so.
 */
export function raceCanUse(
  equipment: number,
  item: Pick<Equippable, 'type' | 'weaponType' | 'slots'>,
): boolean {
  switch (item.type) {
    case 'WEAP':
      return (equipment & (WEAPON_EQUIPMENT[item.weaponType ?? 0] ?? 0)) !== 0;
    case 'SPEL':
    case 'SCRL':
      return (equipment & EquipmentFlag.spell) !== 0;
    case 'LIGH':
      return (equipment & EquipmentFlag.torch) !== 0;
    default:
      return true;
  }
}

/** Where a weapon hangs while sheathed and held while drawn (skeleton nodes). */
export interface WeaponNodes {
  /**
   * Sheathed: the node by its type, as the weapon models' "Prn" extra data name it (the model's
   * own "Prn" wins: a few greatswords hang at the hip); undefined: the skeleton has none for it
   * (staves: vanilla's skeleton has no WeaponStaff node, so a sheathed staff is not shown).
   */
  readonly sheathed: string | undefined;
  /**
   * Drawn: WEAPON in the right hand, SHIELD in the left (shields and torches too), and a bow in
   * SHIELD whichever hand holds it (docs/animation.md, "Held weapons").
   */
  readonly drawn: string;
}

/** The sheath nodes by weapon type (the vanilla weapon models' "Prn"). */
const SHEATH_NODES: Readonly<Record<number, string>> = {
  [WeaponType.oneHandSword]: 'WeaponSword',
  [WeaponType.oneHandDagger]: 'WeaponDagger',
  [WeaponType.oneHandAxe]: 'WeaponAxe',
  [WeaponType.oneHandMace]: 'WeaponMace',
  [WeaponType.twoHandSword]: 'WeaponBack',
  [WeaponType.twoHandAxe]: 'WeaponBack',
  [WeaponType.bow]: 'WeaponBow',
  [WeaponType.staff]: 'WeaponStaff',
  [WeaponType.crossbow]: 'WeaponBow',
};

/** The skeleton nodes of a weapon held in a hand. */
export function weaponNodes(weaponType: number, hand: Hand): WeaponNodes {
  // The left hand's weapon is not shown sheathed (the vanilla skeleton has no left-hand sheath
  // nodes); drawn, it is in the left hand's SHIELD node. So is a bow (observed in the
  // original: the drawn node is SHIELD for the left hand or the bow type, else WEAPON): the bow
  // animations hold the bow in the left hand and carry the WEAPON bone to where the nocked arrow
  // lies, pointing along the shot (the arrow hangs on WEAPON). Crossbows stay on WEAPON.
  return {
    sheathed: hand === 'right' ? SHEATH_NODES[weaponType] : undefined,
    drawn: hand === 'left' || weaponType === WeaponType.bow ? 'SHIELD' : 'WEAPON',
  };
}

/** The node ammunition hangs on: arrows in the quiver (QUIVER). */
export const QUIVER_NODE = 'QUIVER';

// --- Stats ------------------------------------------------------------------------------------

/** A setting read from the load order (undefined: the engine's built-in value is used). */
export type ReadSetting = (name: string) => number | undefined;

/** The game settings of armor. */
export interface ArmorSettings {
  /** Damage taken off per point of armor rating, in percent (0.12). */
  readonly fArmorScalingFactor: number;
  /** Damage taken off per piece worn, as a fraction (0.03). */
  readonly fArmorBaseFactor: number;
  /** The most damage armor takes off, in percent (80). */
  readonly fMaxArmorRating: number;
  /** The rating multiplier at skill 0 (1), and at skill 100: NPCs' (2.5), the player's (1.4). */
  readonly fArmorRatingBase: number;
  readonly fArmorRatingMax: number;
  readonly fArmorRatingPCMax: number;
}

/** The vanilla values (Skyrim.esm sets all of them). */
export const VANILLA_ARMOR_SETTINGS: ArmorSettings = {
  fArmorScalingFactor: 0.12,
  fArmorBaseFactor: 0.03,
  fMaxArmorRating: 80,
  fArmorRatingBase: 1,
  fArmorRatingMax: 2.5,
  fArmorRatingPCMax: 1.4,
};

export function armorSettings(read: ReadSetting): ArmorSettings {
  const get = (name: keyof ArmorSettings): number => read(name) ?? VANILLA_ARMOR_SETTINGS[name];
  return {
    fArmorScalingFactor: get('fArmorScalingFactor'),
    fArmorBaseFactor: get('fArmorBaseFactor'),
    fMaxArmorRating: get('fMaxArmorRating'),
    fArmorRatingBase: get('fArmorRatingBase'),
    fArmorRatingMax: get('fArmorRatingMax'),
    fArmorRatingPCMax: get('fArmorRatingPCMax'),
  };
}

/**
 * The armor skill's multiplier: fArmorRatingBase at skill 0 up to fArmorRatingPCMax (the
 * player: 1 + 0.4 × skill / 100, UESP "Skyrim:Armor") or fArmorRatingMax (NPCs: 1 + 1.5 ×
 * skill / 100) at 100. `skill` is the Light or Heavy Armor skill with its fortifications.
 */
export function armorSkillMultiplier(skill: number, player: boolean, s: ArmorSettings): number {
  const max = player ? s.fArmorRatingPCMax : s.fArmorRatingMax;
  return s.fArmorRatingBase + ((max - s.fArmorRatingBase) * Math.max(0, skill)) / 100;
}

/** Rounding that forgives float error (3.0000001 is 3). */
const EPSILON = 1e-6;

/**
 * A piece's armor rating as the game shows it (UESP "Skyrim:Armor"): ceiling((base + item
 * quality) × the skill's multiplier) × `perks` (the unison, matching-set and armor perks:
 * Custom Fit or Well Fitted, Matching Set, Agile Defender or Juggernaut). Item quality is
 * what improving it added (src/gameplay/crafting.ts: temperingIncrease, unrounded; chest
 * armor gets the full increase, the rest half). Clothing has no rating.
 */
export function armorPieceRating(
  base: number,
  temperLevel: number,
  chest: boolean,
  skillMultiplier: number,
  perks = 1,
): number {
  const quality = temperingIncrease(temperLevel, chest);
  return Math.ceil((base + quality) * skillMultiplier - EPSILON) * perks;
}

/**
 * The share of physical damage armor takes off (0..1; UESP "Skyrim:Armor"): the rating ×
 * fArmorScalingFactor percent, plus fArmorBaseFactor for each piece worn (a hidden rating of 25
 * each), at most fMaxArmorRating percent.
 */
export function armorDamageReduction(rating: number, pieces: number, s: ArmorSettings): number {
  const percent = rating * s.fArmorScalingFactor + pieces * s.fArmorBaseFactor * 100;
  return Math.max(0, Math.min(s.fMaxArmorRating, percent)) / 100;
}

/** The game settings of weapon damage by skill. */
export interface WeaponSettings {
  /** The player's skill multiplier at skill 0 and 100 (UESP: 1 + skill / 200). */
  readonly fDamagePCSkillMin: number;
  readonly fDamagePCSkillMax: number;
  /** NPCs'. */
  readonly fDamageSkillMin: number;
  readonly fDamageSkillMax: number;
}

/**
 * The player's from UESP ("Skyrim:Weapons": 1 + skill / 200; Skyrim.esm sets
 * fDamagePCSkillMax 1.5). NPCs' are the engine's built-in fDamageSkillMin and fDamageSkillMax,
 * which no plugin sets and no source documents: TODO(M13) taken as the player's.
 */
export const VANILLA_WEAPON_SETTINGS: WeaponSettings = {
  fDamagePCSkillMin: 1,
  fDamagePCSkillMax: 1.5,
  fDamageSkillMin: 1,
  fDamageSkillMax: 1.5,
};

export function weaponSettings(read: ReadSetting): WeaponSettings {
  const get = (name: keyof WeaponSettings): number => read(name) ?? VANILLA_WEAPON_SETTINGS[name];
  const pcMin = get('fDamagePCSkillMin');
  const pcMax = get('fDamagePCSkillMax');
  return {
    fDamagePCSkillMin: pcMin,
    fDamagePCSkillMax: pcMax,
    fDamageSkillMin: read('fDamageSkillMin') ?? pcMin,
    fDamageSkillMax: read('fDamageSkillMax') ?? pcMax,
  };
}

/** A weapon skill's damage multiplier: min at skill 0 up to max at 100. */
export function weaponSkillMultiplier(skill: number, player: boolean, s: WeaponSettings): number {
  const min = player ? s.fDamagePCSkillMin : s.fDamageSkillMin;
  const max = player ? s.fDamagePCSkillMax : s.fDamageSkillMax;
  return min + ((max - min) * Math.max(0, skill)) / 100;
}

/**
 * A weapon's damage as the game shows it (UESP "Skyrim:Weapons"): round((base + smithing
 * increase) × the skill's multiplier × (1 + perk effects) × (1 + item effects) × (1 + potion
 * effect)); `multiplier` is the product of the last three. The smithing increase is the
 * unrounded tempering increase (half of armor's chest increase: temperingIncrease).
 */
export function weaponDamage(
  base: number,
  temperLevel: number,
  skillMultiplier: number,
  multiplier = 1,
): number {
  const quality = temperingIncrease(temperLevel, false);
  return Math.round((base + quality) * skillMultiplier * multiplier + EPSILON);
}

/** Whether what an actor carries is more than it can (it cannot run or fast travel then). */
export function overEncumbered(carried: number, carryWeight: number): boolean {
  return carried > carryWeight;
}
