// The player's followers in the loaded area (docs/ai.md, "Followers, mounts and vehicles"; the
// rules: src/ai/followers.ts): the actors whose package follows the player now (Follow,
// FollowTo: src/shell/actor-ai.ts keeps who follows whom). They come along through load doors
// and on fast travel (put beside the player's arrival in the game state, so the place they come
// to shows them as it loads), the player's last ridden horse too on fast travel to an
// exterior; the player's teammates sneak while the player sneaks; one left far behind out of
// the player's sight catches up behind the player.

import { aiSettingsOf } from '../ai/ai-settings.ts';
import {
  CATCH_UP_SECONDS,
  catchUpPlace,
  catchUpTime,
  doorSpacing,
  outOfSight,
  placesBeside,
} from '../ai/followers.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

/** The size of an exterior cell (units). */
const CELL_SIZE = 4096;
/** A follower catching up is put this far behind the player (units). */
const CATCH_UP_BEHIND = 512;
/** ... on the navmesh within this of that point (units). */
const CATCH_UP_REACH = 256;

export interface ActorFollowersOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly ai: ActorAi;
  readonly movers: ActorMovers;
  readonly actors: () => Iterable<StagedActor>;
  readonly player?: () => PlayerView | undefined;
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** An actor of the stage was put somewhere (its controller goes there). */
  readonly teleport: (staged: StagedActor, position: Vec3, heading: number) => void;
}

export class ActorFollowers {
  readonly #options: ActorFollowersOptions;
  /** Each follower's catch-up clock (seconds far behind and unseen). */
  readonly #behind = new Map<number, number>();
  /** The teammates sneaking because the player sneaks. */
  readonly #sneaking = new Set<number>();

  constructor(options: ActorFollowersOptions) {
    this.#options = options;
  }

  /** The actors of the stage that follow the player now. */
  followers(): StagedActor[] {
    const { ai } = this.#options;
    const found: StagedActor[] = [];
    for (const staged of this.#options.actors()) {
      if (!staged.dead && ai.leaderOf(staged.reference) === PLAYER_REF) found.push(staged);
    }
    return found;
  }

  /**
   * Every frame: the player's teammates sneak with them; a follower far behind, out of their
   * sight for a while, is put behind them.
   */
  frame(seconds: number): void {
    const { session, movers } = this.#options;
    const view = this.#options.player?.();
    const runtime = session.scriptsReady;
    if (!view || !runtime) return;
    const player = view.play.player;
    const sneaking = player.sneaking;
    const followers = this.followers();
    const following = new Set(followers.map((staged) => staged.reference));
    for (const staged of followers) {
      const reference = staged.reference;
      // Teammates sneak while the player sneaks.
      const teammate = runtime.state.actors.get(reference)?.playerTeammate === true;
      if (teammate && sneaking && !this.#sneaking.has(reference)) {
        this.#sneaking.add(reference);
        movers.sneak(reference, true);
      } else if ((!teammate || !sneaking) && this.#sneaking.delete(reference)) {
        movers.sneak(reference, false);
      }
      const feet = player.feet;
      const distance = Math.hypot(staged.position[0] - feet[0], staged.position[1] - feet[1]);
      const unseen = outOfSight({ position: player.position, forward: player.forward }, [
        staged.position[0],
        staged.position[1],
        staged.position[2] + 64,
      ]);
      const since = catchUpTime(this.#behind.get(reference) ?? 0, seconds, distance, unseen);
      this.#behind.set(reference, since);
      if (since >= CATCH_UP_SECONDS) {
        this.#behind.delete(reference);
        this.#catchUp(staged, feet, player.forward);
      }
    }
    for (const reference of [...this.#sneaking]) {
      if (!following.has(reference) && this.#sneaking.delete(reference)) {
        movers.sneak(reference, false);
      }
    }
    for (const reference of [...this.#behind.keys()]) {
      if (!following.has(reference)) this.#behind.delete(reference);
    }
  }

  /** A follower put behind the player, on the navmesh there (none near: it stays). */
  #catchUp(staged: StagedActor, feet: Vec3, forward: Vec3): void {
    const point = catchUpPlace({ position: feet, forward }, CATCH_UP_BEHIND);
    const on = this.#options.navmeshes?.()?.nearest?.(point, CATCH_UP_REACH);
    if (!on) return;
    const heading = Math.atan2(feet[0] - on[0], feet[1] - on[1]);
    this.#options.movers.stop(staged.reference);
    this.#options.teleport(staged, [on[0], on[1], on[2]], heading);
    this.#options.terminal.log('actor', `${staged.placed.look.editorId} caught up with the player`);
  }

  /**
   * The player goes elsewhere (a load door, fast travel): their followers come along, put
   * beside where the player arrives (the game state: they show as that place loads); on fast
   * travel (`horse`) to an exterior, the player's last ridden horse too.
   */
  async comeAlong(arrival: Placement, horse: boolean): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    // The cell of an exterior arrival (the game state keeps an actor's cell and worldspace).
    const db = runtime.forms.db;
    const world = arrival.world;
    const cell =
      world === undefined
        ? arrival.cell
        : ((await db.exteriorCell(
            world,
            Math.floor(arrival.position[0] / CELL_SIZE),
            Math.floor(arrival.position[1] / CELL_SIZE),
          )) ?? db.persistentCell(world));
    const going = this.followers().map((staged) => staged.reference);
    const last = runtime.lastHorse;
    if (horse && arrival.world !== undefined && last !== undefined && !going.includes(last)) {
      if (runtime.state.actors.get(last)?.dead !== true) going.push(last);
    }
    // Through a door one behind another at fFollowerSpacingAtDoors; on fast travel at
    // fFollowSpaceBetweenFollowers.
    const settings = aiSettingsOf(this.#options.session);
    const places = placesBeside(
      { position: arrival.position, heading: arrival.rotation[2] },
      going.length,
      horse ? settings.followSpacing : doorSpacing(settings),
    );
    going.forEach((reference, i) => {
      const place = places[i];
      if (!place) return;
      runtime.move(reference, [...place.position], [0, 0, place.heading], cell, world);
    });
    if (going.length > 0) {
      this.#options.terminal.log('actor', `${String(going.length)} come along with the player`);
    }
  }
}
