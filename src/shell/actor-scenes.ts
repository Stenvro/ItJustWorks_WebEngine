// Actors of the loaded area in scenes (src/ai/scene-runtime.ts): an actor whose dialogue action
// has Face Target turns to its target while it stands (not on its way, not in furniture, not
// talking with the player: it faces the player then), as the in-game dialogue package turns it
// to the player (src/shell/actor-ai.ts); a package's own facing (HoldPosition's marker) comes
// back once the action ends. Its head turns through the world's look-at
// (src/scripting/runtime/scene-host.ts); its packages come from the scene through its AI's
// package stack. TODO(M13): the engine's turn while the actor walks its scene package.

import type { MoveRequest } from '../ai/locomotion.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorFurniture } from './actor-furniture.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';

export class ActorScenes {
  readonly #session: GameSession;
  readonly #movers: ActorMovers;
  readonly #furniture: ActorFurniture;
  /** The facing each actor was asked for, and the standing request of its AI it replaced. */
  readonly #facing = new Map<
    number,
    { readonly request: MoveRequest; readonly replaced: MoveRequest | undefined }
  >();

  constructor(options: {
    readonly session: GameSession;
    readonly movers: ActorMovers;
    readonly furniture: ActorFurniture;
  }) {
    this.#session = options.session;
    this.#movers = options.movers;
    this.#furniture = options.furniture;
  }

  /** Every frame (after the actors' AI): those that face their scene target turn to it. */
  frame(actors: Iterable<StagedActor>): void {
    const runtime = this.#session.scriptsReady;
    const movers = this.#movers;
    const facing = new Set<number>();
    for (const staged of actors) {
      const reference = staged.reference;
      const look = runtime?.scenes.lookOf(reference);
      if (
        !runtime ||
        staged.dead ||
        !look?.face ||
        look.target === undefined ||
        runtime.dialogueSpeaker === reference ||
        movers.travelOf(reference) !== undefined ||
        this.#furniture.holds(reference)
      ) {
        continue;
      }
      const ours = this.#facing.get(reference);
      const current = movers.requestOf(reference);
      // Its AI's request to go somewhere is not taken over; one to stand facing a way is.
      if (current?.direction !== undefined && current !== ours?.request) continue;
      const at = this.#session.scriptWorld.livePlacement(look.target)?.position;
      if (!at) continue;
      const heading = Math.atan2(at[0] - staged.position[0], at[1] - staged.position[1]);
      const request: MoveRequest = { gait: 'walk', face: heading };
      const replaced = ours && current === ours.request ? ours.replaced : current;
      movers.request(reference, request);
      this.#facing.set(reference, { request, replaced });
      facing.add(reference);
    }
    // Those no longer facing are let go (if what they were asked is still the scene's): their
    // AI's standing request comes back.
    for (const [reference, entry] of [...this.#facing]) {
      if (facing.has(reference)) continue;
      this.#facing.delete(reference);
      if (movers.requestOf(reference) === entry.request) movers.request(reference, entry.replaced);
    }
  }
}
