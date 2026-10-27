// The player's low health on the screen and in the ears (src/gameplay/low-health.ts): the
// heartbeat loops of the default objects HSSD / HFSD, cross-faded as the health changes, and
// the pulses of the low-health image-space modifier (IMLH).

import {
  DEFAULT_LOW_HEALTH_SETTINGS,
  LowHealthPulse,
  type Heartbeat,
  type LowHealthSettings,
} from '../gameplay/low-health.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import { DefaultObjectUse, type DefaultObjects } from '../world/default-objects.ts';
import type { GameSettings } from '../world/game-settings.ts';
import type { IniSettings } from '../world/ini-settings.ts';

export interface LowHealthHost {
  /** The player's health now: current and maximum (undefined: no player yet). */
  health(): Promise<{ readonly current: number; readonly max: number } | undefined>;
  /** Applies the modifier at a strength (the session's image-space modifiers). */
  applyModifier(formId: number, strength: number): void;
  /** Starts a sound descriptor at the listener, fading in. */
  play(descriptor: number, fadeIn: number): Promise<SoundInstance | undefined>;
}

/** The settings from the game's settings (GMST) and the INI files, the engine's defaults else. */
export function lowHealthSettings(gmst: GameSettings, ini: IniSettings): LowHealthSettings {
  const d = DEFAULT_LOW_HEALTH_SETTINGS;
  return {
    slow: gmst.number('fPlayerHealthHeartbeatSlow') ?? d.slow,
    fast: gmst.number('fPlayerHealthHeartbeatFast') ?? d.fast,
    fadeSeconds: (gmst.number('iPlayerHealthHeartbeatFadeMS') ?? d.fadeSeconds * 1000) / 1000,
    modifierEnabled: ini.bool('Display', 'bLowHealthIModEnabled'),
    interval: ini.number('Display', 'fLowHealthIModInterval'),
    strengthMin: ini.number('Display', 'fLowHealthIModStrengthMin'),
    strengthMax: ini.number('Display', 'fLowHealthIModStrengthMax'),
  };
}

export class LowHealthScreen {
  readonly #host: LowHealthHost;
  readonly #pulse: LowHealthPulse;
  readonly #modifier: number | undefined;
  readonly #sounds: Readonly<Record<Exclude<Heartbeat, 'none'>, number | undefined>>;
  #reading = false;
  #elapsed = 0;
  #heartbeat: Heartbeat = 'none';
  /** The heartbeat loop playing, if any (undefined while one is starting). */
  #loop:
    { heartbeat: Heartbeat; instance: SoundInstance | undefined; dropped: boolean } | undefined;

  constructor(host: LowHealthHost, defaults: DefaultObjects, settings: LowHealthSettings) {
    this.#host = host;
    this.#pulse = new LowHealthPulse(settings);
    this.#modifier = defaults.get(DefaultObjectUse.lowHealthImageSpace);
    this.#sounds = {
      slow: defaults.get(DefaultObjectUse.heartbeatSlow),
      fast: defaults.get(DefaultObjectUse.heartbeatFast),
    };
  }

  /** The heartbeat that loops now (the console and tests). */
  get heartbeat(): Heartbeat {
    return this.#heartbeat;
  }

  /** Every frame the game runs: reads the health and steps the pulses. */
  update(seconds: number): void {
    this.#elapsed += seconds;
    if (this.#reading) return;
    this.#reading = true;
    void this.#host
      .health()
      .then((value) => {
        const elapsed = this.#elapsed;
        this.#elapsed = 0;
        const share = value && value.max > 0 ? value.current / value.max : 1;
        const step = this.#pulse.step(elapsed, share);
        if (step.pulse !== undefined && this.#modifier !== undefined) {
          this.#host.applyModifier(this.#modifier, step.pulse);
        }
        this.#setHeartbeat(step.heartbeat);
      })
      .finally(() => {
        this.#reading = false;
      });
  }

  /** Stops the heartbeat at once (a new game, the player gone). */
  stop(): void {
    this.#setHeartbeat('none', true);
  }

  #setHeartbeat(heartbeat: Heartbeat, immediately = false): void {
    if (heartbeat === this.#heartbeat) return;
    this.#heartbeat = heartbeat;
    const fade = this.#pulse.settings.fadeSeconds;
    const old = this.#loop;
    if (old) {
      old.dropped = true;
      if (immediately) old.instance?.stop(true);
      else old.instance?.fadeOut(fade);
    }
    this.#loop = undefined;
    if (heartbeat === 'none') return;
    const sound = this.#sounds[heartbeat];
    if (sound === undefined) return;
    const loop = { heartbeat, instance: undefined as SoundInstance | undefined, dropped: false };
    this.#loop = loop;
    void this.#host.play(sound, fade).then((instance) => {
      if (loop.dropped) instance?.stop(true);
      else loop.instance = instance;
    });
  }
}
