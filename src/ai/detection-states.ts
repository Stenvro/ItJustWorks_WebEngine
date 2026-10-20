// What each actor knows of the others (docs/ai.md, "Detection"): per observer and target a
// detection state, moved by each test of the detection formula (src/ai/detection.ts) and by
// what the observer hears. The stealth eye's four looks (UESP "Skyrim:Sneak": shut, slightly
// open, half open, open) are the four states: unseen (at or below fSneakNoticeMin), noticed
// (above it: it knows something is near), searching (it noticed or detected the target and lost
// it, or heard it: it looks for it for fDetectionStateExpireTime), detected (above 0; in combat
// with the target above iAICombatMinDetection). What changes is told to listeners: combat
// (docs/m10-plan.md 5.2) and crime (M11) build on it, as do the actors' reactions (searching,
// the dead, alarms). Platform-independent.

import { detectsAt, noticesAt, type DetectionSettings } from './detection.ts';

type Vec3 = readonly [number, number, number];

export type DetectionState = 'unseen' | 'noticed' | 'searching' | 'detected';

/** Crimes and acts detection reports when an actor is seen doing them (crime, M11). */
export type WitnessedAct = 'steal' | 'pickpocket' | 'trespass' | 'attack' | 'murder' | 'lockpick';

/** What detection tells its listeners. */
export type DetectionEvent =
  /** An observer detected a target it had not (DETECTED on the HUD for the player). */
  | {
      readonly kind: 'detected';
      readonly observer: number;
      readonly target: number;
      readonly level: number;
    }
  /** An observer noticed a target (unseen before): something is near. */
  | {
      readonly kind: 'noticed';
      readonly observer: number;
      readonly target: number;
      readonly level: number;
    }
  /** An observer lost a target it had detected or noticed: it searches for it, at `at`. */
  | {
      readonly kind: 'searching';
      readonly observer: number;
      readonly target: number;
      readonly at: Vec3 | undefined;
    }
  /** An observer gave up searching (the target is unseen again: AlertToNormal). */
  | { readonly kind: 'lost'; readonly observer: number; readonly target: number }
  /** An observer heard a noise (a detection event) at a place, of an owner if it has one. */
  | {
      readonly kind: 'heard';
      readonly observer: number;
      readonly at: Vec3;
      readonly owner: number | undefined;
      readonly level: number;
    }
  /** An observer that detects an actor saw it do an act (crime: M11). */
  | {
      readonly kind: 'witnessed';
      readonly observer: number;
      readonly actor: number;
      readonly act: WitnessedAct;
      readonly victim: number | undefined;
    }
  /** An actor raised an alarm (SendAssaultAlarm, ...): those near it heard it. */
  | {
      readonly kind: 'alarm';
      readonly actor: number;
      readonly criminal: number | undefined;
      readonly act: WitnessedAct | undefined;
    }
  /** An actor was attacked by another. */
  | { readonly kind: 'attacked'; readonly victim: number; readonly attacker: number }
  /** An observer saw one who died lately (it goes to look: the engine's observe dead body). */
  | { readonly kind: 'corpse'; readonly observer: number; readonly corpse: number };

/** One observer's knowledge of one target. */
interface Knowledge {
  state: DetectionState;
  /** The last detection level (undefined: not tested, or beyond reach). */
  level: number | undefined;
  /** When it last noticed or detected the target, or heard it (seconds). */
  since: number;
  /** Where it last knew the target to be. */
  at: Vec3 | undefined;
}

/** How far the stealth eye opens (0 shut .. 1 open) while the observer searches: half. */
const SEARCHING_EYE = 0.5;
/** Noticed, the eye opens from this to SEARCHING_EYE as the level rises to 0. */
const NOTICED_EYE = 0.1;

export class Detections {
  readonly #settings: () => DetectionSettings;
  /** By observer, then target. */
  readonly #known = new Map<number, Map<number, Knowledge>>();
  readonly #listeners = new Set<(event: DetectionEvent) => void>();
  /** Actors in an act others may witness while it lasts (trespassing), and its victim. */
  readonly #offences = new Map<number, { act: WitnessedAct; victim: number | undefined }>();
  /** Actors alerted by what they heard, and until when (seconds). */
  readonly #alerted = new Map<number, { at: Vec3; until: number }>();
  /** Actors that raised or heard an alarm, until when. */
  readonly #alarmed = new Map<number, number>();
  /** Actors attacked lately: by whom, until when. */
  readonly #attacked = new Map<number, { attacker: number; until: number }>();
  /** In combat with a target (5.2): the observer detects it down to iAICombatMinDetection. */
  inCombat: (observer: number, target: number) => boolean = () => false;

  constructor(settings: () => DetectionSettings) {
    this.#settings = settings;
  }

  /** Listens to what changes; returns the function that stops listening. */
  listen(listener: (event: DetectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: DetectionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #knowledge(observer: number, target: number): Knowledge {
    let targets = this.#known.get(observer);
    if (!targets) {
      targets = new Map();
      this.#known.set(observer, targets);
    }
    let known = targets.get(target);
    if (!known) {
      known = { state: 'unseen', level: undefined, since: -Infinity, at: undefined };
      targets.set(target, known);
    }
    return known;
  }

  /**
   * An observer tested a target (`level` undefined: beyond its reach); `at`: where the target
   * is; `now`: seconds. The state moves (see the file's comment) and the change is told.
   */
  observe(
    observer: number,
    target: number,
    level: number | undefined,
    at: Vec3,
    now: number,
  ): DetectionState {
    const settings = this.#settings();
    const known = this.#knowledge(observer, target);
    const before = known.state;
    known.level = level;
    const combat = this.inCombat(observer, target);
    if (level !== undefined && detectsAt(settings, level, combat)) {
      known.state = 'detected';
      known.since = now;
      known.at = at;
    } else if (level !== undefined && noticesAt(settings, level)) {
      // Noticed: something is near. One it detected and no longer does it searches for.
      known.state = before === 'detected' || before === 'searching' ? 'searching' : 'noticed';
      known.since = now;
      known.at = at;
    } else if (before !== 'unseen' && now - known.since < settings.stateExpireTime) {
      // Lost: it searches where it last knew the target to be, for a while.
      known.state = 'searching';
    } else {
      known.state = 'unseen';
    }
    this.#told(observer, target, before, known);
    return known.state;
  }

  #told(observer: number, target: number, before: DetectionState, known: Knowledge): void {
    const after = known.state;
    if (after === before) return;
    if (after === 'detected') {
      this.#emit({ kind: 'detected', observer, target, level: known.level ?? 0 });
      const offence = this.#offences.get(target);
      if (offence) this.#witness(observer, target, offence.act, offence.victim);
    } else if (after === 'noticed') {
      this.#emit({ kind: 'noticed', observer, target, level: known.level ?? 0 });
    } else if (after === 'searching') {
      this.#emit({ kind: 'searching', observer, target, at: known.at });
    } else {
      this.#emit({ kind: 'lost', observer, target });
    }
  }

  /**
   * An observer heard a detection event (a noise) at a place, of an owner if any, at a level
   * (src/ai/detection.ts, eventLevel). Above fSneakNoticeMin it is alerted there for
   * fDetectionStateExpireTime: it searches for the owner (one it does not detect) there.
   * Returns whether it heard it.
   */
  hear(observer: number, at: Vec3, owner: number | undefined, level: number, now: number): boolean {
    const settings = this.#settings();
    if (!noticesAt(settings, level)) return false;
    this.#alerted.set(observer, { at, until: now + settings.stateExpireTime });
    if (owner !== undefined && owner !== observer) {
      const known = this.#knowledge(observer, owner);
      const before = known.state;
      if (before !== 'detected') {
        known.state = 'searching';
        known.since = now;
        known.at = at;
        known.level = level;
        this.#told(observer, owner, before, known);
      }
    }
    this.#emit({ kind: 'heard', observer, at, owner, level });
    return true;
  }

  /** Searching expires (after fDetectionStateExpireTime), alerts and alarms too. */
  tick(now: number): void {
    const settings = this.#settings();
    for (const [observer, targets] of this.#known) {
      for (const [target, known] of targets) {
        if (known.state !== 'searching' || now - known.since < settings.stateExpireTime) continue;
        known.state = 'unseen';
        this.#told(observer, target, 'searching', known);
      }
    }
    for (const [actor, alert] of this.#alerted) if (alert.until <= now) this.#alerted.delete(actor);
    for (const [actor, until] of this.#alarmed) if (until <= now) this.#alarmed.delete(actor);
    for (const [actor, attack] of this.#attacked) {
      if (attack.until <= now) this.#attacked.delete(actor);
    }
  }

  /** What an observer knows of a target now. */
  state(observer: number, target: number): DetectionState {
    return this.#known.get(observer)?.get(target)?.state ?? 'unseen';
  }

  /** The last detection level of a target for an observer (undefined: none, beyond reach). */
  level(observer: number, target: number): number | undefined {
    return this.#known.get(observer)?.get(target)?.level;
  }

  /** Whether an observer detects a target now. */
  detects(observer: number, target: number): boolean {
    return this.state(observer, target) === 'detected';
  }

  /** Where an observer last knew a target to be (searching: where it looks). */
  lastKnown(observer: number, target: number): Vec3 | undefined {
    return this.#known.get(observer)?.get(target)?.at;
  }

  /** The observers that know of a target, and how (unseen ones left out). */
  *detectors(
    target: number,
  ): Iterable<{ observer: number; state: DetectionState; level: number | undefined }> {
    for (const [observer, targets] of this.#known) {
      const known = targets.get(target);
      if (known && known.state !== 'unseen') {
        yield { observer, state: known.state, level: known.level };
      }
    }
  }

  /** The targets an observer knows of, and how. */
  *known(
    observer: number,
  ): Iterable<{ target: number; state: DetectionState; level: number | undefined }> {
    for (const [target, known] of this.#known.get(observer) ?? []) {
      if (known.state !== 'unseen') yield { target, state: known.state, level: known.level };
    }
  }

  /** Where an alerted actor heard something (undefined: not alerted: GetIsAlerted). */
  alerted(actor: number): Vec3 | undefined {
    return this.#alerted.get(actor)?.at;
  }

  /** An actor stops being alerted (it found what it searched for, or gave up). */
  calm(actor: number): void {
    this.#alerted.delete(actor);
  }

  /**
   * An actor did an act others may see (stealing, attacking, ...): each observer that detects
   * it now witnessed it (told as 'witnessed'). Returns the witnesses.
   */
  witness(actor: number, act: WitnessedAct, victim?: number): number[] {
    const witnesses: number[] = [];
    for (const { observer, state } of this.detectors(actor)) {
      if (state !== 'detected' || observer === actor) continue;
      witnesses.push(observer);
      this.#witness(observer, actor, act, victim);
    }
    return witnesses;
  }

  #witness(observer: number, actor: number, act: WitnessedAct, victim: number | undefined): void {
    this.#emit({ kind: 'witnessed', observer, actor, act, victim });
  }

  /**
   * An act that lasts (trespassing) begins or ends (undefined): those that detect the actor
   * now witness it, and those that come to detect it while it lasts.
   */
  offence(actor: number, act: WitnessedAct | undefined, victim?: number): number[] {
    if (act === undefined) {
      this.#offences.delete(actor);
      return [];
    }
    this.#offences.set(actor, { act, victim });
    return this.witness(actor, act, victim);
  }

  /**
   * An actor raised an alarm (SendAssaultAlarm, SendTrespassAlarm, SendStealAlarm): it and
   * `hearers` (those within iCrimeAlarmRecDistance) are alarmed for fDetectionStateExpireTime.
   * TODO(M11): crime keeps the alarm while guards pursue, and what each does about it.
   */
  alarm(
    actor: number,
    hearers: Iterable<number>,
    now: number,
    criminal?: number,
    act?: WitnessedAct,
  ): void {
    const until = now + this.#settings().stateExpireTime;
    this.#alarmed.set(actor, until);
    for (const hearer of hearers) this.#alarmed.set(hearer, until);
    this.#emit({ kind: 'alarm', actor, criminal, act });
  }

  /** Whether an actor is alarmed (GetAlarmed, IsAlarmed). */
  alarmed(actor: number): boolean {
    return this.#alarmed.has(actor);
  }

  /** The alarm ends for an actor (StopCombatAlarm). */
  stopAlarm(actor: number): void {
    this.#alarmed.delete(actor);
  }

  /**
   * An actor was attacked (combat, 5.1): it searches for the attacker where it is (unless it
   * detects it), and is attacked (GetAttacked) for fDetectionStateExpireTime.
   */
  attack(victim: number, attacker: number, at: Vec3, now: number): void {
    const settings = this.#settings();
    this.#attacked.set(victim, { attacker, until: now + settings.stateExpireTime });
    const known = this.#knowledge(victim, attacker);
    if (known.state !== 'detected') {
      const before = known.state;
      known.state = 'searching';
      known.since = now;
      known.at = at;
      this.#told(victim, attacker, before, known);
    }
    this.#emit({ kind: 'attacked', victim, attacker });
  }

  /** An observer saw a corpse (one that died lately): told, for those who care (crime: M11). */
  corpseSeen(observer: number, corpse: number): void {
    this.#emit({ kind: 'corpse', observer, corpse });
  }

  /** Who attacked an actor lately (GetAttacked), if anyone. */
  attackedBy(actor: number): number | undefined {
    return this.#attacked.get(actor)?.attacker;
  }

  /** An actor is gone (left the loaded area): what it knew and what was known of it go. */
  forget(actor: number): void {
    this.#known.delete(actor);
    for (const targets of this.#known.values()) targets.delete(actor);
    this.#alerted.delete(actor);
    this.#offences.delete(actor);
  }

  /**
   * How far the stealth eye opens for an observer's knowledge of a target: shut unseen, slightly
   * open noticed (opening with the level towards 0), half open searching, open detected (UESP
   * "Skyrim:Sneak"). TODO(M13): the engine's own mapping is not documented.
   */
  eye(observer: number, target: number): number {
    const known = this.#known.get(observer)?.get(target);
    if (!known) return 0;
    switch (known.state) {
      case 'detected':
        return 1;
      case 'searching':
        return SEARCHING_EYE;
      case 'noticed': {
        const min = this.#settings().noticeMin;
        const level = known.level ?? min;
        const share = min < 0 ? Math.min(1, Math.max(0, (level - min) / -min)) : 0;
        return NOTICED_EYE + (SEARCHING_EYE - NOTICED_EYE) * share;
      }
      default:
        return 0;
    }
  }
}
