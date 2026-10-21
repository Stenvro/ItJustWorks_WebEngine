// The player driven by the scripts (SetPlayerAIDriven; docs/ai.md, "The player driven by AI"):
// while they are, the player runs AI packages as an actor does (src/shell/actor-ai.ts: a scene's
// package actions, their aliases' packages; MQ101's prisoner walks up to the headsman's block),
// and the movement keys do nothing. Their packages move the player's own controller
// (src/shell/player.ts, pilot): along navmesh paths, turned to headings, into furniture.

import { findPath, type NavmeshSet } from '../ai/pathfinding.ts';
import { PathFollower, type DoorPassage } from '../ai/path-follower.ts';
import type { PackageBody, TravelOptions } from '../ai/package-runtime.ts';
import type { Gait, MoveRequest } from '../ai/locomotion.ts';
import type { Space } from '../ai/package-start.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorFurniture } from './actor-furniture.ts';
import { spaceOf } from './actors-away.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerFurniture } from './player-furniture.ts';
import type { Player } from './player.ts';

/** A stuck player searches their way again this many times before the travel fails. */
const SEARCHES = 3;
/** They walk up to furniture this near before its enter's slide (game units). */
const FURNITURE_REACH = 96;
/** Standing: turned to within this of the heading asked (radians). */
const FACED = 0.05;

interface Travel {
  readonly destination: Vec3;
  readonly gait: Gait;
  readonly arrive: number;
  direct: boolean;
  follower: PathFollower | undefined;
  searches: number;
  readonly done: (arrived: boolean) => void;
}

export interface PlayerPilotOptions {
  readonly session: GameSession;
  readonly ai: ActorAi;
  readonly furniture: ActorFurniture;
  /** The player's controller, if they are in the world. */
  readonly player: () => Player | undefined;
  /** The player in furniture. */
  readonly seat: () => PlayerFurniture | undefined;
  /** The navigation meshes of the loaded area. */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** A door on the way as the player comes to it (opened for them). */
  readonly door?: (door: number) => DoorPassage | undefined;
}

export class PlayerPilot {
  readonly #options: PlayerPilotOptions;
  #body: PackageBody | undefined;
  #travel: Travel | undefined;
  /** The heading asked standing (undefined: none). */
  #face: number | undefined;
  #request: MoveRequest | undefined;

  constructor(options: PlayerPilotOptions) {
    this.#options = options;
  }

  /** Whether the scripts drive the player now. */
  get driving(): boolean {
    return this.#body !== undefined;
  }

  /** Every frame (real seconds): the packages run while the scripts drive the player. */
  frame(seconds: number): void {
    const { session, ai } = this.#options;
    const player = this.#options.player();
    const driven = session.scriptsReady?.controls.aiDriven === true && player !== undefined;
    if (!driven) {
      if (this.#body) {
        this.#halt();
        this.#body = undefined;
        ai.drivePlayer(undefined, 0);
      }
      if (player) player.pilot = undefined;
      return;
    }
    this.#body ??= this.#makeBody(player);
    ai.drivePlayer(this.#body, seconds);
    const travel = this.#travel;
    if (travel) this.#travelFrame(player, travel, seconds);
    else this.#request = this.#face === undefined ? undefined : { gait: 'walk', face: this.#face };
    // Standing still unless a package moves them: the movement keys do nothing meanwhile.
    player.pilot = this.#request ?? { gait: 'walk' };
  }

  /** One frame of a travel: its path searched (again), followed, ended. */
  #travelFrame(player: Player, travel: Travel, seconds: number): void {
    const feet = player.feet;
    if (!travel.follower && travel.direct) {
      travel.follower = new PathFollower(
        { points: [[...feet], travel.destination], doors: [], complete: true },
        { gait: travel.gait, arrive: travel.arrive },
      );
    }
    if (!travel.follower) {
      const set = this.#options.navmeshes?.();
      if (!set) {
        travel.done(false);
        return;
      }
      travel.searches++;
      const path = findPath(set, feet, travel.destination, {
        radius: player.character.shape.radius * travel.searches,
      });
      if (!path || path.points.length < 2) {
        travel.done(false);
        return;
      }
      travel.follower = new PathFollower(path, { gait: travel.gait, arrive: travel.arrive });
    }
    const step = travel.follower.step(feet, seconds, this.#options.door);
    if (step.state === 'arrived') {
      travel.done(travel.follower.path.complete);
      return;
    }
    if (step.state === 'stuck' && travel.direct) {
      // Off a straight way (something in it): a navmesh path from here.
      travel.direct = false;
      travel.follower = undefined;
      return;
    }
    if (step.state === 'stuck' || step.state === 'blocked') {
      travel.follower = undefined;
      this.#request = undefined;
      if (step.state === 'blocked' || travel.searches >= SEARCHES) travel.done(false);
      return;
    }
    this.#request = step.request;
  }

  /** The player's travel ends (resolving false) and they stand. */
  #halt(): void {
    this.#travel?.done(false);
    this.#travel = undefined;
    this.#face = undefined;
    this.#request = undefined;
  }

  #go(to: Vec3, gait: Gait, arrive: number, options: TravelOptions = {}): Promise<boolean> {
    this.#travel?.done(false);
    this.#face = undefined;
    return new Promise((resolve) => {
      const travel: Travel = {
        destination: to,
        gait,
        arrive,
        direct: options.direct === true,
        follower: undefined,
        searches: 0,
        done: (arrived) => {
          if (this.#travel !== travel) return;
          this.#travel = undefined;
          this.#request = undefined;
          resolve(arrived);
        },
      };
      this.#travel = travel;
    });
  }

  /** Whether the player is in a space now. */
  async #inSpace(space: Space): Promise<boolean> {
    const at = await this.#options.session.scriptsReady?.placement(PLAYER_REF);
    if (!at) return true;
    const here = spaceOf(at);
    return here.kind === 'world'
      ? space.kind === 'world' && here.world === space.world
      : space.kind === 'interior' && here.cell === space.cell;
  }

  #makeBody(player: Player): PackageBody {
    const { session, furniture, seat } = this.#options;
    const leaveSeat = async (): Promise<void> => {
      const held = seat();
      if (held?.seated) await held.leave();
    };
    const useFurniture = async (target: number, types?: number): Promise<boolean> => {
      const held = seat();
      const at = await session.scriptsReady?.placement(target);
      if (!held || !at) return false;
      await leaveSeat();
      // They walk up to it; the enter's slide takes them in (src/shell/player-furniture.ts).
      await this.#go([...at.position], 'walk', FURNITURE_REACH);
      return held.use({ reference: target }, undefined, types);
    };
    return {
      reference: PLAYER_REF,
      position: () => player.feet,
      heading: () => player.yaw,
      travel: async (to, gait, arrive, space, options) => {
        await leaveSeat();
        // TODO(M13): the player driven through load doors to another cell (no vanilla package
        // takes them there; they stay).
        if (space && !(await this.#inSpace(space))) return false;
        return this.#go(to, gait, arrive, options);
      },
      stop: () => {
        this.#halt();
      },
      face: (heading) => {
        if (this.#travel) return;
        this.#face = heading;
      },
      useFurniture,
      leaveFurniture: leaveSeat,
      takeIdleMarker: (marker) => furniture.takeMarker(PLAYER_REF, marker),
      leaveIdleMarker: () => {
        const user = seat()?.user;
        if (user) furniture.leaveMarker(user);
      },
      playIdle: async (idle) => {
        const user = seat()?.user;
        return user ? furniture.playIdle(user, idle) : false;
      },
      // The player has no lines of their own to say.
      say: () => undefined,
      activate: async (target) => {
        const scripts = session.scriptsReady;
        if (!scripts) return false;
        const base = await scripts.baseOf(target);
        const record = base === undefined ? undefined : await scripts.forms.record(base);
        if (record?.type === 'FURN') return useFurniture(target);
        return scripts.activate(target, PLAYER_REF, false);
      },
      take: async (target) => {
        const scripts = session.scriptsReady;
        if (!scripts) return false;
        await scripts.pickUp(target, PLAYER_REF);
        return true;
      },
      useItem: async (item, consume) => {
        const scripts = session.scriptsReady;
        if (!scripts) return false;
        const used = await scripts.magic.useItem(PLAYER_REF, item, { remove: consume });
        if (used === 'not used' && consume) {
          await scripts.removeItem(PLAYER_REF, scripts.formHandle(item), 1, true, undefined);
        }
        return true;
      },
      // The player does not stop to talk to themselves.
      greet: () => false,
      standing: () => {
        if (this.#travel || seat()?.seated === true) return false;
        const face = this.#face;
        if (face === undefined) return true;
        return (
          Math.abs(Math.atan2(Math.sin(face - player.yaw), Math.cos(face - player.yaw))) <= FACED
        );
      },
    };
  }
}
