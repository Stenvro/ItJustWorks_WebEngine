// The HUD's rules the engine keeps for hudmenu.swf (hud-controller.ts drives the movie): which of
// its modes are on (ShowElements: the movie shows the elements of its last mode; the element
// lists below are the movie's own), when the health, magicka and stamina meters are sent, kept
// or faded, and where the floating quest marker stands. Platform-independent. Notes: docs/ui.md.

/**
 * The modes in which the movie's quest notices show (QuestUpdateBaseInstance's own list: the
 * quest updates, skill increases, discoveries, a dungeon cleared, words of power). Not in
 * WorldMapMode, JournalMode or CartMode: notices wait while the HUD is in one of those.
 */
const NOTICE_MODES = new Set([
  'All',
  'Favor',
  'InventoryMode',
  'TweenMode',
  'BookMode',
  'DialogueMode',
  'BarterMode',
  'MovementDisabled',
  'StealthMode',
  'Swimming',
  'HorseMode',
  'WarHorseMode',
]);

/**
 * The movie's mode stack as ShowElements keeps it: a mode shown goes on top (once), one hidden
 * leaves wherever it is; the top one says what shows ("All" when none is on).
 */
export class HudModes {
  readonly #modes: string[] = [];

  set(mode: string, on: boolean): void {
    const at = this.#modes.lastIndexOf(mode);
    if (at >= 0) this.#modes.splice(at, 1);
    if (on) this.#modes.push(mode);
  }

  get top(): string {
    return this.#modes.at(-1) ?? 'All';
  }

  /** Whether the quest notices show now (else they wait). */
  get showsNotices(): boolean {
    return NOTICE_MODES.has(this.top);
  }

  reset(): void {
    this.#modes.length = 0;
  }
}

/** The frame the meters' fade-in ends on (the movie's METER_PAUSE_FRAME, its "Pause" label). */
export const METER_PAUSE_FRAME = 40;
/** How often a meter that is not full is shown again while it stands still (ms). */
export const METER_KEEP_MS = 1000;

/** What a meter is sent this time. */
export interface MeterStep {
  /** Its percent changed: Set...MeterPercent (the movie shows it as it changes). */
  readonly set: boolean;
  /** Not full and unchanged a while: shown again (its fade-in played from where it is). */
  readonly keep: boolean;
  /** It has just filled up. */
  readonly filled: boolean;
}

/**
 * A meter's showing. The movie's meter clips fade themselves: a change plays the fade-in on from
 * where it is (RunMeterAnim), the clip holds to its last frame, then plays back out. A meter that
 * is not full stays: it is played on again every METER_KEEP_MS while it does not change (else a
 * meter that does not regenerate would fade while low). A full one fades on its own. TODO(M13):
 * the engine's own interval is not recorded.
 */
export class MeterFade {
  #shown = -1;
  #keptAt = -Infinity;

  step(percent: number, now: number): MeterStep {
    const set = percent !== this.#shown;
    const filled = set && percent >= 100 && this.#shown >= 0 && this.#shown < 100;
    let keep = false;
    if (set) this.#keptAt = now;
    else if (percent < 100 && now - this.#keptAt >= METER_KEEP_MS) {
      keep = true;
      this.#keptAt = now;
    }
    this.#shown = percent;
    return { set, keep, filled };
  }

  reset(): void {
    this.#shown = -1;
    this.#keptAt = -Infinity;
  }
}

/** The floating quest marker's settings (engine defaults). */
export interface FloatingMarkerSettings {
  /** fFloatQuestMarkerMinDistance: fully shown this near. */
  readonly minDistance: number;
  /** fFloatQuestMarkerMaxDistance: not shown beyond. */
  readonly maxDistance: number;
  /** fFloatQuestMarkerFloatHeight: how far above the target it floats. */
  readonly floatHeight: number;
}

export const FLOATING_MARKER: FloatingMarkerSettings = {
  minDistance: 1000,
  maxDistance: 2000,
  floatHeight: 20,
};

/**
 * The height of a target the marker floats over. TODO(M13): the target's own bound (its 3D's
 * top); an actor's height for now.
 */
const TARGET_HEIGHT = 128;

/** Where the floating marker shows: on the screen (0..1 from the top left), and its alpha. */
export interface FloatingMarker {
  readonly screen: readonly [number, number];
  /** 0..100. */
  readonly alpha: number;
}

/**
 * The floating quest marker: over the nearest quest target in the player's space within
 * fFloatQuestMarkerMaxDistance and in front of the camera; fully shown up to
 * fFloatQuestMarkerMinDistance, fading out toward the maximum. TODO(M13): how the engine fades
 * it between the two is not recorded (linearly here).
 */
export function floatingMarker(
  targets: readonly (readonly number[])[],
  player: readonly number[],
  project: (point: readonly [number, number, number]) => readonly [number, number] | undefined,
  settings: FloatingMarkerSettings = FLOATING_MARKER,
): FloatingMarker | undefined {
  let best: { readonly point: readonly [number, number, number]; readonly far: number } | undefined;
  for (const target of targets) {
    const x = target[0] ?? 0;
    const y = target[1] ?? 0;
    const z = target[2] ?? 0;
    const far = Math.hypot(x - (player[0] ?? 0), y - (player[1] ?? 0), z - (player[2] ?? 0));
    if (far > settings.maxDistance || (best && best.far <= far)) continue;
    best = { point: [x, y, z + TARGET_HEIGHT + settings.floatHeight], far };
  }
  if (!best) return undefined;
  const screen = project(best.point);
  if (!screen || screen[0] < 0 || screen[0] > 1 || screen[1] < 0 || screen[1] > 1) return undefined;
  const span = settings.maxDistance - settings.minDistance;
  const fade = span > 0 ? (settings.maxDistance - best.far) / span : 1;
  return { screen, alpha: Math.round(100 * Math.max(0, Math.min(1, fade))) };
}
