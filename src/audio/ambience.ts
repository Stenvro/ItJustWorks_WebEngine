// The sounds of the surroundings: the regions the listener is in (REGN sound entries: looping
// beds of wind and water, and one-shots like bird calls and gusts placed around the listener)
// and the weather (its looping rain and wind, crossfading with a change of weather, and
// thunder after lightning). Region loops fade in and out ([Audio] fRegionLoopFadeInTime,
// fRegionLoopFadeOutTime); one-shots get a chance each half-second update, at most
// uRegionSoundsAllowedPerUpdate new sounds an update, placed around the listener by
// fRegionRandomSoundPlacementBase, fRegionSoundPlacementRandomOffset and
// fRegionSoundPlacementZOffset. A weather's
// thunder sounds (SNAM type 3) follow its lightning flashes; its other single sounds (gusts in
// a snowstorm, distant thunder in overcast rain) come at random. Every sound's conditions
// (time of day, weather, indoors) must hold. Notes: docs/audio.md.

import type { Vec3 } from '../render/math.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import { lightningInterval } from '../world/lightning.ts';
import {
  regionMusic,
  regionsInEffect,
  type RegionAudio,
  type SoundDescriptor,
} from '../world/sound-records.ts';
import { soundConditionsHold, type SoundConditionContext } from './sound-conditions.ts';
import type { WaterAt } from './water-audio.ts';

/** The weather as ambience needs it (WeatherRecord). */
export interface AmbientWeather {
  readonly formId: number;
  /** WTHR DATA flags: 0x1 pleasant, 0x2 cloudy, 0x4 rainy, 0x8 snow. */
  readonly flags: number;
  /** DATA thunder frequency (255: no lightning). */
  readonly thunderFrequency: number;
  /** SNAM: 0 default, 1 precipitation, 2 wind, 3 thunder. */
  readonly sounds: readonly { readonly sound: number; readonly type: number }[];
}

/** WTHR SNAM sound type of thunder. */
const THUNDER = 3;

export interface AmbientState {
  /** REGN form ids the listener is in (exterior cell regions; an interior's sound region). */
  readonly regions: readonly number[];
  readonly weather: AmbientWeather | undefined;
  /** The weather being left during a change, and how far the change is (0–1). */
  readonly previousWeather: AmbientWeather | undefined;
  readonly transition: number;
  readonly hour: number;
  readonly interior: boolean;
  readonly swimming: boolean;
  /** When the last lightning flash began (any clock; a new value means a new flash). */
  readonly flash: number | undefined;
  /** The music the cell names (XCMO) and the worldspace's (ZNAM). */
  readonly cellMusic: number | undefined;
  readonly worldMusic: number | undefined;
  /** Water around the listener (src/audio/water-audio.ts), and whether it is under water. */
  readonly waterAt: WaterAt | undefined;
  readonly underwater: boolean;
  /** Whether the player's combat target has a keyword (the combat music's conditions). */
  readonly combatTargetHasKeyword?: ((keyword: number) => boolean) | undefined;
}

/** The conditions of ambient sounds and music in these surroundings. */
export function ambientConditions(
  state: AmbientState,
  global: (formId: number) => number,
): SoundConditionContext {
  return {
    hour: state.hour,
    weather: state.weather?.formId,
    raining: ((state.weather?.flags ?? 0) & 0x4) !== 0,
    interior: state.interior,
    swimming: state.swimming,
    global,
    combatTargetHasKeyword: state.combatTargetHasKeyword,
  };
}

/** A playing sound as ambience controls it (SoundInstance). */
export interface AmbientSound {
  /** Its level (0–1), changed smoothly. */
  setLevel(level: number): void;
  fadeOut(seconds: number): void;
  stop(immediately?: boolean): void;
}

/** What ambience plays sounds through (the sound system). */
export interface AmbientPlayer {
  descriptor(formId: number): Promise<SoundDescriptor | undefined>;
  regionAudio(formId: number): Promise<RegionAudio | undefined>;
  /** A global variable's value (loaded with the descriptors whose conditions read it). */
  global(formId: number): number;
  play(
    descriptor: number,
    place: Vec3 | undefined,
    fadeIn: number,
  ): Promise<AmbientSound | undefined>;
}

/** Seconds between updates of the region sounds (observed in the original: half a second). */
const UPDATE_SECONDS = 0.5;
/** Seconds region loops fade out over when the regions have no sounds (observed). */
const EMPTY_REGION_FADE = 0.3;
/**
 * Thunder follows a flash after a delay (distance); the engine's is not documented: here
 * 0.5–3 s. TODO(M13).
 */
const THUNDER_DELAY = [0.5, 3] as const;
/** Weather loops follow a change of weather; this smooths their level. */
const WEATHER_FADE = 2;
/**
 * The chance each update (half a second) of a weather's single sounds that do not follow
 * lightning: 4 % a second. WTHR SNAM has no chance of its own; this is the median of the
 * region one-shots' (RDSA). TODO(M13): compare with the game.
 */
const WEATHER_SOUND_CHANCE = 0.02;

interface LoopState {
  instance: AmbientSound | undefined;
  starting: boolean;
  /** Removed while starting: stop it once it starts. */
  dropped: boolean;
}

export class Ambience {
  readonly #player: AmbientPlayer;
  readonly #ini: IniSettings;
  readonly #descriptors = new Map<number, SoundDescriptor | undefined>();
  readonly #regions = new Map<number, RegionAudio | undefined>();
  /** Regions whose record has been read (with or without sound data). */
  readonly #regionsRead = new Set<number>();
  #regionMusic: { readonly ready: boolean; readonly music: number | undefined } = {
    ready: false,
    music: undefined,
  };
  readonly #regionLoops = new Map<number, LoopState>();
  readonly #weatherLoops = new Map<number, LoopState>();
  #lastCheck = Number.NEGATIVE_INFINITY;
  #lastFlash: number | undefined;
  #flashSeen = false;
  #random: () => number;

  constructor(player: AmbientPlayer, ini: IniSettings, random: () => number = Math.random) {
    this.#player = player;
    this.#ini = ini;
    this.#random = random;
  }

  /** The region and weather loops playing or starting (SNDR form ids). */
  get loops(): { regionLoops: number[]; weatherLoops: number[] } {
    return {
      regionLoops: [...this.#regionLoops.keys()],
      weatherLoops: [...this.#weatherLoops.keys()],
    };
  }

  /**
   * The music type of the regions in effect (RDMO), once every region has been read (`ready`):
   * until then the location's music is not known yet.
   */
  get regionMusic(): { readonly ready: boolean; readonly music: number | undefined } {
    return this.#regionMusic;
  }

  /** Every frame (`now`: seconds). */
  update(state: AmbientState, listener: Vec3, now: number): void {
    const context = ambientConditions(state, (formId) => this.#player.global(formId));
    const audio = state.regions.flatMap((formId) => {
      const region = this.#regionAudio(formId);
      return region ? [region] : [];
    });
    this.#regionMusic = {
      ready: state.regions.every((formId) => this.#regionsRead.has(formId)),
      music: regionMusic(audio),
    };
    const regions = regionsInEffect(audio);
    const classification = (state.weather?.flags ?? 0) & 0x0f;
    const fits = (flags: number): boolean =>
      state.interior || classification === 0 || (flags & classification) !== 0;
    if (now - this.#lastCheck >= UPDATE_SECONDS) {
      this.#lastCheck = now;
      this.#weatherOneShots(state, context, listener);
      this.#regionSounds(regions, fits, context, listener);
    }
    this.#weather(state, context);
  }

  /**
   * One update of the region sounds, as observed in the original: entries in their regions'
   * order, those that fit the weather and whose conditions hold; an entry of chance 1 is a
   * loop (kept while it fits, faded out over fRegionLoopFadeOutTime once it does not, or over
   * 0.3 s when the regions have no sounds at all), any other a one-shot with half its chance
   * each update (its chance a second). At most uRegionSoundsAllowedPerUpdate sounds start per
   * update, loops and one-shots together.
   */
  #regionSounds(
    regions: readonly RegionAudio[],
    fits: (flags: number) => boolean,
    context: SoundConditionContext,
    listener: Vec3,
  ): void {
    const entries = regions.flatMap((region) => region.sounds);
    let allowed = this.#ini.number('Audio', 'uRegionSoundsAllowedPerUpdate');
    const wanted = new Set<number>();
    for (const entry of entries) {
      const descriptor = this.#descriptor(entry.sound);
      if (!descriptor || !fits(entry.flags)) continue;
      if (!soundConditionsHold(descriptor.conditions, context)) continue;
      if (entry.chance >= 1) {
        if (this.#regionLoops.has(entry.sound)) wanted.add(entry.sound);
        else if (allowed > 0) {
          allowed--;
          wanted.add(entry.sound);
        }
      } else if (allowed > 0 && this.#random() < entry.chance * 0.5) {
        allowed--;
        void this.#player.play(entry.sound, this.#placeAround(listener), 0);
      }
    }
    this.#keep(
      this.#regionLoops,
      wanted,
      this.#ini.number('Audio', 'fRegionLoopFadeInTime'),
      entries.length === 0
        ? EMPTY_REGION_FADE
        : this.#ini.number('Audio', 'fRegionLoopFadeOutTime'),
    );
  }

  /** Stops everything at once (leaving a world). */
  stop(): void {
    for (const loops of [this.#regionLoops, this.#weatherLoops]) {
      for (const state of loops.values()) {
        state.dropped = true;
        state.instance?.stop(true);
      }
      loops.clear();
    }
    this.#flashSeen = false;
  }

  /** Weather loops crossfade with the change of weather; thunder follows flashes. */
  #weather(state: AmbientState, context: SoundConditionContext): void {
    const levels = new Map<number, number>();
    const add = (weather: AmbientWeather | undefined, level: number): void => {
      if (!weather || state.interior || level <= 0) return;
      for (const { sound } of weather.sounds) {
        const descriptor = this.#descriptor(sound);
        if (!descriptor || descriptor.looping === 'none') continue;
        if (!soundConditionsHold(descriptor.conditions, context)) continue;
        levels.set(sound, Math.max(levels.get(sound) ?? 0, level));
      }
    };
    const transition = state.previousWeather ? state.transition : 1;
    add(state.weather, transition);
    add(state.previousWeather, 1 - transition);
    this.#keep(this.#weatherLoops, new Set(levels.keys()), WEATHER_FADE, WEATHER_FADE);
    for (const [sound, loop] of this.#weatherLoops) {
      loop.instance?.setLevel(levels.get(sound) ?? 0);
    }
    // The first state names a flash already under way (or none); later ones are new flashes.
    if (!this.#flashSeen) {
      this.#flashSeen = true;
      this.#lastFlash = state.flash;
    } else if (state.flash !== undefined && state.flash !== this.#lastFlash) {
      this.#lastFlash = state.flash;
      if (!state.interior) this.#thunder(state, context);
    }
  }

  /** A thunder sound of the flashing weather, after a short delay. */
  #thunder(state: AmbientState, context: SoundConditionContext): void {
    const weather = [state.weather, state.previousWeather].find(
      (candidate) => candidate && flashes(candidate),
    );
    const thunders = (weather?.sounds ?? []).filter(
      (entry) => entry.type === THUNDER && this.#single(entry.sound, context),
    );
    const pick = thunders[Math.floor(this.#random() * thunders.length)];
    if (!pick) return;
    const delay = THUNDER_DELAY[0] + this.#random() * (THUNDER_DELAY[1] - THUNDER_DELAY[0]);
    setTimeout(() => void this.#player.play(pick.sound, undefined, 0), delay * 1000);
  }

  /** The current weather's single sounds that do not follow lightning: a chance each check. */
  #weatherOneShots(state: AmbientState, context: SoundConditionContext, listener: Vec3): void {
    const weather = state.weather;
    if (!weather || state.interior) return;
    for (const entry of weather.sounds) {
      if (entry.type === THUNDER && flashes(weather)) continue;
      if (!this.#single(entry.sound, context) || this.#random() >= WEATHER_SOUND_CHANCE) continue;
      void this.#player.play(entry.sound, this.#placeAround(listener), 0);
      return;
    }
  }

  /** A single (not looping) sound whose conditions hold. */
  #single(sound: number, context: SoundConditionContext): boolean {
    const descriptor = this.#descriptor(sound);
    return descriptor?.looping === 'none' && soundConditionsHold(descriptor.conditions, context);
  }

  /** Starts the loops in `wanted` that are not playing and fades out those not wanted. */
  #keep(
    loops: Map<number, LoopState>,
    wanted: ReadonlySet<number>,
    fadeIn: number,
    fadeOut: number,
  ): void {
    for (const [sound, state] of loops) {
      if (wanted.has(sound)) continue;
      state.dropped = true;
      state.instance?.fadeOut(fadeOut);
      loops.delete(sound);
    }
    for (const sound of wanted) {
      if (loops.has(sound)) continue;
      const state: LoopState = { instance: undefined, starting: true, dropped: false };
      loops.set(sound, state);
      void this.#player.play(sound, undefined, fadeIn).then((instance) => {
        state.starting = false;
        if (state.dropped) instance?.stop(true);
        else state.instance = instance;
      });
    }
  }

  /**
   * Where a one-shot region sound plays, as observed in the original: east or west of the
   * listener by fRegionRandomSoundPlacementBase to fRegionSoundPlacementRandomOffset (100 to
   * 650 units), north or south by fRegionRandomSoundPlacementBase, and
   * fRegionSoundPlacementZOffset up.
   */
  #placeAround(listener: Vec3): Vec3 {
    const base = this.#ini.number('Audio', 'fRegionRandomSoundPlacementBase');
    const offset = this.#ini.number('Audio', 'fRegionSoundPlacementRandomOffset');
    const x = base + this.#random() * (offset - base);
    const east = this.#random() > 0.5;
    const north = this.#random() > 0.5;
    return [
      listener[0] + (east ? x : -x),
      listener[1] + (north ? base : -base),
      listener[2] + this.#ini.number('Audio', 'fRegionSoundPlacementZOffset'),
    ];
  }

  /** A descriptor once loaded (undefined until then: the next frames see it). */
  #descriptor(formId: number): SoundDescriptor | undefined {
    if (!this.#descriptors.has(formId)) {
      this.#descriptors.set(formId, undefined);
      void this.#player.descriptor(formId).then((descriptor) => {
        this.#descriptors.set(formId, descriptor);
      });
    }
    return this.#descriptors.get(formId);
  }

  #regionAudio(formId: number): RegionAudio | undefined {
    if (!this.#regions.has(formId)) {
      this.#regions.set(formId, undefined);
      void this.#player.regionAudio(formId).then((audio) => {
        this.#regions.set(formId, audio);
        this.#regionsRead.add(formId);
        for (const entry of audio?.sounds ?? []) this.#descriptor(entry.sound);
      });
    }
    return this.#regions.get(formId);
  }
}

/** Whether a weather has lightning (thunder follows its flashes). */
function flashes(weather: AmbientWeather): boolean {
  return lightningInterval(weather.thunderFrequency) !== undefined;
}
