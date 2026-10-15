// Actor values by index, as UESP's "Skyrim Mod:Actor Value Indices" lists them (the console
// names scripts use with GetActorValue and the like; each one's AVIF record, its name and
// description, is the one named "AV" + its name: AVOneHanded 0x44C, AVCarryWeight 0x3F0).
// Platform-independent.

const NAMES = `
Aggression Confidence Energy Morality Mood Assistance OneHanded TwoHanded Marksman Block
Smithing HeavyArmor LightArmor Pickpocket Lockpicking Sneak Alchemy Speechcraft Alteration
Conjuration Destruction Illusion Restoration Enchanting Health Magicka Stamina HealRate
MagickaRate StaminaRate SpeedMult InventoryWeight CarryWeight CritChance MeleeDamage
UnarmedDamage Mass VoicePoints VoiceRate DamageResist PoisonResist FireResist ElectricResist
FrostResist MagicResist DiseaseResist PerceptionCondition EnduranceCondition
LeftAttackCondition RightAttackCondition LeftMobilityCondition RightMobilityCondition
BrainCondition Paralysis Invisibility NightEye DetectLifeRange WaterBreathing WaterWalking
IgnoreCrippledLimbs Fame Infamy JumpingBonus WardPower RightItemCharge ArmorPerks ShieldPerks
WardDeflection Variable01 Variable02 Variable03 Variable04 Variable05 Variable06 Variable07
Variable08 Variable09 Variable10 BowSpeedBonus FavorActive FavorsPerDay FavorsPerDayTimer
LeftItemCharge AbsorbChance Blindness WeaponSpeedMult ShoutRecoveryMult BowStaggerBonus
Telekinesis FavorPointsBonus LastBribedIntimidated LastFlattered MovementNoiseMult
BypassVendorStolenCheck BypassVendorKeywordCheck WaitingForPlayer OneHandedMod TwoHandedMod
MarksmanMod BlockMod SmithingMod HeavyArmorMod LightArmorMod PickPocketMod LockpickingMod
SneakMod AlchemyMod SpeechcraftMod AlterationMod ConjurationMod DestructionMod IllusionMod
RestorationMod EnchantingMod OneHandedSkillAdvance TwoHandedSkillAdvance MarksmanSkillAdvance
BlockSkillAdvance SmithingSkillAdvance HeavyArmorSkillAdvance LightArmorSkillAdvance
PickPocketSkillAdvance LockpickingSkillAdvance SneakSkillAdvance AlchemySkillAdvance
SpeechcraftSkillAdvance AlterationSkillAdvance ConjurationSkillAdvance DestructionSkillAdvance
IllusionSkillAdvance RestorationSkillAdvance EnchantingSkillAdvance LeftWeaponSpeedMult
DragonSouls CombatHealthRegenMult OneHandedPowerMod TwoHandedPowerMod MarksmanPowerMod
BlockPowerMod SmithingPowerMod HeavyArmorPowerMod LightArmorPowerMod PickPocketPowerMod
LockpickingPowerMod SneakPowerMod AlchemyPowerMod SpeechcraftPowerMod AlterationPowerMod
ConjurationPowerMod DestructionPowerMod IllusionPowerMod RestorationPowerMod
EnchantingPowerMod DragonRend AttackDamageMult HealRateMult MagickaRateMult StaminaRateMult
WerewolfPerks VampirePerks GrabActorOffset Grabbed DEPRECATED05 ReflectDamage
`
  .trim()
  .split(/\s+/);

/** Names scripts also use for some (UESP lists both). */
const ALIASES: Readonly<Record<string, number>> = {
  archery: 8,
  equippeditemcharge: 64,
  equippedstaffcharge: 82,
  combathealthregenmultmod: 155,
  combathealthregenmultpowermod: 156,
};

const BY_NAME = new Map<string, number>([
  ...NAMES.map((name, index): [string, number] => [name.toLowerCase(), index]),
  ...Object.entries(ALIASES),
]);

export const ActorValue = {
  aggression: 0,
  confidence: 1,
  energy: 2,
  morality: 3,
  mood: 4,
  assistance: 5,
  /** The first of the 18 skills, in the order NPC_ DNAM and RACE DATA list them. */
  firstSkill: 6,
  health: 24,
  magicka: 25,
  stamina: 26,
  healRate: 27,
  magickaRate: 28,
  staminaRate: 29,
  speedMult: 30,
  carryWeight: 32,
  unarmedDamage: 35,
  mass: 36,
  voicePoints: 37,
  voiceRate: 38,
  dragonSouls: 133,
  healRateMult: 155,
  magickaRateMult: 156,
  staminaRateMult: 157,
} as const;

export const SKILL_COUNT = 18;

/** An actor value's index by its name (case-insensitive), or undefined. */
export function actorValueIndex(name: string): number | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export function actorValueName(index: number): string {
  return NAMES[index] ?? `ActorValue${String(index)}`;
}

export const ACTOR_VALUE_COUNT = NAMES.length;

/**
 * The editor id of an actor value's AVIF record: "AV" + its name, but Illusion's is still
 * Oblivion's AVMysticism.
 */
export function actorValueEditorId(index: number): string {
  const name = actorValueName(index);
  return `AV${name.toLowerCase() === 'illusion' ? 'Mysticism' : name}`;
}
