// Health, magicka and stamina over time, and what actions cost, as UESP ("Skyrim:Health",
// "Skyrim:Magicka", "Skyrim:Stamina") and the game settings give them:
//
// - Regeneration a second = the maximum × HealRate % (the race's: 0.7 health, 3 magicka, 5
//   stamina for the playable races) × HealRateMult % (100; Fortify Regenerate effects raise it);
//   in combat × fCombatHealthRegenRateMult (0: none; races with "Regen HP In Combat", RACE DATA
//   0x80000, keep theirs; CombatHealthRegenMult raises it), fCombatMagickaRegenRateMult (0.33:
//   UESP's 0.99 %), fCombatStaminaRegenRateMult (0.35: UESP's 1.75 %).
// - Damage stops a value regenerating for fDamagedHealthRegenDelay, ...Magicka..., ...Stamina...
//   (0.5 s; fDamagedAVRegenDelay 1 s for others). Spending more stamina (magicka) than there is
//   waits as long as the deficit takes to regenerate, at most fStaminaRegenDelayMax
//   (fMagickaRegenDelayMax; engine defaults 5 s): UESP's power attack of 80 at 10 stamina waits
//   5 s, not 7.
// - Sprinting drains fSprintStaminaDrainMult × (fSprintStaminaWeightBase + fSprintStaminaWeightMult
//   × worn weight) a second (7 + 2 % a pound); at 0 stamina the actor cannot sprint, power
//   attack or bash (the meter blinks).
// - A power attack costs fPowerAttackStaminaPenalty × (fStaminaAttackWeaponBase +
//   fStaminaAttackWeaponMult × the weapon's weight) (UESP: 40 + 2 × weight), times its attack
//   data's stamina mult (RACE ATKD); dual-wielding 1.5 times (UESP: 3 × (40 + 2w) × 0.5). A bash
//   costs fStaminaBashBase (35), a power bash fStaminaPowerBashBase (55); blocking
//   fStaminaBlockBase + fStaminaBlockDmgMult × the damage blocked. Jumping costs nothing (UESP).
//
// Platform-independent. Notes: docs/gameplay.md ("Skills, levels and actor values").

/** The settings regeneration and costs read (GMSTs; vanilla or engine values by default). */
export interface VitalSettings {
  /** fCombatHealthRegenRateMult, fCombatMagickaRegenRateMult, fCombatStaminaRegenRateMult. */
  readonly combatRegenMult: readonly [number, number, number];
  /** fDamagedHealthRegenDelay, ...Magicka..., ...Stamina... (s). */
  readonly damagedDelay: readonly [number, number, number];
  /** fMagickaRegenDelayMax, fStaminaRegenDelayMax (engine defaults; not in the plugins). */
  readonly magickaDelayMax: number;
  readonly staminaDelayMax: number;
  readonly sprintDrainMult: number;
  readonly sprintWeightBase: number;
  readonly sprintWeightMult: number;
  readonly powerAttackPenalty: number;
  readonly attackWeaponBase: number;
  readonly attackWeaponMult: number;
  readonly bashBase: number;
  readonly powerBashBase: number;
  readonly blockBase: number;
  readonly blockDamageMult: number;
}

export const VITAL_DEFAULTS: VitalSettings = {
  combatRegenMult: [0, 0.33, 0.35],
  damagedDelay: [0.5, 0.5, 0.5],
  magickaDelayMax: 5,
  staminaDelayMax: 5,
  sprintDrainMult: 7,
  sprintWeightBase: 1,
  sprintWeightMult: 0.02,
  powerAttackPenalty: 2,
  attackWeaponBase: 20,
  attackWeaponMult: 1,
  bashBase: 35,
  powerBashBase: 55,
  blockBase: 0,
  blockDamageMult: 0.25,
};

export function vitalSettings(number: (editorId: string) => number | undefined): VitalSettings {
  const d = VITAL_DEFAULTS;
  const pick = (name: string, fallback: number): number => number(name) ?? fallback;
  return {
    combatRegenMult: [
      pick('fCombatHealthRegenRateMult', d.combatRegenMult[0]),
      pick('fCombatMagickaRegenRateMult', d.combatRegenMult[1]),
      pick('fCombatStaminaRegenRateMult', d.combatRegenMult[2]),
    ],
    damagedDelay: [
      pick('fDamagedHealthRegenDelay', d.damagedDelay[0]),
      pick('fDamagedMagickaRegenDelay', d.damagedDelay[1]),
      pick('fDamagedStaminaRegenDelay', d.damagedDelay[2]),
    ],
    magickaDelayMax: pick('fMagickaRegenDelayMax', d.magickaDelayMax),
    staminaDelayMax: pick('fStaminaRegenDelayMax', d.staminaDelayMax),
    sprintDrainMult: pick('fSprintStaminaDrainMult', d.sprintDrainMult),
    sprintWeightBase: pick('fSprintStaminaWeightBase', d.sprintWeightBase),
    sprintWeightMult: pick('fSprintStaminaWeightMult', d.sprintWeightMult),
    powerAttackPenalty: pick('fPowerAttackStaminaPenalty', d.powerAttackPenalty),
    attackWeaponBase: pick('fStaminaAttackWeaponBase', d.attackWeaponBase),
    attackWeaponMult: pick('fStaminaAttackWeaponMult', d.attackWeaponMult),
    bashBase: pick('fStaminaBashBase', d.bashBase),
    powerBashBase: pick('fStaminaPowerBashBase', d.powerBashBase),
    blockBase: pick('fStaminaBlockBase', d.blockBase),
    blockDamageMult: pick('fStaminaBlockDmgMult', d.blockDamageMult),
  };
}

/** Health, magicka, stamina: the regenerating values, in this order everywhere here. */
export type Vital = 0 | 1 | 2;

/** What a value regenerates by a second (see the header). */
export interface RegenInput {
  readonly max: number;
  /** HealRate, MagickaRate, StaminaRate (% of the maximum a second). */
  readonly rate: number;
  /** HealRateMult, MagickaRateMult, StaminaRateMult (%). */
  readonly rateMult: number;
  readonly inCombat: boolean;
  /** Health: the race regenerates in combat (Regen HP In Combat). */
  readonly regenInCombat?: boolean;
  /** Health: the CombatHealthRegenMult actor value. */
  readonly combatHealthMult?: number;
}

export function regenPerSecond(
  vital: Vital,
  input: RegenInput,
  settings: VitalSettings = VITAL_DEFAULTS,
): number {
  if (input.max <= 0 || input.rate <= 0 || input.rateMult <= 0) return 0;
  let perSecond = (input.max * input.rate * input.rateMult) / 10000;
  if (input.inCombat) {
    // TODO(M13): how the engine combines the setting and CombatHealthRegenMult is undocumented
    // (the larger of the two here).
    const mult =
      vital === 0
        ? input.regenInCombat === true
          ? 1
          : Math.max(settings.combatRegenMult[0], input.combatHealthMult ?? 0)
        : settings.combatRegenMult[vital];
    perSecond *= mult;
  }
  return perSecond;
}

/**
 * The wait before a value regenerates after `amount` was spent with `current` left: none
 * unless it was more than there was, then the deficit's regeneration time, at most `max`.
 */
export function spendDelay(
  amount: number,
  current: number,
  perSecond: number,
  max: number,
): number {
  const deficit = amount - Math.max(0, current);
  if (deficit <= 0) return 0;
  return perSecond > 0 ? Math.min(max, deficit / perSecond) : max;
}

/** Stamina a second of sprinting costs with `wornWeight` of armor on. */
export function sprintDrain(wornWeight: number, settings: VitalSettings = VITAL_DEFAULTS): number {
  return (
    settings.sprintDrainMult *
    (settings.sprintWeightBase + settings.sprintWeightMult * Math.max(0, wornWeight))
  );
}

/** Stamina a power attack costs (see the header). */
export function powerAttackCost(
  weaponWeight: number,
  options: { readonly dualWield?: boolean; readonly attackStaminaMult?: number } = {},
  settings: VitalSettings = VITAL_DEFAULTS,
): number {
  const single =
    settings.powerAttackPenalty *
    (settings.attackWeaponBase + settings.attackWeaponMult * Math.max(0, weaponWeight));
  // TODO(M13): the dual-wield factor (UESP's 3 × ... × 0.5) has no game setting found.
  return single * (options.attackStaminaMult ?? 1) * (options.dualWield === true ? 1.5 : 1);
}

/** Stamina a bash costs (power bash: fStaminaPowerBashBase). */
export function bashCost(power: boolean, settings: VitalSettings = VITAL_DEFAULTS): number {
  return power ? settings.powerBashBase : settings.bashBase;
}

/** Stamina blocking `damage` costs. */
export function blockCost(damage: number, settings: VitalSettings = VITAL_DEFAULTS): number {
  return settings.blockBase + settings.blockDamageMult * Math.max(0, damage);
}

/** Stamina a jump costs: none (UESP "Stamina": "Jumping does not reduce stamina"). */
export const JUMP_STAMINA_COST = 0;
