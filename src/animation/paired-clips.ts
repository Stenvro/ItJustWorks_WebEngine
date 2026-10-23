// Paired animations (a rider mounting a horse, killmoves, a vampire's feeding): one clip
// animates two actors in a shared frame. Its tracks are named (the clip's annotation tracks):
// "PairedRoot", the first actor's bones by their own names ("NPC", "NPC Root [Root]", ...) and
// the second actor's prefixed "2_" ("2_HorsePelvis"); bones the first actor's skeleton has none
// of keep their own name for the second (the horse's "SaddleBone" in the human and horse
// clips). The bindings name no skeleton but "PairedRoot" and map no track to a bone, so each
// actor's graph takes the tracks of its own bones by name. Both actors stand at the pair's
// root: the first actor's "NPC" track holds where it is from there (the mount's 63.5 units to
// the horse's left, as the horse race's mount offset says). Platform-independent.

import { TRANSFORM_FLOATS, type AnimationBinding } from '../formats/hkx/animation.ts';

/** The skeleton name of a paired animation's binding. */
export const PAIRED_ROOT = 'PairedRoot';
/** The prefix of the second actor's tracks. */
export const PARTNER_PREFIX = '2_';

/** Which actor of a pair a skeleton plays: the first (unprefixed tracks) or the second. */
export type PairedSide = 'first' | 'second';

/** Whether a binding is a paired animation's (its tracks named, "PairedRoot" first). */
export function isPaired(binding: AnimationBinding): boolean {
  return (
    binding.skeletonName === PAIRED_ROOT ||
    binding.animation.trackNames?.[0]?.toLowerCase() === PAIRED_ROOT.toLowerCase()
  );
}

/**
 * The side of a pair a skeleton plays: the one more of whose bones the clip names (the human
 * takes its 99 bones unprefixed, the horse its 55 prefixed). Two actors of one skeleton (a
 * human killing a human) name the same bones on both sides: here the first is taken, and a
 * killmove sets its victim's graph to the second (BehaviorRuntime.pairedSide, set by combat).
 */
export function pairedSide(trackNames: readonly string[], bones: readonly string[]): PairedSide {
  const own = new Set(bones.map((bone) => bone.toLowerCase()));
  let first = 0;
  let second = 0;
  for (const name of trackNames) {
    const lower = name.toLowerCase();
    if (lower.startsWith(PARTNER_PREFIX)) {
      if (own.has(lower.slice(PARTNER_PREFIX.length))) second++;
    } else if (own.has(lower)) {
      first++;
    }
  }
  return second > first ? 'second' : 'first';
}

/**
 * The bone of each track for a skeleton playing one side of a paired clip (−1: not its bone).
 * The first side takes the unprefixed tracks of its bones; the second its prefixed ones, and an
 * unprefixed one of a bone it has where no prefixed track names that bone. PairedRoot is no
 * actor's bone.
 */
export function pairedTrackBones(
  trackNames: readonly string[],
  bones: readonly string[],
  side: PairedSide = pairedSide(trackNames, bones),
): Int16Array {
  const index = new Map<string, number>();
  bones.forEach((bone, i) => {
    const key = bone.toLowerCase();
    if (!index.has(key)) index.set(key, i);
  });
  const prefixed = new Set(
    trackNames
      .map((name) => name.toLowerCase())
      .filter((name) => name.startsWith(PARTNER_PREFIX))
      .map((name) => name.slice(PARTNER_PREFIX.length)),
  );
  const result = new Int16Array(trackNames.length).fill(-1);
  trackNames.forEach((name, track) => {
    const lower = name.toLowerCase();
    if (lower === PAIRED_ROOT.toLowerCase()) return;
    const partner = lower.startsWith(PARTNER_PREFIX);
    const bone = partner ? lower.slice(PARTNER_PREFIX.length) : lower;
    if (side === 'first' && partner) return;
    if (side === 'second' && !partner && prefixed.has(bone)) return;
    result[track] = index.get(bone) ?? -1;
  });
  return result;
}

/** Where a paired clip puts its partner from its lead: in the lead's frame, and turned by. */
export interface PartnerMark {
  /** Game units: x to the lead's right, y ahead, z up. */
  readonly offset: readonly [number, number, number];
  /** Radians, counter-clockwise seen from above (to the left): the partner's facing less the lead's. */
  readonly yaw: number;
}

/**
 * The partner's mark in a paired clip: where its actor stands from the lead's as the clip
 * begins. The clip holds both actors' placements from the pair's root: the lead's in its "NPC"
 * track (a killmove's: at the root), the partner's in the track named the prefix alone ("2_":
 * Paired_1HMKillMoveB's 72.8 units ahead, turned about; a bear's 157, a wolf's 116.6).
 * Undefined: the clip names no partner placement.
 */
export function partnerMark(
  binding: AnimationBinding,
  prefix = PARTNER_PREFIX,
): PartnerMark | undefined {
  const names = binding.animation.trackNames;
  if (!names) return undefined;
  const lower = names.map((name) => name.toLowerCase());
  const partner = lower.indexOf(prefix.toLowerCase());
  if (partner < 0) return undefined;
  const lead = lower.indexOf('npc');
  const out = new Float32Array(binding.animation.trackCount * TRANSFORM_FLOATS);
  // Unwritten (unusable) tracks read as the identity.
  for (let track = 0; track < binding.animation.trackCount; track++) {
    out[track * TRANSFORM_FLOATS + 6] = 1;
  }
  binding.animation.sample(0, out);
  const place = (track: number): { x: number; y: number; z: number; yaw: number } => {
    if (track < 0) return { x: 0, y: 0, z: 0, yaw: 0 };
    const o = track * TRANSFORM_FLOATS;
    const qz = out[o + 5] ?? 0;
    const qw = out[o + 6] ?? 1;
    return { x: out[o] ?? 0, y: out[o + 1] ?? 0, z: out[o + 2] ?? 0, yaw: 2 * Math.atan2(qz, qw) };
  };
  const from = place(lead);
  const to = place(partner);
  // Into the lead's frame: its placement's turn undone.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const cos = Math.cos(-from.yaw);
  const sin = Math.sin(-from.yaw);
  return {
    offset: [dx * cos - dy * sin, dx * sin + dy * cos, to.z - from.z],
    yaw: to.yaw - from.yaw,
  };
}

/**
 * A paired clip's binding for a skeleton (its bones by name): its tracks mapped to that
 * skeleton's bones. Other bindings are returned as they are.
 */
export function bindPaired(binding: AnimationBinding, bones: readonly string[]): AnimationBinding {
  const names = binding.animation.trackNames;
  if (!names || !isPaired(binding)) return binding;
  return { ...binding, trackToBone: pairedTrackBones(names, bones) };
}
