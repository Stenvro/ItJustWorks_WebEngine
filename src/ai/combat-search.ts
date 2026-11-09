// Searching for a lost target in combat (docs/ai.md, "Combat AI"; CommonLibSSE
// CombatSearchLocation; the combat tree's Search subtree, observed in the original: Wait to
// Start Search, then Search Location, Search Wander, Search Center and the Investigate
// selector's Investigating and Looking): an actor whose target it no longer detects (and its
// group does not see) stands fCombatSearchStartWaitTime, runs to where it was last known, within
// fCombatSearchLocationInvestigateDistance, looks round (fCombatSearchInvestigateTime a look,
// three looks), then walks to its group's priority points round that place (Search, then the
// Investigate Selector's Investigating Door and Looking: SearchArea below), then wanders round
// it, walking (each time a point within the search radius of it, fCombatSearchInterior /
// ExteriorRadiusMin .. Max, at most fCombatSearchWanderDistance from where it stands), looking
// round at each for fCombatSearchLookTime; it gives up once it has searched
// fDetectionStateExpireTime in all: its combat ends (detection's lost state: the LostToNormal
// line). Finding the target again (detected) ends the search at once; news of it (a noise, its
// group seeing it) moves the search there. Platform-independent.

import { bearing } from './reactions.ts';

type Vec3 = readonly [number, number, number];

/** A place a lost target may be: where it could hide, or a door it may have gone through. */
export interface SearchPoint {
  readonly at: Vec3;
  /** The door (Investigating Door: looked at from fCombatSearchDoorDistance). */
  readonly door?: number | undefined;
}

export interface SearchAreaSettings {
  /** fCombatSearchIgnoreLocationRadius: a point a searcher passed this near counts as searched. */
  readonly ignoreLocationRadius: number;
  /** fCombatSearchSightRadius: a point a searcher sees within this counts as searched. */
  readonly sightRadius: number;
  /** iCombatSearchDoorFailureMax: doors are given up after this many it could not reach. */
  readonly doorFailureMax: number;
}

const flatDistance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * A group's search area (CommonLibSSE CombatSearchLocation; the Search behaviour): the priority
 * points its searchers share round the place it last knew its target, nearest that place first,
 * the places a target could hide and the doors it may have gone through alike. A searcher takes
 * the first point no other searcher holds; a point counts as searched once a searcher looked
 * there, passed within fCombatSearchIgnoreLocationRadius of it, or sees it from within
 * fCombatSearchSightRadius; doors are left once iCombatSearchDoorFailureMax of them could not be
 * reached. Inferred from the behaviours' and settings' names, TODO(M13): the original's choice
 * of the points and their order.
 */
export class SearchArea {
  readonly center: Vec3;
  readonly #settings: SearchAreaSettings;
  readonly #points: { readonly point: SearchPoint; by: number | undefined; done: boolean }[];
  #doorFailures = 0;

  constructor(center: Vec3, points: readonly SearchPoint[], settings: SearchAreaSettings) {
    this.center = center;
    this.#settings = settings;
    this.#points = [...points]
      .sort((a, b) => flatDistance(a.at, center) - flatDistance(b.at, center))
      .map((point) => ({ point, by: undefined, done: false }));
  }

  /**
   * The next point for a searcher standing at `from` (undefined: none left). Points it sees from
   * there (`sees`) within the sight radius count as searched on the way.
   */
  take(member: number, from: Vec3, sees?: (at: Vec3) => boolean): SearchPoint | undefined {
    this.release(member);
    this.pass(from);
    for (const entry of this.#points) {
      if (entry.done || entry.by !== undefined) continue;
      if (entry.point.door !== undefined && this.#doorFailures >= this.#settings.doorFailureMax)
        continue;
      // A hiding place it sees from where it stands it has searched by looking (not a door: what
      // lies past one cannot be seen).
      if (
        entry.point.door === undefined &&
        sees &&
        flatDistance(entry.point.at, from) <= this.#settings.sightRadius &&
        sees(entry.point.at)
      ) {
        entry.done = true;
        continue;
      }
      entry.by = member;
      return entry.point;
    }
    return undefined;
  }

  /**
   * A searcher stands here: hiding places within the ignore radius count as searched (a door
   * is searched only by looking at it).
   */
  pass(at: Vec3): void {
    for (const entry of this.#points) {
      if (entry.done || entry.point.door !== undefined) continue;
      if (flatDistance(entry.point.at, at) <= this.#settings.ignoreLocationRadius)
        entry.done = true;
    }
  }

  /** A searcher looked at its point. */
  searched(point: SearchPoint): void {
    const entry = this.#points.find((candidate) => candidate.point === point);
    if (entry) {
      entry.done = true;
      entry.by = undefined;
    }
  }

  /** A searcher could not reach its point (a door counts towards giving doors up). */
  failed(point: SearchPoint): void {
    const entry = this.#points.find((candidate) => candidate.point === point);
    if (!entry) return;
    entry.done = true;
    entry.by = undefined;
    if (point.door !== undefined) this.#doorFailures++;
  }

  /** A searcher stopped: the point it held is free again. */
  release(member: number): void {
    for (const entry of this.#points) if (entry.by === member) entry.by = undefined;
  }

  /** How many points are left (not searched). */
  get left(): number {
    return this.#points.filter((entry) => !entry.done).length;
  }
}

/** What a search moves. */
export interface SearchBody {
  position(): Vec3 | undefined;
  /** Goes to a place over the navmeshes, running or walking; resolves whether it got there. */
  travel(to: Vec3, arrive: number, run: boolean): Promise<boolean>;
  /** Turns to a heading, standing. */
  face(heading: number): void;
  stop(): void;
  /** Whether nothing blocks its eyes from a place (a hiding place it sees it need not go to). */
  sees?(at: Vec3): boolean;
}

/** A search's share of its group's search area. */
export interface SearchShare {
  /** The group's priority points (shared by its searchers). */
  readonly area: SearchArea;
  /** The searcher (who holds a point). */
  readonly member: number;
  /** fCombatSearchDoorDistance: it looks at a door from this near. */
  readonly doorDistance: number;
}

export interface SearchSettings {
  /** fCombatSearchLocationInvestigateDistance. */
  readonly searchInvestigateDistance: number;
  /** fCombatSearchInvestigateTime: one look round. */
  readonly searchInvestigateTime: number;
  /** fDetectionStateExpireTime: how long it searches in all. */
  readonly stateExpireTime: number;
  /** fCombatSearchStartWaitTime: it stands this long first (Wait to Start Search). */
  readonly searchStartWaitTime?: number;
  /** The search radius round the place (searchRadius in combat-subtrees.ts). */
  readonly searchRadius?: number;
  /** fCombatSearchWanderDistance: a wander step goes at most this far. */
  readonly searchWanderDistance?: number;
  /** fCombatSearchLookTime: one look at a wander point (Looking). */
  readonly searchLookTime?: number;
}

/** It looks round this many times at each place. */
const LOOKS = 3;
/** ... up to this far either side of the way it came (radians). */
const LOOK_SPREAD = Math.PI / 2;
/** It searches round the last known place within this (units). TODO(M13). */
export const SEARCH_RADIUS = 768;

export type SearchState = 'searching' | 'gave-up';

/**
 * A search's step (Wait to Start Search, the run or walk, a look round, a walk to a priority
 * point, a wander, over).
 */
export type SearchPhase = 'wait' | 'go' | 'look' | 'point' | 'wander' | 'done';

/**
 * A search as a save keeps it: its place, its step and how far into it, the seconds searched.
 * A walk under way is walked again from where the searcher stands.
 */
export interface SavedCombatSearch {
  readonly at: Vec3;
  readonly phase: SearchPhase;
  /** Seconds left of its wait or its look. */
  readonly left: number;
  readonly looks: number;
  readonly elapsed: number;
  /** Its run to the place not made yet (it runs; then it walks). */
  readonly first: boolean;
  /** It looks round at the place itself (else at a wander point). */
  readonly atPlace: boolean;
  /** The wander point it walks to. */
  readonly target: Vec3;
  /** Its search radius (drawn as it began). */
  readonly radius?: number | undefined;
}

export class CombatSearch {
  readonly #body: SearchBody;
  readonly #settings: SearchSettings;
  readonly #random: () => number;
  #at: Vec3;
  #phase: SearchPhase;
  /** It looks round at the place itself (Investigating), else at a wander point (Looking). */
  #atPlace = true;
  #walking: Promise<boolean> | undefined;
  #walked = false;
  #looks = 0;
  #left = 0;
  #elapsed = 0;
  /** Its first run is to the last known place; then it walks. */
  #first = true;
  /** The point round the place it walks to now. */
  #target: Vec3 = [0, 0, 0];
  /** Its walk got there. */
  #reached = false;
  /** Its group's search area, and the priority point it holds of it. */
  #share: SearchShare | undefined;
  #point: SearchPoint | undefined;

  constructor(
    at: Vec3,
    body: SearchBody,
    settings: SearchSettings,
    random: () => number,
    share?: SearchShare,
  ) {
    this.#at = at;
    this.#body = body;
    this.#settings = settings;
    this.#random = random;
    this.#share = share;
    this.#left = settings.searchStartWaitTime ?? 0;
    this.#phase = this.#left > 0 ? 'wait' : 'go';
  }

  /** A search a save kept, going on from its step (a walk under way starts again). */
  static restore(
    saved: SavedCombatSearch,
    body: SearchBody,
    settings: SearchSettings,
    random: () => number,
    share?: SearchShare,
  ): CombatSearch {
    const radius = saved.radius ?? settings.searchRadius;
    const kept = { ...settings, ...(radius !== undefined && { searchRadius: radius }) };
    const search = new CombatSearch(saved.at, body, kept, random, share);
    search.#phase = saved.phase;
    search.#left = saved.left;
    search.#looks = saved.looks;
    search.#elapsed = saved.elapsed;
    search.#first = saved.first;
    search.#atPlace = saved.atPlace;
    search.#target = [saved.target[0], saved.target[1], saved.target[2]];
    return search;
  }

  /** What a save keeps of it. */
  save(): SavedCombatSearch {
    return {
      at: [this.#at[0], this.#at[1], this.#at[2]],
      // A walk to a priority point goes on as a walk to that place (the area is made again).
      phase: this.#phase === 'point' ? 'wander' : this.#phase,
      left: this.#left,
      looks: this.#looks,
      elapsed: this.#elapsed,
      first: this.#first,
      atPlace: this.#atPlace,
      target: [this.#target[0], this.#target[1], this.#target[2]],
      radius: this.#settings.searchRadius,
    };
  }

  /** Where it searches round. */
  get at(): Vec3 {
    return this.#at;
  }

  /** Seconds it has searched. */
  get elapsed(): number {
    return this.#elapsed;
  }

  /** The priority point it walks to or looks at now (undefined: none). */
  get point(): SearchPoint | undefined {
    return this.#point;
  }

  /**
   * News of the target: it searches there now (its time goes on), with the search area of that
   * place if one is given.
   */
  moveTo(at: Vec3, share?: SearchShare): void {
    this.#release();
    if (share) this.#share = share;
    this.#at = at;
    this.#phase = 'go';
    this.#walking = undefined;
    this.#first = true;
  }

  /** Every frame (seconds): 'gave-up' once it has searched long enough. */
  update(seconds: number): SearchState {
    if (this.#phase === 'done') return 'gave-up';
    this.#elapsed += seconds;
    const here = this.#body.position();
    if (!here || this.#elapsed >= this.#settings.stateExpireTime) return this.#giveUp();
    // Where it goes, it searches: points it passes need no one else.
    if (this.#phase !== 'wait') this.#share?.area.pass(here);
    switch (this.#phase) {
      case 'wait':
        this.#left -= seconds;
        if (this.#left <= 0) this.#phase = 'go';
        return 'searching';
      case 'go':
      case 'point':
      case 'wander':
        return this.#go(here);
      case 'look':
        this.#left -= seconds;
        if (this.#left > 0) return 'searching';
        if (this.#looks >= LOOKS) {
          this.#next(here);
          return 'searching';
        }
        this.#look(here);
        return 'searching';
      default:
        return 'gave-up';
    }
  }

  /** It stops searching (found, or cut short). */
  cancel(): void {
    if (this.#phase !== 'done') this.#body.stop();
    this.#release();
    this.#phase = 'done';
  }

  #go(here: Vec3): SearchState {
    if (!this.#walking) {
      const to = this.#phase === 'go' ? this.#at : this.#target;
      const door = this.#phase === 'point' && this.#point?.door !== undefined;
      const arrive =
        door && this.#share ? this.#share.doorDistance : this.#settings.searchInvestigateDistance;
      this.#walked = false;
      const walking = this.#body.travel(to, arrive, this.#first);
      this.#walking = walking;
      void walking.then((reached) => {
        if (this.#walking !== walking) return;
        this.#reached = reached;
        this.#walked = true;
      });
      return 'searching';
    }
    if (!this.#walked) return 'searching';
    this.#walking = undefined;
    this.#first = false;
    const point = this.#phase === 'point' ? this.#point : undefined;
    if (point) {
      // A point it could not reach is left (a door counts towards giving doors up).
      if (!this.#reached) {
        this.#share?.area.failed(point);
        this.#point = undefined;
        this.#next(here);
        return 'searching';
      }
      this.#share?.area.searched(point);
    }
    this.#atPlace = this.#phase === 'go';
    this.#phase = 'look';
    this.#looks = 0;
    this.#look(here);
    return 'searching';
  }

  /**
   * After a look: the next of its group's priority points it may take (Search), else a wander
   * round the place (Search Wander).
   */
  #next(here: Vec3): void {
    this.#point = undefined;
    const share = this.#share;
    const sees = this.#body.sees?.bind(this.#body);
    const point = share?.area.take(share.member, here, sees);
    if (!point) {
      this.#wander(here);
      return;
    }
    this.#point = point;
    this.#target = [point.at[0], point.at[1], point.at[2]];
    this.#phase = 'point';
    this.#walking = undefined;
  }

  /** The priority point it held is free again. */
  #release(): void {
    if (this.#share) this.#share.area.release(this.#share.member);
    this.#point = undefined;
  }

  /** Off to another point round the place, at most a wander step from where it stands. */
  #wander(here: Vec3): void {
    const radius = this.#settings.searchRadius ?? SEARCH_RADIUS;
    const step = this.#settings.searchWanderDistance ?? Infinity;
    const angle = this.#random() * Math.PI * 2;
    const distance = radius * Math.sqrt(this.#random());
    let x = this.#at[0] + Math.sin(angle) * distance;
    let y = this.#at[1] + Math.cos(angle) * distance;
    const away = Math.hypot(x - here[0], y - here[1]);
    if (away > step) {
      x = here[0] + ((x - here[0]) * step) / away;
      y = here[1] + ((y - here[1]) * step) / away;
    }
    this.#target = [x, y, here[2]];
    this.#phase = 'wander';
    this.#walking = undefined;
  }

  #look(here: Vec3): void {
    this.#looks++;
    // Investigating Door: it looks at the door, fCombatSearchInvestigateTime, once.
    const door = this.#point?.door !== undefined ? this.#point.at : undefined;
    if (door) {
      this.#looks = LOOKS;
      this.#left = this.#settings.searchInvestigateTime;
      this.#body.face(bearing(here, door));
      return;
    }
    // Investigating at the place (its looks), Looking at a wander point (one, shorter).
    const looking = !this.#atPlace && this.#settings.searchLookTime !== undefined;
    if (looking) this.#looks = LOOKS;
    this.#left = looking
      ? (this.#settings.searchLookTime ?? 0)
      : this.#settings.searchInvestigateTime;
    const flat = Math.hypot(here[0] - this.#at[0], here[1] - this.#at[1]);
    const toward = flat > 1 ? bearing(here, this.#at) : this.#random() * Math.PI * 2;
    this.#body.face(toward + (this.#random() * 2 - 1) * LOOK_SPREAD);
  }

  #giveUp(): SearchState {
    if (this.#phase !== 'done') this.#body.stop();
    this.#release();
    this.#phase = 'done';
    return 'gave-up';
  }
}
