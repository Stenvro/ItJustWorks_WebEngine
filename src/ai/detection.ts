// Detection (docs/ai.md, "Detection"): how well an actor (the observer) notices another (the
// target), as the engine computes it (observed in the original): a base, the target's sound
// (moving in what it wears, what it does) and how well it is seen (the light on it, how it
// moves, its size, the observer's eyes), both attenuated by distance, and the observer's
// perception against the target's sneaking; the reach and the line of sight's reach off the
// observer's facing; and the levels of detection events (noises, projectiles passing). The
// settings are the load order's (Skyrim.esm stores 18 fSneak* and fDetectionSneakLightMod),
// else the engine's built-in values. Platform-independent.

/** The sound levels of WEAP VNAM, MGEF casting, IPCT and CreateDetectionEvent (xEdit). */
export const SoundLevel = { loud: 0, normal: 1, silent: 2, veryLoud: 3 } as const;

/** The game settings detection reads, with the engine's built-in values. */
export interface DetectionSettings {
  /** fSneakBaseValue: what every detection starts from. */
  readonly baseValue: number;
  /** fSneakMaxDistance: the reach of detection inside (game units). */
  readonly maxDistance: number;
  /** fSneakExteriorDistanceMult: the reach outside is this many times as far. */
  readonly exteriorDistanceMult: number;
  /** fSneakFlyingDistanceMult: a flying target is noticed this many times as far. */
  readonly flyingDistanceMult: number;
  /** fSneakDistanceAttenuationExponent. */
  readonly attenuationExponent: number;
  /** fSneakSoundsMult: how much sound counts. */
  readonly soundsMult: number;
  /** fSneakSoundLosMult: sound heard without line of sight counts this much. */
  readonly soundLosMult: number;
  /** fSneakEquippedWeightBase, fSneakEquippedWeightMult: the sound of moving in armour. */
  readonly equippedWeightBase: number;
  readonly equippedWeightMult: number;
  /** fSneakRunningMult: running (and sprinting) is this much louder. */
  readonly runningMult: number;
  /** fSneakActionMult: an action's sound level counts this much. */
  readonly actionMult: number;
  /** fSneakLightMult, fSneakLightExteriorMult (outside): how much light counts. */
  readonly lightMult: number;
  readonly lightExteriorMult: number;
  /** fDetectionSneakLightMod: added to the light level on the target. */
  readonly lightMod: number;
  /** fSneakLightMoveMult, fSneakLightRunMult: a target moving or running is seen better. */
  readonly lightMoveMult: number;
  readonly lightRunMult: number;
  /** fDetectionNightEyeBonus: the light on the target, for an observer with night eye. */
  readonly nightEyeBonus: number;
  /** fSneakStealthBoyMult: what is left of the sight of an invisible target. */
  readonly stealthBoyMult: number;
  /** fSneakDetectionSize{Small,Normal,Large,VeryLarge}: the sight of a target by its size. */
  readonly sizeMults: readonly [number, number, number, number];
  /** fSneakSkillMult: how much the skills count. */
  readonly skillMult: number;
  /** fSneakPerceptionSkillMin, Max: the observer's perception from its Sneak skill. */
  readonly perceptionMin: number;
  readonly perceptionMax: number;
  /** fSneakAlertMod, fSneakSleepMod, fSneakCombatMod: the observer's perception, alerted,
   * asleep, or in combat with the target. */
  readonly alertMod: number;
  readonly sleepMod: number;
  readonly combatMod: number;
  /** fSneakSleepBonus: what an asleep observer hears, × (1 + this) (read from the engine). */
  readonly sleepBonus: number;
  /**
   * fSneakAmbushTargetMod, fSneakAmbushNonTargetMod: the perception of an observer in ambush,
   * against its ambush's target and against another.
   */
  readonly ambushTargetMod: number;
  readonly ambushNonTargetMod: number;
  /** fDetectionLargeActorSizeMult: the sight of a target, × this and its size's mult. */
  readonly largeActorSizeMult: number;
  /**
   * fDetectProjectileDistanceNPC, Player: an observer sees a target's projectile passing this
   * near it (an NPC's, the player's).
   */
  readonly projectileDistanceNpc: number;
  readonly projectileDistancePlayer: number;
  /**
   * fDetectionUpdateTimeMinComplex, MaxComplex: the test times while the scene is complex (as
   * many actors as iAINumberActorsComplexScene or more).
   */
  readonly updateTimeMinComplex: number;
  readonly updateTimeMaxComplex: number;
  readonly complexSceneActors: number;
  /**
   * iCrimeAlarmLowRecDistance: an alarm reaches the actors of another process level than the
   * criminal's this near one who raised it (units).
   */
  readonly lowAlarmDistance: number;
  /**
   * fSneakNoticeMin: above it the observer has noticed the target (ours: the engine never reads
   * it; see noticesAt).
   */
  readonly noticeMin: number;
  /**
   * fPlayerDetectionSneakMult, Base: the player's Sneak skill counts in detection as Mult ×
   * skill + Base (detectionSkill).
   */
  readonly playerSneakMult: number;
  readonly playerSneakBase: number;
  /**
   * fDetectionCombatNonTargetDistanceMult: an observer in combat notices actors other than its
   * combat target (not the player) within this share of the reach.
   */
  readonly combatNonTargetDistanceMult: number;
  /** fDetectionViewCone: the observer's field of view (degrees, all of it). */
  readonly viewCone: number;
  /**
   * fDetectionLOSDistanceAngle (degrees off the facing): beyond it the reach of the line of
   * sight shrinks to fDetectionLOSDistanceMultInterior / Exterior straight behind (sightReach).
   */
  readonly losDistanceAngle: number;
  readonly losDistanceMultInterior: number;
  readonly losDistanceMultExterior: number;
  /** iSoundLevelLoud, Normal, Silent, VeryLoud: a sound level's loudness (by SoundLevel). */
  readonly soundLevels: readonly [number, number, number, number];
  /** fDetectionActionTimer: an action's sound lasts this long (seconds). */
  readonly actionTimer: number;
  /** fDetectionUpdateTimeMin, Max: an observer tests its targets this often (seconds). */
  readonly updateTimeMin: number;
  readonly updateTimeMax: number;
  /** fDetectionStateExpireTime: an observer searches this long for what it lost (seconds). */
  readonly stateExpireTime: number;
  /** fDetectionEventExpireTime: a detection event (a noise) lasts this long (seconds). */
  readonly eventExpireTime: number;
  /** fDetectEventDistanceNPC, Player: how far a detection event of an actor, the player, carries. */
  readonly eventDistanceNpc: number;
  readonly eventDistancePlayer: number;
  /** fDetectEventDistanceVeryLoudMult: a very loud event carries this many times as far. */
  readonly eventDistanceVeryLoudMult: number;
  /** fDetectEventSneakDistanceVeryLoud: a very loud event of one who sneaks carries this far. */
  readonly eventSneakDistanceVeryLoud: number;
  /** iDetectEventLightLevelExterior, Interior: the light an event is seen in. */
  readonly eventLightExterior: number;
  readonly eventLightInterior: number;
  /** iLightLevelExteriorMod, InteriorMod, Max: the light level (src/ai/light-level.ts). */
  readonly lightLevelExteriorMod: number;
  readonly lightLevelInteriorMod: number;
  readonly lightLevelMax: number;
  /** fAIExteriorSpectatorDetection, Interior: how far an actor notices a fight to watch it. */
  readonly spectatorDetectionExterior: number;
  readonly spectatorDetectionInterior: number;
  /** fAIExteriorSpectatorDistance, Interior: a spectator keeps this far from the fight. */
  readonly spectatorDistanceExterior: number;
  readonly spectatorDistanceInterior: number;
  /** fAISpectatorShutdownDistance: beyond this from the fight a spectator stops watching. */
  readonly spectatorShutdownDistance: number;
  /** fAISpectatorRememberThreatTimer: a spectator watches this long after the fight's last blow. */
  readonly spectatorRememberTimer: number;
  /** fCheckDeadBodyTimer: an actor looks for the dead this often (seconds). */
  readonly checkDeadBodyTimer: number;
  /** iHoursToClearCorpses: the dead are noticed this many game hours after they died. */
  readonly hoursToClearCorpses: number;
  /** fCombatSearchLocationInvestigateDistance: a searcher goes this near what it heard. */
  readonly searchInvestigateDistance: number;
  /** fCombatSearchLookTime: a searcher turns to what it noticed this long first (seconds). */
  readonly searchLookTime: number;
  /** fCombatSearchInvestigateTime: a searcher looks round this long each time (seconds). */
  readonly searchInvestigateTime: number;
  /** iCrimeAlarmRecDistance: an alarm reaches the actors this near (units). */
  readonly alarmDistance: number;
}

/**
 * Each setting's GMST and the engine's built-in value (used where the load order stores none):
 * "All Skyrim Game Settings" (see the file's comment).
 */
const SETTINGS: readonly (readonly [
  Exclude<keyof DetectionSettings, 'sizeMults' | 'soundLevels'>,
  string,
  number,
])[] = [
  ['baseValue', 'fSneakBaseValue', -25],
  ['maxDistance', 'fSneakMaxDistance', 1500],
  ['exteriorDistanceMult', 'fSneakExteriorDistanceMult', 2],
  ['flyingDistanceMult', 'fSneakFlyingDistanceMult', 2],
  ['attenuationExponent', 'fSneakDistanceAttenuationExponent', 2],
  ['soundsMult', 'fSneakSoundsMult', 1.6],
  ['soundLosMult', 'fSneakSoundLosMult', 0.25],
  ['equippedWeightBase', 'fSneakEquippedWeightBase', 12],
  ['equippedWeightMult', 'fSneakEquippedWeightMult', 0.5],
  ['runningMult', 'fSneakRunningMult', 2],
  ['actionMult', 'fSneakActionMult', 1],
  ['lightMult', 'fSneakLightMult', 1.4],
  ['lightExteriorMult', 'fSneakLightExteriorMult', 1],
  ['lightMod', 'fDetectionSneakLightMod', 0],
  ['lightMoveMult', 'fSneakLightMoveMult', 0.01],
  ['lightRunMult', 'fSneakLightRunMult', 0.2],
  ['nightEyeBonus', 'fDetectionNightEyeBonus', 3],
  ['stealthBoyMult', 'fSneakStealthBoyMult', 0],
  ['skillMult', 'fSneakSkillMult', 0.5],
  ['perceptionMin', 'fSneakPerceptionSkillMin', 10],
  ['perceptionMax', 'fSneakPerceptionSkillMax', 90],
  ['alertMod', 'fSneakAlertMod', 0.2],
  ['sleepMod', 'fSneakSleepMod', -0.2],
  ['combatMod', 'fSneakCombatMod', -0.4],
  ['sleepBonus', 'fSneakSleepBonus', -0.5],
  ['ambushTargetMod', 'fSneakAmbushTargetMod', 2.5],
  ['ambushNonTargetMod', 'fSneakAmbushNonTargetMod', -0.25],
  ['largeActorSizeMult', 'fDetectionLargeActorSizeMult', 1],
  ['projectileDistanceNpc', 'fDetectProjectileDistanceNPC', 512],
  ['projectileDistancePlayer', 'fDetectProjectileDistancePlayer', 1024],
  ['updateTimeMinComplex', 'fDetectionUpdateTimeMinComplex', 2.5],
  ['updateTimeMaxComplex', 'fDetectionUpdateTimeMaxComplex', 5],
  ['complexSceneActors', 'iAINumberActorsComplexScene', 20],
  ['lowAlarmDistance', 'iCrimeAlarmLowRecDistance', 2000],
  ['noticeMin', 'fSneakNoticeMin', -20],
  ['playerSneakMult', 'fPlayerDetectionSneakMult', 1],
  ['playerSneakBase', 'fPlayerDetectionSneakBase', 0],
  ['combatNonTargetDistanceMult', 'fDetectionCombatNonTargetDistanceMult', 0.75],
  ['viewCone', 'fDetectionViewCone', 190],
  ['losDistanceAngle', 'fDetectionLOSDistanceAngle', 60],
  ['losDistanceMultInterior', 'fDetectionLOSDistanceMultInterior', 0.75],
  ['losDistanceMultExterior', 'fDetectionLOSDistanceMultExterior', 0.5],
  ['actionTimer', 'fDetectionActionTimer', 1.2],
  ['updateTimeMin', 'fDetectionUpdateTimeMin', 1],
  ['updateTimeMax', 'fDetectionUpdateTimeMax', 2],
  ['stateExpireTime', 'fDetectionStateExpireTime', 30],
  ['eventExpireTime', 'fDetectionEventExpireTime', 5],
  ['eventDistanceNpc', 'fDetectEventDistanceNPC', 512],
  ['eventDistancePlayer', 'fDetectEventDistancePlayer', 1536],
  ['eventDistanceVeryLoudMult', 'fDetectEventDistanceVeryLoudMult', 2],
  ['eventSneakDistanceVeryLoud', 'fDetectEventSneakDistanceVeryLoud', 3072],
  ['eventLightExterior', 'iDetectEventLightLevelExterior', 75],
  ['eventLightInterior', 'iDetectEventLightLevelInterior', 225],
  ['lightLevelExteriorMod', 'iLightLevelExteriorMod', 0],
  ['lightLevelInteriorMod', 'iLightLevelInteriorMod', 50],
  ['lightLevelMax', 'iLightLevelMax', 100],
  ['spectatorDetectionExterior', 'fAIExteriorSpectatorDetection', 1000],
  ['spectatorDetectionInterior', 'fAIInteriorSpectatorDetection', 600],
  ['spectatorDistanceExterior', 'fAIExteriorSpectatorDistance', 450],
  ['spectatorDistanceInterior', 'fAIInteriorSpectatorDistance', 200],
  ['spectatorShutdownDistance', 'fAISpectatorShutdownDistance', 1000],
  ['spectatorRememberTimer', 'fAISpectatorRememberThreatTimer', 20],
  ['checkDeadBodyTimer', 'fCheckDeadBodyTimer', 20],
  ['hoursToClearCorpses', 'iHoursToClearCorpses', 24],
  ['searchInvestigateDistance', 'fCombatSearchLocationInvestigateDistance', 256],
  ['searchLookTime', 'fCombatSearchLookTime', 1],
  ['searchInvestigateTime', 'fCombatSearchInvestigateTime', 2.5],
  ['alarmDistance', 'iCrimeAlarmRecDistance', 4000],
];

/** fSneakDetectionSize* by RACE DATA size (small, medium, large, extra large). */
const SIZE_SETTINGS = [
  ['fSneakDetectionSizeSmall', 0.5],
  ['fSneakDetectionSizeNormal', 1],
  ['fSneakDetectionSizeLarge', 1.5],
  ['fSneakDetectionSizeVeryLarge', 2],
] as const;

/** iSoundLevel* by SoundLevel (loud, normal, silent, very loud). */
const SOUND_LEVEL_SETTINGS = [
  ['iSoundLevelLoud', 100],
  ['iSoundLevelNormal', 50],
  ['iSoundLevelSilent', 0],
  ['iSoundLevelVeryLoud', 200],
] as const;

/** The game settings detection reads, with their GMSTs and built-in values (tools). */
export function detectionSettingNames(): readonly (readonly [string, number])[] {
  return [
    ...SETTINGS.map(([, gmst, value]) => [gmst, value] as const),
    ...SIZE_SETTINGS,
    ...SOUND_LEVEL_SETTINGS,
  ];
}

/** Detection's settings: the load order's values, else the engine's built-in ones. */
export function readDetectionSettings(settings?: {
  number(editorId: string): number | undefined;
}): DetectionSettings {
  const read = (gmst: string, fallback: number): number => settings?.number(gmst) ?? fallback;
  const entries = SETTINGS.map(([key, gmst, value]) => [key, read(gmst, value)] as const);
  const size = SIZE_SETTINGS.map(([gmst, value]) => read(gmst, value));
  const levels = SOUND_LEVEL_SETTINGS.map(([gmst, value]) => read(gmst, value));
  return {
    ...(Object.fromEntries(entries) as Omit<DetectionSettings, 'sizeMults' | 'soundLevels'>),
    sizeMults: [size[0] ?? 0.5, size[1] ?? 1, size[2] ?? 1.5, size[3] ?? 2],
    soundLevels: [levels[0] ?? 100, levels[1] ?? 50, levels[2] ?? 0, levels[3] ?? 200],
  };
}

/** A sound level's loudness (iSoundLevel*); an unknown level is a normal one. */
export function loudness(settings: DetectionSettings, level: number): number {
  return settings.soundLevels[level] ?? settings.soundLevels[SoundLevel.normal];
}

/** How far an observer notices a target: fSneakMaxDistance, farther outside and when it flies. */
export function detectionReach(
  settings: DetectionSettings,
  exterior: boolean,
  flying = false,
): number {
  return (
    settings.maxDistance *
    (exterior ? settings.exteriorDistanceMult : 1) *
    (flying ? settings.flyingDistanceMult : 1)
  );
}

/** ((reach − distance) / reach) ^ fSneakDistanceAttenuationExponent; 0 at or beyond the reach. */
export function distanceAttenuation(
  settings: DetectionSettings,
  distance: number,
  reach: number,
): number {
  if (reach <= 0 || distance >= reach) return 0;
  return ((reach - Math.max(0, distance)) / reach) ** settings.attenuationExponent;
}

/**
 * How far an observer's sight reaches a point off the way it faces (observed in the
 * original): as far as detection reaches within fDetectionLOSDistanceAngle of its facing (the angle
 * off it, not half of it); beyond, the reach shrinks evenly to fDetectionLOSDistanceMultInterior
 * / Exterior of it straight behind. Within that reach the observer looks for a line of sight;
 * it sees the target only within half of fDetectionViewCone (inView). `off`: the angle off its
 * facing (radians, 0 .. π).
 */
export function sightReach(
  settings: DetectionSettings,
  off: number,
  reach: number,
  exterior: boolean,
): number {
  const angle = (settings.losDistanceAngle * Math.PI) / 180;
  const off_ = Math.min(Math.PI, Math.abs(off));
  if (off_ <= angle || angle >= Math.PI) return reach;
  const mult = exterior ? settings.losDistanceMultExterior : settings.losDistanceMultInterior;
  return reach * (((off_ - angle) / (Math.PI - angle)) * (mult - 1) + 1);
}

/** Whether a point `off` radians off an observer's facing is within its view cone. */
export function inViewCone(settings: DetectionSettings, off: number): boolean {
  return Math.abs(off) < (settings.viewCone * Math.PI) / 360;
}

/**
 * The angle between where an observer faces (its heading: radians clockwise from north, +Y) and
 * a point, in the horizontal plane (radians, 0 .. π).
 */
export function angleOff(heading: number, from: readonly number[], to: readonly number[]): number {
  const dx = (to[0] ?? 0) - (from[0] ?? 0);
  const dy = (to[1] ?? 0) - (from[1] ?? 0);
  if (dx === 0 && dy === 0) return 0;
  const bearing = Math.atan2(dx, dy);
  let off = bearing - heading;
  off = Math.atan2(Math.sin(off), Math.cos(off));
  return Math.abs(off);
}

/**
 * The Sneak skill detection counts for an actor: the player's is fPlayerDetectionSneakMult ×
 * skill + fPlayerDetectionSneakBase (as observer and as target), another's its skill.
 */
export function detectionSkill(
  settings: DetectionSettings,
  skill: number,
  player: boolean,
): number {
  return player ? settings.playerSneakMult * skill + settings.playerSneakBase : skill;
}

/** The observer, as detection weighs it. */
export interface Observer {
  /** Its Sneak skill (its perception), as detectionSkill counts it. */
  readonly skill: number;
  /** Asleep: it does not see, and it perceives with fSneakSleepMod, hears with fSneakSleepBonus. */
  readonly sleeping: boolean;
  /** In combat (with anyone): its perception with fSneakAlertMod. */
  readonly inCombat: boolean;
  /**
   * It has a combat target and this is another: its perception with fSneakCombatMod (its mind
   * is on its own target).
   */
  readonly otherThanTarget: boolean;
  /** Its Blindness actor value (0..100). */
  readonly blindness: number;
  /**
   * In an ambush package: against the package's target ('target': fSneakAmbushTargetMod, and it
   * hears that target as well without a line of sight) or another ('other':
   * fSneakAmbushNonTargetMod).
   */
  readonly ambush?: 'target' | 'other' | undefined;
}

/** The target, as detection weighs it. */
export interface Target {
  /** It moves of itself; it runs (or sprints). */
  readonly moving: boolean;
  readonly running: boolean;
  /** It sneaks: its skill counts against the observer's perception. */
  readonly sneaking: boolean;
  /** Its Sneak skill as detectionSkill counts it, then its perks (Mod Detection Sneak Skill). */
  readonly skill: number;
  /** The weight of the armour it wears. */
  readonly armourWeight: number;
  /** How loud its movement is (movementNoise: Muffle lowers it; 1 without). */
  readonly noiseMult: number;
  /** The loudness of its last action within fDetectionActionTimer (0: none). */
  readonly actionSound: number;
  /** The light level on it as detection sees it (detectionLight, then its perks). */
  readonly light: number;
  /**
   * How much moving and running add to its sight (1 + fSneakLightRunMult running +
   * fSneakLightMoveMult moving, then its perks: Mod Detection Movement); undefined: computed.
   */
  readonly motion?: number | undefined;
  /** Its race's size (RACE DATA: 0 small .. 3 extra large). */
  readonly size: number;
  /** Invisible (Invisibility above 0): it is not seen at all. */
  readonly invisible: boolean;
}

/** One test of an observer against a target. */
export interface DetectionInput {
  readonly observer: Observer;
  readonly target: Target;
  /** Between them (game units). */
  readonly distance: number;
  /** Detection's reach (detectionReach, × fDetectionCombatNonTargetDistanceMult if it applies). */
  readonly reach: number;
  readonly exterior: boolean;
  /** The observer has a line of sight to the target (within sightReach). */
  readonly lineOfSight: boolean;
  /** ... and the target is within its view cone (inViewCone): it can see it. */
  readonly seen: boolean;
}

/** What a test gives: the detection level and its terms. */
export interface DetectionLevel {
  readonly level: number;
  /** The target is within reach (beyond it the observer does not test it). */
  readonly inReach: boolean;
  readonly attenuation: number;
  readonly sound: number;
  readonly visual: number;
  /** The observer's perception (attenuated) less the target's sneaking, times fSneakSkillMult. */
  readonly skill: number;
}

/** PKDT package type of an Ambush package (CommonLibSSE PACKAGE_TYPE::kAmbush). */
export const AMBUSH_PACKAGE_TYPE = 9;

/**
 * How an observer's ambush weighs a target (Observer.ambush): an observer whose running package
 * is an Ambush waits for whom it would fight ('target': fSneakAmbushTargetMod, heard without a
 * line of sight too), and is less watchful of anyone else ('other': fSneakAmbushNonTargetMod).
 * Skyrim.esm has no package of that type (its ambushes are Sleep and Sit packages in ambush
 * furniture, sprung by masterAmbushScript); plugins may. TODO(M13): the Ambush package's own
 * target (TESAmbushPackageData) is not read; whom it is hostile to stands in for it.
 */
export function ambushOf(
  packageType: number | undefined,
  hostile: boolean,
): Observer['ambush'] {
  if (packageType !== AMBUSH_PACKAGE_TYPE) return undefined;
  return hostile ? 'target' : 'other';
}

/**
 * The engine's rounding of a detection level: a level between 0 and 1 is 1, else its whole part
 * (towards zero).
 */
export function wholeLevel(level: number): number {
  if (level > 0 && level < 1) return 1;
  return Math.trunc(level) || 0;
}

/**
 * The detection level of a target for an observer, as the engine computes it (observed in the original):
 *
 *   A      = (max(0, reach − distance) / reach) ^ fSneakDistanceAttenuationExponent
 *   sound  = (int(fSneakActionMult) × action loudness + (running ? fSneakRunningMult : 1) ×
 *             (fSneakEquippedWeightMult × armour + fSneakEquippedWeightBase) × noise × moving)
 *            × fSneakSoundsMult × A (× fSneakSoundLosMult without a line of sight, unless it is
 *            the observer's ambush target) × (1 + fSneakSleepBonus asleep), at least 0
 *   visual = seen × A × motion × (light × fSneakLightMult (fSneakLightExteriorMult outside) +
 *            fDetectionSneakLightMod) × (asleep ? 0 : (100 − blindness) / 100) ×
 *            fDetectionLargeActorSizeMult × fSneakDetectionSize*, at least 0 (none invisible)
 *   skill  = (A × (1 + fSneakAlertMod in combat + fSneakSleepMod asleep + fSneakCombatMod
 *            when it is not the observer's combat target + the ambush mod) × perception −
 *            sneaking × the target's skill) × fSneakSkillMult
 *   level  = fSneakBaseValue + sound + visual + skill (wholeLevel)
 *
 * perception = fSneakPerceptionSkillMin + (Max − Min) × the observer's skill / 100.
 */
export function detectionLevel(settings: DetectionSettings, input: DetectionInput): DetectionLevel {
  const { observer, target } = input;
  const inReach = input.distance < input.reach;
  const attenuation = distanceAttenuation(settings, input.distance, input.reach);
  // Sound: what it does, and moving in what it wears.
  const heard =
    input.lineOfSight || observer.ambush === 'target'
      ? attenuation
      : attenuation * settings.soundLosMult;
  const movement = target.moving
    ? (target.running ? settings.runningMult : 1) *
      (settings.equippedWeightMult * target.armourWeight + settings.equippedWeightBase) *
      Math.max(0, target.noiseMult)
    : 0;
  const action = Math.trunc(settings.actionMult) * target.actionSound;
  const sound = Math.max(
    0,
    (action + movement) *
      settings.soundsMult *
      heard *
      (1 + (observer.sleeping ? settings.sleepBonus : 0)),
  );
  // Sight: the light on it, how it moves, its size, the observer's eyes.
  let visual = 0;
  if (input.seen && !target.invisible) {
    const motion =
      target.motion ??
      1 +
        (target.running ? settings.lightRunMult : 0) +
        (target.moving ? settings.lightMoveMult : 0);
    const lightMult = input.exterior ? settings.lightExteriorMult : settings.lightMult;
    const eyes = observer.sleeping ? 0 : (100 - observer.blindness) * 0.01;
    const size = settings.sizeMults[target.size] ?? 1;
    visual = Math.max(
      0,
      attenuation *
        motion *
        (target.light * lightMult + settings.lightMod) *
        eyes *
        settings.largeActorSizeMult *
        size,
    );
  }
  // The skills: the observer's perception against the target's sneaking.
  const perception =
    settings.perceptionMin +
    (settings.perceptionMax - settings.perceptionMin) * observer.skill * 0.01;
  const mods =
    1 +
    (observer.inCombat ? settings.alertMod : 0) +
    (observer.sleeping ? settings.sleepMod : 0) +
    (observer.otherThanTarget ? settings.combatMod : 0) +
    (observer.ambush === 'target'
      ? settings.ambushTargetMod
      : observer.ambush === 'other'
        ? settings.ambushNonTargetMod
        : 0);
  const skill =
    (attenuation * mods * perception - (target.sneaking ? target.skill : 0)) * settings.skillMult;
  const level = wholeLevel(settings.baseValue + sound + visual + skill);
  return { level, inReach, attenuation, sound, visual, skill };
}

/**
 * The light level on a target as detection weighs it (observed in the original): its light (night eye: ×
 * int(fDetectionNightEyeBonus)), less iLightLevelExteriorMod outside or, inside, the lesser of
 * iLightLevelInteriorMod and 100 × the brightest channel of the cell's ambient light, between 0
 * and iLightLevelMax.
 */
export function detectionLight(
  settings: DetectionSettings,
  light: number,
  options: { readonly nightEye: boolean; readonly exterior: boolean; readonly ambient: number },
): number {
  const seen = options.nightEye ? light * Math.trunc(settings.nightEyeBonus) : light;
  const mod = options.exterior
    ? settings.lightLevelExteriorMod
    : Math.min(settings.lightLevelInteriorMod, Math.trunc(options.ambient * 100));
  return Math.min(settings.lightLevelMax, Math.max(0, Math.trunc(seen) - mod));
}

/**
 * How loud an actor's movement is for its MovementNoiseMult actor value. The engine multiplies
 * the movement's sound by the actor value (at least 0); here the value's modifiers are what
 * Muffle adds (the Muffle spell 1, the Muffle enchantment 0.5, the Muffled Movement perk's
 * ability 0.5, Silence's 1: all Peak Value Modifiers on it) and they take that share of the
 * sound off, so 1 or more is silent (UESP: Muffle "move more quietly", Silence "walking and
 * running does not affect detection"). TODO(M13): how the engine's actor value getter turns
 * the modifiers into the multiplier was not read.
 */
export function movementNoise(movementNoiseMult: number): number {
  return Math.max(0, 1 - movementNoiseMult);
}

/** Whether a detection level detects the target (above 0: the engine's DETECTED). */
export function detectsAt(level: number): boolean {
  return level > 0;
}

/**
 * Whether a detection level notices the target (above fSneakNoticeMin): ours, for the stealth
 * eye's slightly open look and the reactions to something near; the engine never reads
 * fSneakNoticeMin.
 */
export function noticesAt(settings: DetectionSettings, level: number): boolean {
  return level > settings.noticeMin;
}

/**
 * How far a detection event (a noise: CreateDetectionEvent, an impact, a weapon's swing) of a
 * target reaches an observer (observed in the original): fDetectEventDistancePlayer for the player's
 * events, fDetectEventDistanceNPC for others' (and none's), fDetectEventDistanceVeryLoudMult
 * times as far when it is very loud (its loudness iSoundLevelVeryLoud or more).
 */
export function eventDistance(
  settings: DetectionSettings,
  loudness: number,
  byPlayer: boolean,
): number {
  const veryLoud = loudness >= settings.soundLevels[SoundLevel.veryLoud];
  return (
    (byPlayer ? settings.eventDistancePlayer : settings.eventDistanceNpc) *
    (veryLoud ? settings.eventDistanceVeryLoudMult : 1)
  );
}

/**
 * The detection level of an event (a noise, or a projectile seen passing: loudness 50) for an
 * observer within eventDistance of it, as the engine computes it (observed in the original); above 0 the
 * observer knows the target is there (its detection level 0, at the event's place):
 *
 *   reach  = fSneakMaxDistance (fDetectEventSneakDistanceVeryLoud when very loud), ×
 *            fSneakExteriorDistanceMult outside
 *   A      = (max(0, reach − distance) / reach) ^ fSneakDistanceAttenuationExponent
 *   sound  = int(fSneakActionMult) × loudness × fSneakSoundsMult × A (× fSneakSoundLosMult
 *            without a line of sight to the place)
 *   visual = seen × A × (light × fSneakLightMult (outside fSneakLightExteriorMult) +
 *            fDetectionSneakLightMod) × (asleep ? 0 : 1); light: iDetectEventLightLevel*
 *   level  = fSneakBaseValue + sound + visual (wholeLevel)
 *
 * The skills do not count.
 */
export function eventLevel(
  settings: DetectionSettings,
  event: { readonly loudness: number },
  observer: { readonly sleeping: boolean },
  options: {
    readonly distance: number;
    readonly exterior: boolean;
    readonly lineOfSight: boolean;
    readonly seen: boolean;
  },
): number {
  const veryLoud = event.loudness >= settings.soundLevels[SoundLevel.veryLoud];
  const reach =
    (veryLoud ? settings.eventSneakDistanceVeryLoud : settings.maxDistance) *
    (options.exterior ? settings.exteriorDistanceMult : 1);
  const attenuation = distanceAttenuation(settings, options.distance, reach);
  const sound = Math.max(
    0,
    Math.trunc(settings.actionMult) *
      event.loudness *
      settings.soundsMult *
      attenuation *
      (options.lineOfSight ? 1 : settings.soundLosMult),
  );
  const light = options.exterior ? settings.eventLightExterior : settings.eventLightInterior;
  const lightMult = options.exterior ? settings.lightExteriorMult : settings.lightMult;
  const visual =
    options.seen && !observer.sleeping
      ? Math.max(0, attenuation * (light * lightMult + settings.lightMod))
      : 0;
  return wholeLevel(settings.baseValue + sound + visual);
}
