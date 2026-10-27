// The player's low health: below fPlayerHealthHeartbeatSlow of their health a slow heartbeat
// loops (default object HSSD), below fPlayerHealthHeartbeatFast a fast one (HFSD), each faded in
// and out over iPlayerHealthHeartbeatFadeMS. While the heartbeat sounds and [Display]
// bLowHealthIModEnabled is on, the low-health image-space modifier (default object IMLH,
// LowHealthImod: a red tint with blur and radial blur, one second long) is applied again every
// fLowHealthIModInterval seconds, stronger the lower the health: from fLowHealthIModStrengthMin
// at the slow threshold to fLowHealthIModStrengthMax at none. Platform-independent.
// TODO(M13): that the modifier follows the slow heartbeat's threshold and its strength runs
// linearly is inferred from the settings (the engine's rule is not read).

export interface LowHealthSettings {
  /** fPlayerHealthHeartbeatSlow, fPlayerHealthHeartbeatFast: shares of the health's maximum. */
  readonly slow: number;
  readonly fast: number;
  /** iPlayerHealthHeartbeatFadeMS, in seconds. */
  readonly fadeSeconds: number;
  /** [Display] bLowHealthIModEnabled, fLowHealthIModInterval, fLowHealthIModStrengthMin/Max. */
  readonly modifierEnabled: boolean;
  readonly interval: number;
  readonly strengthMin: number;
  readonly strengthMax: number;
}

/** The executable's defaults (none of them is a GMST of Skyrim.esm). */
export const DEFAULT_LOW_HEALTH_SETTINGS: LowHealthSettings = {
  slow: 0.2,
  fast: 0.1,
  fadeSeconds: 1,
  modifierEnabled: true,
  interval: 2,
  strengthMin: 0.8,
  strengthMax: 1.5,
};

export type Heartbeat = 'none' | 'slow' | 'fast';

/** The heartbeat at a share of the health (0..1); none for the dead. */
export function heartbeatAt(health: number, settings: LowHealthSettings): Heartbeat {
  if (!(health > 0)) return 'none';
  if (health < settings.fast) return 'fast';
  if (health < settings.slow) return 'slow';
  return 'none';
}

/** The modifier's strength at a share of the health; 0 above the threshold. */
export function lowHealthStrength(health: number, settings: LowHealthSettings): number {
  if (!settings.modifierEnabled || !(health > 0) || !(health < settings.slow)) return 0;
  const low = 1 - health / settings.slow;
  return settings.strengthMin + (settings.strengthMax - settings.strengthMin) * low;
}

export interface LowHealthStep {
  /** The heartbeat that should loop now. */
  readonly heartbeat: Heartbeat;
  /** Apply the modifier at this strength this frame (a pulse); undefined: not now. */
  readonly pulse: number | undefined;
}

/** The pulses' clock: the first as health falls below the threshold, then every interval. */
export class LowHealthPulse {
  readonly settings: LowHealthSettings;
  #since: number | undefined;

  constructor(settings: LowHealthSettings = DEFAULT_LOW_HEALTH_SETTINGS) {
    this.settings = settings;
  }

  step(seconds: number, health: number): LowHealthStep {
    const heartbeat = heartbeatAt(health, this.settings);
    const strength = lowHealthStrength(health, this.settings);
    if (strength <= 0) {
      this.#since = undefined;
      return { heartbeat, pulse: undefined };
    }
    const due = this.#since === undefined || this.#since + seconds >= this.settings.interval;
    this.#since = due ? 0 : (this.#since ?? 0) + seconds;
    return { heartbeat, pulse: due ? strength : undefined };
  }
}
