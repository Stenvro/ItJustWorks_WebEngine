// A player who follows a guide as a real player does, for the headless simulation: they walk (never
// put anywhere) after the guide over the navmeshes, stand when near, fall behind now and then, and
// either fight by button presses or leave the fighting to the guide; beside a guide who stands
// with nothing going on, they go on by the quest's marker. Used by Helgen Keep's and the walk to
// Riverwood's follow cases (tests/sim-helgen-keep-follow.int.test.ts).

import type { Placement } from '../../src/scripting/runtime/runtime.ts';
import { firstDoorToward, questTargets } from '../../src/shell/compass.ts';
import { PLAYER_REF, type Sim } from './sim.ts';

type Vec3 = [number, number, number];

/** How the player plays. */
export interface FollowStyle {
  /** They fight what fights them or the guide (swings by real input); else they stand aside. */
  readonly fights: boolean;
  /**
   * They fall behind: every `lagEvery` seconds of play they stand `lagFor` seconds wherever
   * they are (looking about, looting), letting the guide get ahead.
   */
  readonly lagEvery: number;
  readonly lagFor: number;
}

/** Nearer than this to the guide the player stands; further, they walk after them. */
const FOLLOW_NEAR = 220;
/** How near they walk up to the guide before standing again. */
const FOLLOW_REACH = 140;
/** Nearer than this to a guide who waits (stands still) the player stands, and how near they go. */
const WAITED_NEAR = 95;
const WAITED_REACH = 70;
/** Seconds beside a guide who stands, nothing going on, before they go on by the quest's marker. */
const LEAD_AFTER = 10;
/** Leading, a guide this far behind who stands has them go back to them. */
const LEAD_AHEAD = 600;
/** A walk after the guide lasts at most this long before they look again (seconds). */
const FOLLOW_LEG = 1.5;
/** An enemy this near the player (units) is fought, by one who fights. */
const FIGHT_REACH = 900;
/** The weapon's reach the player swings within. */
const SWING_REACH = 110;

/** One stall: nothing moved on for a while (for the case's message). */
export interface Stall {
  readonly at: number;
  readonly what: string;
}

export class Follower {
  readonly stalls: Stall[] = [];
  #last = '';
  #since = 0;
  #played = 0;
  #reported = false;
  #guideAt: Vec3 | undefined;
  #stillFor = 0;
  #besideFor = 0;
  #leading = false;
  /** The load door the guide went through, if they are in another space. */
  door: Vec3 | undefined;

  readonly sim: Sim;
  /** The guide now (the quest's alias may change hands). */
  readonly guide: () => number;
  readonly style: FollowStyle;
  /** A line saying where the game stands (stage, scene phases), for stalls. */
  readonly progress: () => string;

  constructor(sim: Sim, guide: () => number, style: FollowStyle, progress: () => string) {
    this.sim = sim;
    this.guide = guide;
    this.style = style;
    this.progress = progress;
  }

  /** The living actors in combat with the player or the guide. */
  async enemies(): Promise<number[]> {
    const guide = this.guide();
    const fighting = new Map<number, number | undefined>();
    for (const event of this.sim.events('combat')) {
      if (event.state !== 0) fighting.set(event.actor, event.target);
      else fighting.delete(event.actor);
    }
    const out: number[] = [];
    for (const [actor, target] of fighting) {
      if (actor === guide || actor === PLAYER_REF) continue;
      if (target !== PLAYER_REF && target !== guide) continue;
      if (await this.sim.runtime.actors.isDead(actor)) continue;
      out.push(actor);
    }
    return out;
  }

  /** The nearest of the enemies within reach of the player, if any. */
  async #nearestEnemy(): Promise<number | undefined> {
    let best: number | undefined;
    let nearest = FIGHT_REACH;
    for (const enemy of await this.enemies()) {
      const away = await this.sim.distance(enemy, PLAYER_REF);
      if (away !== undefined && away < nearest) {
        nearest = away;
        best = enemy;
      }
    }
    return best;
  }

  /** Whether the player stands behind now (the lag schedule). */
  get lagging(): boolean {
    const { lagEvery, lagFor } = this.style;
    if (lagEvery <= 0) return false;
    return this.#played % lagEvery >= lagEvery - lagFor;
  }

  /**
   * About a second of play: a fight (one who fights), standing behind (the schedule), or walking
   * after the guide when they are further than FOLLOW_NEAR. `toward`: where to walk instead of
   * the guide (a body to loot), if anything.
   */
  async tick(toward?: Vec3): Promise<void> {
    const before = this.sim.time;
    const enemy = this.style.fights ? await this.#nearestEnemy() : undefined;
    if (enemy !== undefined) {
      await this.sim.swingAt(enemy, SWING_REACH);
    } else if (toward) {
      await this.sim.walkPath(toward, FOLLOW_LEG * 2, 90);
    } else if (this.lagging) {
      await this.sim.step(1);
    } else {
      const guide = this.guide();
      const [at, me] = await Promise.all([this.sim.position(guide), this.sim.position(PLAYER_REF)]);
      const [where, mine] = await Promise.all([
        this.sim.runtime.placement(guide),
        this.sim.runtime.placement(PLAYER_REF),
      ]);
      const sameSpace =
        where !== undefined &&
        mine !== undefined &&
        (where.world !== undefined ? where.world === mine.world : where.cell === mine.cell);
      const away = at && me ? Math.hypot(at[0] - me[0], at[1] - me[1], at[2] - me[2]) : Infinity;
      // A guide who has stood still a while is waiting for them (a scene's "wait for the player
      // to get close"): they walk right up to them, as a player goes to one who calls them.
      const still =
        this.#guideAt !== undefined &&
        at !== undefined &&
        Math.hypot(at[0] - this.#guideAt[0], at[1] - this.#guideAt[1]) < 8;
      this.#stillFor = still ? this.#stillFor + 1 : 0;
      this.#guideAt = at;
      const waited = this.#stillFor >= 3;
      // Beside a guide who stands and nothing goes on, they go on the way the quest's marker
      // shows, as a player does (a guide who follows them: Ralof's "let's sneak past the bear"
      // has him follow the player); back to the guide if they stay behind.
      this.#besideFor = still && away <= WAITED_NEAR + 40 ? this.#besideFor + 1 : 0;
      if (this.#besideFor >= LEAD_AFTER) this.#leading = true;
      if (this.#leading && (!sameSpace || (still && away > LEAD_AHEAD))) this.#leading = false;
      const marker = this.#leading && mine ? await this.#marker(mine, guide) : undefined;
      if (marker) {
        await this.sim.walkPath(marker, FOLLOW_LEG, 60);
      } else if (at && sameSpace && away > (waited ? WAITED_NEAR : FOLLOW_NEAR)) {
        await this.sim.walkPath(at, FOLLOW_LEG, waited ? WAITED_REACH : FOLLOW_REACH);
      } else if (!sameSpace && this.door) {
        // Gone through a load door: after them, to it (the compass's quest door).
        await this.sim.walkPath(this.door, FOLLOW_LEG, 40);
      } else {
        await this.sim.step(1);
      }
    }
    // Under a second (a walk that found no way): the rest of it stood.
    const took = this.sim.time - before;
    if (took < 0.5) await this.sim.step(1 - took);
    this.#played += Math.max(1, this.sim.time - before);
    await this.#watch();
  }

  /** The nearest target of the shown objectives in the player's space (the guide's aside). */
  async #marker(mine: Placement, guide: number): Promise<Vec3 | undefined> {
    const me = mine.position;
    let best: Vec3 | undefined;
    let nearest = Infinity;
    for (const target of await questTargets(this.sim.runtime)) {
      if (target.reference === guide) continue;
      const placement = target.placement;
      const elsewhere =
        placement.world !== undefined
          ? placement.world !== mine.world
          : placement.cell !== mine.cell;
      // In another space: the load door the way there goes through (the compass's quest door).
      const there = elsewhere
        ? firstDoorToward(await this.sim.world.session.routeMap(), mine, placement)?.position
        : placement.position;
      if (!there) continue;
      const away = Math.hypot(there[0] - me[0], there[1] - me[1], there[2] - me[2]);
      if (away < 80 || away >= nearest) continue;
      nearest = away;
      best = [there[0], there[1], there[2]];
    }
    return best;
  }

  /** Notes a stall: the game's progress line unchanged for 60 s. */
  async #watch(): Promise<void> {
    const now = this.progress();
    if (now !== this.#last) {
      this.#leading = false;
      this.#besideFor = 0;
      this.#last = now;
      this.#since = this.sim.time;
      this.#reported = false;
      return;
    }
    if (this.#reported || this.sim.time - this.#since < 60) return;
    this.#reported = true;
    const guide = this.guide();
    const [at, me] = await Promise.all([this.sim.position(guide), this.sim.position(PLAYER_REF)]);
    const running = this.sim.package(guide);
    const fmt = (p: Vec3 | undefined): string =>
      p ? p.map((v) => Math.round(v)).join(',') : 'none';
    const combat = this.sim.world.stage.combat;
    const fighter = (actor: number): string => {
      const state = combat.state(actor);
      return state?.inCombat
        ? `fights ${state.combatTarget?.toString(16) ?? '-'} (state ${String(state.combatState)})`
        : 'not fighting';
    };
    const enemies: string[] = [];
    for (const enemy of await this.enemies()) {
      enemies.push(
        `${enemy.toString(16)} at ${fmt(await this.sim.position(enemy))} ${fighter(enemy)}`,
      );
    }
    this.stalls.push({
      at: Math.round(this.sim.time),
      what: `${now} guide ${guide.toString(16)} at ${fmt(at)} package ${
        running ? running.id.toString(16) : 'none'
      } ${fighter(guide)}; player at ${fmt(me)}; enemies ${enemies.join('; ')}`,
    });
  }
}
