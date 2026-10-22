// The engine's own reactions to what an actor notices (docs/ai.md, "Detection"), run where its
// override package lists (NPC_ and alias SPOR, OCOR, GWOR) do not name packages for them, while
// its package waits:
//
// - searching: it heard a noise, or noticed one sneaking, or lost one it detected and is hostile
//   to: it turns to the place (fCombatSearchLookTime), walks to within
//   fCombatSearchLocationInvestigateDistance of it, looks round three times
//   (fCombatSearchInvestigateTime each), and goes back to its package; at most
//   fDetectionStateExpireTime in all;
// - observing the dead: it saw one who died lately (within iHoursToClearCorpses): it walks to the
//   body, looks at it and says its NoticeCorpse line;
// - spectating: a fight it noticed (within fAIInteriorSpectatorDetection / Exterior: combat,
//   5.2): it keeps fAIInteriorSpectatorDistance / Exterior from it, facing it, until the last
//   blow is fAISpectatorRememberThreatTimer old or the fight fAISpectatorShutdownDistance away;
// - warning (a guard, crime: M11): it goes to the one it warns and faces them while the warning
//   lasts.
//
// They say their lines as they go (NormalToAlert, AlertToNormal, NoticeCorpse, Trespass for the
// warning: src/shell/actor-talk.ts). TODO(M13): the engine's own steps and timings beyond these
// settings are not documented. Platform-independent.

type Vec3 = readonly [number, number, number];

export type ReactionKind = 'search' | 'corpse' | 'spectator' | 'warn';

/** What a reaction moves. */
export interface ReactionBody {
  position(): Vec3 | undefined;
  /** Walks to a place over the navmeshes; resolves whether it got within `arrive` of it. */
  travel(to: Vec3, arrive: number): Promise<boolean>;
  /** Turns to a heading, standing (undefined: stops turning). */
  face(heading: number | undefined): void;
  /** Stops going and stands. */
  stop(): void;
  /** Says a line of a topic subtype (NormalToAlert, NoticeCorpse, ...). */
  say(subtype: string): void;
}

/** The game settings the reactions read (DetectionSettings'). */
export interface ReactionSettings {
  readonly searchInvestigateDistance: number;
  readonly searchLookTime: number;
  readonly searchInvestigateTime: number;
  readonly stateExpireTime: number;
  readonly spectatorDistance: number;
  readonly spectatorShutdownDistance: number;
  readonly spectatorRememberTimer: number;
}

/** What the reaction answers, as it is now (the fight moves, the trespasser walks). */
export interface Situation {
  /** Where it is now (undefined: where it was). */
  readonly at?: Vec3 | undefined;
  /** It is over (the fight's last blow is old, the warning was lifted, the one searched for found). */
  readonly over?: boolean;
}

/** A searcher looks round this many times. */
const LOOKS = 3;
/** ... each time up to this far either side of the place (radians). */
const LOOK_SPREAD = Math.PI / 2;
/** One observing the dead goes this near the body (units) ... */
const CORPSE_REACH = 128;
/** ... and looks at it this long (seconds). */
const CORPSE_LOOK = 5;
/** A guard warning goes this near the one it warns (units). */
const WARN_REACH = 192;
/** A spectator stands within this of where it keeps (units). */
const SPECTATOR_SLACK = 64;

/** The heading (radians clockwise from north) from one point to another. */
export function bearing(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Reaction {
  readonly kind: ReactionKind;
  readonly subject: number | undefined;
  #at: Vec3;
  readonly #body: ReactionBody;
  readonly #settings: ReactionSettings;
  readonly #random: () => number;
  #phase: 'turn' | 'go' | 'look' | 'watch' | 'warn' | 'done' = 'turn';
  /** Seconds left in the phase (turn, look), and in all. */
  #left = 0;
  #total: number;
  #looks = 0;
  /** Its walk under way, and whether it ended. */
  #walking: Promise<boolean> | undefined;
  #walked = false;
  #said = false;

  constructor(
    kind: ReactionKind,
    at: Vec3,
    subject: number | undefined,
    body: ReactionBody,
    settings: ReactionSettings,
    random: () => number,
  ) {
    this.kind = kind;
    this.subject = subject;
    this.#at = at;
    this.#body = body;
    this.#settings = settings;
    this.#random = random;
    this.#total = settings.stateExpireTime;
    if (kind === 'search') {
      this.#left = settings.searchLookTime;
      body.say('NormalToAlert');
    } else if (kind === 'spectator') {
      this.#phase = 'watch';
      this.#left = settings.spectatorRememberTimer;
    } else {
      this.#phase = 'go';
    }
  }

  /** Where it reacts to. */
  get at(): Vec3 {
    return this.#at;
  }

  /** Every frame (seconds since the last): false once it has ended (the actor is let go). */
  update(seconds: number, situation: Situation = {}): boolean {
    if (this.#phase === 'done') return false;
    if (situation.at) this.#at = situation.at;
    this.#total -= seconds;
    const here = this.#body.position();
    if (!here || (this.kind !== 'spectator' && (situation.over === true || this.#total <= 0))) {
      return this.#end();
    }
    switch (this.#phase) {
      case 'turn':
        this.#body.face(bearing(here, this.#at));
        this.#left -= seconds;
        if (this.#left > 0) return true;
        if (flat(here, this.#at) > this.#settings.searchInvestigateDistance) {
          this.#phase = 'go';
          return true;
        }
        this.#lookRound(here);
        return true;
      case 'go':
        return this.#go(here);
      case 'look':
        this.#left -= seconds;
        if (this.#left > 0) return true;
        if (this.kind === 'corpse' || this.#looks >= LOOKS) return this.#end();
        this.#look(here);
        return true;
      case 'watch':
        return this.#watch(here, seconds, situation);
      case 'warn':
        this.#body.face(bearing(here, this.#at));
        if (!this.#said) {
          this.#said = true;
          this.#body.say('Trespass');
        }
        return true;
      default:
        return false;
    }
  }

  /** On its way (searching, to the dead, to the one it warns). */
  #go(here: Vec3): boolean {
    const arrive =
      this.kind === 'corpse'
        ? CORPSE_REACH
        : this.kind === 'warn'
          ? WARN_REACH
          : this.#settings.searchInvestigateDistance;
    if (!this.#walking) {
      this.#walked = false;
      this.#walking = this.#body.travel(this.#at, arrive);
      void this.#walking.then(() => {
        this.#walked = true;
      });
      return true;
    }
    // The one warned moves: the way is taken again once it is far from where it was.
    if (this.kind === 'warn' && !this.#walked && flat(here, this.#at) <= arrive) {
      this.#body.stop();
      this.#walked = true;
    }
    if (!this.#walked) return true;
    this.#walking = undefined;
    if (this.kind === 'corpse') {
      this.#phase = 'look';
      this.#left = CORPSE_LOOK;
      this.#body.face(bearing(here, this.#at));
      this.#body.say('NoticeCorpse');
      return true;
    }
    if (this.kind === 'warn') {
      if (flat(here, this.#at) > WARN_REACH * 2) return true;
      this.#phase = 'warn';
      return true;
    }
    this.#lookRound(here);
    return true;
  }

  #lookRound(here: Vec3): void {
    this.#phase = 'look';
    this.#looks = 0;
    this.#look(here);
  }

  /** One look round: towards the place, up to LOOK_SPREAD either side. */
  #look(here: Vec3): void {
    this.#looks++;
    this.#left = this.#settings.searchInvestigateTime;
    const toward =
      flat(here, this.#at) > 1 ? bearing(here, this.#at) : this.#random() * Math.PI * 2;
    this.#body.face(toward + (this.#random() * 2 - 1) * LOOK_SPREAD);
  }

  /** Spectating: kept from the fight, facing it, while it lasts. */
  #watch(here: Vec3, seconds: number, situation: Situation): boolean {
    const distance = flat(here, this.#at);
    // The fight's blows keep it watching; once they stop it watches on a while.
    this.#left =
      situation.over === true ? this.#left - seconds : this.#settings.spectatorRememberTimer;
    if (this.#left <= 0 || distance > this.#settings.spectatorShutdownDistance) return this.#end();
    const keep = this.#settings.spectatorDistance;
    if (this.#walking && !this.#walked) return true;
    this.#walking = undefined;
    if (distance < keep - SPECTATOR_SLACK) {
      // Back from it, to where it keeps.
      const away = distance > 1 ? bearing(this.#at, here) : this.#random() * Math.PI * 2;
      const to: Vec3 = [
        this.#at[0] + Math.sin(away) * keep,
        this.#at[1] + Math.cos(away) * keep,
        here[2],
      ];
      this.#walked = false;
      this.#walking = this.#body.travel(to, SPECTATOR_SLACK / 2);
      void this.#walking.then(() => {
        this.#walked = true;
      });
      return true;
    }
    this.#body.face(bearing(here, this.#at));
    return true;
  }

  /** It ends: the actor stands and its package goes on. */
  #end(): false {
    if (this.#phase !== 'done') {
      if (this.kind === 'search') this.#body.say('AlertToNormal');
      this.#body.stop();
      this.#body.face(undefined);
    }
    this.#phase = 'done';
    return false;
  }

  /** It is cut short (the actor left, died, a script took it): it ends at once. */
  cancel(): void {
    this.#end();
  }
}
