import { describe, expect, it } from 'vitest';
import { EquipmentFlag } from '../ai/race-combat-records.ts';
import { WeaponType } from '../world/item-records.ts';
import {
  armorDamageReduction,
  armorPieceRating,
  armorSkillMultiplier,
  emptyLoadout,
  equipItem,
  equippedItemType,
  EquippedItemType,
  loadoutForms,
  menuEquipState,
  MenuEquipState,
  overEncumbered,
  raceCanUse,
  unequipItem,
  VANILLA_ARMOR_SETTINGS,
  VANILLA_WEAPON_SETTINGS,
  weaponDamage,
  weaponNodes,
  weaponSettings,
  weaponSkillMultiplier,
  type Equippable,
} from './equipment.ts';

const slot = (n: number): number => 2 ** (n - 30);
const items = new Map<number, Equippable>();
const item = (formId: number, rest: Partial<Equippable> & Pick<Equippable, 'type' | 'place'>) => {
  const made: Equippable = { formId, slots: 0, anyHand: false, counted: true, ...rest };
  items.set(formId, made);
  return made;
};
const describe_ = (formId: number) => items.get(formId);

const SWORD = item(1, { type: 'WEAP', place: 'right', anyHand: true, weaponType: 1 });
const DAGGER = item(2, { type: 'WEAP', place: 'right', anyHand: true, weaponType: 2 });
const BOW = item(3, { type: 'WEAP', place: 'both', weaponType: WeaponType.bow });
const SHIELD = item(4, { type: 'ARMO', place: 'left', slots: slot(39) });
const TORCH = item(5, { type: 'LIGH', place: 'left' });
const CUIRASS = item(6, { type: 'ARMO', place: 'body', slots: slot(32) });
const ROBES = item(7, { type: 'ARMO', place: 'body', slots: slot(32) | slot(37) });
const BOOTS = item(8, { type: 'ARMO', place: 'body', slots: slot(37) });
const FLAMES = item(9, { type: 'SPEL', place: 'either', anyHand: true, counted: false });
const SHOUT = item(10, { type: 'SHOU', place: 'voice', counted: false });
const ARROWS = item(11, { type: 'AMMO', place: 'ammo' });
const RITUAL = item(12, { type: 'SPEL', place: 'both', counted: false });
const HELD_RIGHT = item(13, { type: 'SPEL', place: 'right', counted: false });

describe('equipping', () => {
  it('puts armor on by its biped slots; what covers them comes off', () => {
    const loadout = emptyLoadout();
    equipItem(loadout, CUIRASS, { count: 1 }, describe_);
    equipItem(loadout, BOOTS, { count: 1 }, describe_);
    const robes = equipItem(loadout, ROBES, { count: 1 }, describe_);
    expect([...robes.removed].sort()).toEqual([CUIRASS.formId, BOOTS.formId]);
    expect(loadout.worn).toEqual([ROBES.formId]);
  });

  it('puts one-handed weapons in the hand asked for, the right by default', () => {
    const loadout = emptyLoadout();
    equipItem(loadout, SWORD, { count: 1 }, describe_);
    expect(loadout.right).toBe(SWORD.formId);
    equipItem(loadout, DAGGER, { count: 1, hand: 'left' }, describe_);
    expect(loadout.left).toBe(DAGGER.formId);
    expect(menuEquipState(loadout, DAGGER.formId)).toBe(MenuEquipState.left);
    expect(menuEquipState(loadout, SWORD.formId)).toBe(MenuEquipState.right);
  });

  it('moves a weapon the actor has one of to the other hand; two of it fill both', () => {
    const one = emptyLoadout();
    equipItem(one, SWORD, { count: 1 }, describe_);
    equipItem(one, SWORD, { count: 1, hand: 'left' }, describe_);
    expect([one.left, one.right]).toEqual([SWORD.formId, undefined]);
    const two = emptyLoadout();
    equipItem(two, SWORD, { count: 2 }, describe_);
    equipItem(two, SWORD, { count: 2, hand: 'left' }, describe_);
    expect(menuEquipState(two, SWORD.formId)).toBe(MenuEquipState.both);
  });

  it('gives a two-handed weapon both hands: the shield and the sword come off', () => {
    const loadout = emptyLoadout();
    equipItem(loadout, SWORD, { count: 1 }, describe_);
    equipItem(loadout, SHIELD, { count: 1 }, describe_);
    expect(loadout.worn).toEqual([SHIELD.formId]);
    const result = equipItem(loadout, BOW, { count: 1 }, describe_);
    expect([...result.removed].sort()).toEqual([SWORD.formId, SHIELD.formId]);
    expect([loadout.left, loadout.right, loadout.worn]).toEqual([BOW.formId, BOW.formId, []]);
    // A shield (or a torch) takes the two-handed weapon off again.
    equipItem(loadout, TORCH, { count: 1 }, describe_);
    expect([loadout.left, loadout.right]).toEqual([TORCH.formId, undefined]);
  });

  it('holds a spell in each hand (not counted), two-handed spells in both', () => {
    const loadout = emptyLoadout();
    equipItem(loadout, FLAMES, { count: 0, hand: 'left' }, describe_);
    equipItem(loadout, FLAMES, { count: 0, hand: 'right' }, describe_);
    expect(menuEquipState(loadout, FLAMES.formId)).toBe(MenuEquipState.both);
    equipItem(loadout, RITUAL, { count: 0 }, describe_);
    expect([loadout.left, loadout.right]).toEqual([RITUAL.formId, RITUAL.formId]);
    // A right-hand spell stays in the right hand whatever is asked.
    equipItem(loadout, HELD_RIGHT, { count: 0, hand: 'left' }, describe_);
    expect([loadout.left, loadout.right]).toEqual([undefined, HELD_RIGHT.formId]);
  });

  it('puts shouts in the voice, ammunition in its slot; a race without the place cannot', () => {
    const loadout = emptyLoadout();
    expect(equipItem(loadout, SHOUT, { count: 0 }, describe_).equipped).toBe(true);
    equipItem(loadout, ARROWS, { count: 20 }, describe_);
    expect([loadout.voice, loadout.ammo]).toEqual([SHOUT.formId, ARROWS.formId]);
    const wolf = emptyLoadout();
    const slots = new Set(['right'] as const);
    expect(equipItem(wolf, SHOUT, { count: 0, slots }, describe_).equipped).toBe(false);
    expect(equipItem(wolf, SHIELD, { count: 1, slots }, describe_).equipped).toBe(false);
    // A one-handed weapon asked for the missing hand goes in the one it has.
    equipItem(wolf, SWORD, { count: 1, slots, hand: 'left' }, describe_);
    expect(wolf.right).toBe(SWORD.formId);
  });

  it('takes off from one hand or everywhere', () => {
    const loadout = emptyLoadout();
    equipItem(loadout, FLAMES, { count: 0, hand: 'left' }, describe_);
    equipItem(loadout, FLAMES, { count: 0, hand: 'right' }, describe_);
    expect(unequipItem(loadout, FLAMES.formId, describe_, 'left')).toBe(true);
    expect([loadout.left, loadout.right]).toEqual([undefined, FLAMES.formId]);
    equipItem(loadout, SHIELD, { count: 1 }, describe_);
    expect(unequipItem(loadout, SHIELD.formId, describe_)).toBe(true);
    expect(loadout.worn).toEqual([]);
    expect(loadoutForms(loadout)).toEqual(new Set([FLAMES.formId]));
    expect(unequipItem(loadout, SHIELD.formId, describe_)).toBe(false);
  });
});

describe('what is held', () => {
  it("counts as Actor.GetEquippedItemType's codes", () => {
    expect(equippedItemType(undefined)).toBe(EquippedItemType.handToHand);
    expect(equippedItemType(SWORD)).toBe(EquippedItemType.sword);
    expect(equippedItemType(BOW)).toBe(EquippedItemType.bow);
    expect(equippedItemType({ type: 'WEAP', weaponType: WeaponType.crossbow })).toBe(12);
    expect(equippedItemType({ type: 'WEAP', weaponType: WeaponType.staff })).toBe(8);
    expect(equippedItemType(FLAMES)).toBe(EquippedItemType.spell);
    expect(equippedItemType(SHIELD)).toBe(EquippedItemType.shield);
    expect(equippedItemType(TORCH)).toBe(EquippedItemType.torch);
  });

  it('limits weapons, spells and torches by the race (RACE VNAM)', () => {
    const wolf = EquipmentFlag.handToHandMelee;
    expect(raceCanUse(wolf, SWORD)).toBe(false);
    expect(raceCanUse(wolf, CUIRASS)).toBe(true);
    expect(raceCanUse(0xffffffff, BOW)).toBe(true);
    expect(raceCanUse(EquipmentFlag.spell, FLAMES)).toBe(true);
    expect(raceCanUse(0, TORCH)).toBe(false);
  });

  it('hangs weapons on their sheath node by type, drawn in WEAPON or SHIELD', () => {
    expect(weaponNodes(WeaponType.oneHandSword, 'right')).toEqual({
      sheathed: 'WeaponSword',
      drawn: 'WEAPON',
    });
    expect(weaponNodes(WeaponType.twoHandAxe, 'right').sheathed).toBe('WeaponBack');
    expect(weaponNodes(WeaponType.oneHandDagger, 'left')).toEqual({
      sheathed: undefined,
      drawn: 'SHIELD',
    });
    // A bow is drawn into the left hand (the arrow takes WEAPON); a crossbow into the right.
    expect(weaponNodes(WeaponType.bow, 'right')).toEqual({
      sheathed: 'WeaponBow',
      drawn: 'SHIELD',
    });
    expect(weaponNodes(WeaponType.crossbow, 'right').drawn).toBe('WEAPON');
    expect(weaponNodes(WeaponType.staff, 'right').drawn).toBe('WEAPON');
  });
});

describe('stats (UESP)', () => {
  const s = VANILLA_ARMOR_SETTINGS;

  it('scales armor by skill: the player 1.4 at 100, NPCs 2.5', () => {
    expect(armorSkillMultiplier(0, true, s)).toBe(1);
    expect(armorSkillMultiplier(100, true, s)).toBeCloseTo(1.4);
    expect(armorSkillMultiplier(100, false, s)).toBeCloseTo(2.5);
    // Iron cuirass (25) at Heavy Armor 15: ceil(25 × 1.06) = 27.
    expect(armorPieceRating(25, 0, true, armorSkillMultiplier(15, true, s))).toBe(27);
    // Improved to Legendary (6): + (3.6 × 6 − 1.6) on chest armor, half elsewhere.
    expect(armorPieceRating(25, 6, true, 1)).toBe(45);
    expect(armorPieceRating(10, 6, false, 1)).toBe(20);
    expect(armorPieceRating(10, 0, false, 1, 1.25)).toBeCloseTo(12.5);
  });

  it('takes 0.12% off per point and 3% per piece, at most 80%', () => {
    expect(armorDamageReduction(100, 4, s)).toBeCloseTo(0.24);
    expect(armorDamageReduction(1000, 5, s)).toBeCloseTo(0.8);
    expect(armorDamageReduction(0, 0, s)).toBe(0);
  });

  it('scales weapon damage by skill (1 + skill / 200) and improvement', () => {
    const w = weaponSettings(() => undefined);
    expect(w).toEqual(VANILLA_WEAPON_SETTINGS);
    expect(weaponSkillMultiplier(100, true, w)).toBeCloseTo(1.5);
    // Iron sword (7) at One-Handed 15: round(7 × 1.075) = 8.
    expect(weaponDamage(7, 0, weaponSkillMultiplier(15, true, w))).toBe(8);
    // Fine (1): + (3.6 − 1.6) / 2 = 1.
    expect(weaponDamage(7, 1, 1)).toBe(8);
    expect(weaponDamage(7, 0, 1, 1.2)).toBe(8);
    const set = weaponSettings((name) => (name === 'fDamageSkillMax' ? 2 : undefined));
    expect(weaponSkillMultiplier(100, false, set)).toBe(2);
  });

  it('is over-encumbered above the carry weight', () => {
    expect(overEncumbered(300, 300)).toBe(false);
    expect(overEncumbered(300.5, 300)).toBe(true);
  });
});
