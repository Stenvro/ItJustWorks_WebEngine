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
}

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
];

/** The settings by the load order's values (`number`: a GMST's value, if it has one). */
export function readAiSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): AiSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as AiSettings;
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
