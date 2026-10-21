// The perks' entry points (UESP "Skyrim Mod:Mod File Format/PERK", xEdit wbDefinitionsTES5
// wbEntryPointsEnum, CommonLibSSE BGSEntryPoint / BGSEntryPointFunction): the places where the
// engine asks an actor's perks to change a value (a weapon's damage, a spell's cost, a price,
// the chance to pickpocket ...). Each entry point has its condition tabs, the subjects its
// entries' conditions run on (PRKC: the perk owner first, then the weapon, the target, the
// spell, the item ... the caller passes), and each entry a function that changes the value:
// Set, Add, Multiply, Add Range, the actor value functions (the owner's actor value × a
// factor: how Fortify <skill> reaches the systems, AlchemySkillBoosts and PerkSkillBoosts),
// Absolute; or picks a spell, a text, a leveled list or adds an activation choice. An actor's
// matching entries run in priority order (the lowest number first), each whose conditions all
// hold changing the value the one before left. Platform-independent. Notes: docs/gameplay.md
// ("Perks").

/** Entry point ids (DATA byte 0 of an entry point entry). */
export const EntryPoint = {
  calculateWeaponDamage: 0,
  calculateMyCriticalHitChance: 1,
  calculateMyCriticalHitDamage: 2,
  calculateMineExplodeChance: 3,
  adjustLimbDamage: 4,
  adjustBookSkillPoints: 5,
  modRecoveredHealth: 6,
  getShouldAttack: 7,
  modBuyPrices: 8,
  addLeveledListOnDeath: 9,
  getMaxCarryWeight: 10,
  modAddictionChance: 11,
  modAddictionDuration: 12,
  modPositiveChemDuration: 13,
  activate: 14,
  ignoreRunningDuringDetection: 15,
  ignoreBrokenLock: 16,
  modEnemyCriticalHitChance: 17,
  modSneakAttackMult: 18,
  modMaxPlaceableMines: 19,
  modBowZoom: 20,
  modRecoverArrowChance: 21,
  modSkillUse: 22,
  modTelekinesisDistance: 23,
  modTelekinesisDamageMult: 24,
  modTelekinesisDamage: 25,
  modBashingDamage: 26,
  modPowerAttackStamina: 27,
  modPowerAttackDamage: 28,
  modSpellMagnitude: 29,
  modSpellDuration: 30,
  modSecondaryValueWeight: 31,
  modArmorWeight: 32,
  modIncomingStagger: 33,
  modTargetStagger: 34,
  modAttackDamage: 35,
  modIncomingDamage: 36,
  modTargetDamageResistance: 37,
  modSpellCost: 38,
  modPercentBlocked: 39,
  modShieldDeflectArrowChance: 40,
  modIncomingSpellMagnitude: 41,
  modIncomingSpellDuration: 42,
  modPlayerIntimidation: 43,
  modPlayerReputation: 44,
  modFavorPoints: 45,
  modBribeAmount: 46,
  modDetectionLight: 47,
  modDetectionMovement: 48,
  modSoulGemRecharge: 49,
  setSweepAttack: 50,
  applyCombatHitSpell: 51,
  applyBashingSpell: 52,
  applyReanimateSpell: 53,
  setBooleanGraphVariable: 54,
  modSpellCastingSoundEvent: 55,
  modPickpocketChance: 56,
  modDetectionSneakSkill: 57,
  modFallingDamage: 58,
  modLockpickSweetSpot: 59,
  modSellPrices: 60,
  canPickpocketEquippedItem: 61,
  modLockpickLevelAllowed: 62,
  setLockpickStartingArc: 63,
  setProgressionPicking: 64,
  makeLockpicksUnbreakable: 65,
  modAlchemyEffectiveness: 66,
  applyWeaponSwingSpell: 67,
  modCommandedActorLimit: 68,
  applySneakingSpell: 69,
  modPlayerMagicSlowdown: 70,
  modWardMagickaAbsorptionPct: 71,
  modInitialIngredientEffectsLearned: 72,
  purifyAlchemyIngredients: 73,
  filterActivation: 74,
  canDualCastSpell: 75,
  modTemperingHealth: 76,
  modEnchantmentPower: 77,
  modSoulPctCapturedToWeapon: 78,
  modSoulGemEnchanting: 79,
  modNumberAppliedEnchantmentsAllowed: 80,
  setActivateLabel: 81,
  modShoutOk: 82,
  modPoisonDoseCount: 83,
  shouldApplyPlacedItem: 84,
  modArmorRating: 85,
  modLockpickingCrimeChance: 86,
  modIngredientsHarvested: 87,
  modSpellRangeTargetLoc: 88,
  modPotionsCreated: 89,
  modLockpickingKeyRewardChance: 90,
  allowMountActor: 91,
} as const;

export type EntryPointId = (typeof EntryPoint)[keyof typeof EntryPoint];

/** What a condition tab runs on (the perk owner, or what the caller passes). */
export type ConditionSubject =
  | 'owner'
  | 'weapon'
  | 'target'
  | 'item'
  | 'attacker'
  | 'attackerWeapon'
  | 'spell'
  | 'enchantment'
  | 'lockedReference';

export interface EntryPointInfo {
  readonly name: string;
  /** Its condition tabs in order (PRKC indexes them): the owner first. */
  readonly tabs: readonly ConditionSubject[];
}

const O = 'owner';
const W = 'weapon';
const T = 'target';
const I = 'item';
const S = 'spell';
const A = 'attacker';
const AW = 'attackerWeapon';
const E = 'enchantment';
const L = 'lockedReference';

/**
 * Every entry point by id: its name (xEdit) and condition tabs (UESP's table; the tab counts
 * the vanilla entries store, DATA byte 2, agree: tests/perks.int.test.ts). The ingredient
 * eaten (Mod Initial Ingredient Effects Learned) and the potion made (Mod Potions Created) are
 * magic items, so their tab is the spell's.
 */
export const ENTRY_POINTS: readonly EntryPointInfo[] = [
  { name: 'Calculate Weapon Damage', tabs: [O, W, T] },
  { name: 'Calculate My Critical Hit Chance', tabs: [O, W, T] },
  { name: 'Calculate My Critical Hit Damage', tabs: [O, W, T] },
  { name: 'Calculate Mine Explode Chance', tabs: [O, I] },
  { name: 'Adjust Limb Damage', tabs: [O, A, AW] },
  { name: 'Adjust Book Skill Points', tabs: [O] },
  { name: 'Mod Recovered Health', tabs: [O] },
  { name: 'Get Should Attack', tabs: [O, A] },
  { name: 'Mod Buy Prices', tabs: [O, T] },
  { name: 'Add Leveled List On Death', tabs: [O, T] },
  { name: 'Get Max Carry Weight', tabs: [O] },
  { name: 'Mod Addiction Chance', tabs: [O] },
  { name: 'Mod Addiction Duration', tabs: [O] },
  { name: 'Mod Positive Chem Duration', tabs: [O] },
  { name: 'Activate', tabs: [O, T] },
  { name: 'Ignore Running During Detection', tabs: [O] },
  { name: 'Ignore Broken Lock', tabs: [O] },
  { name: 'Mod Enemy Critical Hit Chance', tabs: [O, W, T] },
  { name: 'Mod Sneak Attack Mult', tabs: [O, W, T] },
  { name: 'Mod Max Placeable Mines', tabs: [O] },
  { name: 'Mod Bow Zoom', tabs: [O, W] },
  { name: 'Mod Recover Arrow Chance', tabs: [O] },
  { name: 'Mod Skill Use', tabs: [O] },
  { name: 'Mod Telekinesis Distance', tabs: [O] },
  { name: 'Mod Telekinesis Damage Mult', tabs: [O] },
  { name: 'Mod Telekinesis Damage', tabs: [O, T] },
  { name: 'Mod Bashing Damage', tabs: [O, T] },
  { name: 'Mod Power Attack Stamina', tabs: [O, W] },
  { name: 'Mod Power Attack Damage', tabs: [O, W, T] },
  { name: 'Mod Spell Magnitude', tabs: [O, S, T] },
  { name: 'Mod Spell Duration', tabs: [O, S, T] },
  { name: 'Mod Secondary Value Weight', tabs: [O, S, T] },
  { name: 'Mod Armor Weight', tabs: [O, I] },
  { name: 'Mod Incoming Stagger', tabs: [O, A] },
  { name: 'Mod Target Stagger', tabs: [O, T] },
  { name: 'Mod Attack Damage', tabs: [O, W, T] },
  { name: 'Mod Incoming Damage', tabs: [O, A, AW] },
  { name: 'Mod Target Damage Resistance', tabs: [O, W, T] },
  { name: 'Mod Spell Cost', tabs: [O, S] },
  { name: 'Mod Percent Blocked', tabs: [O] },
  { name: 'Mod Shield Deflect Arrow Chance', tabs: [O] },
  { name: 'Mod Incoming Spell Magnitude', tabs: [O, S] },
  { name: 'Mod Incoming Spell Duration', tabs: [O, S] },
  { name: 'Mod Player Intimidation', tabs: [O, T] },
  { name: 'Mod Player Reputation', tabs: [O] },
  { name: 'Mod Favor Points', tabs: [O, T] },
  { name: 'Mod Bribe Amount', tabs: [O, T] },
  { name: 'Mod Detection Light', tabs: [O, T] },
  { name: 'Mod Detection Movement', tabs: [O, T] },
  { name: 'Mod Soul Gem Recharge', tabs: [O, I] },
  { name: 'Set Sweep Attack', tabs: [O, W] },
  { name: 'Apply Combat Hit Spell', tabs: [O, W, T] },
  { name: 'Apply Bashing Spell', tabs: [O, T] },
  { name: 'Apply Reanimate Spell', tabs: [O, S, T] },
  { name: 'Set Boolean Graph Variable', tabs: [O] },
  { name: 'Mod Spell Casting Sound Event', tabs: [O, S] },
  { name: 'Mod Pickpocket Chance', tabs: [O, T, I] },
  { name: 'Mod Detection Sneak Skill', tabs: [O, T] },
  { name: 'Mod Falling Damage', tabs: [O] },
  { name: 'Mod Lockpick Sweet Spot', tabs: [O, L] },
  { name: 'Mod Sell Prices', tabs: [O, T] },
  { name: 'Can Pickpocket Equipped Item', tabs: [O, T, I] },
  { name: 'Mod Lockpick Level Allowed', tabs: [O] },
  { name: 'Set Lockpick Starting Arc', tabs: [O] },
  { name: 'Set Progression Picking', tabs: [O] },
  { name: 'Make Lockpicks Unbreakable', tabs: [O] },
  { name: 'Mod Alchemy Effectiveness', tabs: [O] },
  { name: 'Apply Weapon Swing Spell', tabs: [O, A, AW] },
  { name: 'Mod Commanded Actor Limit', tabs: [O, S] },
  { name: 'Apply Sneaking Spell', tabs: [O] },
  { name: 'Mod Player Magic Slowdown', tabs: [O, S] },
  { name: 'Mod Ward Magicka Absorption Pct', tabs: [O, S] },
  { name: 'Mod Initial Ingredient Effects Learned', tabs: [O, S] },
  { name: 'Purify Alchemy Ingredients', tabs: [O] },
  { name: 'Filter Activation', tabs: [O, T] },
  { name: 'Can Dual Cast Spell', tabs: [O, S] },
  { name: 'Mod Tempering Health', tabs: [O, I] },
  { name: 'Mod Enchantment Power', tabs: [O, E, I] },
  { name: 'Mod Soul Pct Captured to Weapon', tabs: [O, T, I] },
  { name: 'Mod Soul Gem Enchanting', tabs: [O, E, I] },
  { name: 'Mod # Applied Enchantments Allowed', tabs: [O] },
  { name: 'Set Activate Label', tabs: [O, T] },
  { name: 'Mod Shout OK', tabs: [O] },
  { name: 'Mod Poison Dose Count', tabs: [O, W, S] },
  { name: 'Should Apply Placed Item', tabs: [O, T, I] },
  { name: 'Mod Armor Rating', tabs: [O, I] },
  { name: 'Mod Lockpicking Crime Chance', tabs: [O, L] },
  { name: 'Mod Ingredients Harvested', tabs: [O, I] },
  { name: 'Mod Spell Range (Target Loc.)', tabs: [O, S] },
  { name: 'Mod Potions Created', tabs: [O, S] },
  { name: 'Mod Lockpicking Key Reward Chance', tabs: [O, L] },
  { name: 'Allow Mount Actor', tabs: [O, T] },
];

/** An entry point's name ("Entry point 120" for one the game does not have). */
export function entryPointName(id: number): string {
  return ENTRY_POINTS[id]?.name ?? `Entry point ${String(id)}`;
}

/** Entry point functions (DATA byte 1; CommonLibSSE ENTRY_POINT_FUNCTION). */
export const EntryFunction = {
  none: 0,
  setValue: 1,
  addValue: 2,
  multiplyValue: 3,
  addRangeToValue: 4,
  addActorValueMult: 5,
  absoluteValue: 6,
  negativeAbsoluteValue: 7,
  addLeveledList: 8,
  addActivateChoice: 9,
  selectSpell: 10,
  selectText: 11,
  setToActorValueMult: 12,
  multiplyActorValueMult: 13,
  multiplyOnePlusActorValueMult: 14,
  setText: 15,
} as const;

/** xEdit's names of the functions, for tools. */
export const ENTRY_FUNCTION_NAMES = [
  'None',
  'Set Value',
  'Add Value',
  'Multiply Value',
  'Add Range To Value',
  'Add Actor Value Mult',
  'Absolute Value',
  'Negative Absolute Value',
  'Add Leveled List',
  'Add Activate Choice',
  'Select Spell',
  'Select Text',
  'Set to Actor Value Mult',
  'Multiply Actor Value Mult',
  'Multiply 1 + Actor Value Mult',
  'Set Text',
] as const;

/**
 * An entry's function data (EPFT, then EPFD / EPF2 / EPF3): one float, two floats (a range),
 * an actor value and a factor, a leveled item list, an activation choice (its spell, button
 * label and script flags: run immediately, replace default; the fragment index of the perk's
 * script), a spell, a text.
 */
export type EntryFunctionData =
  | { readonly type: 'none' }
  | { readonly type: 'float'; readonly value: number }
  | { readonly type: 'range'; readonly min: number; readonly max: number }
  | { readonly type: 'actorValue'; readonly actorValue: number; readonly factor: number }
  | { readonly type: 'leveledList'; readonly list: number }
  | {
      readonly type: 'activateChoice';
      readonly spell: number | undefined;
      readonly label: string;
      readonly runImmediately: boolean;
      readonly replaceDefault: boolean;
      readonly fragment: number;
    }
  | { readonly type: 'spell'; readonly spell: number | undefined }
  | { readonly type: 'text'; readonly text: string };

/** What a value function needs: the owner's actor values, and a random number (0..1). */
export interface EntryFunctionSources {
  actorValue(index: number): number;
  random(): number;
}

/**
 * One entry's function on a value (the value functions; the others leave it: what they pick
 * is gathered by the caller). The actor value functions read the perk owner's current value.
 */
export function applyEntryFunction(
  value: number,
  fn: number,
  data: EntryFunctionData,
  sources: EntryFunctionSources,
): number {
  const float = data.type === 'float' ? data.value : 0;
  const av = (): number => (data.type === 'actorValue' ? sources.actorValue(data.actorValue) : 0);
  const factor = data.type === 'actorValue' ? data.factor : 0;
  switch (fn) {
    case EntryFunction.setValue:
      return float;
    case EntryFunction.addValue:
      return value + float;
    case EntryFunction.multiplyValue:
      return value * float;
    case EntryFunction.addRangeToValue: {
      if (data.type !== 'range') return value;
      return value + data.min + (data.max - data.min) * sources.random();
    }
    case EntryFunction.addActorValueMult:
      return value + av() * factor;
    case EntryFunction.absoluteValue:
      return Math.abs(value);
    case EntryFunction.negativeAbsoluteValue:
      return -Math.abs(value);
    case EntryFunction.setToActorValueMult:
      return av() * factor;
    case EntryFunction.multiplyActorValueMult:
      return value * av() * factor;
    case EntryFunction.multiplyOnePlusActorValueMult:
      return value * (1 + av() * factor);
    default:
      return value;
  }
}

/** Whether a function changes the value (the others pick a spell, a text, a list, a choice). */
export function isValueFunction(fn: number): boolean {
  return (
    fn === EntryFunction.setValue ||
    fn === EntryFunction.addValue ||
    fn === EntryFunction.multiplyValue ||
    fn === EntryFunction.addRangeToValue ||
    fn === EntryFunction.addActorValueMult ||
    fn === EntryFunction.absoluteValue ||
    fn === EntryFunction.negativeAbsoluteValue ||
    fn === EntryFunction.setToActorValueMult ||
    fn === EntryFunction.multiplyActorValueMult ||
    fn === EntryFunction.multiplyOnePlusActorValueMult
  );
}

/**
 * The order an actor's entries run in: by priority, the lowest number first (the Creation
 * Kit wikis: "lower values indicating higher priority", "higher priority computed before
 * lower"; vanilla's Set Value entries never meet another entry on the same value, so no
 * vanilla result depends on it: TODO(M13) confirm against the engine), entries of equal
 * priority in the order the actor got their perks and the perk lists them (stable).
 */
export function orderEntries<T extends { readonly priority: number }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.priority - b.entry.priority || a.index - b.index)
    .map(({ entry }) => entry);
}
