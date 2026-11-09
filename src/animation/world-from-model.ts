// Where a knocked-down character is while its ragdoll lies (docs/physics.md, "Powered
// ragdolls"): Havok's ragdoll driver takes the character's world-from-model, while a powered
// ragdoll controls modifier is active, from that modifier's hkbWorldFromModelModeData. The
// vanilla graphs have two per character: FullyRagdoll's (force 0) from the ragdoll (4), the
// get-up's matching (force 200) computed from the pose matching bones (2).
//
// An actor's placement here is upright (a position on the ground and a heading), not a full
// turn: "from the ragdoll" moves it by the way its ragdoll's root body has gone since it went
// limp, keeping its heading (inferred, TODO(M13): Havok's mode takes the root body's whole
// transform; the engine's actor stays upright, and which point of the ragdoll it follows is not
// read). "Computed" is the get-up's pose match (src/animation/pose-matching.ts: the frame whose
// pose matching bones lie as the ragdoll's do), the frame the actor stands up in.

/** hkbWorldFromModelModeData::WorldFromModelMode. */
export const WORLD_FROM_MODEL_MODE = {
  /** The one it had (kept). */
  useOld: 0,
  /** The graph's input (the character's own placement). */
  useInput: 1,
  /** Computed so the pose matching bones of the pose lie as the ragdoll's do. */
  compute: 2,
  /** None (identity). */
  none: 3,
  /** The ragdoll's root body's. */
  ragdoll: 4,
} as const;

/** Where a character is: its position and the heading it faces (radians). */
export interface UprightPlace {
  readonly position: readonly [number, number, number];
  readonly heading: number;
}

/**
 * Where a knocked-down character is by its active powered ragdoll controls' world-from-model
 * `mode` (undefined: none active): `own` its placement as it was knocked down, `last` where this
 * gave it last, `ragdollWay` how far its ragdoll's root has gone since it went limp, `matched`
 * the get-up's match (undefined until one is made). From the ragdoll: its own place moved by
 * the ragdoll's way. Computed: the match, else as from the ragdoll. The old one: the last, else
 * its own. The input, none (TODO(M13): Havok's identity has no meaning for a placed actor) and
 * no powered controls: its own.
 */
export function knockedPlace(
  mode: number | undefined,
  own: UprightPlace,
  last: UprightPlace | undefined,
  ragdollWay: readonly [number, number, number] | undefined,
  matched: UprightPlace | undefined,
): UprightPlace {
  const fromRagdoll = (): UprightPlace =>
    ragdollWay
      ? {
          position: [
            own.position[0] + ragdollWay[0],
            own.position[1] + ragdollWay[1],
            own.position[2] + ragdollWay[2],
          ],
          heading: own.heading,
        }
      : own;
  switch (mode) {
    case WORLD_FROM_MODEL_MODE.ragdoll:
      return fromRagdoll();
    case WORLD_FROM_MODEL_MODE.compute:
      return matched ?? fromRagdoll();
    case WORLD_FROM_MODEL_MODE.useOld:
      return last ?? own;
    default:
      return own;
  }
}
