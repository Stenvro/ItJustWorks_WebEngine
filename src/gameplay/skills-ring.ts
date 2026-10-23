// Where the skills menu puts the skills and their perk trees in its sky dome
// (meshes\interface\intperkskydome.nif). The dome has 18 directions around its middle, nodes
// Point00 .. Point17 every 20° (0° along +Y, turning towards +X: clockwise from above), and over
// each a constellation image (cImage00 .. cImage17: its quad spans about ±9° about its point,
// 7° .. 30° up as seen from the camera, about 92 out). The images name the skills: Point01's is
// the anvil (Smithing), Point09's the key (Lockpicking), the magic skills in the blue nebula left
// of Smithing; going clockwise: Enchanting, Smithing, Heavy Armor, Block, Two-handed,
// One-handed, Archery, Light Armor, Sneak, Lockpicking, Pickpocket, Speech, Alchemy, Illusion,
// Conjuration, Destruction, Restoration, Alteration (the ring the menu's skill names keep:
// SKILL_ANGLE 20, one name per skill in that order).
//
// A perk's star stands on its constellation's image: fStatsStarXIncrement (5) a grid column
// along the image, the tree's columns about the point's direction; a grid row up the image the
// sum of fStatsStarYIncrement and fStatsStarZIncrement (15 − 9 = 6), row 0 at the image's foot.
// These measures fit the images (Smithing's twelve columns span its anvil's 35°, Lockpicking's
// five rows its key's height). Platform-independent. Notes: docs/ui.md ("The skills menu").

import type { Vec3 } from '../render/math.ts';
import type { PerkTreeNode, SkillRecord } from '../world/perk-trees.ts';

/** The skills around the ring (actor value indices), from Point00 clockwise. */
export const RING_SKILLS: readonly number[] = [
  23, 10, 11, 9, 7, 6, 8, 12, 15, 14, 13, 17, 16, 21, 19, 20, 22, 18,
];
/** Degrees between two skills of the ring (the menu's SKILL_ANGLE). */
export const SKILL_ANGLE = 20;
/** How far out the constellations' images lie from the dome's middle. */
export const STAR_DISTANCE = 92;
/** The images' foot: row 0's height. */
export const STAR_BASE = -2;

/** The settings the stars' grid comes from (GMSTs). */
export interface StarGrid {
  /** fStatsStarXIncrement: along a row. */
  readonly column: number;
  /** fStatsStarYIncrement + fStatsStarZIncrement: up the image. */
  readonly row: number;
}

export const STAR_GRID_DEFAULTS: StarGrid = { column: 5, row: 15 - 9 };

/** A ring position's direction: its unit vector out from the middle and its rightward one. */
export function ringAxes(ring: number): { out: Vec3; right: Vec3 } {
  const angle = (ring * SKILL_ANGLE * Math.PI) / 180;
  return {
    out: [Math.sin(angle), Math.cos(angle), 0],
    right: [Math.cos(angle), -Math.sin(angle), 0],
  };
}

/** The middle of a tree's columns (its perks' grid places with their offsets). */
export function treeMiddle(skill: SkillRecord): number {
  const columns = skill.nodes
    .filter((node) => node.perk !== undefined)
    .map((node) => node.column + node.offsetX);
  if (columns.length === 0) return 0;
  return (Math.min(...columns) + Math.max(...columns)) / 2;
}

/** Where a perk's star stands, for the skill at a ring position. */
export function starPlace(
  skill: SkillRecord,
  node: PerkTreeNode,
  ring: number,
  grid: StarGrid = STAR_GRID_DEFAULTS,
): Vec3 {
  const { out, right } = ringAxes(ring);
  const x = (node.column + node.offsetX - treeMiddle(skill)) * grid.column;
  const z = STAR_BASE + (node.row + node.offsetY) * grid.row;
  return [out[0] * STAR_DISTANCE + right[0] * x, out[1] * STAR_DISTANCE + right[1] * x, z];
}

/** Below this speed (degrees a second; 0.01 radians) the ring stops turning. */
const TURN_STOP = (0.01 * 180) / Math.PI;

/**
 * How fast the ring turns now (degrees a second; 0: it has arrived), observed in the
 * original: turning, its speed rises to its most, 1 / fStatsRotationSpeedMax radians a second, over
 * fStatsRotationRampTime ms (along a quarter sine); toward the skill it turns to it goes no
 * faster than the most times the share of a skill's angle left, a speed under that growing by
 * 1.3 an update (at 60 a second); it stops below 0.01 radians a second.
 */
export function ringTurnSpeed(
  previous: number,
  sinceStart: number,
  degreesLeft: number,
  dt: number,
  settings: { readonly speedMax: number; readonly rampMs: number },
): number {
  const most = 180 / Math.PI / Math.max(1e-3, settings.speedMax);
  const share = Math.min(1, (sinceStart * 1000) / Math.max(1, settings.rampMs));
  const ramp = most * Math.sin((Math.PI / 2) * share);
  const cap = most * Math.min(1, Math.abs(degreesLeft) / SKILL_ANGLE);
  // Slowed to a stop at the skill: arrived.
  if (cap < TURN_STOP) return 0;
  return Math.min(cap, Math.max(ramp, TURN_STOP, previous * 1.3 ** (dt * 60)));
}

/** The ring position nearest to a heading (degrees), 0 .. 17. */
export function nearestRing(degrees: number): number {
  const count = RING_SKILLS.length;
  return ((Math.round(degrees / SKILL_ANGLE) % count) + count) % count;
}
