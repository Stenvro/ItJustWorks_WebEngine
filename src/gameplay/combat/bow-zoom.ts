// The bow's zoom spends the player's stamina (docs/ai.md, "The bow's zoom"), observed in the
// original: every frame of the zoom, while the player is not invulnerable (god mode), stamina is
// damaged by the drain a second (fBowZoomStaminaDrainMult through the perks' Mod Power Attack
// Stamina) times the frame's seconds; the frame that takes it from above 0 to 0 or below holds
// its regeneration for fBowZoomStaminaRegenDelay and blinks the HUD's stamina meter.
// Platform-independent: the shell's time flow (src/shell/time-flow.ts) runs it.

/** One frame of the zoom's drain. */
export interface BowZoomStep {
  /** The stamina the frame takes. */
  readonly spend: number;
  /** The frame emptied the stamina: hold its regeneration, blink the meter. */
  readonly emptied: boolean;
}

/**
 * A frame of the zoom: `stamina` the player's now, `perSecond` the drain after the perks,
 * `seconds` the frame's. Nothing while invulnerable or with no drain.
 */
export function bowZoomStep(
  stamina: number,
  perSecond: number,
  seconds: number,
  invulnerable = false,
): BowZoomStep {
  if (invulnerable || !(perSecond > 0) || !(seconds > 0)) return { spend: 0, emptied: false };
  const spend = perSecond * seconds;
  return { spend, emptied: stamina > 0 && stamina - spend <= 0 };
}
