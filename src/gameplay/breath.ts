// Breath and drowning, observed in the original (docs/gameplay.md, "Breath and drowning"):
//
// - An actor is under water while the water covers 0.875 of its height (the engine's constant;
//   its submersion: the water's height over its feet, as a share of its height; the engine marks
//   it swimming from 0.7).
// - Its breath lasts fActorSwimBreathBase + fActorSwimBreathMult × 50 seconds (the engine passes
//   50, not a level or a value: 20 s with Skyrim.esm's 10 and 0.2, 35 s with the built-in 10
//   and 0.5). Under water it runs down by the time passed; out of the water, or with Water
//   Breathing (the actor value), it is whole again at once.
// - With its breath gone the player drowns: each second takes fActorSwimBreathDamage of their
//   base health (8 % with Skyrim.esm), through the difficulty's damage to the player, and the
//   NPCHumanDrowning sound plays. Other actors never drown (as they run out of breath they make
//   for the surface).
// - An actor that comes up after more than fActorLeaveWaterBreathTimer (4 s) under water says
//   its Leave Water Breath line (dialogue subtype LWBS).
//
// Platform-independent: src/shell/time-flow.ts runs the player's.

/** The settings breath reads (GMST), with the engine's built-in values. */
export interface BreathSettings {
  /** fActorSwimBreathBase (seconds). */
  readonly base: number;
  /** fActorSwimBreathMult (seconds per point of the engine's 50). */
  readonly mult: number;
  /** fActorSwimBreathDamage: the share of base health a second of drowning takes. */
  readonly damage: number;
  /** fActorLeaveWaterBreathTimer: seconds under water after which coming up gasps. */
  readonly leaveWaterTimer: number;
}

/** The engine's built-in values (Skyrim.esm sets the mult to 0.2 and the damage to 0.08). */
export const BREATH_DEFAULTS: BreathSettings = {
  base: 10,
  mult: 0.5,
  damage: 0.2,
  leaveWaterTimer: 4,
};

/** The settings by their game setting names (a GMST's value, else the built-in). */
export const BREATH_SETTING_NAMES: Readonly<Record<keyof BreathSettings, string>> = {
  base: 'fActorSwimBreathBase',
  mult: 'fActorSwimBreathMult',
  damage: 'fActorSwimBreathDamage',
  leaveWaterTimer: 'fActorLeaveWaterBreathTimer',
};

/** The value the engine passes to the breath's length (a constant, observed in the original). */
const BREATH_POINTS = 50;

/** Submersion from which an actor is under water (its breath runs down). */
export const UNDERWATER_SUBMERSION = 0.875;

/** How long an actor's breath lasts (seconds). */
export function maxBreath(settings: BreathSettings = BREATH_DEFAULTS): number {
  return settings.base + settings.mult * BREATH_POINTS;
}

/** Health a span of drowning takes (before the difficulty). */
export function drowningDamage(
  baseHealth: number,
  seconds: number,
  settings: BreathSettings = BREATH_DEFAULTS,
): number {
  return Math.trunc(baseHealth) * settings.damage * seconds;
}

/** What a step of breathing came to. */
export interface BreathStep {
  /** Under water now. */
  readonly underwater: boolean;
  /** Seconds of the step drowned (the player's drowning damage is for them). */
  readonly drowning: number;
  /** It came up after more than fActorLeaveWaterBreathTimer under water (Leave Water Breath). */
  readonly gasped: boolean;
}

/** One actor's breath. */
export class Breath {
  readonly settings: BreathSettings;
  /** Seconds of breath left (whole: maxBreath). */
  remaining: number;
  /** Seconds it has been under water. */
  #under = 0;
  #wasUnder = false;

  constructor(settings: BreathSettings = BREATH_DEFAULTS) {
    this.settings = settings;
    this.remaining = maxBreath(settings);
  }

  /**
   * `seconds` pass with the actor at a submersion (0..1); `waterBreathing`: it has Water
   * Breathing.
   */
  step(seconds: number, submersion: number, waterBreathing = false): BreathStep {
    const underwater = submersion >= UNDERWATER_SUBMERSION;
    let gasped = false;
    if (this.#wasUnder && !underwater && this.#under >= this.settings.leaveWaterTimer)
      gasped = true;
    this.#under = underwater && this.#wasUnder ? this.#under + seconds : 0;
    this.#wasUnder = underwater;
    if (!underwater || waterBreathing) {
      this.remaining = maxBreath(this.settings);
      return { underwater, drowning: 0, gasped };
    }
    // The whole step drowns once the breath is gone (the engine's rule).
    this.remaining -= seconds;
    const drowning = this.remaining < 0 ? seconds : 0;
    return { underwater, drowning, gasped };
  }
}
