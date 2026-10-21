// Detection (docs/ai.md, "Detection"): how well an actor (the observer) notices another (the
// target), as the engine's detection formula has it. UESP "Skyrim:Sneak" gives its terms and
// their game settings: a base, the target's sound and the visual factor attenuated by distance
// ((reach − distance) / reach to fSneakDistanceAttenuationExponent), and the skills of the two;
// the sound of moving (fSneakEquippedWeightBase + fSneakEquippedWeightMult × the armour worn,
// times fSneakRunningMult running) and of actions (their sound level times fSneakActionMult),
// less without line of sight (fSneakSoundLosMult). What UESP leaves open (the visual factor,
// the skill factors) is the predecessor engine's documented formula with Skyrim's settings:
// The Fallout Wiki, "Detection Formula" (light: (fDetectionSneakLightMod + light level, times
// fDetectionNightEyeBonus with night eye) × fSneakLightMult, movement 1 + fSneakLightMoveMult
// moving + fSneakLightRunMult running, blindness, Stealth Boy; the observer's perception between
// fSneakPerceptionSkillMin and Max with fSneakAlertMod, fSneakSleepBonus and fSneakCombatMod)
// and the Construction Set wiki, "Detection" (Oblivion: the reach, fSneakMaxDistance times
// fSneakExteriorDistanceMult outside; the target's skill counting only while it sneaks out of
// combat; no sight while asleep). The settings are the load order's (Skyrim.esm stores 18
// fSneak* and fDetectionSneakLightMod), else the engine's own: the list of every SSE setting
// with its built-in value ("All Skyrim Game Settings", BeermotorWB's gist linked from AFK
// Mods' "TES5: All GMSTs and INI Settings"). Platform-independent.

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
  /** fSneakAlertMod, fSneakSleepBonus, fSneakCombatMod: the observer's perception, alerted,
   * asleep, or in combat with the target. */
  readonly alertMod: number;
  readonly sleepBonus: number;
  readonly combatMod: number;
  /** fSneakNoticeMin: above it the observer has noticed the target. */
  readonly noticeMin: number;
  /** iAICombatMinDetection: in combat with the target, it detects it down to this. */
  readonly combatMinDetection: number;
  /** fDetectionViewCone: the observer's field of view (degrees, all of it). */
  readonly viewCone: number;
  /**
   * fDetectionLOSDistanceAngle (degrees, all of it): beyond it, to the edge of the view cone,
   * sight reaches fDetectionLOSDistanceMultInterior / Exterior as far.
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
  ['baseValue', 'fSneakBaseValue', -15],
  ['maxDistance', 'fSneakMaxDistance', 2500],
  ['exteriorDistanceMult', 'fSneakExteriorDistanceMult', 2.1],
  ['flyingDistanceMult', 'fSneakFlyingDistanceMult', 3],
  ['attenuationExponent', 'fSneakDistanceAttenuationExponent', 2],
  ['soundsMult', 'fSneakSoundsMult', 1],
  ['soundLosMult', 'fSneakSoundLosMult', 0.4],
  ['equippedWeightBase', 'fSneakEquippedWeightBase', 12],
  ['equippedWeightMult', 'fSneakEquippedWeightMult', 0.5],
  ['runningMult', 'fSneakRunningMult', 2],
  ['actionMult', 'fSneakActionMult', 2],
  ['lightMult', 'fSneakLightMult', 0.33],
  ['lightExteriorMult', 'fSneakLightExteriorMult', 0.5],
  ['lightMod', 'fDetectionSneakLightMod', 15],
  ['lightMoveMult', 'fSneakLightMoveMult', 0.01],
  ['lightRunMult', 'fSneakLightRunMult', 0.2],
  ['nightEyeBonus', 'fDetectionNightEyeBonus', 3],
  ['stealthBoyMult', 'fSneakStealthBoyMult', 0],
  ['skillMult', 'fSneakSkillMult', 0.4],
  ['perceptionMin', 'fSneakPerceptionSkillMin', 0],
  ['perceptionMax', 'fSneakPerceptionSkillMax', 100],
  ['alertMod', 'fSneakAlertMod', 0],
  ['sleepBonus', 'fSneakSleepBonus', 0],
  ['combatMod', 'fSneakCombatMod', -0.4],
  ['noticeMin', 'fSneakNoticeMin', -20],
  ['combatMinDetection', 'iAICombatMinDetection', -50],
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
  ['lightLevelInteriorMod', 'iLightLevelInteriorMod', 25],
  ['lightLevelMax', 'iLightLevelMax', 300],
  ['spectatorDetectionExterior', 'fAIExteriorSpectatorDetection', 1000],
  ['spectatorDetectionInterior', 'fAIInteriorSpectatorDetection', 600],
  ['spectatorDistanceExterior', 'fAIExteriorSpectatorDistance', 450],
  ['spectatorDistanceInterior', 'fAIInteriorSpectatorDistance', 200],
  ['spectatorShutdownDistance', 'fAISpectatorShutdownDistance', 1000],
  ['spectatorRememberTimer', 'fAISpectatorRememberThreatTimer', 5],
  ['checkDeadBodyTimer', 'fCheckDeadBodyTimer', 20],
  ['hoursToClearCorpses', 'iHoursToClearCorpses', 24],
  ['searchInvestigateDistance', 'fCombatSearchLocationInvestigateDistance', 256],
  ['searchLookTime', 'fCombatSearchLookTime', 1],
  ['searchInvestigateTime', 'fCombatSearchInvestigateTime', 2.5],
  ['alarmDistance', 'iCrimeAlarmRecDistance', 2300],
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
  ['iSoundLevelSilent', 10],
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
    soundLevels: [levels[0] ?? 100, levels[1] ?? 50, levels[2] ?? 10, levels[3] ?? 200],
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
 * How far an observer's sight reaches a point off the way it faces: as far as detection reaches
 * within fDetectionLOSDistanceAngle of its facing; beyond it, to the edge of its view cone
 * (fDetectionViewCone), fDetectionLOSDistanceMultInterior / Exterior as far; behind it, not at
 * all. `off`: the angle off its facing (radians). TODO(M13): whether the engine's angles are
 * whole (as read here: 190° is beyond the half circle) and how it narrows the reach is not
 * documented.
 */
export function sightReach(
  settings: DetectionSettings,
  off: number,
  reach: number,
  exterior: boolean,
): number {
  const degrees = (Math.abs(off) * 180) / Math.PI;
  if (degrees <= settings.losDistanceAngle / 2) return reach;
  if (degrees > settings.viewCone / 2) return 0;
  return reach * (exterior ? settings.losDistanceMultExterior : settings.losDistanceMultInterior);
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

/** The observer, as detection weighs it. */
export interface Observer {
  /** Its Sneak skill (its perception). */
  readonly skill: number;
  /** Asleep: it does not see. */
  readonly sleeping: boolean;
  /** Alerted (searching for something it noticed or heard). */
  readonly alerted: boolean;
  /** In combat with this target. */
  readonly combatTarget: boolean;
  /** Its Blindness actor value (0..100). */
  readonly blindness: number;
  /** It has night eye (NightEye actor value above 0). */
  readonly nightEye: boolean;
  /** Its perks' factors on the sight and the movement sound (Mod Detection Light, Movement). */
  readonly lightMult?: number;
  readonly movementMult?: number;
}

/** The target, as detection weighs it. */
export interface Target {
  /** It moves of itself; it runs (or sprints). */
  readonly moving: boolean;
  readonly running: boolean;
  /** It sneaks (its skill counts), in combat (its skill does not). */
  readonly sneaking: boolean;
  readonly inCombat: boolean;
  /** It swims (no sound). */
  readonly swimming: boolean;
  /** Its Sneak skill. */
  readonly skill: number;
  /** The weight of the armour it wears. */
  readonly armourWeight: number;
  /** MovementNoiseMult (muffled movement lowers it; 1 without). */
  readonly noiseMult: number;
  /** The loudness of its last action within fDetectionActionTimer (0: none). */
  readonly actionSound: number;
  /** The light level on it (src/ai/light-level.ts). */
  readonly light: number;
  /** Its race's size (RACE DATA: 0 small .. 3 extra large). */
  readonly size: number;
  /** Invisible (Invisibility above 0): it is not seen. */
  readonly invisible: boolean;
}

/** One test of an observer against a target. */
export interface DetectionInput {
  readonly observer: Observer;
  readonly target: Target;
  /** Between them (game units). */
  readonly distance: number;
  /** Detection's reach (detectionReach). */
  readonly reach: number;
  readonly exterior: boolean;
  /** Nothing is in the way between them (eye to eye: sound heard and the target seen). */
  readonly lineOfSight: boolean;
  /** The target is within the observer's sight (sightReach) and nothing is in the way. */
  readonly seen: boolean;
}

/** What a test gives: the detection level and its terms (before the distance attenuates them). */
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

/**
 * The detection level of a target for an observer:
 *
 *   level = fSneakBaseValue + attenuation × (sound + visual)
 *           + fSneakSkillMult × (perception × attenuation − the target's Sneak while sneaking)
 *
 * sound = fSneakSoundsMult × (moving: (fSneakEquippedWeightBase + fSneakEquippedWeightMult ×
 *   armour) × fSneakRunningMult running × MovementNoiseMult; + the action's sound level ×
 *   fSneakActionMult), × fSneakSoundLosMult without line of sight; none swimming.
 * visual (seen, awake) = fSneakLightMult (× fSneakLightExteriorMult outside) ×
 *   (fDetectionSneakLightMod + light, × fDetectionNightEyeBonus with night eye) ×
 *   (1 + fSneakLightMoveMult moving + fSneakLightRunMult running) × size × (1 − blindness/100),
 *   × fSneakStealthBoyMult invisible.
 * perception = the observer's Sneak between fSneakPerceptionSkillMin and Max, × (1 +
 *   fSneakAlertMod alerted + fSneakSleepBonus asleep + fSneakCombatMod in combat with it).
 *
 * UESP writes the observer's skill twice (attenuated, and again unattenuated against the
 * target's); with it an observer of middling skill would detect a sneaking target in the dark,
 * unseen and unheard, anywhere within reach. The predecessor engine's documented formula has it
 * once, as here. TODO(M13): the engine's own terms are not documented (Stealth perks, muffle:
 * M11).
 */
export function detectionLevel(settings: DetectionSettings, input: DetectionInput): DetectionLevel {
  const { observer, target } = input;
  const inReach = input.distance < input.reach;
  const attenuation = distanceAttenuation(settings, input.distance, input.reach);
  // Sound: moving in what it wears, and what it does.
  const movement = target.moving
    ? (settings.equippedWeightBase + settings.equippedWeightMult * target.armourWeight) *
      (target.running ? settings.runningMult : 1) *
      target.noiseMult *
      (observer.movementMult ?? 1)
    : 0;
  const action = target.actionSound * settings.actionMult;
  const sound = target.swimming
    ? 0
    : settings.soundsMult * (movement + action) * (input.lineOfSight ? 1 : settings.soundLosMult);
  // Sight: the light on it, how it moves, its size, the observer's eyes.
  let visual = 0;
  if (input.seen && !observer.sleeping) {
    const light =
      settings.lightMod + target.light * (observer.nightEye ? settings.nightEyeBonus : 1);
    const motion =
      1 +
      (target.moving ? settings.lightMoveMult : 0) +
      (target.moving && target.running ? settings.lightRunMult : 0);
    const size = settings.sizeMults[target.size] ?? 1;
    const blindness = Math.min(1, Math.max(0, 1 - observer.blindness / 100));
    visual =
      settings.lightMult *
      (input.exterior ? settings.lightExteriorMult : 1) *
      light *
      motion *
      size *
      blindness *
      (observer.lightMult ?? 1) *
      (target.invisible ? settings.stealthBoyMult : 1);
    visual = Math.max(0, visual);
  }
  // The skills: the observer's perception against the target's sneaking.
  const perception =
    Math.min(settings.perceptionMax, Math.max(settings.perceptionMin, observer.skill)) *
    (1 +
      (observer.alerted ? settings.alertMod : 0) +
      (observer.sleeping ? settings.sleepBonus : 0) +
      (observer.combatTarget ? settings.combatMod : 0));
  const sneaker = target.sneaking && !target.inCombat ? target.skill : 0;
  const skill = settings.skillMult * (perception * attenuation - sneaker);
  const level = settings.baseValue + attenuation * (sound + visual) + skill;
  return { level, inReach, attenuation, sound, visual, skill };
}

/**
 * Whether a detection level detects the target: above 0, or in combat with it above
 * iAICombatMinDetection (Construction Set wiki, "Detection": the thresholds).
 */
export function detectsAt(settings: DetectionSettings, level: number, combat = false): boolean {
  return level > (combat ? settings.combatMinDetection : 0);
}

/** Whether a detection level notices the target (above fSneakNoticeMin). */
export function noticesAt(settings: DetectionSettings, level: number): boolean {
  return level > settings.noticeMin;
}

/**
 * How loud a detection event (a noise: CreateDetectionEvent, an impact, a weapon's swing) is
 * for an observer, and how far it carries: fDetectEventDistancePlayer for the player's events,
 * fDetectEventDistanceNPC for others' (and none's), fDetectEventDistanceVeryLoudMult times as
 * far very loud, fDetectEventSneakDistanceVeryLoud very loud from one who sneaks. Its level is
 * fSneakBaseValue + its loudness (iSoundLevel*) × fSneakSoundsMult, × fSneakSoundLosMult
 * unheard in the line of sight, attenuated over its reach, + the observer's perception
 * (attenuated) × fSneakSkillMult. TODO(M13): how the engine weighs events is not documented.
 */
export function eventLevel(
  settings: DetectionSettings,
  event: {
    readonly soundLevel: number;
    readonly byPlayer: boolean;
    readonly sneaking: boolean;
  },
  observer: Observer,
  distance: number,
  lineOfSight: boolean,
): { readonly level: number; readonly reach: number } {
  const veryLoud = event.soundLevel === SoundLevel.veryLoud;
  const reach =
    veryLoud && event.sneaking
      ? settings.eventSneakDistanceVeryLoud
      : (event.byPlayer ? settings.eventDistancePlayer : settings.eventDistanceNpc) *
        (veryLoud ? settings.eventDistanceVeryLoudMult : 1);
  const attenuation = distanceAttenuation(settings, distance, reach);
  if (attenuation <= 0) return { level: -Infinity, reach };
  const sound =
    loudness(settings, event.soundLevel) *
    settings.soundsMult *
    (lineOfSight ? 1 : settings.soundLosMult);
  const perception = Math.min(
    settings.perceptionMax,
    Math.max(settings.perceptionMin, observer.skill),
  );
  const level =
    settings.baseValue + attenuation * sound + settings.skillMult * perception * attenuation;
  return { level, reach };
}
