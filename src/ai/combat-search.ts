// Searching for a lost target in combat (docs/ai.md, "Combat AI"; CommonLibSSE
// CombatSearchLocation): an actor whose target it no longer detects (and its group does not see)
// runs to where it was last known, within fCombatSearchLocationInvestigateDistance, looks round
// (fCombatSearchInvestigateTime a look, three looks), then searches round that place (each time
// a point within SEARCH_RADIUS of it, walking), looking round at each; it gives up once it has
// searched fDetectionStateExpireTime in all: its combat ends (detection's lost state: the
// LostToNormal line). Finding the target again (detected) ends the search at once; news of it
// (a noise, its group seeing it) moves the search there. TODO(M13): the engine's search areas
// (fCombatSearch*Radius, its search of doors and hiding places) are not documented.
// Platform-independent.

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
  #phase: 'go' | 'look' | 'wander' | 'done' = 'go';
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
    this.#phase = 'look';
    this.#looks = 0;
    this.#look(here);
    return 'searching';
  }

  /** Off to another point round the place. */
  #wander(here: Vec3): void {
    const angle = this.#random() * Math.PI * 2;
    const distance = SEARCH_RADIUS * Math.sqrt(this.#random());
    this.#target = [
      this.#at[0] + Math.sin(angle) * distance,
      this.#at[1] + Math.cos(angle) * distance,
      here[2],
    ];
    this.#phase = 'wander';
    this.#walking = undefined;
  }

  #look(here: Vec3): void {
    this.#looks++;
    this.#left = this.#settings.searchInvestigateTime;
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
