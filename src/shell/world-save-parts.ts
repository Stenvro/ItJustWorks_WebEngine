// The parts of a view's world a save keeps beside its actors and graphs (docs/formats/save.md):
// the decals on the world, the animation objects actors hold, the loose objects in motion and
// what actors know of each other. Each is put back by its own system as the world loads again
// (src/save/world-save.ts WorldRestore).

import type { WorldSaveParts } from '../save/world-save.ts';
import type { ActorStage } from './actor-stage.ts';
import type { PlaySession } from './play-session.ts';

/** A view's parts for a save (those empty left out). */
export function worldSaveParts(
  stage: ActorStage | undefined,
  play: PlaySession | undefined,
): WorldSaveParts {
  const decals = stage?.combat.saveDecals() ?? [];
  const animObjects = stage?.animObjects.save() ?? [];
  const motions = play?.saveMotions() ?? [];
  const saved = stage?.senses.saveDetection();
  const detection =
    saved &&
    [saved.known, saved.alerted, saved.alarmed, saved.attacked, saved.offences].some(
      (list) => list.length > 0,
    )
      ? saved
      : undefined;
  return {
    ...(decals.length > 0 && { decals }),
    ...(animObjects.length > 0 && { animObjects }),
    ...(motions.length > 0 && { motions }),
    ...(detection && { detection }),
  };
}

/** The parts of every view merged (the first view's detection: there is one stage). */
export function mergeWorldSaveParts(parts: readonly WorldSaveParts[]): WorldSaveParts {
  const decals = parts.flatMap((part) => part.decals ?? []);
  const animObjects = parts.flatMap((part) => part.animObjects ?? []);
  const motions = parts.flatMap((part) => part.motions ?? []);
  const detection = parts.find((part) => part.detection)?.detection;
  return {
    ...(decals.length > 0 && { decals }),
    ...(animObjects.length > 0 && { animObjects }),
    ...(motions.length > 0 && { motions }),
    ...(detection && { detection }),
  };
}
