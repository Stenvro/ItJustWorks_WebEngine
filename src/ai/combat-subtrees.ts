// The combat tree's places and choices beyond close movement (docs/ai.md, "The combat behaviour
// tree"): where a searcher looks, the shore a swimmer makes for, the cover a shooter or a fleeing
// actor takes, the door it flees through, the weapon an unarmed fighter picks up, the low
// process's blows, and which of its casters (ward, restore, summon, reanimate, buff) it uses.
// The tree's shape was observed in the original (combat-tree.ts); the rules here are built on
// the engine's game settings by name (fCombatSearch*, fCombatCover*, fCombatFlee*,
// fCombatAcquireWeapon*, fCombatLow*, fCombatMagic*, fCombatRestoreStopCastThreshold). Where the
// engine's use of a setting was not read, ours is marked TODO(M13). Platform-independent.

import {
  NavmeshFlag,
  NavmeshLinkType,
  navmeshTriangle,
  triangleNeighbour,
  type Navmesh,
} from '../world/navmesh.ts';
import type { NavmeshSet } from './pathfinding.ts';

type Vec3 = readonly [number, number, number];

export interface CombatSubtreeSettings {
  readonly searchStartWaitTime: number;
  readonly searchExteriorRadiusMin: number;
  readonly searchExteriorRadiusMax: number;
  readonly searchInteriorRadiusMin: number;
  readonly searchInteriorRadiusMax: number;
  readonly searchWanderDistance: number;
  readonly searchLookTime: number;
  readonly searchDoorDistance: number;
  readonly coverSearchDistanceMin: number;
  readonly coverSearchDistanceMax: number;
  readonly coverMinimumRange: number;
  readonly coverMaxRangeMult: number;
  readonly coverRangeMinBufferDistance: number;
  readonly coverRangeMaxBufferDistance: number;
  readonly coverMidPointMaxRangeBuffer: number;
  readonly coverCheckHeightOffset: number;
  readonly coverEdgeOffsetDistance: number;
  readonly coverLedgeOffsetDistance: number;
  readonly coverAttackOffsetDistance: number;
  readonly coverSecondaryThreatMinDistance: number;
  readonly coverCheckHeightMin: number;
  readonly coverAvoidTargetRadius: number;
  readonly coverWaitTimeMin: number;
  readonly coverWaitTimeMid: number;
  readonly coverWaitTimeMax: number;
  readonly coverAttackTimeMin: number;
  readonly coverAttackTimeMid: number;
  readonly coverAttackTimeMax: number;
  readonly coverSearchFailedDelay: number;
  readonly fleeUseDoorChance: number;
  readonly fleeDoorDistanceMax: number;
  readonly fleeDoorTargetCheckDistance: number;
  readonly fleeUseDoorRestrictTime: number;
  readonly fleeLastDoorRestrictTime: number;
  readonly hideFailedTargetDistance: number;
  readonly hideFailedTargetLosDistance: number;
  readonly fleeCoverMinDistance: number;
  readonly fleeCoverSearchRadius: number;
  readonly acquireUnarmedDistanceMin: number;
  readonly acquireUnarmedDistanceMax: number;
  readonly acquireDisarmedDistanceMin: number;
  readonly acquireDisarmedDistanceMax: number;
  readonly acquireScoreCostMult: number;
  readonly acquireMeleeScoreMult: number;
  readonly acquireMinimumScoreMult: number;
  readonly acquireMinimumTargetDistance: number;
  readonly acquireReachDistance: number;
  readonly acquireSearchFailedDelay: number;
  readonly acquireSearchSuccessDelay: number;
  readonly acquirePickupAnimationDelay: number;
  readonly lowTargetHitPercent: number;
  readonly lowFleeingTargetHitPercent: number;
  readonly lowMaxAttackDistance: number;
  readonly unreachableTargetCheckTime: number;
  readonly rangedDistance: number;
  readonly dualCastInterruptTime: number;
  readonly restoreStopCastThreshold: number;
  readonly wardMinCastTime: number;
  readonly wardCooldownTime: number;
  readonly wardMagickaCastLimit: number;
  readonly summonRestrictTime: number;
  readonly reanimateDistance: number;
  readonly reanimateRestrictTime: number;
}

const SETTINGS: readonly (readonly [keyof CombatSubtreeSettings, string, number])[] = [
  ['searchStartWaitTime', 'fCombatSearchStartWaitTime', 1],
  ['searchExteriorRadiusMin', 'fCombatSearchExteriorRadiusMin', 1280],
  ['searchExteriorRadiusMax', 'fCombatSearchExteriorRadiusMax', 2048],
  ['searchInteriorRadiusMin', 'fCombatSearchInteriorRadiusMin', 768],
  ['searchInteriorRadiusMax', 'fCombatSearchInteriorRadiusMax', 1280],
  ['searchWanderDistance', 'fCombatSearchWanderDistance', 512],
  ['searchLookTime', 'fCombatSearchLookTime', 1],
  ['searchDoorDistance', 'fCombatSearchDoorDistance', 384],
  ['coverSearchDistanceMin', 'fCombatCoverSearchDistanceMin', 1536],
  ['coverSearchDistanceMax', 'fCombatCoverSearchDistanceMax', 3072],
  ['coverMinimumRange', 'fCombatCoverMinimumRange', 768],
  ['coverMaxRangeMult', 'fCombatCoverMaxRangeMult', 1.5],
  ['coverCheckHeightMin', 'fCombatCoverCheckCoverHeightMin', 64],
  ['coverAvoidTargetRadius', 'fCombatCoverAvoidTargetRadius', 256],
  ['coverWaitTimeMin', 'fCombatCoverWaitTimeMin', 1.5],
  ['coverWaitTimeMid', 'fCombatCoverWaitTimeMid', 2.5],
  ['coverWaitTimeMax', 'fCombatCoverWaitTimeMax', 5],
  ['coverAttackTimeMin', 'fCombatCoverAttackTimeMin', 2],
  ['coverAttackTimeMid', 'fCombatCoverAttackTimeMid', 4],
  ['coverAttackTimeMax', 'fCombatCoverAttackTimeMax', 8],
  ['coverSearchFailedDelay', 'fCombatCoverSearchFailedDelay', 5],
  ['fleeUseDoorChance', 'fCombatFleeUseDoorChance', 0.33],
  ['fleeDoorDistanceMax', 'fCombatFleeDoorDistanceMax', 1024],
  ['fleeDoorTargetCheckDistance', 'fCombatFleeDoorTargetCheckDistance', 128],
  ['fleeUseDoorRestrictTime', 'fCombatFleeUseDoorRestrictTime', 15],
  ['fleeLastDoorRestrictTime', 'fCombatFleeLastDoorRestrictTime', 30],
  ['hideFailedTargetDistance', 'fCombatHideFailedTargetDistance', 128],
  ['hideFailedTargetLosDistance', 'fCombatHideFailedTargetLOSDistance', 384],
  ['coverRangeMinBufferDistance', 'fCombatCoverRangeMinBufferDistance', 512],
  ['coverRangeMaxBufferDistance', 'fCombatCoverRangeMaxBufferDistance', 768],
  ['coverMidPointMaxRangeBuffer', 'fCombatCoverMidPointMaxRangeBuffer', 256],
  ['coverCheckHeightOffset', 'fCombatCoverCheckCoverHeightOffset', 32],
  ['coverEdgeOffsetDistance', 'fCombatCoverEdgeOffsetDistance', 16],
  ['coverLedgeOffsetDistance', 'fCombatCoverLedgeOffsetDistance', 128],
  ['coverAttackOffsetDistance', 'fCombatCoverAttackOffsetDistance', 16],
  ['coverSecondaryThreatMinDistance', 'fCombatCoverSecondaryThreatMinDistance', 512],
  ['fleeCoverMinDistance', 'fCombatFleeCoverMinDistance', 1024],
  ['fleeCoverSearchRadius', 'fCombatFleeCoverSearchRadius', 3072],
  ['acquireUnarmedDistanceMin', 'fCombatAcquireWeaponUnarmedDistanceMin', 256],
  ['acquireUnarmedDistanceMax', 'fCombatAcquireWeaponUnarmedDistanceMax', 2048],
  ['acquireDisarmedDistanceMin', 'fCombatAcquireWeaponDisarmedDistanceMin', 512],
  ['acquireDisarmedDistanceMax', 'fCombatAcquireWeaponDisarmedDistanceMax', 2048],
  ['acquireScoreCostMult', 'fCombatAcquireWeaponScoreCostMult', 4096],
  ['acquireMeleeScoreMult', 'fCombatAcquireWeaponMeleeScoreMult', 0.5],
  ['acquireMinimumScoreMult', 'fCombatAcquireWeaponMinimumScoreMult', 1.5],
  ['acquireMinimumTargetDistance', 'fCombatAcquireWeaponMinimumTargetDistance', 384],
  ['acquireReachDistance', 'fCombatAcquireWeaponReachDistance', 48],
  ['acquireSearchFailedDelay', 'fCombatAcquireWeaponSearchFailedDelay', 5],
  ['acquireSearchSuccessDelay', 'fCombatAcquireWeaponSearchSuccessDelay', 15],
  ['acquirePickupAnimationDelay', 'fCombatAcquirePickupAnimationDelay', 1],
  ['lowTargetHitPercent', 'fCombatLowTargetHitPercent', 0.5],
  ['lowFleeingTargetHitPercent', 'fCombatLowFleeingTargetHitPercent', 0.25],
  ['lowMaxAttackDistance', 'fCombatLowMaxAttackDistance', 2048],
  ['unreachableTargetCheckTime', 'fCombatUnreachableTargetCheckTime', 3],
  ['rangedDistance', 'fCombatRangedDistance', 1024],
  ['dualCastInterruptTime', 'fCombatMagicDualCastInterruptTime', 2.5],
  ['restoreStopCastThreshold', 'fCombatRestoreStopCastThreshold', 0.25],
  ['wardMinCastTime', 'fCombatMagicWardMinCastTime', 1.5],
  ['wardCooldownTime', 'fCombatMagicWardCooldownTime', 1],
  ['wardMagickaCastLimit', 'fCombatMagicWardMagickaCastLimit', 0.25],
  ['summonRestrictTime', 'fCombatMagicSummonRestrictTime', 30],
  ['reanimateDistance', 'fCombatMagicReanimateDistance', 1024],
  ['reanimateRestrictTime', 'fCombatMagicReanimateRestrictTime', 30],
];

/** The load order's settings (GMST) by name, else the engine's built-in defaults. */
export function readCombatSubtreeSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatSubtreeSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as CombatSubtreeSettings;
}

export const COMBAT_SUBTREE_DEFAULTS = readCombatSubtreeSettings();

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// --- Search -----------------------------------------------------------------------------------

/**
 * The radius a group searches round the place it last knew its target (Search Location, then
 * Search Wander within it): fCombatSearchInteriorRadiusMin .. Max indoors, the Exterior pair
 * outdoors. TODO(M13): where in the range the engine takes it (ours: at random).
 */
export function searchRadius(
  interior: boolean,
  random: () => number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): number {
  const min = interior ? settings.searchInteriorRadiusMin : settings.searchExteriorRadiusMin;
  const max = interior ? settings.searchInteriorRadiusMax : settings.searchExteriorRadiusMax;
  return min + random() * (max - min);
}

// --- The navmeshes: the shore, cover, doors -----------------------------------------------------

/** How many triangles a search of the navmeshes round an actor visits at most. */
const PLACE_SEARCH_LIMIT = 3000;

interface Visit {
  readonly navmesh: Navmesh;
  readonly triangle: number;
  readonly middle: Vec3;
}

function middleOf(navmesh: Navmesh, triangle: number): Vec3 {
  const [a, b, c] = navmeshTriangle(navmesh, triangle);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/**
 * The triangles an actor at `from` reaches over the navmeshes (across their edges and the
 * portals between meshes) whose middle lies within `radius` of it, nearest the actor first by
 * the order they are reached. Undefined off the navmeshes.
 */
function reachable(set: NavmeshSet, from: Vec3, radius: number): Visit[] | undefined {
  const start = set.locate(from);
  if (!start) return undefined;
  const seen = new Set<string>([`${start.navmesh.formId}:${start.triangle}`]);
  const out: Visit[] = [{ ...start, middle: middleOf(start.navmesh, start.triangle) }];
  for (let i = 0; i < out.length && out.length < PLACE_SEARCH_LIMIT; i++) {
    const at = out[i];
    if (!at) break;
    for (let edge = 0; edge < 3; edge++) {
      const neighbour = triangleNeighbour(at.navmesh, at.triangle, edge);
      if (neighbour === undefined) continue;
      let navmesh = at.navmesh;
      let triangle: number;
      if (typeof neighbour === 'number') triangle = neighbour;
      else {
        if (neighbour.type !== NavmeshLinkType.portal) continue;
        const other = set.navmesh(neighbour.navmesh);
        if (!other) continue;
        navmesh = other;
        triangle = neighbour.triangle;
      }
      const key = `${navmesh.formId}:${triangle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = navmesh.triangles[triangle];
      if (!t || (t.flags & NavmeshFlag.deleted) !== 0) continue;
      const middle = middleOf(navmesh, triangle);
      if (flat(middle, from) > radius) continue;
      out.push({ navmesh, triangle, middle });
    }
  }
  return out;
}

/**
 * Exit Water: the nearest place of the navmeshes it reaches that is not water (triangles without
 * the water flag), within `radius`, and where it would not swim (`swimsAt`: the water's surface
 * stands that high over it). A triangle the navmesh leaves unflagged can lie deep under its
 * cell's water: Riverwood's river bank by Alvor's forge, 90 units under the cell's plane; taken
 * as the shore, a fighter swimming there stayed in the water for good, where it cannot draw.
 * Undefined: none, or off the navmeshes. TODO(M13): the engine's choice of the shore (ours: the
 * nearest dry triangle's middle).
 */
export function exitWaterPoint(
  set: NavmeshSet,
  from: Vec3,
  radius = 4096,
  swimsAt?: (point: Vec3) => boolean,
): Vec3 | undefined {
  let best: Vec3 | undefined;
  let bestDistance = Infinity;
  for (const visit of reachable(set, from, radius) ?? []) {
    const t = visit.navmesh.triangles[visit.triangle];
    if (!t || (t.flags & NavmeshFlag.water) !== 0) continue;
    if (swimsAt?.(visit.middle) === true) continue;
    const distance = flat(visit.middle, from);
    if (distance < bestDistance) {
      best = visit.middle;
      bestDistance = distance;
    }
  }
  return best;
}

/** A place of cover: an edge of the navmesh with cover along it. */
export interface CoverSpot {
  /** Where it stands: the edge's middle, its radius back into the triangle. */
  readonly at: Vec3;
  /** The cover's height (units; full cover counts as the check height × 2). */
  readonly height: number;
  /** Out across the edge (unit, flat): the side the cover keeps off. */
  readonly facing: readonly [number, number];
  /** The edge's ends. */
  readonly ends?: readonly [Vec3, Vec3];
  /** A ledge (the drop's edge): it stands back from it and shoots from the edge itself. */
  readonly ledge?: boolean;
  /** The edge's end is open on its left or right (NAVM cover flags): one can lean out there. */
  readonly open?: boolean;
  /** Where it steps to shoot (past the edge's nearer open end; on a ledge, at the edge). */
  readonly attackAt?: Vec3;
}

/** The actor a cover edge is weighed for (a person where unknown). */
export interface CoverActor {
  readonly radius: number;
  /** Its height standing and crouched (units). */
  readonly height: number;
  readonly crouched: number;
}

const COVER_ACTOR: CoverActor = { radius: 32, height: 128, crouched: 64 };

/** The units a NAVM cover value counts in (a value is that many × 16 units high). */
const COVER_UNIT = 16;

/**
 * The cover edges of the navmeshes an actor reaches within `radius`, in the order its way search
 * reaches them (NAVM triangle cover: edges 0–1 and 1–2, a value 4–14 is that many × 16 units high,
 * 15 full cover, 2 a ledge; 1 a wall without cover gives none).
 */
export function coverSpots(
  set: NavmeshSet,
  from: Vec3,
  radius: number,
  actor: CoverActor = COVER_ACTOR,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): CoverSpot[] {
  const spots: CoverSpot[] = [];
  for (const visit of reachable(set, from, radius) ?? []) {
    const t = visit.navmesh.triangles[visit.triangle];
    if (!t || t.cover === 0) continue;
    const corners = navmeshTriangle(visit.navmesh, visit.triangle);
    for (let edge = 0; edge < 2; edge++) {
      const bits = t.cover >> (edge * 6);
      const value = bits & 0xf;
      const ledge = value === 2;
      if (value < 4 && !ledge) continue;
      const a = corners[edge];
      const b = corners[edge + 1];
      if (!a || !b) continue;
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const out = [mid[0] - visit.middle[0], mid[1] - visit.middle[1]] as const;
      const length = Math.hypot(out[0], out[1]);
      if (length <= 0) continue;
      const facing = [out[0] / length, out[1] / length] as const;
      // The actor must fit along the edge; it stands its radius and the offset back from it.
      if (flat(a, b) < actor.radius * 2) continue;
      const back = actor.radius + settings.coverEdgeOffsetDistance;
      const step = Math.min(ledge ? back + settings.coverLedgeOffsetDistance : back, length);
      const at: Vec3 = [mid[0] - facing[0] * step, mid[1] - facing[1] * step, mid[2]];
      const open = (bits & 0x30) !== 0;
      spots.push({
        at,
        height: value === 15 ? Infinity : ledge ? 0 : value * COVER_UNIT,
        facing,
        ends: [a, b],
        ledge,
        open,
        attackAt: ledge
          ? [mid[0] - facing[0] * back, mid[1] - facing[1] * back, mid[2]]
          : value * COVER_UNIT > actor.crouched
            ? coverAttackPlace(at, a, b, actor, settings)
            : at,
      });
    }
  }
  return spots;
}

/** Past the nearer end of a tall cover's edge: there it steps out of it to shoot. */
function coverAttackPlace(
  at: Vec3,
  a: Vec3,
  b: Vec3,
  actor: CoverActor,
  settings: CombatSubtreeSettings,
): Vec3 {
  const length = flat(a, b) || 1;
  const along = [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as const;
  const past = actor.radius * 2 + settings.coverAttackOffsetDistance;
  // The spot stands at the edge's middle: past its second end by half the edge and the offset.
  const sign = flat(at, b) <= flat(at, a) ? 1 : -1;
  const shift = length / 2 + past;
  return [at[0] + along[0] * shift * sign, at[1] + along[1] * shift * sign, at[2]];
}

export interface CoverNeed {
  /** Who it takes cover from. */
  readonly threat: Vec3;
  /** At least this far from the threat ... */
  readonly minRange: number;
  /** ... and at most this far (coverRange). */
  readonly maxRange: number;
  /** The cover must be at least this high (fCombatCoverCheckCoverHeightMin). */
  readonly height: number;
  /** Its way there keeps this far from the threat (fCombatCoverAvoidTargetRadius). */
  readonly avoid: number;
  /** Who is weighed (a person where unknown). */
  readonly actor?: CoverActor;
  /** Find Hide Cover (fleeing): cover it hides behind crouched, no ledge, no leaning out. */
  readonly hide?: boolean;
  /** Its other enemies seen lately (fCombatCoverSecondaryThreatLastSeenTime). */
  readonly others?: readonly Vec3[];
}

/**
 * The range from its target cover is looked for at: its weapon's minimum range less
 * fCombatCoverRangeMinBufferDistance, at least fCombatCoverMinimumRange, to its optimal range
 * plus fCombatCoverRangeMaxBufferDistance, at most its maximum range.
 */
export function coverRange(
  weapon: { readonly minimum: number; readonly optimal: number; readonly maximum: number },
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): { readonly min: number; readonly max: number } {
  return {
    min: Math.max(
      settings.coverMinimumRange,
      weapon.minimum - settings.coverRangeMinBufferDistance,
    ),
    max: Math.min(weapon.maximum, weapon.optimal + settings.coverRangeMaxBufferDistance),
  };
}

/** Where a line from `from` to `to` crosses the edge a .. b (flat), if it does. */
function crossing(from: Vec3, to: Vec3, a: Vec3, b: Vec3): Vec3 | undefined {
  const rx = to[0] - from[0];
  const ry = to[1] - from[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const cross = rx * sy - ry * sx;
  if (Math.abs(cross) < 1e-6) return undefined;
  const t = ((a[0] - from[0]) * sy - (a[1] - from[1]) * sx) / cross;
  const u = ((a[0] - from[0]) * ry - (a[1] - from[1]) * rx) / cross;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return [from[0] + rx * t, from[1] + ry * t, from[2] + (to[2] - from[2]) * t];
}

/**
 * Find Cover (observed in the original: its way search stops at the first triangle with an edge
 * that holds, so no score weighs them: the first the way reaches). An edge holds with:
 * a ledge, or cover no taller than the actor crouched, or taller with an end open to lean out
 * (hiding, fleeing: cover at least its crouched height, no ledge); its middle within the range of
 * the threat (the far end by fCombatCoverMidPointMaxRangeBuffer more) and the line from it to the
 * threat crossing the edge below the cover's top (the height at least the check height, less
 * fCombatCoverCheckCoverHeightOffset); no other enemy within
 * fCombatCoverSecondaryThreatMinDistance of the place. `spots` come in the way search's order.
 * TODO(M13): the reservation slots along an edge (ours: its middle) and an obstacle's move.
 */
export function pickCover(
  spots: readonly CoverSpot[],
  from: Vec3,
  need: CoverNeed,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): CoverSpot | undefined {
  const actor = need.actor ?? COVER_ACTOR;
  for (const spot of spots) {
    if (need.hide) {
      if (spot.ledge === true || spot.height < actor.crouched) continue;
    } else if (spot.ledge !== true && spot.height > actor.crouched && spot.open === false) {
      continue;
    }
    if (spot.ledge !== true && spot.height < need.height) continue;
    const range = Math.hypot(spot.at[0] - need.threat[0], spot.at[1] - need.threat[1]);
    if (range < need.minRange) continue;
    if (range > need.maxRange + settings.coverMidPointMaxRangeBuffer) continue;
    const toward = [(need.threat[0] - spot.at[0]) / range, (need.threat[1] - spot.at[1]) / range];
    if (spot.facing[0] * (toward[0] ?? 0) + spot.facing[1] * (toward[1] ?? 0) < 0.5) continue;
    if (spot.ends) {
      const crossed = crossing(spot.at, need.threat, spot.ends[0], spot.ends[1]);
      if (!crossed) continue;
      const top = spot.at[2] + Math.max(spot.height, need.height);
      if (crossed[2] + settings.coverCheckHeightOffset >= top) continue;
    }
    if (
      need.others?.some(
        (other) =>
          Math.hypot(spot.at[0] - other[0], spot.at[1] - other[1], spot.at[2] - other[2]) <
          settings.coverSecondaryThreatMinDistance,
      )
    ) {
      continue;
    }
    if (passesNear(from, spot.at, need.threat, need.avoid)) continue;
    return spot;
  }
  return undefined;
}

/** What a hide weighs, each half second (Hide: observed in the original). */
export interface HideCheck {
  /** Between it and its enemy now (units), and fCombatAnticipateTime ahead. */
  readonly distance: number;
  readonly distanceAhead: number;
  /** Its and its enemy's radii added. */
  readonly radii: number;
  /** It has its enemy in sight. */
  readonly sees: boolean;
  /** Its enemy has engaged it since the hide began. */
  readonly engagedSince: boolean;
}

/**
 * A hide is over once its enemy comes near: within fCombatHideFailedTargetDistance out of sight,
 * or (in sight) fCombatHideFailedTargetLOSDistance fCombatAnticipateTime ahead, or once it is
 * engaged after all. The Hide Selector then goes on to Boost Confidence: it turns and fights.
 */
export function hideFails(
  check: HideCheck,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): boolean {
  const near = check.sees
    ? check.distanceAhead < check.radii + settings.hideFailedTargetLosDistance
    : check.distance < check.radii + settings.hideFailedTargetDistance;
  return near || check.engagedSince;
}

/**
 * Fallback To Ranged (observed in the original): turned to its target (within 60°) it backs along
 * the line from its target to fCombatRangedDistance from it; farther already, it stays.
 */
export function fallbackPlace(
  feet: Vec3,
  target: Vec3,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): Vec3 | undefined {
  const dx = feet[0] - target[0];
  const dy = feet[1] - target[1];
  const dz = feet[2] - target[2];
  const distance = Math.hypot(dx, dy, dz);
  const back = settings.rangedDistance - distance;
  if (back <= 0 || distance <= 1e-6) return undefined;
  return [
    feet[0] + (dx / distance) * back,
    feet[1] + (dy / distance) * back,
    feet[2] + (dz / distance) * back,
  ];
}

/** Whether the straight way from `a` to `b` passes within `radius` of `point`. */
function passesNear(a: Vec3, b: Vec3, point: Vec3, radius: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 0
      ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
      : 0;
  return Math.hypot(a[0] + dx * t - point[0], a[1] + dy * t - point[1]) < radius;
}

/**
 * Use Cover's times on the three-point scale of its settings by the style's defensive mult
 * (Wait Behind Cover) and offensive mult (Attack From Cover), 0 .. 1 mapped to −1 .. 1.
 * TODO(M13): which style value the engine puts on the scale (inferred).
 */
export function coverTimes(
  style: { readonly offensiveMult: number; readonly defensiveMult: number },
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): { readonly wait: number; readonly attack: number } {
  const scale = (v: number, min: number, mid: number, max: number): number => {
    const t = Math.max(-1, Math.min(1, v * 2 - 1));
    return t > 0 ? mid + (max - mid) * t : min + (mid - min) * (t + 1);
  };
  return {
    wait: scale(
      style.defensiveMult,
      settings.coverWaitTimeMin,
      settings.coverWaitTimeMid,
      settings.coverWaitTimeMax,
    ),
    attack: scale(
      style.offensiveMult,
      settings.coverAttackTimeMin,
      settings.coverAttackTimeMid,
      settings.coverAttackTimeMax,
    ),
  };
}

/** A door of the navmeshes (NAVM door triangles) and where it is. */
export interface DoorSpot {
  readonly door: number;
  readonly at: Vec3;
}

/** The doors the navmeshes an actor reaches name, within `radius` of it. */
export function doorSpots(set: NavmeshSet, from: Vec3, radius: number): DoorSpot[] {
  const visits = reachable(set, from, radius) ?? [];
  const inReach = new Set(visits.map((visit) => `${visit.navmesh.formId}:${visit.triangle}`));
  const out: DoorSpot[] = [];
  const meshes = new Set(visits.map((visit) => visit.navmesh));
  for (const navmesh of meshes) {
    for (const door of navmesh.doors) {
      if (!inReach.has(`${navmesh.formId}:${door.triangle}`)) continue;
      out.push({ door: door.door, at: middleOf(navmesh, door.triangle) });
    }
  }
  return out;
}

/**
 * Flee Through Door (observed in the original): by fCombatFleeUseDoorChance, not within
 * fCombatFleeUseDoorRestrictTime of its last and only while its enemy stands in its cell, the
 * nearest load door within fCombatFleeDoorDistanceMax with no enemy within
 * fCombatFleeDoorTargetCheckDistance of it, not the door it came by within
 * fCombatFleeLastDoorRestrictTime; not one leading out of its encounter zone (`allowed`). Its
 * way goes on through it to the other side.
 */
export function pickFleeDoor(
  doors: readonly DoorSpot[],
  from: Vec3,
  enemy: Vec3,
  sinceLastDoor: number,
  random: () => number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
  allowed?: (door: DoorSpot) => boolean,
): DoorSpot | undefined {
  if (sinceLastDoor < settings.fleeUseDoorRestrictTime) return undefined;
  if (random() >= settings.fleeUseDoorChance) return undefined;
  let best: DoorSpot | undefined;
  let bestDistance = Infinity;
  for (const door of doors) {
    const distance = flat(from, door.at);
    if (distance > settings.fleeDoorDistanceMax || distance >= bestDistance) continue;
    if (flat(door.at, enemy) <= settings.fleeDoorTargetCheckDistance) continue;
    if (allowed && !allowed(door)) continue;
    best = door;
    bestDistance = distance;
  }
  return best;
}

// --- Acquire Weapon ------------------------------------------------------------------------------

/** A weapon lying in the world. */
export interface LooseWeapon {
  readonly reference: number;
  readonly at: Vec3;
  /** Its damage as the menus show it. */
  readonly damage: number;
  /** A bow or crossbow (ammunition it carries) or a staff. */
  readonly ranged: boolean;
}

export interface AcquireSituation {
  readonly feet: Vec3;
  readonly target: Vec3;
  /** Disarmed lately (its weapon knocked from its hand), else unarmed. */
  readonly disarmed: boolean;
  /** Its best option's score now (its fists' damage unarmed). */
  readonly currentScore: number;
}

/**
 * Find Weapon: a weapon it can pick up within its search radius (fCombatAcquireWeaponUnarmed /
 * Disarmed DistanceMin .. Max, as far as its target stands within the pair), not within
 * fCombatAcquireWeaponMinimumTargetDistance of its target. Each is scored by its damage (a
 * melee weapon × fCombatAcquireWeaponMeleeScoreMult) less its distance's cost (distance /
 * fCombatAcquireWeaponScoreCostMult of it); the best is taken if it beats what it fights with
 * by fCombatAcquireWeaponMinimumScoreMult. TODO(M13): the engine's score (inferred from its
 * settings' names).
 */
export function pickWeapon(
  weapons: readonly LooseWeapon[],
  situation: AcquireSituation,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): LooseWeapon | undefined {
  const min = situation.disarmed
    ? settings.acquireDisarmedDistanceMin
    : settings.acquireUnarmedDistanceMin;
  const max = situation.disarmed
    ? settings.acquireDisarmedDistanceMax
    : settings.acquireUnarmedDistanceMax;
  const radius = Math.max(min, Math.min(max, flat(situation.feet, situation.target)));
  let best: { weapon: LooseWeapon; score: number } | undefined;
  for (const weapon of weapons) {
    const distance = flat(situation.feet, weapon.at);
    if (distance > radius) continue;
    if (flat(weapon.at, situation.target) < settings.acquireMinimumTargetDistance) continue;
    const worth = weapon.damage * (weapon.ranged ? 1 : settings.acquireMeleeScoreMult);
    const score = worth * (1 - distance / settings.acquireScoreCostMult);
    if (!best || score > best.score) best = { weapon, score };
  }
  if (!best || best.score < situation.currentScore * settings.acquireMinimumScoreMult) {
    return undefined;
  }
  return best.weapon;
}

// --- Low Combat ----------------------------------------------------------------------------------

/**
 * The low process's Attack (CombatBehaviorAttackLow): a blow without its animation against a
 * target within fCombatLowMaxAttackDistance, landing by fCombatLowTargetHitPercent
 * (fCombatLowFleeingTargetHitPercent on one that flees). Whether this blow lands; undefined out
 * of reach.
 */
export function lowCombatBlow(
  distance: number,
  targetFleeing: boolean,
  random: () => number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): boolean | undefined {
  if (distance > settings.lowMaxAttackDistance) return undefined;
  const chance = targetFleeing ? settings.lowFleeingTargetHitPercent : settings.lowTargetHitPercent;
  return random() < chance;
}

// --- Casters by purpose --------------------------------------------------------------------------

/** What its casters (CombatMagicCaster…) may do for it now. */
export interface CasterState {
  /** Its health and magicka shares (0..1). */
  readonly health: number;
  readonly magicka: number;
  /** Its restore shares (restoreShare in combat-tactics.ts). */
  readonly restoreHealthBelow: number;
  /** A spell or breath comes at it and it has a ward. */
  readonly wardThreat: boolean;
  readonly sinceWard: number;
  readonly canHeal: boolean;
  readonly sinceHealthRestore: number;
  readonly restoreHealthRestrictTime: number;
  readonly canSummon: boolean;
  readonly sinceSummon: number;
  /** A corpse it can raise lies within fCombatMagicReanimateDistance. */
  readonly corpseDistance: number | undefined;
  readonly canReanimate: boolean;
  readonly sinceReanimate: number;
  readonly canBuff: boolean;
  /** Its best spell's combat inventory score by purpose (combatSpellScore): the order weighed. */
  readonly scores?: Partial<Record<CasterPurpose, number>>;
}

export type CasterPurpose = 'ward' | 'restore' | 'summon' | 'reanimate' | 'buff';

/**
 * Which of its casters acts now. The original has no order between them: each spell has its one
 * caster by its effect, and the combat inventory takes its items by their score (observed in the
 * original: combatSpellScore), the first whose caster's own check holds. Those checks: a ward
 * against what comes at it (with fCombatMagicWardMagickaCastLimit of its magicka, not within its
 * cooldown); restoring below its restore share; a summons (not within
 * fCombatMagicSummonRestrictTime); a corpse raised within fCombatMagicReanimateDistance (not
 * within its restrict time); a buff. Scores equal or not given keep that order. Potions come
 * before the hands' spells (the Action Equipment Selector's Potion before Magic): chooseSupport.
 */
export function chooseCaster(
  state: CasterState,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): CasterPurpose | undefined {
  const ready: CasterPurpose[] = [];
  if (
    state.wardThreat &&
    state.magicka >= settings.wardMagickaCastLimit &&
    state.sinceWard >= settings.wardCooldownTime
  ) {
    ready.push('ward');
  }
  if (
    state.canHeal &&
    state.health < state.restoreHealthBelow &&
    state.sinceHealthRestore >= state.restoreHealthRestrictTime
  ) {
    ready.push('restore');
  }
  if (state.canSummon && state.sinceSummon >= settings.summonRestrictTime) ready.push('summon');
  if (
    state.canReanimate &&
    state.corpseDistance !== undefined &&
    state.corpseDistance <= settings.reanimateDistance &&
    state.sinceReanimate >= settings.reanimateRestrictTime
  ) {
    ready.push('reanimate');
  }
  if (state.canBuff) ready.push('buff');
  let best: CasterPurpose | undefined;
  let bestScore = -Infinity;
  for (const purpose of ready) {
    const score = state.scores?.[purpose] ?? 0;
    if (best === undefined || score > bestScore) {
      best = purpose;
      bestScore = score;
    }
  }
  return best;
}

/** Its potions as the Action Equipment Selector's Potion slot weighs them. */
export interface PotionState {
  /** Its restore share for magicka (restoreShare), seconds since it restored it. */
  readonly restoreMagickaBelow: number;
  readonly sinceMagickaRestore: number;
  readonly restoreMagickaRestrictTime: number;
  /** It carries a potion restoring Health, Magicka. */
  readonly health: boolean;
  readonly magicka: boolean;
}

/** One thing it does for itself in its fight: a potion, or one of its casters. */
export type CombatSupportChoice =
  | { readonly kind: 'potion'; readonly value: 'health' | 'magicka' }
  | { readonly kind: CasterPurpose };

/**
 * What it does for itself now, in the Action Equipment Selector's order (Potion before
 * Magic): a health potion below its restore share (not within its restrict time), a magicka
 * potion below its magicka share, else its casters (chooseCaster).
 */
export function chooseCombatSupport(
  state: CasterState,
  potions: PotionState,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): CombatSupportChoice | undefined {
  if (
    potions.health &&
    state.health < state.restoreHealthBelow &&
    state.sinceHealthRestore >= state.restoreHealthRestrictTime
  ) {
    return { kind: 'potion', value: 'health' };
  }
  if (
    potions.magicka &&
    state.magicka < potions.restoreMagickaBelow &&
    potions.sinceMagickaRestore >= potions.restoreMagickaRestrictTime
  ) {
    return { kind: 'potion', value: 'magicka' };
  }
  const caster = chooseCaster(state, settings);
  return caster === undefined ? undefined : { kind: caster };
}

/**
 * A held (concentration) restoring spell: cast on until its health share is
 * fCombatRestoreStopCastThreshold past the share it started below, or full. TODO(M13): the
 * engine's use of the threshold (inferred: the margin above the restore share).
 */
export function holdsRestore(
  health: number,
  restoreBelow: number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): boolean {
  return health < 1 && health < restoreBelow + settings.restoreStopCastThreshold;
}

/** A ward is held at least fCombatMagicWardMinCastTime, and while something comes at it. */
export function holdsWard(
  heldFor: number,
  threat: boolean,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): boolean {
  return heldFor < settings.wardMinCastTime || threat;
}

/**
 * Prepare Dual Cast: both hands charge the spell, and it is loosed from both once charged; a
 * charge that takes longer than fCombatMagicDualCastInterruptTime is broken off.
 */
export function dualCastHold(
  heldFor: number,
  chargeTime: number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): 'charging' | 'release' | 'interrupt' {
  if (heldFor >= settings.dualCastInterruptTime) return 'interrupt';
  return heldFor >= chargeTime ? 'release' : 'charging';
}

// --- Reachability --------------------------------------------------------------------------------

/**
 * What a fighter does about a target its way cannot reach (Check Unreachable Target, every
 * fCombatUnreachableTargetCheckTime): a ranged option fights from range (Fallback To Ranged);
 * without one it holds where it is while another target can be chosen (target selection weighs
 * an unreachable one down), and searches once its group has lost the target. TODO(M13): the
 * engine's own answer without a ranged option (ours: it holds, as the engine's Check
 * Unreachable Target's movement does).
 */
export function unreachableResponse(hasRanged: boolean): 'ranged' | 'hold' {
  return hasRanged ? 'ranged' : 'hold';
}
