// The game settings the actors' AI reads outside combat (docs/ai.md, "The AI's game settings"):
// package evaluation, the procedures' distances and times, followers, horses, head tracking and
// the guards' response. Each is read by its GMST name: the load order's value, else the engine's
// built-in default (the defaults and what the engine does with each were observed in the
// original, for behaviour only). Detection's settings are detection's own
// (src/ai/detection.ts); the INI's pathfinding and head tracking ones are src/world/
// ini-settings.ts's. Platform-independent.

export interface AiSettings {
  /** fEvaluatePackageTimer: an actor chooses its package again at least this often (seconds). */
  readonly evaluatePackageTimer: number;
  /**
   * fAIMaxWanderTime, fAIEngergyLevelMult, fAIEnergyLevelBase: a wandering actor pauses up to
   * (fAIMaxWanderTime − (Energy × mult + base)) / 2 seconds between its walks.
   */
  readonly maxWanderTime: number;
  readonly energyLevelMult: number;
  readonly energyLevelBase: number;
  /** fAIWanderDefaultMinDist: Wander's and Sandbox's Min Wander Distance without one (units). */
  readonly wanderDefaultMinDist: number;
  /** fAIFindBedChairsDistance: furniture is looked for this far round a place without a radius. */
  readonly findBedChairsDistance: number;
  /** fAIAcquireObjectDistance: an object is looked for this far round where it is wanted. */
  readonly acquireObjectDistance: number;
  /** fAIPatrolMinSecondsAtNormalFurniture: a patrol stays at least this long in furniture. */
  readonly patrolMinSecondsAtNormalFurniture: number;
  /** fAIEscortHysteresisWidth: an escort on its way stops this much later than it goes on. */
  readonly escortHysteresisWidth: number;
  /** fAIEscortStartStopDelayTime: an escort starts or stops at most this often (seconds). */
  readonly escortStartStopDelayTime: number;
  /**
   * fAIEscortWaitDistanceInterior, Exterior: an escort without a Distance To Wait For Followers
   * waits for them this far inside, outside this many times its destination's radius.
   */
  readonly escortWaitDistanceInterior: number;
  readonly escortWaitDistanceExterior: number;
  /**
   * fAIDistanceRadiusMinLocation, fAIMarkerDestinationRadius, fAIFurnitureDestinationRadius:
   * an actor is at a place, a marker or furniture within this (or the place's radius if larger).
   */
  readonly distanceRadiusMinLocation: number;
  readonly markerDestinationRadius: number;
  readonly furnitureDestinationRadius: number;
  /**
   * fAIMoveDistanceToRecalcTravelPath, …TravelToActor, …FollowPath: a path to a moving
   * destination (an actor) is searched again once it moved this far from where the path led.
   */
  readonly recalcTravelPath: number;
  readonly recalcTravelToActor: number;
  readonly recalcFollowPath: number;
  /** fAITrespassWarningTimer: LockDoors' warning gives the player this long (seconds). */
  readonly trespassWarningTimer: number;
  /** fBigBumpSpeed: a bump of an actor going this fast or faster is a big one (units/s). */
  readonly bigBumpSpeed: number;
  /** iNumberGuardsCrimeResponse: at most this many guards go after one criminal. */
  readonly guardsCrimeResponse: number;
  /** fFollowSpaceBetweenFollowers: one follower behind another (units). */
  readonly followSpacing: number;
  /** fFollowerSpacingAtDoors: followers coming through a door after their leader (units). */
  readonly followerSpacingAtDoors: number;
  /** fFollowStartSprintDistance: farther behind a running player a follower sprints (units). */
  readonly followStartSprintDistance: number;
  /**
   * fFollowSlowdownZoneWidth, fFollowMatchSpeedZoneWidth: Follow's minimum and maximum radius
   * without its own (the smaller is the minimum).
   */
  readonly followSlowdownZoneWidth: number;
  readonly followMatchSpeedZoneWidth: number;
  /** fFollowExtraCatchUpSpeedMult: a follower behind goes up to this much faster. */
  readonly followExtraCatchUpSpeedMult: number;
  /**
   * fFollowWalkZoneMult: a follower within this many times its maximum radius of its leader walks
   * (beyond, it runs). TODO(M13): the engine's built-in value is not read (Skyrim.esm does not
   * store it); 2, the walk zone used before.
   */
  readonly followWalkZoneMult: number;
  /**
   * fFollowWalk/RunMaxSpeedupMultiplier, …MinSlowdownMultiplier: a follower's speed stays within
   * these times its own (or its leader's), walking and running.
   */
  readonly followWalkMaxSpeedup: number;
  readonly followWalkMinSlowdown: number;
  readonly followRunMaxSpeedup: number;
  readonly followRunMinSlowdown: number;
  /** fAIHorseSearchDistance: an actor takes a horse this near (units). */
  readonly horseSearchDistance: number;
  /** fAIMaxHeadTrackDistance: another actor (the player too) is looked at this near (units). */
  readonly maxHeadTrackDistance: number;
  /** fAIMaxHeadTrackDistanceFromPC: an actor farther from the player looks at nothing by itself. */
  readonly maxHeadTrackDistanceFromPC: number;
  /** fAIMaxLargeCreatureHeadTrackDistance: both distances for an extra large race. */
  readonly maxLargeCreatureHeadTrackDistance: number;
  /** fAIHoldDefaultHeadTrackTimer: a new default look is held at least this long (seconds). */
  readonly holdDefaultHeadTrackTimer: number;
  /**
   * fAIStayonScriptHeadtrack, fAIRevertToScriptTracking: a script's look is held this long, then
   * the actor's own look for −fAIRevertToScriptTracking seconds, then the script's again.
   */
  readonly stayOnScriptHeadtrack: number;
  readonly revertToScriptTracking: number;
  /**
   * The sandbox (src/ai/sandbox.ts): an activity lasts fSandboxDurationBase game hours times its
   * kind's fSandboxDurationMult…, times (1 + fSandboxEnergyMult × its kind's fSandboxEnergyMult… ×
   * Energy), within ± fSandboxDurationRangeMult of that.
   */
  readonly sandboxDurationBase: number;
  readonly sandboxEnergyMult: number;
  readonly sandboxDurationRangeMult: number;
  /** By activity kind: sitting, sleeping, eating standing, eating sitting, wandering, idle marker, furniture. */
  readonly sandboxDurationMults: readonly number[];
  readonly sandboxEnergyMults: readonly number[];
  /** The daily plan (game hours): sleep's start and length, the meals' windows and length. */
  readonly sandboxSleepStartMin: number;
  readonly sandboxSleepStartMax: number;
  readonly sandboxSleepDurationMin: number;
  readonly sandboxSleepDurationMax: number;
  readonly sandboxBreakfastMin: number;
  readonly sandboxBreakfastMax: number;
  readonly sandboxLunchMin: number;
  readonly sandboxLunchMax: number;
  readonly sandboxDinnerMin: number;
  readonly sandboxDinnerMax: number;
  readonly sandboxMealDurationMin: number;
  readonly sandboxMealDurationMax: number;
  /** What it looks for, and how often again (real seconds), within the radius it has or this. */
  readonly sandboxSearchRadius: number;
  readonly sandboxCylinderTop: number;
  readonly sandboxCylinderBottom: number;
  readonly sandboxInterMarkerMinDist: number;
  readonly minSandboxRescanSeconds: number;
  readonly maxSandboxRescanSeconds: number;
  /** fSandBoxRadiusHysteresis: a sandboxer goes back into its place once this far outside it. */
  readonly sandboxRadiusHysteresis: number;
  /**
   * The engine's Avoid Player package: the player's swing, bow shot or projectile spell within
   * fTriggerAvoidPlayerDistance starts it; it keeps the actor fAvoidPlayerDistance from them.
   */
  readonly triggerAvoidPlayerDistance: number;
  readonly avoidPlayerDistance: number;
  /** The process lists' update budget (ms a frame) by frame rate ([General] INI settings). */
  readonly processListsUpdateTimeMin: number;
  readonly processListsUpdateTimeMax: number;
  readonly processListsUpdateLowFrameRate: number;
  readonly processListsUpdateHighFrameRate: number;
}

/** The sandbox's activity kinds, in the engine's order (its settings tables by kind). */
const SANDBOX_KINDS = [
  'Sitting',
  'Sleeping',
  'EatStanding',
  'EatSitting',
  'Wandering',
  'IdleMarker',
  'Furniture',
] as const;
/** fSandboxDurationMult… and fSandboxEnergyMult… built-in values by kind (the engine's defaults). */
const SANDBOX_DURATION_MULTS = [2, 2, 0.75, 0.75, 0.5, 1, 2];
const SANDBOX_ENERGY_MULTS = [-0.1, -0.1, -0.05, -0.05, 0.2, 0.05, -0.1];

/** Each setting's GMST and the engine's built-in value (the load order's value first). */
const SETTINGS: readonly (readonly [keyof AiSettings, string, number])[] = [
  ['evaluatePackageTimer', 'fEvaluatePackageTimer', 15],
  ['maxWanderTime', 'fAIMaxWanderTime', 100],
  ['energyLevelMult', 'fAIEngergyLevelMult', 1],
  ['energyLevelBase', 'fAIEnergyLevelBase', 0],
  ['wanderDefaultMinDist', 'fAIWanderDefaultMinDist', 200],
  ['findBedChairsDistance', 'fAIFindBedChairsDistance', 8000],
  ['acquireObjectDistance', 'fAIAcquireObjectDistance', 4000],
  ['patrolMinSecondsAtNormalFurniture', 'fAIPatrolMinSecondsAtNormalFurniture', 30],
  ['escortHysteresisWidth', 'fAIEscortHysteresisWidth', 50],
  ['escortStartStopDelayTime', 'fAIEscortStartStopDelayTime', 1],
  ['escortWaitDistanceInterior', 'fAIEscortWaitDistanceInterior', 512],
  ['escortWaitDistanceExterior', 'fAIEscortWaitDistanceExterior', 2],
  ['distanceRadiusMinLocation', 'fAIDistanceRadiusMinLocation', 100],
  ['markerDestinationRadius', 'fAIMarkerDestinationRadius', 25],
  ['furnitureDestinationRadius', 'fAIFurnitureDestinationRadius', 25],
  ['recalcTravelPath', 'fAIMoveDistanceToRecalcTravelPath', 300],
  ['recalcTravelToActor', 'fAIMoveDistanceToRecalcTravelToActor', 100],
  ['recalcFollowPath', 'fAIMoveDistanceToRecalcFollowPath', 300],
  ['trespassWarningTimer', 'fAITrespassWarningTimer', 10],
  ['bigBumpSpeed', 'fBigBumpSpeed', 600],
  ['guardsCrimeResponse', 'iNumberGuardsCrimeResponse', 4],
  ['followSpacing', 'fFollowSpaceBetweenFollowers', 100],
  ['followerSpacingAtDoors', 'fFollowerSpacingAtDoors', 200],
  ['followStartSprintDistance', 'fFollowStartSprintDistance', 500],
  ['followSlowdownZoneWidth', 'fFollowSlowdownZoneWidth', 150],
  ['followMatchSpeedZoneWidth', 'fFollowMatchSpeedZoneWidth', 128],
  ['followExtraCatchUpSpeedMult', 'fFollowExtraCatchUpSpeedMult', 0.2],
  ['followWalkZoneMult', 'fFollowWalkZoneMult', 2],
  ['followWalkMaxSpeedup', 'fFollowWalkMaxSpeedupMultiplier', 1.5],
  ['followWalkMinSlowdown', 'fFollowWalkMinSlowdownMultiplier', 0.75],
  ['followRunMaxSpeedup', 'fFollowRunMaxSpeedupMultiplier', 1.25],
  ['followRunMinSlowdown', 'fFollowRunMinSlowdownMultiplier', 0.9],
  ['horseSearchDistance', 'fAIHorseSearchDistance', 3000],
  ['maxHeadTrackDistance', 'fAIMaxHeadTrackDistance', 400],
  ['maxHeadTrackDistanceFromPC', 'fAIMaxHeadTrackDistanceFromPC', 2000],
  ['maxLargeCreatureHeadTrackDistance', 'fAIMaxLargeCreatureHeadTrackDistance', 12000],
  ['holdDefaultHeadTrackTimer', 'fAIHoldDefaultHeadTrackTimer', 5],
  ['stayOnScriptHeadtrack', 'fAIStayonScriptHeadtrack', 20],
  ['revertToScriptTracking', 'fAIRevertToScriptTracking', -3],
  ['sandboxDurationBase', 'fSandboxDurationBase', 0.02],
  ['sandboxEnergyMult', 'fSandboxEnergyMult', 0.05],
  ['sandboxDurationRangeMult', 'fSandboxDurationRangeMult', 0.25],
  ['sandboxSleepStartMin', 'fSandboxSleepStartMin', 19],
  ['sandboxSleepStartMax', 'fSandboxSleepStartMax', 1],
  ['sandboxSleepDurationMin', 'fSandboxSleepDurationMin', 6],
  ['sandboxSleepDurationMax', 'fSandboxSleepDurationMax', 10],
  ['sandboxBreakfastMin', 'fSandboxBreakfastMin', 6],
  ['sandboxBreakfastMax', 'fSandboxBreakfastMax', 9],
  ['sandboxLunchMin', 'fSandboxLunchMin', 11.5],
  ['sandboxLunchMax', 'fSandboxLunchMax', 12.5],
  ['sandboxDinnerMin', 'fSandboxDinnerMin', 18],
  ['sandboxDinnerMax', 'fSandboxDinnerMax', 19],
  ['sandboxMealDurationMin', 'fSandboxMealDurationMin', 0.1],
  ['sandboxMealDurationMax', 'fSandboxMealDurationMax', 0.25],
  ['sandboxSearchRadius', 'fSandBoxSearchRadius', 6000],
  ['sandboxCylinderTop', 'fSandboxCylinderTop', 150],
  ['sandboxCylinderBottom', 'fSandboxCylinderBottom', -50],
  ['sandboxInterMarkerMinDist', 'fSandBoxInterMarkerMinDist', 100],
  ['minSandboxRescanSeconds', 'fMinSandboxRescanSeconds', 3],
  ['maxSandboxRescanSeconds', 'fMaxSandboxRescanSeconds', 6],
  // TODO(M13): the engine's built-in value (Skyrim.esm sets 50).
  ['sandboxRadiusHysteresis', 'fSandBoxRadiusHysteresis', 50],
  ['triggerAvoidPlayerDistance', 'fTriggerAvoidPlayerDistance', 400],
  ['avoidPlayerDistance', 'fAvoidPlayerDistance', 100],
  ['processListsUpdateTimeMin', 'fProcessListsUpdateTimeMin:General', 0.5],
  ['processListsUpdateTimeMax', 'fProcessListsUpdateTimeMax:General', 5],
  ['processListsUpdateLowFrameRate', 'fProcessListsUpdateLowFrameRate:General', 10],
  ['processListsUpdateHighFrameRate', 'fProcessListsUpdateHighFrameRate:General', 30],
];

/** The settings by kind (fSandboxDurationMultSitting, ...), the load order's values first. */
const SANDBOX_TABLES: readonly (readonly [
  'sandboxDurationMults' | 'sandboxEnergyMults',
  string,
  readonly number[],
])[] = [
  ['sandboxDurationMults', 'fSandboxDurationMult', SANDBOX_DURATION_MULTS],
  ['sandboxEnergyMults', 'fSandboxEnergyMult', SANDBOX_ENERGY_MULTS],
];

/** The settings by the load order's values (`number`: a GMST's value, if it has one). */
export function readAiSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): AiSettings {
  const entries: (readonly [string, number | readonly number[]])[] = [
    ...SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback] as const),
    ...SANDBOX_TABLES.map(
      ([key, prefix, fallbacks]) =>
        [
          key,
          SANDBOX_KINDS.map((kind, i) => number(`${prefix}${kind}`) ?? fallbacks[i] ?? 1),
        ] as const,
    ),
  ];
  return Object.fromEntries(entries) as unknown as AiSettings;
}

/** The engine's built-in values (until the load order's are read). */
export const AI_DEFAULTS = readAiSettings();

/** The GMST names with their built-in values (tools). */
export function aiSettingNames(): readonly (readonly [string, number])[] {
  return SETTINGS.map(([, name, value]) => [name, value] as const);
}

/** Where the game settings come from (the session's GMSTs). */
export interface AiSettingsSource {
  settings(): Promise<{ number(editorId: string): number | undefined }>;
}

const read = new WeakMap<AiSettingsSource, { value: AiSettings }>();

/**
 * A source's AI settings: the built-in values until its game settings are read (asked once per
 * source), the load order's after.
 */
export function aiSettingsOf(source: AiSettingsSource): AiSettings {
  let entry = read.get(source);
  if (!entry) {
    const kept = { value: AI_DEFAULTS };
    entry = kept;
    read.set(source, kept);
    source.settings().then(
      (settings) => {
        kept.value = readAiSettings((name) => settings.number(name));
      },
      () => undefined,
    );
  }
  return entry.value;
}
