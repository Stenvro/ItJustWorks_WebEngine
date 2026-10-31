// The sounds of the surroundings: the regions the listener is in (REGN sound entries: looping
// beds of wind and water, and one-shots like bird calls and gusts placed around the listener)
// and the weather (its rain and wind, crossfading with a change of weather, and thunder with
// its lightning). Region loops fade in and out ([Audio] fRegionLoopFadeInTime,
// fRegionLoopFadeOutTime); one-shots get a chance each half-second update, at most
// uRegionSoundsAllowedPerUpdate new sounds an update, placed around the listener by
// fRegionRandomSoundPlacementBase, fRegionSoundPlacementRandomOffset and
// fRegionSoundPlacementZOffset. Observed in the original: a
// weather's thunder sounds (SNAM type 3) start at random, checked every 30 ms, and bring the
// lightning flash; its other sounds play on at its share of a change, a single one (gusts in
// a snowstorm, distant thunder in overcast rain) started again within a second of ending.
// Every sound's conditions (time of day, weather, indoors) must hold. Notes: docs/audio.md.

import type { Vec3 } from '../render/math.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import { fadeShare, THUNDER_CHECK_SECONDS, thunderChance } from '../world/lightning.ts';
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
  /** DATA thunder frequency: one chance in this (× its thunder sounds) each check. */
  readonly thunderFrequency: number;
  /** DATA fade points of thunder and precipitation (0–1 of a change of weather). */
  readonly thunderFadeIn: number;
  readonly thunderFadeOut: number;
  readonly precipitationFadeIn: number;
  readonly precipitationFadeOut: number;
  /** SNAM: 0 default, 1 precipitation, 2 wind, 3 thunder. */
  readonly sounds: readonly { readonly sound: number; readonly type: number }[];
}

/** WTHR SNAM sound types: precipitation and thunder. */
const PRECIPITATION = 1;
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
  /** A thunder sound started: the lightning flash comes with it, this bright (0–1). */
  readonly lightning?: ((amount: number) => void) | undefined;
  /** The music the cell names (XCMO) and the worldspace's (ZNAM). */
  readonly cellMusic: number | undefined;
  /** The location the cell is in (XLCN; its music: LCTN NAM1). */
  readonly location?: number | undefined;
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
  /** It finished playing. */
  readonly ended: boolean;
  /** Its level (0–1), changed smoothly (`smoothing` 0: at once). */
  setLevel(level: number, smoothing?: number): void;
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
/** Weather loops follow a change of weather; this smooths their level. */
const WEATHER_FADE = 2;
/** A weather's single sounds start again at most this often (observed in the original). */
const WEATHER_RESTART_SECONDS = 1;
/** Shares at or below this start no thunder (observed). */
const SILENT_SHARE = 0.0001;

interface LoopState {
  instance: AmbientSound | undefined;
  starting: boolean;
  /** Removed while starting: stop it once it starts. */
  dropped: boolean;
  /** When a single sound was last started again (seconds). */
  restarted?: number;
}

/** A thunder sound of a weather: playing until its instance ends. */
interface ThunderState {
  playing: boolean;
  instance: AmbientSound | undefined;
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
  /** The last thunder check (seconds), and the thunder sounds by weather and sound. */
  #thunderCheck: number | undefined;
  readonly #thunders = new Map<string, ThunderState>();
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
      this.#regionSounds(regions, fits, context, listener);
    }
    this.#weather(state, context, now);
    this.#thunder(state, context, now);
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
    for (const thunder of this.#thunders.values()) thunder.instance?.stop(true);
    this.#thunders.clear();
    this.#thunderCheck = undefined;
  }

  /**
   * The weathers' sounds other than thunder, observed in the original: each plays at its
   * weather's share of a change (precipitation by the weathers' precipitation fade points,
   * the others by the change itself; a sound both weathers name at the larger share), loops
   * and single sounds alike: a single one that ended starts again, checked once a second.
   */
  #weather(state: AmbientState, context: SoundConditionContext, now: number): void {
    const levels = new Map<number, number>();
    const change = state.previousWeather ? state.transition : undefined;
    const add = (weather: AmbientWeather | undefined, leaving: boolean): void => {
      if (!weather || state.interior) return;
      for (const { sound, type } of weather.sounds) {
        if (type === THUNDER) continue;
        const descriptor = this.#descriptor(sound);
        if (!descriptor || !soundConditionsHold(descriptor.conditions, context)) continue;
        const level =
          type === PRECIPITATION
            ? fadeShare(weather.precipitationFadeIn, weather.precipitationFadeOut, leaving, change)
            : change === undefined
              ? Number(!leaving)
              : leaving
                ? 1 - change
                : change;
        levels.set(sound, Math.max(levels.get(sound) ?? 0, level));
      }
    };
    add(state.weather, false);
    add(state.previousWeather, true);
    this.#keep(this.#weatherLoops, new Set(levels.keys()), WEATHER_FADE, WEATHER_FADE);
    for (const [sound, loop] of this.#weatherLoops) {
      const level = levels.get(sound) ?? 0;
      const instance = loop.instance;
      if (instance?.ended && this.#descriptor(sound)?.looping === 'none') {
        if (now - (loop.restarted ?? Number.NEGATIVE_INFINITY) < WEATHER_RESTART_SECONDS) continue;
        loop.restarted = now;
        loop.instance = undefined;
        loop.starting = true;
        void this.#player.play(sound, undefined, 0).then((started) => {
          loop.starting = false;
          if (loop.dropped) started?.stop(true);
          else {
            loop.instance = started;
            started?.setLevel(level, 0);
          }
        });
        continue;
      }
      instance?.setLevel(level);
    }
  }

  /**
   * Thunder, observed in the original: every 30 ms each thunder sound of the current and the
   * leaving weather that is not playing starts with one chance in its weather's frequency ×
   * the thunder sounds of both, at its weather's thunder share of a change (none: no thunder),
   * and the lightning flash comes with it at that brightness.
   */
  #thunder(state: AmbientState, context: SoundConditionContext, now: number): void {
    const last = this.#thunderCheck ?? now;
    const checks = Math.min(10, Math.floor((now - last) / THUNDER_CHECK_SECONDS));
    if (this.#thunderCheck === undefined || checks > 0) this.#thunderCheck = now;
    const weathers: (readonly [AmbientWeather | undefined, boolean])[] = state.interior
      ? []
      : [
          [state.weather, false],
          [state.previousWeather, true],
        ];
    let count = 0;
    for (const [weather] of weathers) {
      for (const entry of weather?.sounds ?? []) if (entry.type === THUNDER) count++;
    }
    const change = state.previousWeather ? state.transition : undefined;
    const live = new Set<string>();
    for (const [weather, leaving] of weathers) {
      if (!weather) continue;
      for (const entry of weather.sounds) {
        if (entry.type !== THUNDER) continue;
        const key = `${String(weather.formId)}:${String(entry.sound)}`;
        live.add(key);
        let thunder = this.#thunders.get(key);
        if (!thunder) {
          thunder = { playing: false, instance: undefined };
          this.#thunders.set(key, thunder);
        }
        if (thunder.instance?.ended) {
          thunder.playing = false;
          thunder.instance = undefined;
        }
        // (Its descriptor loads from the first sight of it, before its first chance.)
        if (!this.#single(entry.sound, context) || thunder.playing || checks <= 0) continue;
        const chance = 1 - (1 - thunderChance(weather.thunderFrequency, count)) ** checks;
        if (this.#random() >= chance) continue;
        const share = fadeShare(weather.thunderFadeIn, weather.thunderFadeOut, leaving, change);
        if (share <= SILENT_SHARE) continue;
        const playing = thunder;
        playing.playing = true;
        void this.#player.play(entry.sound, undefined, 0).then((instance) => {
          if (!instance) playing.playing = false;
          playing.instance = instance;
          instance?.setLevel(share, 0);
        });
        state.lightning?.(share);
      }
    }
    for (const key of this.#thunders.keys()) if (!live.has(key)) this.#thunders.delete(key);
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
