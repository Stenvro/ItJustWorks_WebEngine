// Sound-driven gamepad rumble (docs/audio.md, "Rumble"). Observed in the original: a sound whose
// output model allows rumble (SOPM NAM1 flag 0x2: the player's own models) sends its signal,
// scaled by its descriptor's rumble send (SNDR LNAM byte 3), into two buses, one per motor.
// Each bus measures its loudest sample of every pass; once a frame the two peaks become the
// motors' strengths: raised to [Audio] fAudioRumbleSmallExponent and fAudioRumbleBigExponent
// (both lowered by fAudioRumblePowerAttackAdj while the player power attacks: a power
// attack's rumble is stronger), below the dead zone none, else lerped between LerpMin and
// LerpMax. The rumble stops (both motors at 0) while it is off.

/** The [Audio] settings of the sound-driven rumble. */
export interface RumbleSettings {
  readonly fAudioRumbleSmallExponent: number;
  readonly fAudioRumbleBigExponent: number;
  readonly fAudioRumbleSmallLerpMin: number;
  readonly fAudioRumbleSmallLerpMax: number;
  readonly fAudioRumbleSmallDeadZone: number;
  readonly fAudioRumbleBigLerpMin: number;
  readonly fAudioRumbleBigLerpMax: number;
  readonly fAudioRumbleBigDeadZone: number;
  readonly fAudioRumblePowerAttackAdj: number;
}

/** The rumble's settings, each read by its name (the [Audio] INI settings). */
export function readRumbleSettings(read: (name: keyof RumbleSettings) => number): RumbleSettings {
  return {
    fAudioRumbleSmallExponent: read('fAudioRumbleSmallExponent'),
    fAudioRumbleBigExponent: read('fAudioRumbleBigExponent'),
    fAudioRumbleSmallLerpMin: read('fAudioRumbleSmallLerpMin'),
    fAudioRumbleSmallLerpMax: read('fAudioRumbleSmallLerpMax'),
    fAudioRumbleSmallDeadZone: read('fAudioRumbleSmallDeadZone'),
    fAudioRumbleBigLerpMin: read('fAudioRumbleBigLerpMin'),
    fAudioRumbleBigLerpMax: read('fAudioRumbleBigLerpMax'),
    fAudioRumbleBigDeadZone: read('fAudioRumbleBigDeadZone'),
    fAudioRumblePowerAttackAdj: read('fAudioRumblePowerAttackAdj'),
  };
}

/** The two motors' strengths (0–1): the small (high frequency) and the big (low frequency). */
export interface RumbleLevels {
  readonly small: number;
  readonly big: number;
}

/**
 * A descriptor's rumble send (LNAM byte 3) as the share of its signal each motor's bus gets:
 * two levels of 0–15, the low four bits the small motor's, the high four the big motor's
 * (Skyrim.esm: light weapon impacts send 0x01–0x05, the readied spells' loops 0x20–0x30, the
 * Fire Storm's blast 0xA0, the killmoves 0x53–0x64; the ward test descriptors 0x11 and 0x22).
 * TODO(M13): which half is which motor is inferred from the data (the Creation Kit's two
 * values); the engine code that splits it was not found.
 */
export function rumbleSends(value: number): RumbleLevels {
  return { small: (value & 0x0f) / 15, big: ((value >> 4) & 0x0f) / 15 };
}

/** One motor's strength from its bus's peak (the original's curve: see the head comment). */
function motor(peak: number, exponent: number, adjust: number): number {
  return Math.max(0, peak) ** Math.max(0.01, exponent - adjust);
}

/**
 * The motors' strengths from the two buses' peaks (0–1 samples). Observed in the original: a
 * big motor below its dead zone silences the small motor (and leaves the big at its curve's
 * value, not lerped); with the vanilla dead zones of 0 that never happens.
 */
export function rumbleMotors(
  peaks: RumbleLevels,
  settings: RumbleSettings,
  powerAttack: boolean,
): RumbleLevels {
  const adjust = powerAttack ? settings.fAudioRumblePowerAttackAdj : 0;
  const small = motor(peaks.small, settings.fAudioRumbleSmallExponent, adjust);
  const big = motor(peaks.big, settings.fAudioRumbleBigExponent, adjust);
  let smallOut =
    small < settings.fAudioRumbleSmallDeadZone
      ? 0
      : (settings.fAudioRumbleSmallLerpMax - settings.fAudioRumbleSmallLerpMin) * small +
        settings.fAudioRumbleSmallLerpMin;
  let bigOut = big;
  if (big < settings.fAudioRumbleBigDeadZone) smallOut = 0;
  else
    bigOut =
      (settings.fAudioRumbleBigLerpMax - settings.fAudioRumbleBigLerpMin) * big +
      settings.fAudioRumbleBigLerpMin;
  return { small: Math.min(1, Math.max(0, smallOut)), big: Math.min(1, Math.max(0, bigOut)) };
}

/** The loudest sample of a block (the original's bus meter: one peak per pass). */
export function blockPeak(samples: Iterable<number>): number {
  let peak = 0;
  for (const sample of samples) {
    const value = Math.abs(sample);
    if (value > peak) peak = value;
  }
  return peak;
}
