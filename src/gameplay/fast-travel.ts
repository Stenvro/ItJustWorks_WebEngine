// Fast travel (the map's discovered places, Game.FastTravel): whether the player may go now and
// how long the way takes. The game's messages say why not: scripts block it
// (Game.EnableFastTravel(false): sNoFastTravelScriptBlock), the place forbids it (the world's
// "can't fast travel" flag, WRLD DATA 0x2; an interior's "can't travel from here", CELL DATA
// 0x4: sNoFastTravelCell), the player is jumping or falling (sNoFastTravelInAir) or carries more
// than they can (sNoFastTravelOverencumbered). The time it takes is the time walking there would
// take (UESP, Skyrim:Time: the game estimates it from the player's movement speed, not their
// horse's or their running): the distance at the walk speed (MOVT NPCDefault, forward), times
// fFastTravelSpeedMult (1 unless a plugin sets it), at the timescale. TODO(M13): the game's own
// rounding of the hours (unknown, UESP). Not in combat (sNoFastTravelCombat), with enemies near
// (sNoFastTravelHostileActorsNear), while guards pursue the player (sNoFastTravelAlarm: crime) or
// while an effect takes their health (sFastTravelNoTravelHealthDamage). Followers and the horse
// come along (src/shell/actor-followers.ts).
// Platform-independent. Notes: docs/ui.md ("The map").

/** WRLD DATA: the world forbids fast travel. */
export const WORLD_NO_FAST_TRAVEL = 0x2;
/** CELL DATA: an interior one cannot fast travel from. */
export const CELL_NO_FAST_TRAVEL = 0x4;

/** What decides whether the player may fast travel now. */
export interface FastTravelState {
  readonly enabled: boolean;
  /** The world's or the interior's flag forbids it. */
  readonly placeForbids: boolean;
  readonly inAir: boolean;
  readonly carried: number;
  readonly carryWeight: number;
  /** Guards pursue the player (crime: src/shell/actor-crime.ts). */
  readonly pursued?: boolean;
  /** Someone fights the player (the combat AI's). */
  readonly inCombat?: boolean;
  /** Actors hostile to the player are near (src/shell/actor-stage.ts, hostilesNear). */
  readonly hostilesNear?: boolean;
  /** An effect takes the player's health now (poison, fire over time). */
  readonly takingHealthDamage?: boolean;
}

/** Why the player may not fast travel now (the game setting of its message), if not. */
export function noFastTravelReason(state: FastTravelState): string | undefined {
  if (!state.enabled) return 'sNoFastTravelScriptBlock';
  if (state.placeForbids) return 'sNoFastTravelCell';
  if (state.inAir) return 'sNoFastTravelInAir';
  if (state.carried > state.carryWeight) return 'sNoFastTravelOverencumbered';
  if (state.inCombat === true) return 'sNoFastTravelCombat';
  if (state.hostilesNear === true) return 'sNoFastTravelHostileActorsNear';
  if (state.takingHealthDamage === true) return 'sFastTravelNoTravelHealthDamage';
  if (state.pursued === true) return 'sNoFastTravelAlarm';
  return undefined;
}

/**
 * Game hours a fast travel takes: walking the distance (game units) at `walkSpeed` (units a
 * second) times `speedMult`, the game's clock running `timeScale` times real time.
 */
export function fastTravelHours(
  distance: number,
  walkSpeed: number,
  speedMult: number,
  timeScale: number,
): number {
  const speed = walkSpeed * speedMult;
  if (!(distance > 0) || !(speed > 0)) return 0;
  return (distance / speed) * (timeScale / 3600);
}

/** Where a fast travel starts or ends: a worldspace (none: an interior) and a point in it. */
export interface FastTravelEnd {
  readonly world: number | undefined;
  readonly position: readonly number[];
}

/**
 * How far a fast travel goes (game units): across the map the two places share. A city's own
 * worldspace (WhiterunWorld, SolitudeWorld) shows its parent's map and stands at the parent's
 * coordinates, so the way from the city to a place of Tamriel is measured across Tamriel's map
 * (`mapWorldOf`: the worldspace whose map a worldspace shows: its parent where it uses the
 * parent's map). Without a shared map (an interior, another land) the way is none.
 * TODO(M13): inferred from the shared coordinates; the original's own measure is not confirmed,
 * nor how it measures the way from an interior.
 */
export function fastTravelDistance(
  from: FastTravelEnd,
  to: FastTravelEnd,
  mapWorldOf: (world: number) => number,
): number {
  if (from.world === undefined || to.world === undefined) return 0;
  if (mapWorldOf(from.world) !== mapWorldOf(to.world)) return 0;
  const dx = (to.position[0] ?? 0) - (from.position[0] ?? 0);
  const dy = (to.position[1] ?? 0) - (from.position[1] ?? 0);
  return Math.hypot(dx, dy);
}
