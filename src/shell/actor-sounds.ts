// The sounds actors' animations raise: their footsteps (the events their footstep set answers,
// FootLeft, FootRight, FootFront, JumpDown, ..., sounding the impact for the ground underfoot)
// and SoundPlay events (SoundPlay.<descriptor>: a sound descriptor by editor id at the actor;
// NPCSoundPlay.<descriptor> only for actors other than the player). Notes: docs/audio.md
// ("Footsteps").

import type RAPIER from '@dimforge/rapier3d-compat';
import type { SoundSystem } from '../audio/sound-system.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorLook } from '../world/actors.ts';
import type { FootstepGait } from '../world/footstep-records.ts';

/** An actor whose animations sound. */
export interface SoundingActor {
  readonly look: ActorLook;
  /** Where its feet are now. */
  feet(): Vec3;
  /** How it moves now (which of its footsteps answer). */
  gait(): FootstepGait;
  readonly player: boolean;
  /** Its own collision (the player's character controller), left out of the ground ray. */
  readonly collider?: RAPIER.Collider;
}

/** What actors' sounds need of the world. */
export interface SoundingWorld {
  sounds(): SoundSystem | undefined;
  /** What lies underfoot at a point (a ray down), or undefined where nothing is loaded. */
  ground(
    at: Vec3,
    exclude?: RAPIER.Collider,
  ): { readonly material: number; readonly landscape: boolean } | undefined;
}

const SOUND_PLAY = 'soundplay.';
const NPC_SOUND_PLAY = 'npcsoundplay.';

/** The handler of an actor's raised events (AnimatedSkeleton.onEvents). */
export function actorSounds(
  actor: SoundingActor,
  world: SoundingWorld,
): (events: readonly string[]) => void {
  return (events) => {
    const sounds = world.sounds();
    if (!sounds) return;
    for (const event of events) {
      const lower = event.toLowerCase();
      if (lower.startsWith(SOUND_PLAY)) {
        void sounds.playNamed(event.slice(SOUND_PLAY.length), () => actor.feet());
        continue;
      }
      if (lower.startsWith(NPC_SOUND_PLAY)) {
        if (!actor.player)
          void sounds.playNamed(event.slice(NPC_SOUND_PLAY.length), () => actor.feet());
        continue;
      }
      const set = actor.look.footstepSet;
      if (set === undefined) continue;
      const feet = actor.feet();
      const ground = world.ground(feet, actor.collider);
      if (!ground) continue;
      void sounds.footstep(set, event, actor.gait(), feet, ground);
    }
  };
}

/** How far above and below the feet the ground is looked for (game units). */
const GROUND_ABOVE = 32;
const GROUND_BELOW = 96;

/** What lies under a point in a physics world (a ray down, as characters collide). */
export function groundUnder(
  physics: PhysicsWorld | undefined,
  at: Vec3,
  exclude?: RAPIER.Collider,
): { readonly material: number; readonly landscape: boolean } | undefined {
  const hit = physics?.raycast(
    [at[0], at[1], at[2] + GROUND_ABOVE],
    [0, 0, -1],
    GROUND_ABOVE + GROUND_BELOW,
    Layer.charController,
    exclude,
  );
  return hit && { material: hit.material, landscape: hit.owner?.kind === 'landscape' };
}

/** Placed actors' animations sound (they stand where they were placed: TODO(M10) gaits). */
export function soundPlacedActors(actors: readonly PlacedActorLike[], world: SoundingWorld): void {
  for (const placed of actors) {
    placed.onEvents = actorSounds(
      { look: placed.look, feet: () => feetOf(placed), gait: () => 'walk', player: false },
      world,
    );
  }
}

/** What soundPlacedActors needs of a placed actor (PlacedActor). */
interface PlacedActorLike {
  readonly look: ActorLook;
  readonly actor: { readonly position: Vec3 };
  /** Its placement (its feet are where it was set on the ground). */
  readonly instances: readonly { readonly world: Float32Array }[];
  onEvents?: (events: readonly string[]) => void;
}

/** Where a placed actor's feet are: its placement, else its reference. */
function feetOf(placed: PlacedActorLike): Vec3 {
  const world = placed.instances[0]?.world;
  return world ? [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] : placed.actor.position;
}
