// Music as the engine plays it (MUSC music types, MUST tracks). Music types are in play: the
// location's (the cell's XCMO, else its regions' RDMO, else the worldspace's ZNAM, else the
// default object DFMS) and those game events add (combat, discoveries, quest moments: Papyrus
// MusicType.Add and Remove; combat, TODO(M10)). The most important one (the lowest
// priority number; the latest of equals) plays:
//
// - A type that ducks the current track (combat, discoveries) plays over it while the other
//   goes on quietly (its Ducking dB lower), coming back up once the ducking music has ended.
// - Otherwise the current music leaves first: a track with cue points plays on to the next
//   one, then crossfades into its finale (combat's ending) or fades out; then the new type
//   starts. An abrupt transition starts it at once while the old fades.
// - A type's tracks play in order (Maintain Track Order) or shuffled, skipping those whose
//   conditions do not hold (day, night, weather); after the list it plays on only if it
//   cycles. Plays One Selection: one track, then the type ends. Doesn't Queue: dropped when
//   something more important plays.
// - Single tracks play their file (looping between LNAM's points); silent tracks are silence;
//   palettes play their layers at once, each layer's tracks one after another at random,
//   until the palette's duration ends and they fade out.
//
// Platform-independent: it plays through a MusicOutput (the sound system). Notes:
// docs/audio.md ("Music").

import { dbToGain } from './attenuation.ts';
import { soundConditionsHold, type SoundConditionContext } from './sound-conditions.ts';
import { MusicTypeFlag, type MusicTrack, type MusicType } from '../world/sound-records.ts';

/** A music file playing. */
export interface MusicVoice {
  /** Seconds into the file. */
  readonly position: number;
  readonly ended: boolean;
  /** Fades out over `seconds`, then stops. */
  stop(seconds: number): void;
}

/** The output of one music type: its level follows ducking. */
export interface MusicBus {
  fade(level: number, seconds: number): void;
  dispose(): void;
}

/** Where music plays (the sound system). */
export interface MusicOutput {
  musicType(formId: number): Promise<MusicType | undefined>;
  musicTrack(formId: number): Promise<MusicTrack | undefined>;
  /**
   * Whether a file can play now (true), cannot play at all (false) or is still being decoded
   * (undefined: this starts it). Asked every frame for the files about to play.
   */
  prepare(file: string): boolean | undefined;
  /** Plays a prepared file now; undefined if it is not prepared. */
  play(
    file: string,
    bus: MusicBus,
    fadeIn: number,
    loop: MusicTrack['loop'],
  ): MusicVoice | undefined;
  bus(): MusicBus;
}

/** [Audio] settings of music. */
export interface MusicSettings {
  /** fMusicDuckingSeconds, fMusicUnDuckingSeconds. */
  readonly duckingSeconds: number;
  readonly unDuckingSeconds: number;
  /** fMusicFinaleCrossFadeTimeIn, fMusicFinaleCrossFadeTimeOut. */
  readonly finaleFadeIn: number;
  readonly finaleFadeOut: number;
}

/** What is playing (development tools show it). */
export interface MusicState {
  readonly location: number | undefined;
  readonly added: readonly number[];
  readonly current: number | undefined;
  readonly track: number | undefined;
  readonly ducked: readonly number[];
  readonly leaving: readonly number[];
}

/** Stops without a fade still ramp down this long (no click). */
const CLICK_FREE = 0.05;
/** When no track's conditions hold, a type looks again this much later. */
const RETRY_SECONDS = 1;

/** The first value above zero. */
function positive(...values: (number | undefined)[]): number | undefined {
  return values.find((value) => value !== undefined && value > 0);
}

/** The time base the music runs on (seconds) and what it needs to decide. */
interface Clock {
  readonly now: number;
  readonly context: SoundConditionContext;
}

export class Music {
  readonly #output: MusicOutput;
  readonly #settings: MusicSettings;
  readonly #random: () => number;
  readonly #types = new Map<number, MusicType | undefined>();
  readonly #tracks = new Map<number, MusicTrack | undefined>();
  #location: number | undefined;
  /** Types added by events, oldest first. */
  #added: number[] = [];
  #current: TypeRun | undefined;
  #ducked: TypeRun[] = [];
  #leaving: TypeRun[] = [];
  /** Ducked types coming back up once the music that ducked them has fallen silent. */
  #unducking: { readonly run: TypeRun; readonly after: TypeRun; readonly seconds: number }[] = [];

  constructor(output: MusicOutput, settings: MusicSettings, random: () => number = Math.random) {
    this.#output = output;
    this.#settings = settings;
    this.#random = random;
  }

  /** The location's music type (undefined: none). */
  setLocation(formId: number | undefined): void {
    if (formId !== undefined) this.#type(formId);
    this.#location = formId;
  }

  /** Adds a music type to those in play (MusicType.Add). */
  add(formId: number): void {
    this.#added = this.#added.filter((id) => id !== formId);
    this.#added.push(formId);
    this.#type(formId);
  }

  /** Removes a music type (MusicType.Remove). */
  remove(formId: number): void {
    this.#added = this.#added.filter((id) => id !== formId);
  }

  get state(): MusicState {
    return {
      location: this.#location,
      added: [...this.#added],
      current: this.#current?.type.formId,
      track: this.#current?.track?.track.formId,
      ducked: this.#ducked.map((run) => run.type.formId),
      leaving: this.#leaving.map((run) => run.type.formId),
    };
  }

  /** Every frame: `now` in seconds on the clock the voices play by. */
  update(now: number, context: SoundConditionContext): void {
    const clock: Clock = { now, context };
    this.#transition(clock);
    for (const run of this.#leaving) run.update(clock, true);
    this.#leaving = this.#leaving.filter((run) => {
      if (!run.done) return true;
      run.bus.dispose();
      return false;
    });
    // Ducking lasts as long as the ducking music sounds (combat through its finale).
    this.#unducking = this.#unducking.filter(({ run, after, seconds }) => {
      if (!after.done) return true;
      if (run === this.#current) run.bus.fade(1, seconds);
      return false;
    });
    for (const run of this.#ducked) run.update(clock, true);
    const current = this.#current;
    if (current) {
      const blocked = !current.abrupt && this.#leaving.length > 0;
      current.update(clock, !blocked);
      // Plays One Selection: the type ends with its track.
      if (current.finished && (current.type.flags & MusicTypeFlag.playsOneSelection) !== 0) {
        this.remove(current.type.formId);
      }
    }
  }

  /** Stops all music at once (leaving the game). */
  stop(): void {
    for (const run of [this.#current, ...this.#ducked, ...this.#leaving]) {
      run?.stopNow();
      run?.bus.dispose();
    }
    this.#current = undefined;
    this.#ducked = [];
    this.#leaving = [];
    this.#unducking = [];
    this.#added = [];
    this.#location = undefined;
  }

  /** The type that should play: the most important in play (types still loading wait). */
  #desired(): MusicType | undefined {
    let best: MusicType | undefined;
    const candidates = [this.#location, ...this.#added];
    for (const formId of candidates) {
      if (formId === undefined) continue;
      const type = this.#type(formId);
      // Equal priorities: the later added wins (candidates are oldest first).
      if (type && (!best || type.priority <= best.priority)) best = type;
    }
    return best;
  }

  #transition(clock: Clock): void {
    const desired = this.#desired();
    const current = this.#current;
    // Ducked types no longer in play leave.
    const inPlay = new Set([this.#location, ...this.#added]);
    for (const run of this.#ducked.filter((run) => !inPlay.has(run.type.formId))) {
      this.#ducked = this.#ducked.filter((other) => other !== run);
      run.leave(clock, this.#fadeOut(run.type, undefined), false);
      this.#leaving.push(run);
    }
    // Doesn't Queue: an added type that cannot play now is dropped rather than waiting.
    const running = new Set([current, ...this.#ducked].map((run) => run?.type.formId));
    for (const formId of this.#added) {
      const type = this.#types.get(formId);
      if (
        type &&
        formId !== desired?.formId &&
        !running.has(formId) &&
        (type.flags & MusicTypeFlag.doesNotQueue) !== 0
      ) {
        this.remove(formId);
      }
    }
    if (desired?.formId === current?.type.formId) return;
    const returning = desired && this.#ducked.find((run) => run.type.formId === desired.formId);
    if (returning) {
      // The ducking type ended: the ducked one comes back up.
      this.#ducked = this.#ducked.filter((run) => run !== returning);
      if (current) {
        current.leave(clock, this.#fadeOut(current.type, desired), true);
        this.#leaving.push(current);
      }
      const seconds = this.#unDuckSeconds(current?.type);
      if (current) this.#unducking.push({ run: returning, after: current, seconds });
      else returning.bus.fade(1, seconds);
      this.#current = returning;
      return;
    }
    if (!desired) {
      if (current) {
        current.leave(clock, this.#fadeOut(current.type, undefined), true);
        this.#leaving.push(current);
      }
      this.#current = undefined;
      return;
    }
    const ducks =
      current !== undefined &&
      inPlay.has(current.type.formId) &&
      (desired.flags & MusicTypeFlag.ducksCurrentTrack) !== 0 &&
      desired.priority < current.type.priority;
    if (current && ducks) {
      current.bus.fade(dbToGain(-desired.ducking), this.#duckSeconds(desired));
      this.#ducked.push(current);
    } else if (current) {
      const abrupt = (desired.flags & MusicTypeFlag.abruptTransition) !== 0;
      current.leave(clock, this.#fadeOut(current.type, desired), !abrupt);
      this.#leaving.push(current);
    }
    this.#current = new TypeRun(desired, this.#output.bus(), this.#runContext());
  }

  /**
   * How long music fades out for another type: the arriving type's Fade Duration (the Creation
   * Kit: how long another type fades out or in for it), else the leaving one's; none: at once.
   * TODO(M13): compare with the game.
   */
  #fadeOut(leaving: MusicType, arriving: MusicType | undefined): number {
    return positive(arriving?.fadeDuration, leaving.fadeDuration) ?? CLICK_FREE;
  }

  /**
   * Ducking takes the ducking type's Fade Duration, else [Audio] fMusicDuckingSeconds (and
   * fMusicUnDuckingSeconds coming back up). TODO(M13): compare with the game.
   */
  #duckSeconds(ducking: MusicType): number {
    return positive(ducking.fadeDuration) ?? this.#settings.duckingSeconds;
  }

  #unDuckSeconds(ducking: MusicType | undefined): number {
    return positive(ducking?.fadeDuration) ?? this.#settings.unDuckingSeconds;
  }

  #runContext(): RunContext {
    return {
      output: this.#output,
      settings: this.#settings,
      random: this.#random,
      track: (formId) => this.#track(formId),
      file: (path) => this.#output.prepare(path),
    };
  }

  #type(formId: number): MusicType | undefined {
    if (!this.#types.has(formId)) {
      this.#types.set(formId, undefined);
      void this.#output.musicType(formId).then((type) => {
        this.#types.set(formId, type);
        // Load its tracks (and a palette's) ahead: conditions are checked synchronously.
        for (const track of type?.tracks ?? []) this.#track(track);
      });
    }
    return this.#types.get(formId);
  }

  #track(formId: number): MusicTrack | undefined {
    if (!this.#tracks.has(formId)) {
      this.#tracks.set(formId, undefined);
      void this.#output.musicTrack(formId).then((track) => {
        this.#tracks.set(formId, track);
        for (const layer of track?.layers ?? []) for (const piece of layer) this.#track(piece);
      });
    }
    return this.#tracks.get(formId);
  }
}

/** What a type's run needs from the music system. */
interface RunContext {
  readonly output: MusicOutput;
  readonly settings: MusicSettings;
  readonly random: () => number;
  track(formId: number): MusicTrack | undefined;
  file(path: string): boolean | undefined;
}

/** A music type playing: its tracks one after another. */
class TypeRun {
  readonly type: MusicType;
  readonly bus: MusicBus;
  readonly #run: RunContext;
  track: TrackRun | undefined;
  /** Its list is played (and it does not cycle), or its one selection is. */
  finished = false;
  #queue: number[] = [];
  #passes = 0;
  #leaving = false;
  /** No track's conditions held: try again at this time. */
  #retryAt = -Infinity;

  constructor(type: MusicType, bus: MusicBus, run: RunContext) {
    this.type = type;
    this.bus = bus;
    this.#run = run;
  }

  get abrupt(): boolean {
    return (this.type.flags & MusicTypeFlag.abruptTransition) !== 0;
  }

  /** Left and fallen silent. */
  get done(): boolean {
    return this.#leaving && (this.track === undefined || this.track.done);
  }

  update(clock: Clock, mayStart: boolean): void {
    this.track?.update(clock);
    if (this.track?.done) {
      this.track = undefined;
      if ((this.type.flags & MusicTypeFlag.playsOneSelection) !== 0) this.finished = true;
    }
    if (this.track || this.finished || this.#leaving || !mayStart) return;
    if (clock.now < this.#retryAt) return;
    const next = this.#next(clock.context);
    if (next) this.track = new TrackRun(next, this.bus, this.#run, clock);
    else this.#retryAt = clock.now + RETRY_SECONDS;
  }

  /**
   * Leaves: the track plays on to its next cue point (`atCue`) and crossfades into its finale
   * or fades out over `seconds`; without cue points it fades out now.
   */
  leave(clock: Clock, seconds: number, atCue: boolean): void {
    this.#leaving = true;
    this.track?.leave(clock, seconds, atCue);
  }

  stopNow(): void {
    this.#leaving = true;
    this.track?.stopNow();
  }

  /** The next track whose conditions hold, from this pass or a new one. */
  #next(context: SoundConditionContext): MusicTrack | undefined {
    for (let refill = 0; refill < 2; refill++) {
      while (this.#queue.length > 0) {
        const formId = this.#queue.shift() ?? 0;
        const track = this.#run.track(formId);
        if (track && soundConditionsHold(track.conditions, context)) return track;
      }
      const cycles = (this.type.flags & MusicTypeFlag.cycleTracks) !== 0;
      if (this.#passes > 0 && !cycles) {
        this.finished = true;
        return undefined;
      }
      // A new pass, once every track has loaded.
      if (this.type.tracks.some((formId) => this.#run.track(formId) === undefined))
        return undefined;
      this.#queue = [...this.type.tracks];
      if ((this.type.flags & MusicTypeFlag.maintainTrackOrder) === 0)
        shuffle(this.#queue, this.#run.random);
      this.#passes++;
    }
    return undefined;
  }
}

/** A piece of music in a sequence: a file playing, or silence until a time. */
interface Piece {
  readonly track: MusicTrack;
  voice: MusicVoice | undefined;
  until: number;
}

/** One track playing: a single file, silence, or a palette's layers. */
class TrackRun {
  readonly track: MusicTrack;
  readonly #bus: MusicBus;
  readonly #run: RunContext;
  #started = false;
  /** Silent tracks and palettes end at this time. */
  #until = 0;
  #voice: MusicVoice | undefined;
  #finale: MusicVoice | undefined;
  /** Each palette layer's piece and the one after it. */
  #layers: { pieces: readonly number[]; piece: Piece | undefined; next: MusicTrack | undefined }[] =
    [];
  /** Leaving: at a cue point (time), into the finale or fading over `seconds`. */
  #leave: { at: number; seconds: number; finale: boolean } | undefined;
  /** A palette fading out: done at this time. */
  #fadingUntil: number | undefined;
  done = false;

  constructor(track: MusicTrack, bus: MusicBus, run: RunContext, clock: Clock) {
    this.track = track;
    this.#bus = bus;
    this.#run = run;
    if (track.file) run.file(track.file);
    if (track.finale) run.file(track.finale);
    if (track.type === 'palette') {
      this.#layers = track.layers.map((pieces) => ({ pieces, piece: undefined, next: undefined }));
      for (const layer of this.#layers) layer.next = this.#pick(layer.pieces, clock.context);
    }
  }

  update(clock: Clock): void {
    if (this.done) return;
    if (!this.#started) this.#start(clock);
    if (!this.#started) return;
    switch (this.track.type) {
      case 'single':
        this.#updateSingle(clock);
        break;
      case 'silent':
        if (clock.now >= this.#until || this.#leave) this.done = true;
        break;
      case 'palette':
        this.#updatePalette(clock);
        break;
    }
  }

  leave(clock: Clock, seconds: number, atCue: boolean): void {
    if (this.#leave || this.done) return;
    if (!this.#started) {
      this.done = true;
      return;
    }
    const voice = this.#voice;
    const cue =
      atCue && voice
        ? this.track.cuePoints.find((point) => point > voice.position + 0.01)
        : undefined;
    if (cue !== undefined && voice) {
      const finale = this.track.finale !== undefined;
      this.#leave = { at: clock.now + (cue - voice.position), seconds, finale };
      return;
    }
    this.#leave = { at: clock.now, seconds, finale: false };
    this.#fadeAll(clock, seconds);
  }

  stopNow(): void {
    this.#voice?.stop(CLICK_FREE);
    this.#finale?.stop(CLICK_FREE);
    for (const layer of this.#layers) layer.piece?.voice?.stop(CLICK_FREE);
    this.done = true;
  }

  #start(clock: Clock): void {
    const { track } = this;
    if (track.type === 'silent') {
      this.#until = clock.now + track.duration;
      this.#started = true;
      return;
    }
    if (track.type === 'palette') {
      this.#until = clock.now + track.duration;
      this.#started = true;
      return;
    }
    const file = track.file;
    const ready = file === undefined ? false : this.#run.file(file);
    if (ready === undefined) return;
    this.#started = true;
    this.#voice =
      ready && file !== undefined
        ? this.#run.output.play(file, this.#bus, 0, track.loop)
        : undefined;
    if (!this.#voice) this.done = true;
  }

  #updateSingle(clock: Clock): void {
    const voice = this.#voice;
    const leave = this.#leave;
    if (
      leave &&
      clock.now >= leave.at &&
      voice &&
      !voice.ended &&
      this.#fadingUntil === undefined
    ) {
      const finale = leave.finale && this.track.finale;
      const settings = this.#run.settings;
      if (finale && this.#run.file(finale) === true) {
        // Combat's ending: crossfade from the cue point into the finale.
        this.#finale = this.#run.output.play(finale, this.#bus, settings.finaleFadeIn, undefined);
        voice.stop(settings.finaleFadeOut);
      } else {
        voice.stop(leave.seconds);
      }
      this.#fadingUntil = clock.now;
    }
    const finaleDone = this.#finale === undefined || this.#finale.ended;
    if ((voice?.ended ?? true) && finaleDone) this.done = true;
  }

  #updatePalette(clock: Clock): void {
    if (this.#fadingUntil === undefined && clock.now >= this.#until) {
      this.#fadeAll(clock, this.track.fadeOut);
    }
    if (this.#fadingUntil !== undefined) {
      if (clock.now >= this.#fadingUntil) {
        for (const layer of this.#layers) layer.piece?.voice?.stop(CLICK_FREE);
        this.done = true;
      }
      return;
    }
    for (const layer of this.#layers) {
      const piece = layer.piece;
      const over =
        piece === undefined || (piece.voice ? piece.voice.ended : clock.now >= piece.until);
      if (!over) continue;
      const next = layer.next;
      if (!next) {
        layer.next = this.#pick(layer.pieces, clock.context);
        continue;
      }
      const started = this.#startPiece(next, clock);
      if (!started) continue;
      layer.piece = started;
      layer.next = this.#pick(layer.pieces, clock.context);
    }
  }

  /** Starts a palette piece: its file once decoded, or its silence. */
  #startPiece(track: MusicTrack, clock: Clock): Piece | undefined {
    if (track.type !== 'single' || track.file === undefined) {
      return { track, voice: undefined, until: clock.now + track.duration };
    }
    const ready = this.#run.file(track.file);
    if (ready === undefined) return undefined;
    const voice = ready ? this.#run.output.play(track.file, this.#bus, 0, track.loop) : undefined;
    return { track, voice, until: clock.now };
  }

  /** A layer's next piece: one at random whose conditions hold (its file starts decoding). */
  #pick(pieces: readonly number[], context: SoundConditionContext): MusicTrack | undefined {
    const candidates = pieces.flatMap((formId) => {
      const track = this.#run.track(formId);
      return track && soundConditionsHold(track.conditions, context) ? [track] : [];
    });
    const pick = candidates[Math.floor(this.#run.random() * candidates.length)];
    if (pick?.file) this.#run.file(pick.file);
    return pick;
  }

  #fadeAll(clock: Clock, seconds: number): void {
    const fade = Math.max(seconds, CLICK_FREE);
    this.#voice?.stop(fade);
    this.#finale?.stop(fade);
    for (const layer of this.#layers) layer.piece?.voice?.stop(fade);
    this.#fadingUntil = clock.now + fade;
    if (this.track.type !== 'single') this.#until = Math.min(this.#until, clock.now);
  }
}

/** Shuffles in place (Fisher–Yates). */
function shuffle(items: number[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = items[i] ?? 0;
    items[i] = items[j] ?? 0;
    items[j] = a;
  }
}
