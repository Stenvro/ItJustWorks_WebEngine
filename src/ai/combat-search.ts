// Searching for a lost target in combat (docs/ai.md, "Combat AI"; CommonLibSSE
// CombatSearchLocation; the combat tree's Search subtree, observed in the original: Wait to
// Start Search, then Search Location, Search Wander, Search Center and the Investigate
// selector's Investigating and Looking): an actor whose target it no longer detects (and its
// group does not see) stands fCombatSearchStartWaitTime, runs to where it was last known, within
// fCombatSearchLocationInvestigateDistance, looks round (fCombatSearchInvestigateTime a look,
// three looks), then wanders round that place, walking (each time a point within the search
// radius of it, fCombatSearchInterior / ExteriorRadiusMin .. Max, at most
// fCombatSearchWanderDistance from where it stands), looking round at each for
// fCombatSearchLookTime; it gives up once it has searched fDetectionStateExpireTime in all: its
// combat ends (detection's lost state: the LostToNormal line). Finding the target again
// (detected) ends the search at once; news of it (a noise, its group seeing it) moves the search
// there. TODO(M13): the search's priority points (Search, Search Unimportant Location) and
// Investigating Door (fCombatSearchDoor*) are not read. Platform-independent.

import { bearing } from './reactions.ts';

type Vec3 = readonly [number, number, number];

/** What a search moves. */
export interface SearchBody {
  position(): Vec3 | undefined;
  /** Goes to a place over the navmeshes, running or walking; resolves whether it got there. */
  travel(to: Vec3, arrive: number, run: boolean): Promise<boolean>;
  /** Turns to a heading, standing. */
  face(heading: number): void;
  stop(): void;
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

export class CombatSearch {
  readonly #body: SearchBody;
  readonly #settings: SearchSettings;
  readonly #random: () => number;
  #at: Vec3;
  #phase: 'wait' | 'go' | 'look' | 'wander' | 'done';
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

  constructor(at: Vec3, body: SearchBody, settings: SearchSettings, random: () => number) {
    this.#at = at;
    this.#body = body;
    this.#settings = settings;
    this.#random = random;
    this.#left = settings.searchStartWaitTime ?? 0;
    this.#phase = this.#left > 0 ? 'wait' : 'go';
  }

  /** Where it searches round. */
  get at(): Vec3 {
    return this.#at;
  }

  /** Seconds it has searched. */
  get elapsed(): number {
    return this.#elapsed;
  }

  /** News of the target: it searches there now (its time goes on). */
  moveTo(at: Vec3): void {
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
    switch (this.#phase) {
      case 'wait':
        this.#left -= seconds;
        if (this.#left <= 0) this.#phase = 'go';
        return 'searching';
      case 'go':
      case 'wander':
        return this.#go(here);
      case 'look':
        this.#left -= seconds;
        if (this.#left > 0) return 'searching';
        if (this.#looks >= LOOKS) {
          this.#wander(here);
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
    this.#phase = 'done';
  }

  #go(here: Vec3): SearchState {
    if (!this.#walking) {
      const to = this.#phase === 'go' ? this.#at : this.#target;
      this.#walked = false;
      this.#walking = this.#body.travel(to, this.#settings.searchInvestigateDistance, this.#first);
      void this.#walking.then(() => {
        this.#walked = true;
      });
      return 'searching';
    }
    if (!this.#walked) return 'searching';
    this.#walking = undefined;
    this.#first = false;
    this.#atPlace = this.#phase === 'go';
    this.#phase = 'look';
    this.#looks = 0;
    this.#look(here);
    return 'searching';
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
    this.#phase = 'done';
    return 'gave-up';
  }
}
