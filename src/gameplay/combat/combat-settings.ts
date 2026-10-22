// The game settings combat reads (GMST; docs/ai.md, "Combat"; the equip system reads those of
// weapon damage and armour, the skill progression those of stamina). Where the load order sets one,
// its value counts; the others keep the engine's built-in value, which the plugins do not hold:
// those below come from UESP's pages ("Damage", "Block", "Archery", "Difficulty") where it
// gives them, else they are inferred from what the game does and marked so. Platform-independent.

/** Difficulty: Novice (0) .. Legendary (5), as [GamePlay] iDifficulty numbers it. */
export const DIFFICULTY_SUFFIXES = ['VE', 'E', 'N', 'H', 'VH', 'L'] as const;

export interface CombatSettings {
  // --- Reach and hits ----------------------------------------------------------------------
  /** fCombatDistance: a melee weapon's reach at reach 1 (game units). */
  readonly combatDistance: number;
  /** fCombatBashReach: a bash's reach. */
  readonly combatBashReach: number;
  /**
   * fCombatHitConeAngle: the cone in front of an actor its blocks cover (degrees; UESP "Block":
   * 35, not in the plugins).
   */
  readonly combatHitConeAngle: number;
  // --- Damage --------------------------------------------------------------------------------
  /** fDamageSneakAttackMult: times the sneak attack multiplier (1). */
  readonly damageSneakAttackMult: number;
  /** fCombatSneak*Mult: the sneak attack multiplier of each kind of weapon. */
  readonly sneakMult: {
    readonly hand: number;
    readonly oneHandSword: number;
    readonly oneHandDagger: number;
    readonly oneHandAxe: number;
    readonly oneHandMace: number;
    readonly twoHandSword: number;
    readonly twoHandAxe: number;
    /** UESP "Sneak": bows ×2 (its setting is not in the plugins). */
    readonly bow: number;
  };
  /** fCombatUnarmedCritDamageMult. */
  readonly unarmedCritDamageMult: number;
  /** fDiffMultHPByPC<VE..L>: damage the player deals, by difficulty (UESP "Difficulty"). */
  readonly damageByPlayer: readonly number[];
  /** fDiffMultHPToPC<VE..L>: damage the player takes, by difficulty. */
  readonly damageToPlayer: readonly number[];
  // --- Blocking and bashing ----------------------------------------------------------------
  /** fBlockWeaponBase, fBlockWeaponScaling: blocking with a weapon. */
  readonly blockWeaponBase: number;
  readonly blockWeaponScaling: number;
  /** fShieldBaseFactor, fShieldScalingFactor: blocking with a shield. */
  readonly shieldBaseFactor: number;
  readonly shieldScalingFactor: number;
  /** fBlockPowerAttackMult: what is blocked of a power attack. */
  readonly blockPowerAttackMult: number;
  /**
   * The most a block takes off (UESP "Block": 85%). TODO(M13): the plugins' fBlockMax is 0.7;
   * which cap the engine applies, and to what, is not documented.
   */
  readonly blockCap: number;
  /** fWeaponBash{PC}Min/Max, fShieldBash{PC}Min/Max: a bash's damage factor (UESP "Block"). */
  readonly weaponBashMin: number;
  readonly weaponBashMax: number;
  readonly weaponBashPCMin: number;
  readonly weaponBashPCMax: number;
  readonly shieldBashMin: number;
  readonly shieldBashMax: number;
  readonly shieldBashPCMin: number;
  readonly shieldBashPCMax: number;
  // --- Staggers ------------------------------------------------------------------------------
  readonly staggerMin: number;
  readonly staggerMassOffsetBase: number;
  readonly staggerPlayerMassMult: number;
  readonly staggerBlockBase: number;
  readonly staggerBlockMult: number;
  readonly staggerBlockingMult: number;
  readonly staggerBlockAttackMult: number;
  readonly staggerBlockAttackShieldBase: number;
  readonly staggerBlockAttackShieldMult: number;
  // --- Bleedout ------------------------------------------------------------------------------
  /** fBleedoutRate: health an actor bleeding out regains a second (% of its maximum ×100). */
  readonly bleedoutRate: number;
  /** fBleedoutMin: it regains at least this much before it gets up. */
  readonly bleedoutMin: number;
  /** fBleedoutDefault: the share of its health it gets up with (0.15). */
  readonly bleedoutDefault: number;
  /** fBleedoutRecover: the health share (of its maximum) below which it stays down. */
  readonly bleedoutRecover: number;
  /** fEssentialDeathTime: how long an essential actor stays down (seconds). */
  readonly essentialDeathTime: number;
  /** fCombatPlayerBleedoutHealthDamageMult: damage the player takes bleeding out. */
  readonly playerBleedoutHealthDamageMult: number;
  // --- Arrows --------------------------------------------------------------------------------
  /** iArrowInventoryChance: % of arrows that hit an actor going into its inventory. */
  readonly arrowInventoryChance: number;
  /** fAttachedArrowAgeMax: seconds an arrow stays stuck in an actor. */
  readonly attachedArrowAgeMax: number;
  /** fCombatMissileStickDepth: how deep an arrow sticks (game units). */
  readonly missileStickDepth: number;
  /** fProjectileKnockMultBiped: the push of an arrow on a ragdoll. */
  readonly projectileKnockMultBiped: number;
  // --- Death ---------------------------------------------------------------------------------
  /** fDeathForce*: the push a killing blow gives the ragdoll by its damage (melee, ranged). */
  readonly deathForceDamageMin: number;
  readonly deathForceDamageMax: number;
  readonly deathForceForceMin: number;
  readonly deathForceForceMax: number;
  readonly deathForceRangedDamageMin: number;
  readonly deathForceRangedDamageMax: number;
  readonly deathForceRangedForceMin: number;
  readonly deathForceRangedForceMax: number;
  // --- Weapon blood --------------------------------------------------------------------------
  /** fWeaponBloodLifetime: seconds a weapon's blood stays fresh after a hit. */
  readonly weaponBloodLifetime: number;
  /** fWeaponBloodFadeDuration: seconds it then takes to dry away. */
  readonly weaponBloodFadeDuration: number;
  /** fWeaponBloodFalloffThreshold: the soft edge of its mask (the blood shader's). */
  readonly weaponBloodFalloffThreshold: number;
}

/** The engine's values where the plugins have none (Skyrim.esm and Update.esm otherwise). */
export const COMBAT_DEFAULTS: CombatSettings = {
  combatDistance: 141,
  combatBashReach: 141,
  combatHitConeAngle: 35,
  damageSneakAttackMult: 1,
  sneakMult: {
    hand: 2,
    oneHandSword: 3,
    oneHandDagger: 3,
    oneHandAxe: 3,
    oneHandMace: 3,
    twoHandSword: 2,
    twoHandAxe: 2,
    bow: 2,
  },
  unarmedCritDamageMult: 1,
  damageByPlayer: [2, 1.5, 1, 0.75, 0.5, 0.25],
  damageToPlayer: [0.5, 0.75, 1, 1.5, 2, 3],
  blockWeaponBase: 0.3,
  blockWeaponScaling: 0.2,
  shieldBaseFactor: 0.45,
  shieldScalingFactor: 0.2,
  blockPowerAttackMult: 0.66,
  blockCap: 0.85,
  weaponBashMin: 0.1,
  weaponBashMax: 0.25,
  weaponBashPCMin: 0.1,
  weaponBashPCMax: 0.5,
  shieldBashMin: 0.05,
  shieldBashMax: 0.25,
  shieldBashPCMin: 0.1,
  shieldBashPCMax: 0.25,
  staggerMin: 0,
  staggerMassOffsetBase: 2.1,
  staggerPlayerMassMult: 2.5,
  staggerBlockBase: 0.001,
  staggerBlockMult: 0.005,
  staggerBlockingMult: 0,
  staggerBlockAttackMult: -0.0001,
  staggerBlockAttackShieldBase: 0.01,
  staggerBlockAttackShieldMult: 0.001,
  bleedoutRate: 15,
  bleedoutMin: 5,
  bleedoutDefault: 0.15,
  bleedoutRecover: 0.05,
  essentialDeathTime: 20,
  playerBleedoutHealthDamageMult: 0,
  arrowInventoryChance: 33,
  attachedArrowAgeMax: 10,
  missileStickDepth: 20,
  projectileKnockMultBiped: 0.25,
  deathForceDamageMin: 1,
  deathForceDamageMax: 40,
  deathForceForceMin: 4,
  deathForceForceMax: 12,
  deathForceRangedDamageMin: 1,
  deathForceRangedDamageMax: 50,
  deathForceRangedForceMin: 10,
  deathForceRangedForceMax: 30,
  weaponBloodLifetime: 10,
  weaponBloodFadeDuration: 60,
  weaponBloodFalloffThreshold: 0.07,
};

/** Each number setting's game setting (its editor id). */
const SETTING_NAMES: Readonly<Partial<Record<keyof CombatSettings, string>>> = {
  combatDistance: 'fCombatDistance',
  combatBashReach: 'fCombatBashReach',
  combatHitConeAngle: 'fCombatHitConeAngle',
  damageSneakAttackMult: 'fDamageSneakAttackMult',
  unarmedCritDamageMult: 'fCombatUnarmedCritDamageMult',
  blockWeaponBase: 'fBlockWeaponBase',
  blockWeaponScaling: 'fBlockWeaponScaling',
  shieldBaseFactor: 'fShieldBaseFactor',
  shieldScalingFactor: 'fShieldScalingFactor',
  blockPowerAttackMult: 'fBlockPowerAttackMult',
  weaponBashMin: 'fWeaponBashMin',
  weaponBashMax: 'fWeaponBashMax',
  weaponBashPCMin: 'fWeaponBashPCMin',
  weaponBashPCMax: 'fWeaponBashPCMax',
  shieldBashMin: 'fShieldBashMin',
  shieldBashMax: 'fShieldBashMax',
  shieldBashPCMin: 'fShieldBashPCMin',
  shieldBashPCMax: 'fShieldBashPCMax',
  staggerMin: 'fStaggerMin',
  staggerMassOffsetBase: 'fStaggerMassOffsetBase',
  staggerPlayerMassMult: 'fStaggerPlayerMassMult',
  staggerBlockBase: 'fStaggerBlockBase',
  staggerBlockMult: 'fStaggerBlockMult',
  staggerBlockingMult: 'fStaggerBlockingMult',
  staggerBlockAttackMult: 'fStaggerBlockAttackMult',
  staggerBlockAttackShieldBase: 'fStaggerBlockAttackShieldBase',
  staggerBlockAttackShieldMult: 'fStaggerBlockAttackShieldMult',
  bleedoutRate: 'fBleedoutRate',
  bleedoutMin: 'fBleedoutMin',
  bleedoutDefault: 'fBleedoutDefault',
  bleedoutRecover: 'fBleedoutRecover',
  essentialDeathTime: 'fEssentialDeathTime',
  playerBleedoutHealthDamageMult: 'fCombatPlayerBleedoutHealthDamageMult',
  arrowInventoryChance: 'iArrowInventoryChance',
  attachedArrowAgeMax: 'fAttachedArrowAgeMax',
  missileStickDepth: 'fCombatMissileStickDepth',
  projectileKnockMultBiped: 'fProjectileKnockMultBiped',
  deathForceDamageMin: 'fDeathForceDamageMin',
  deathForceDamageMax: 'fDeathForceDamageMax',
  deathForceForceMin: 'fDeathForceForceMin',
  deathForceForceMax: 'fDeathForceForceMax',
  deathForceRangedDamageMin: 'fDeathForceRangedDamageMin',
  deathForceRangedDamageMax: 'fDeathForceRangedDamageMax',
  deathForceRangedForceMin: 'fDeathForceRangedForceMin',
  deathForceRangedForceMax: 'fDeathForceRangedForceMax',
  weaponBloodLifetime: 'fWeaponBloodLifetime',
  weaponBloodFadeDuration: 'fWeaponBloodFadeDuration',
  weaponBloodFalloffThreshold: 'fWeaponBloodFalloffThreshold',
};

/** The sneak multipliers' settings. */
const SNEAK_NAMES: Readonly<Record<keyof CombatSettings['sneakMult'], string>> = {
  hand: 'fCombatSneakHandMult',
  oneHandSword: 'fCombatSneak1HSwordMult',
  oneHandDagger: 'fCombatSneak1HDaggerMult',
  oneHandAxe: 'fCombatSneak1HAxeMult',
  oneHandMace: 'fCombatSneak1HMaceMult',
  twoHandSword: 'fCombatSneak2HSwordMult',
  twoHandAxe: 'fCombatSneak2HAxeMult',
  bow: 'fCombatSneakBowMult',
};

/** Combat's settings from the load order's (`number`: a GMST's number, if it has one). */
export function readCombatSettings(
  number: (editorId: string) => number | undefined,
): CombatSettings {
  const settings: Record<string, unknown> = { ...COMBAT_DEFAULTS };
  for (const [key, name] of Object.entries(SETTING_NAMES)) {
    const value = number(name);
    if (value !== undefined) settings[key] = value;
  }
  const sneak = { ...COMBAT_DEFAULTS.sneakMult };
  for (const key of Object.keys(SNEAK_NAMES) as (keyof typeof SNEAK_NAMES)[]) {
    sneak[key] = number(SNEAK_NAMES[key]) ?? sneak[key];
  }
  const byDifficulty = (prefix: string, defaults: readonly number[]): number[] =>
    DIFFICULTY_SUFFIXES.map((suffix, i) => number(`${prefix}${suffix}`) ?? defaults[i] ?? 1);
  return {
    ...(settings as unknown as CombatSettings),
    sneakMult: sneak,
    damageByPlayer: byDifficulty('fDiffMultHPByPC', COMBAT_DEFAULTS.damageByPlayer),
    damageToPlayer: byDifficulty('fDiffMultHPToPC', COMBAT_DEFAULTS.damageToPlayer),
  };
}

/** The [Controls] settings of power attacks (STEP's dump of SSE's INI defaults). */
export interface PowerAttackTiming {
  /** fInitialPowerAttackDelay: an attack held this long is a power attack (seconds). */
  readonly initialPowerAttackDelay: number;
  readonly initialPowerBashDelay: number;
  /** fSubsequentPowerAttackDelay: holding on through a combo, the next one after this long. */
  readonly subsequentPowerAttackDelay: number;
  readonly subsequentPowerBashDelay: number;
}

export const POWER_ATTACK_TIMING: PowerAttackTiming = {
  initialPowerAttackDelay: 0.3,
  initialPowerBashDelay: 0.3,
  subsequentPowerAttackDelay: 2,
  subsequentPowerBashDelay: 2,
};
