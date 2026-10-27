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
 * the water flag), within `radius`. Undefined: none, or off the navmeshes. TODO(M13): the
 * engine's choice of the shore (ours: the nearest dry triangle's middle).
 */
export function exitWaterPoint(set: NavmeshSet, from: Vec3, radius = 4096): Vec3 | undefined {
  let best: Vec3 | undefined;
  let bestDistance = Infinity;
  for (const visit of reachable(set, from, radius) ?? []) {
    const t = visit.navmesh.triangles[visit.triangle];
    if (!t || (t.flags & NavmeshFlag.water) !== 0) continue;
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
}

/**
 * The cover edges of the navmeshes an actor reaches within `radius` (NAVM triangle cover: edges
 * 0–1 and 1–2, a value 4–14 is that many × 16 units high, 15 full cover; 1 a wall without
 * cover and 2 a ledge give none).
 */
export function coverSpots(set: NavmeshSet, from: Vec3, radius: number, back = 32): CoverSpot[] {
  const spots: CoverSpot[] = [];
  for (const visit of reachable(set, from, radius) ?? []) {
    const t = visit.navmesh.triangles[visit.triangle];
    if (!t || t.cover === 0) continue;
    const corners = navmeshTriangle(visit.navmesh, visit.triangle);
    for (let edge = 0; edge < 2; edge++) {
      const value = (t.cover >> (edge * 6)) & 0xf;
      if (value < 4) continue;
      const a = corners[edge];
      const b = corners[edge + 1];
      if (!a || !b) continue;
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const out = [mid[0] - visit.middle[0], mid[1] - visit.middle[1]] as const;
      const length = Math.hypot(out[0], out[1]);
      if (length <= 0) continue;
      const facing = [out[0] / length, out[1] / length] as const;
      const step = Math.min(back, length);
      spots.push({
        at: [mid[0] - facing[0] * step, mid[1] - facing[1] * step, mid[2]],
        height: value === 15 ? Infinity : value * 16,
        facing,
      });
    }
  }
  return spots;
}

export interface CoverNeed {
  /** Who it takes cover from. */
  readonly threat: Vec3;
  /** At least this far from the threat ... */
  readonly minRange: number;
  /** ... and at most this far (a shooter: its weapon's range × fCombatCoverMaxRangeMult). */
  readonly maxRange: number;
  /** The cover must be at least this high (fCombatCoverCheckCoverHeightMin). */
  readonly height: number;
  /** Its way there keeps this far from the threat (fCombatCoverAvoidTargetRadius). */
  readonly avoid: number;
}

/**
 * Find Cover: of the cover spots, those whose cover lies between them and the threat (the edge
 * faces it within 60°), high enough, within the range from it and not past it on the way; the
 * nearest to the actor. TODO(M13): the engine's scoring of cover (ours: the nearest that holds).
 */
export function pickCover(
  spots: readonly CoverSpot[],
  from: Vec3,
  need: CoverNeed,
): CoverSpot | undefined {
  let best: CoverSpot | undefined;
  let bestDistance = Infinity;
  for (const spot of spots) {
    if (spot.height < need.height) continue;
    const range = flat(spot.at, need.threat);
    if (range < need.minRange || range > need.maxRange) continue;
    const toward = [(need.threat[0] - spot.at[0]) / range, (need.threat[1] - spot.at[1]) / range];
    if (spot.facing[0] * (toward[0] ?? 0) + spot.facing[1] * (toward[1] ?? 0) < 0.5) continue;
    if (passesNear(from, spot.at, need.threat, need.avoid)) continue;
    const distance = flat(from, spot.at);
    if (distance < bestDistance) {
      best = spot;
      bestDistance = distance;
    }
  }
  return best;
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
 * Flee Through Door: by fCombatFleeUseDoorChance, not within fCombatFleeUseDoorRestrictTime of
 * its last, the nearest door within fCombatFleeDoorDistanceMax that lies farther from its enemy
 * than it stands and whose way keeps fCombatFleeDoorTargetCheckDistance off the enemy.
 * TODO(M13): the engine's choice among doors and what it does past a load door.
 */
export function pickFleeDoor(
  doors: readonly DoorSpot[],
  from: Vec3,
  enemy: Vec3,
  sinceLastDoor: number,
  random: () => number,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): DoorSpot | undefined {
  if (sinceLastDoor < settings.fleeUseDoorRestrictTime) return undefined;
  if (random() >= settings.fleeUseDoorChance) return undefined;
  const own = flat(from, enemy);
  let best: DoorSpot | undefined;
  let bestDistance = Infinity;
  for (const door of doors) {
    const distance = flat(from, door.at);
    if (distance > settings.fleeDoorDistanceMax || distance >= bestDistance) continue;
    if (flat(door.at, enemy) <= own) continue;
    if (passesNear(from, door.at, enemy, settings.fleeDoorTargetCheckDistance)) continue;
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
}

export type CasterPurpose = 'ward' | 'restore' | 'summon' | 'reanimate' | 'buff';

/**
 * Which of its casters acts now, in the order its tree weighs them: a ward against what comes
 * at it (with fCombatMagicWardMagickaCastLimit of its magicka, not within its cooldown);
 * restoring below its restore share; a summons (not within fCombatMagicSummonRestrictTime); a
 * corpse raised within fCombatMagicReanimateDistance (not within its restrict time); a buff.
 * Potions come before the hands' spells (the Action Equipment Selector's Potion before Magic):
 * chooseSupport. TODO(M13): the engine's weighing between casters (ours: this fixed order).
 */
export function chooseCaster(
  state: CasterState,
  settings: CombatSubtreeSettings = COMBAT_SUBTREE_DEFAULTS,
): CasterPurpose | undefined {
  if (
    state.wardThreat &&
    state.magicka >= settings.wardMagickaCastLimit &&
    state.sinceWard >= settings.wardCooldownTime
  ) {
    return 'ward';
  }
  if (
    state.canHeal &&
    state.health < state.restoreHealthBelow &&
    state.sinceHealthRestore >= state.restoreHealthRestrictTime
  ) {
    return 'restore';
  }
  if (state.canSummon && state.sinceSummon >= settings.summonRestrictTime) return 'summon';
  if (
    state.canReanimate &&
    state.corpseDistance !== undefined &&
    state.corpseDistance <= settings.reanimateDistance &&
    state.sinceReanimate >= settings.reanimateRestrictTime
  ) {
    return 'reanimate';
  }
  if (state.canBuff) return 'buff';
  return undefined;
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
