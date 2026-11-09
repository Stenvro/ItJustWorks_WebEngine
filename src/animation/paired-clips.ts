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

/**
 * The first actor's name in a paired clip (its placement track, "NPC"): the prefix its own
 * events carry in the clip's triggers (NPCHitFrame, NPCpairedStop, NPCVampireFeedEnd).
 */
export const FIRST_EVENT_PREFIX = 'NPC';

/**
 * NPCSoundPlay.<descriptor> is an event of its own, not the first side's SoundPlay: the engine
 * plays it for actors other than the player (src/shell/actor-sounds.ts), and both sides of
 * paired clips raise it (the killers' NPCSoundPlay.NPCKillChop; the vampire lord's victims'
 * clips annotate NPCSoundPlay.NPCVampireLordFeed, which the lord's side raises too: an NPC
 * victim sounds the player lord's feeding). The werewolf killmoves raise both
 * NPCSoundPlay.NPCWerewolfMaul and SoundPlay.NPCWerewolfMaul, a mount both NPCSoundPlay and
 * SoundPlay.NPCHorseMount: the player hears each once.
 */
const NPC_SOUND_PLAY = 'npcsoundplay.';

/**
 * The prefix of a side's own events in the synchronized clip it plays: the clip's
 * SyncAnimPrefix where it names one (the second actor's "2_": a killmove victim's 2_KillActor,
 * 2_Decapitate, 2_DeathEmote), else the first actor's "NPC" (the killer's NPCHitFrame, a
 * rider's NPCpairedStop). Read from the vanilla behaviors (docs/animation.md, "Paired
 * events"): of the triggers on their synchronized clips, a side whose clip names "2_" carries
 * "2_" events (1,165 of 1,222), one whose clip names none "NPC" events (4,657 of 4,787).
 */
export function ownEventPrefix(syncPrefix: string | undefined): string {
  return syncPrefix !== undefined && syncPrefix !== '' ? syncPrefix : FIRST_EVENT_PREFIX;
}

/**
 * The prefix of the other side's events, for a side whose own is `own`: the first actor's
 * "NPC" for the second side, the second's "2_" for the first.
 */
export function partnerEventPrefix(own: string): string {
  return own.toLowerCase() === FIRST_EVENT_PREFIX.toLowerCase()
    ? PARTNER_PREFIX
    : FIRST_EVENT_PREFIX;
}

/**
 * A side's own event of a paired clip without its prefix ("2_KillActor" with "2_": "KillActor"),
 * undefined for one that does not begin with it (the other side's, or one of no side) and for
 * NPCSoundPlay (an event of its own, above).
 */
export function ownPairedEvent(text: string, prefix: string): string | undefined {
  if (text.length <= prefix.length) return undefined;
  if (text.toLowerCase().startsWith(NPC_SOUND_PLAY)) return undefined;
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? text.slice(prefix.length)
    : undefined;
}

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
export function pairedSide(
  trackNames: readonly string[],
  bones: readonly string[],
  prefix = PARTNER_PREFIX,
): PairedSide {
  const own = new Set(bones.map((bone) => bone.toLowerCase()));
  const lowerPrefix = prefix.toLowerCase();
  let first = 0;
  let second = 0;
  for (const name of trackNames) {
    const lower = name.toLowerCase();
    if (lower.startsWith(lowerPrefix)) {
      if (own.has(lower.slice(lowerPrefix.length))) second++;
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
  prefix = PARTNER_PREFIX,
): Int16Array {
  const lowerPrefix = prefix.toLowerCase();
  const index = new Map<string, number>();
  bones.forEach((bone, i) => {
    const key = bone.toLowerCase();
    if (!index.has(key)) index.set(key, i);
  });
  const prefixed = new Set(
    trackNames
      .map((name) => name.toLowerCase())
      .filter((name) => name.startsWith(lowerPrefix))
      .map((name) => name.slice(lowerPrefix.length)),
  );
  const result = new Int16Array(trackNames.length).fill(-1);
  trackNames.forEach((name, track) => {
    const lower = name.toLowerCase();
    if (lower === PAIRED_ROOT.toLowerCase()) return;
    const partner = lower.startsWith(lowerPrefix);
    const bone = partner ? lower.slice(lowerPrefix.length) : lower;
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
 * Whether a paired clip's partner is at its mark (observed in the original): once its
 * get-to-mark time is over, it is there when each of its x, y and z is within the clip's
 * fMarkErrorThreshold of the mark's; a clip that reorients it (bReorientSupportChar) asks its
 * turn too, each component of its rotation (about z: the half angle's sine and cosine) within
 * the threshold of the mark's. Until it is, the clip keeps putting it on its mark.
 */
export function atMark(
  position: readonly [number, number, number],
  heading: number,
  mark: readonly [number, number, number],
  markHeading: number,
  threshold: number,
  reorient: boolean,
): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs((position[axis] ?? 0) - (mark[axis] ?? 0)) > threshold) return false;
  }
  if (!reorient) return true;
  // Rotations about z as quaternions: (0, 0, sin(h/2), cos(h/2)); q and -q are one turn.
  const dz = Math.abs(Math.sin(heading / 2) - Math.sin(markHeading / 2));
  const dw = Math.abs(Math.cos(heading / 2) - Math.cos(markHeading / 2));
  const flipZ = Math.abs(Math.sin(heading / 2) + Math.sin(markHeading / 2));
  const flipW = Math.abs(Math.cos(heading / 2) + Math.cos(markHeading / 2));
  return (dz <= threshold && dw <= threshold) || (flipZ <= threshold && flipW <= threshold);
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
