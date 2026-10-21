// The player's death on the stage (docs/ai.md, "Combat"): the runtime killed them (health run
// out, Actor.Kill; src/scripting/runtime/actor-engine.ts) and the stage shows it as the game
// does. Their body goes limp as an NPC's does (its ragdoll: ActorBodies, from the pose it had,
// the killing blow pushing it by fDeathForce*), out of furniture, off a horse or a cart; their
// controller's shape goes (the body is what lies there); their keys do nothing (the console and
// the journal's system page still open: src/shell/game-menus.ts) and the HUD stays as it was;
// the camera goes to the bleedout camera on the body (src/shell/death-camera.ts); enemies leave
// the dead (src/shell/actor-combat.ts). fPlayerDeathReloadTime later the game loads its most
// recent save: the Play mode's to do (HudSignals.menus.reloadAfterDeath); the sandbox, which
// has no saves, leaves the body lying.

import {
  PLAYER_DEATH_DEFAULTS,
  PlayerDeathTimer,
  readPlayerDeathSettings,
  type PlayerDeathSettings,
} from '../gameplay/combat/player-death.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorBodies, BodyHolder } from './actor-bodies.ts';
import { DeathCamera } from './death-camera.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

export interface PlayerDeathOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly bodies: ActorBodies;
  /** The player being played (undefined: no play, nothing to show). */
  readonly player: () => PlayerView | undefined;
}

/** A death being shown. */
interface Dying {
  readonly view: PlayerView;
  /** The avatar's body as ActorBodies keeps it (undefined: no avatar was made). */
  readonly holder: BodyHolder | undefined;
  readonly camera: DeathCamera;
  readonly timer: PlayerDeathTimer;
}

export class PlayerDeath {
  readonly #options: PlayerDeathOptions;
  #settings: PlayerDeathSettings = PLAYER_DEATH_DEFAULTS;
  #settingsRead = false;
  #dying: Dying | undefined;

  constructor(options: PlayerDeathOptions) {
    this.#options = options;
  }

  /** Whether the player lies dead on this stage. */
  get dead(): boolean {
    return this.#dying !== undefined;
  }

  /** The dead player's body, as ActorBodies keeps it (the killing blow pushes it). */
  get body(): BodyHolder | undefined {
    return this.#dying?.holder;
  }

  /** Reads the settings ahead (the death uses them at once). */
  prepare(): void {
    if (this.#settingsRead) return;
    this.#settingsRead = true;
    const session = this.#options.session;
    void session
      .settings()
      .then((settings) => {
        this.#settings = readPlayerDeathSettings(
          (name) => settings.number(name),
          (key) => session.ini.lookup('Camera', key),
        );
      })
      .catch(() => undefined);
  }

  /**
   * The player died (the stage's killed, after furniture, mounts and fights let them go): the
   * body falls, the controls go, the camera goes to the body.
   */
  died(): void {
    const view = this.#options.player();
    if (!view || this.#dying) return;
    this.prepare();
    const { play, avatar } = view;
    const player = play.player;
    play.dead = true;
    play.seated = false;
    player.releaseAll();
    player.sneaking = false;
    // The body lies where it falls; the controller's shape is not in its way.
    player.character.solid = false;
    player.character.velocity = [0, 0];
    let holder: BodyHolder | undefined;
    if (avatar) {
      avatar.die();
      avatar.seated = false;
      const world = avatar.placement.world;
      holder = {
        reference: PLAYER_REF,
        placed: avatar.body,
        position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
        visibility: { hidden: false },
        dead: true,
        world,
      };
      void this.#options.bodies.kill(holder).catch((error: unknown) => {
        this.#options.terminal.log(
          'actor',
          `the player's ragdoll: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      });
    }
    // The camera the player looked through (a killmove's too) is where the death camera starts.
    const current = play.view;
    const camera = new DeathCamera({
      from: {
        position: [...current.position],
        forward: current.forward ? [...current.forward] : [...player.forward],
      },
      body: avatar?.body,
      world: avatar?.placement.world ?? feetWorld(player.feet),
      physics: play.physics,
      settings: this.#settings,
      lens: player,
      turn: Math.random() < 0.5 ? -1 : 1,
    });
    play.cameraOverride = camera;
    this.#dying = { view, holder, camera, timer: new PlayerDeathTimer(this.#settings) };
    // Its menus close (a conversation, a container), as dying ends them in the game.
    this.#options.session.hud.menus?.playerDied?.();
    this.#options.terminal.log('actor', 'the player died', 'info');
  }

  /**
   * Every frame (the game's seconds: a menu holds them): the camera on the body; the reload
   * once fPlayerDeathReloadTime has passed.
   */
  frame(seconds: number): void {
    const dying = this.#dying;
    if (!dying) return;
    const { play } = dying.view;
    // The death camera stays the player's (a killmove's camera gives way to it).
    if (play.cameraOverride !== dying.camera) play.cameraOverride = dying.camera;
    if (!dying.timer.advance(seconds)) {
      dying.camera.elapsed = dying.timer.elapsed;
      return;
    }
    dying.camera.elapsed = dying.timer.elapsed;
    const menus = this.#options.session.hud.menus;
    // After this frame: the reload ends the world this frame is drawing.
    if (menus?.reloadAfterDeath) {
      setTimeout(() => {
        if (this.#dying === dying) menus.reloadAfterDeath?.();
      }, 0);
    } else {
      this.#options.terminal.log(
        'actor',
        'the player is dead: the sandbox has no save to load (reset the states to play on)',
        'info',
      );
    }
  }

  /** The play ended (the stage lets go of it): the death with it. */
  clear(): void {
    const dying = this.#dying;
    this.#dying = undefined;
    if (dying && dying.view.play.cameraOverride === dying.camera) {
      dying.view.play.cameraOverride = undefined;
    }
  }
}

/** A placement at the feet (no avatar: the camera looks at where the player stood). */
function feetWorld(feet: readonly number[]): Float32Array {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = feet[0] ?? 0;
  world[13] = feet[1] ?? 0;
  world[14] = feet[2] ?? 0;
  return world;
}
