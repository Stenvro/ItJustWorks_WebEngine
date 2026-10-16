// The player using furniture (docs/ai.md, "Furniture and idle markers"; docs/m10-plan.md, 3.3):
// a chair or bench they sit on, a workbench they stand at while its crafting menu is open. They
// use it as actors do (src/shell/actor-furniture.ts: its marker and way in, the enter and exit
// idles of the idle tree, whose conditions name the player's own: IdleStoolEnterPlayer, ...),
// except that the engine moves them to where the enter begins at once (its path tweener: a
// short slide and turn) instead of letting them walk. While in it, their controls do nothing
// but look round; a movement key gets them up. Furniture with the FurnitureForce3rdPerson or
// FurnitureForce1stPerson keyword sets the camera while it is used.

import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { PlaySession } from './play-session.ts';
import type { PlayerAvatar } from './player-avatar.ts';

/** KYWD FurnitureForce3rdPerson, FurnitureForce1stPerson (Skyrim.esm). */
const FORCE_THIRD_PERSON = 0xa56d8;
const FORCE_FIRST_PERSON = 0xa56d7;
/** The player slides to where an enter begins at this speed, at least this long (seconds). */
const SLIDE_SPEED = 300;
const SLIDE_MIN = 0.15;
/** And turns to its heading at this rate (radians per second). */
const TURN_RATE = Math.PI * 2;
/** The movement events that get the player up. */
const GET_UP = ['Forward', 'Back', 'Strafe Left', 'Strafe Right'] as const;

interface Slide {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly seconds: number;
  elapsed: number;
  readonly done: (arrived: boolean) => void;
}

export interface PlayerFurnitureOptions {
  readonly furniture: ActorFurniture;
  readonly play: PlaySession;
  readonly avatar: PlayerAvatar;
  /** Whether a reference's base has a keyword. */
  readonly hasKeyword: (reference: number, keyword: number) => Promise<boolean>;
  /** Whether a menu is open (its keys are its own). */
  readonly menuOpen: () => boolean;
}

export class PlayerFurniture {
  readonly #furniture: ActorFurniture;
  readonly #play: PlaySession;
  readonly #avatar: PlayerAvatar;
  readonly #options: PlayerFurnitureOptions;
  /** The player as a user of furniture. */
  readonly user: FurnitureUser;
  #seated = false;
  #slide: Slide | undefined;
  #turnTo: number | undefined;
  /** The camera the player had before furniture forced one. */
  #pov: 'first' | 'third' | undefined;
  #leaving: Promise<void> | undefined;

  constructor(options: PlayerFurnitureOptions) {
    const { furniture, play, avatar } = options;
    this.#furniture = furniture;
    this.#play = play;
    this.#avatar = avatar;
    this.#options = options;
    const player = play.player;
    this.user = {
      reference: PLAYER_REF,
      get placed() {
        return avatar.body;
      },
      get position() {
        return player.feet;
      },
      get heading() {
        return avatar.bodyYaw;
      },
      moveTo: (position, heading) => {
        player.teleport(position);
        avatar.bodyYaw = heading;
      },
      send: (event) => avatar.send(event),
    };
  }

  /** Whether furniture holds the player (from using it until they stand again). */
  get seated(): boolean {
    return this.#seated;
  }

  /**
   * Uses a furniture: in it, `then` runs with what gets the player up (a workbench's menu,
   * closed, gets them up). Resolves whether they got in.
   */
  async use(object: CellObject, then?: (leave: () => void) => void): Promise<boolean> {
    if (this.#seated) return false;
    this.#hold(true);
    const forced = await this.#forcedPov(object.reference);
    if (forced) {
      this.#pov = this.#play.player.pov;
      this.#play.player.setPov(forced);
      this.#play.player.povLocked = true;
    }
    const inside = await this.#furniture.use(
      this.user,
      object.reference,
      (to) => this.#slideTo(to),
      (heading) => {
        this.#turnTo = heading;
      },
    );
    if (!inside) {
      this.#stand();
      return false;
    }
    then?.(() => {
      void this.leave();
    });
    return true;
  }

  /** Gets up: the furniture's exit plays, then the player stands and moves again. */
  leave(): Promise<void> {
    this.#leaving ??= this.#furniture.leave(this.user).finally(() => {
      this.#leaving = undefined;
      this.#stand();
    });
    return this.#leaving;
  }

  /**
   * Every frame after the player's body animated (`seconds` of its graphs): the slide and
   * turn to where an enter begins, the furniture's root motion; a movement key gets a seated
   * player up.
   */
  frame(seconds: number): void {
    if (!this.#seated) return;
    const player = this.#play.player;
    const slide = this.#slide;
    if (slide) {
      slide.elapsed += seconds;
      const t = Math.min(1, slide.elapsed / slide.seconds);
      const at: Vec3 = [
        slide.from[0] + (slide.to[0] - slide.from[0]) * t,
        slide.from[1] + (slide.to[1] - slide.from[1]) * t,
        slide.from[2] + (slide.to[2] - slide.from[2]) * t,
      ];
      player.teleport(at);
      if (t >= 1) {
        this.#slide = undefined;
        slide.done(true);
      }
    }
    const turnTo = this.#turnTo;
    if (turnTo !== undefined) {
      const yaw = this.#avatar.bodyYaw;
      const delta = Math.atan2(Math.sin(turnTo - yaw), Math.cos(turnTo - yaw));
      const step = TURN_RATE * seconds;
      this.#avatar.bodyYaw = Math.abs(delta) <= step ? turnTo : yaw + Math.sign(delta) * step;
      if (Math.abs(delta) <= step) this.#turnTo = undefined;
    }
    this.#furniture.animated(this.user, seconds);
    const using = this.#furniture.interaction(PLAYER_REF);
    const menuOpen = this.#options.menuOpen();
    if (using?.state === 3 && !menuOpen && GET_UP.some((name) => player.isHeld(name))) {
      void this.leave();
    }
  }

  /** The player moves again (the furniture let go of them, or they never got in). */
  #stand(): void {
    this.#slide?.done(false);
    this.#slide = undefined;
    this.#turnTo = undefined;
    if (this.#pov !== undefined) {
      this.#play.player.setPov(this.#pov);
      this.#play.player.povLocked = false;
      this.#pov = undefined;
    }
    this.#hold(false);
  }

  #hold(held: boolean): void {
    this.#seated = held;
    this.#play.seated = held;
    this.#avatar.seated = held;
  }

  /** Slides the player to a place (the path tweener), the slide's time by its length. */
  #slideTo(to: Vec3): Promise<boolean> {
    const from = this.#play.player.feet;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    this.#slide?.done(false);
    return new Promise((resolve) => {
      this.#slide = {
        from: [...from],
        to: [to[0], to[1], from[2]],
        seconds: Math.max(SLIDE_MIN, length / SLIDE_SPEED),
        elapsed: 0,
        done: resolve,
      };
    });
  }

  /** The camera a furniture's keywords force while it is used, if any. */
  async #forcedPov(reference: number): Promise<'first' | 'third' | undefined> {
    const { hasKeyword } = this.#options;
    if (await hasKeyword(reference, FORCE_THIRD_PERSON)) return 'third';
    if (await hasKeyword(reference, FORCE_FIRST_PERSON)) return 'first';
    return undefined;
  }
}
