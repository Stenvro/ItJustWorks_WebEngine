// The player knocked down (docs/ai.md, "Combat": Staggers and knock-downs): a draugr's or a
// dragon's Unrelenting Force, a giant's knock-down, a script's PushActorAway on the player. As
// an NPC does (src/shell/actor-knockdowns.ts) their body goes limp as its ragdoll and gets up
// through its graph; meanwhile their keys do nothing (no movement, attacks, casts or activation:
// PlaySession.knocked), their controller's shape is out of the way, and the camera is the
// engine's ragdoll camera on the body (the bleedout camera the dead player's is:
// src/shell/death-camera.ts). Getting up, the controller goes where the body stands.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { PlayerDeathSettings } from '../gameplay/combat/player-death.ts';
import type { Vec3 } from '../render/math.ts';
import type { BodyHolder } from './actor-bodies.ts';
import type { KnockSubject } from './actor-knockdowns.ts';
import type { PlacedActor } from './actors.ts';
import { DeathCamera } from './death-camera.ts';
import type { PlayerAvatar } from './player-avatar.ts';
import type { PlayerView } from './race-menu.ts';

/** The player as one knocked down: their avatar's body, their controls and camera. */
export class PlayerKnockSubject implements KnockSubject {
  readonly reference = PLAYER_REF;
  readonly holder: BodyHolder;
  readonly #view: PlayerView;
  readonly #avatar: PlayerAvatar;
  readonly #settings: PlayerDeathSettings;
  #camera: DeathCamera | undefined;
  #elapsed = 0;

  constructor(view: PlayerView, avatar: PlayerAvatar, settings: PlayerDeathSettings) {
    this.#view = view;
    this.#avatar = avatar;
    this.#settings = settings;
    const world = avatar.placement.world;
    this.holder = {
      reference: PLAYER_REF,
      placed: avatar.body,
      position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
      visibility: { hidden: false },
      dead: false,
      world,
    };
  }

  get placed(): PlacedActor {
    return this.#avatar.body;
  }

  get heading(): number {
    return this.#avatar.bodyYaw;
  }

  get dead(): boolean {
    return this.#view.play.dead;
  }

  /** The body stands there; the player's controller goes with it (the camera keeps its turn). */
  moveTo(position: Vec3, heading: number): void {
    this.#view.play.player.teleport([...position]);
    this.#avatar.placeAt(position, heading);
  }

  lying(on: boolean): void {
    const { play } = this.#view;
    const player = play.player;
    play.knocked = on;
    this.#avatar.knocked = on;
    // While it lies the body is what is there: the controller's shape is out of the way.
    player.character.solid = !on;
    if (on) {
      player.releaseAll();
      player.character.velocity = [0, 0];
      const current = play.view;
      this.#elapsed = 0;
      this.#camera = new DeathCamera({
        from: {
          position: [...current.position],
          forward: current.forward ? [...current.forward] : [...player.forward],
        },
        body: this.#avatar.body,
        world: this.#avatar.placement.world,
        physics: play.physics,
        settings: this.#settings,
        lens: player,
        turn: Math.random() < 0.5 ? -1 : 1,
      });
      play.cameraOverride = this.#camera;
    } else {
      if (this.#camera && play.cameraOverride === this.#camera) play.cameraOverride = undefined;
      this.#camera = undefined;
    }
  }

  frame(seconds: number): void {
    const camera = this.#camera;
    if (!camera) return;
    this.#elapsed += seconds;
    camera.elapsed = this.#elapsed;
    const { play } = this.#view;
    // A killmove's camera gives way to it, as to the death camera.
    if (play.cameraOverride !== camera && !play.dead) play.cameraOverride = camera;
  }
}
