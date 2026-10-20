// What an actor fights with (docs/ai.md, "Combat"): the weapon in each hand, its shield, the
// ammunition it shoots and the projectile that flies, its armour, and its fists. The narrow
// interface combat needs; what an actor holds is the equip system's (M11), whose API this is
// switched to: here it is chosen from the items an actor has (choose below) by a small adapter
// (src/shell/combat-gear.ts). Platform-independent.

import {
  EquippedType,
  WeaponAnimType,
  type AmmoCombat,
  type ProjectileCombat,
  type WeaponCombat,
} from './combat-records.ts';

/** A shield as combat uses it. */
export interface ShieldGear {
  readonly formId: number;
  /** ARMO DNAM / 100: its base rating (blocks and bashes scale with it, not its tempering). */
  readonly rating: number;
  readonly weight: number;
  /** BAMT-like: the impact data set of its blocks and bashes (ARMO has none: its material's). */
  readonly blockBashImpactDataSet: number | undefined;
}

/** What an actor fights with. */
export interface CombatGear {
  /** The weapon in the right hand (a two-handed weapon, a bow: both hands); undefined: fists. */
  readonly right: WeaponCombat | undefined;
  /** A one-handed weapon in the left hand (dual wielding). */
  readonly left: WeaponCombat | undefined;
  /** A shield on the left arm. */
  readonly shield: ShieldGear | undefined;
  /** The arrows or bolts equipped (a bow or crossbow shoots them) and how many it has. */
  readonly ammo: AmmoCombat | undefined;
  readonly ammoCount: number;
  /** The ammunition's projectile (PROJ). */
  readonly projectile: ProjectileCombat | undefined;
  /** Its armour: the rating of the pieces it wears (skill applied) and how many (shield too). */
  readonly armorRating: number;
  readonly armorPieces: number;
  /** Its fists' damage (the UnarmedDamage actor value: its race's) and its gauntlets' rating. */
  readonly unarmedDamage: number;
  readonly gauntletRating: number;
}

/** No gear (fists only). */
export const BARE_HANDS: CombatGear = {
  right: undefined,
  left: undefined,
  shield: undefined,
  ammo: undefined,
  ammoCount: 0,
  projectile: undefined,
  armorRating: 0,
  armorPieces: 0,
  unarmedDamage: 0,
  gauntletRating: 0,
};

/** Whether a weapon takes both hands (two-handed, bows, crossbows, staffs are one-handed). */
export function twoHanded(weapon: WeaponCombat | undefined): boolean {
  if (!weapon) return false;
  return (
    weapon.animType === WeaponAnimType.twoHandSword ||
    weapon.animType === WeaponAnimType.twoHandAxe ||
    weapon.animType === WeaponAnimType.bow ||
    weapon.animType === WeaponAnimType.crossbow
  );
}

/** Whether a weapon shoots (a bow or crossbow). */
export function ranged(weapon: WeaponCombat | undefined): boolean {
  return (
    weapon?.animType === WeaponAnimType.bow || weapon?.animType === WeaponAnimType.crossbow
  );
}

/**
 * GetEquippedItemType for a hand (0 the left, 1 the right; the graphs' iLeftHandType and
 * iRightHandType): what it holds, a shield in the left; a two-handed weapon in both; fists 0.
 * TODO(M10) 5.3: spells (9), staffs and torches (11) once the magic and equip systems hold them.
 */
export function equippedType(gear: CombatGear | undefined, hand: 0 | 1): number {
  if (!gear) return EquippedType.handToHand;
  if (hand === 1) return gear.right?.equippedType ?? EquippedType.handToHand;
  if (twoHanded(gear.right)) return gear.right?.equippedType ?? EquippedType.handToHand;
  if (gear.left) return gear.left.equippedType;
  if (gear.shield) return EquippedType.shield;
  return EquippedType.handToHand;
}

/** An item an actor has, as the gear is chosen from it. */
export interface GearItem {
  readonly formId: number;
  readonly count: number;
  /** Equipped by a script or the menus (the game state's equipped set). */
  readonly equipped: boolean;
  readonly weapon?: WeaponCombat;
  readonly shield?: ShieldGear;
  readonly ammo?: AmmoCombat;
}

/**
 * The gear an actor fights with, from its items. Replaced by the equip system (M11): what is
 * equipped is held (the last weapon equipped in the right hand, another one-handed one in the
 * left, a shield equipped, the ammunition equipped); an NPC that has equipped no weapon holds
 * the strongest it carries that its race can use (and the arrows it carries most of, for a
 * bow), and a shield it carries beside a one-handed weapon. The player's hands stay empty
 * until they equip something.
 */
export function chooseGear(
  items: readonly GearItem[],
  options: {
    readonly player: boolean;
    /** Whether its race can use a weapon (RACE VNAM equipment flags). */
    readonly canUse: (weapon: WeaponCombat) => boolean;
  },
): Pick<CombatGear, 'right' | 'left' | 'shield' | 'ammo' | 'ammoCount'> {
  const weapons = items.filter(
    (item): item is GearItem & { weapon: WeaponCombat } => item.weapon !== undefined,
  );
  const equipped = weapons.filter((item) => item.equipped);
  let right = equipped.at(-1)?.weapon;
  let left: WeaponCombat | undefined;
  if (right && !twoHanded(right)) {
    left = equipped
      .slice(0, -1)
      .reverse()
      .find((item) => !twoHanded(item.weapon) && item.weapon.animType !== WeaponAnimType.staff)
      ?.weapon;
  }
  if (!right && !options.player) {
    const usable = weapons
      .filter((item) => item.count > 0 && options.canUse(item.weapon))
      .sort((a, b) => b.weapon.damage - a.weapon.damage);
    right = usable[0]?.weapon;
  }
  const shields = items.filter(
    (item): item is GearItem & { shield: ShieldGear } => item.shield !== undefined,
  );
  let shield = shields.find((item) => item.equipped)?.shield;
  if (!shield && !options.player && !twoHanded(right) && !left) {
    shield = shields.find((item) => item.count > 0)?.shield;
  }
  if (twoHanded(right) || left) shield = undefined;
  const ammos = items.filter(
    (item): item is GearItem & { ammo: AmmoCombat } => item.ammo !== undefined && item.count > 0,
  );
  // A crossbow shoots bolts, a bow arrows (AMMO "Non-Bolt").
  const fits = (ammo: AmmoCombat): boolean =>
    right?.animType === WeaponAnimType.crossbow ? (ammo.flags & 0x4) === 0 : (ammo.flags & 0x4) !== 0;
  const pick =
    ammos.find((item) => item.equipped && fits(item.ammo)) ??
    (options.player ? undefined : [...ammos].sort((a, b) => b.count - a.count).find((item) => fits(item.ammo)));
  return {
    right,
    left,
    shield,
    ammo: pick?.ammo,
    ammoCount: pick?.count ?? 0,
  };
}
