// The HUD's stealth meter (hudmenu.swf's StealthMeterInstance, one of the clips the HUD hands
// the engine with RegisterHUDComponents), driven as the engine drives it: while the player
// sneaks the HUD is in its StealthMode (ShowElements: the crosshair gives way to the meter) and
// the meter fades in (its FadeIn frames; FadeOut as the player stands up); its eye
// (SneakAnimInstance: 100 frames from "invisible", shut, to "visible", open) opens as far as
// the actor that knows the player best has it (src/ai/detection-states.ts, eye); its text
// (SneakTextHolder, played from "Start") flashes sSneakDetected as an actor detects the player
// and sSneakHidden as the last one searching gives up. TODO(M13): the engine's own eye frames
// (the clip's frames 101–120 play back to "visible"), its easing and when it flashes are not
// documented. Notes: docs/ui.md ("The HUD").

/** What the stealth meter shows (the play's senses: src/shell/actor-senses.ts). */
export interface StealthReading {
  /** The player sneaks: the meter shows. */
  readonly sneaking: boolean;
  /** How far the eye is open: 0 shut .. 1 open. */
  readonly eye: number;
  /** Counts each time an actor came to detect the player (DETECTED flashes). */
  readonly detected: number;
  /** Counts each time the last actor that knew of the player lost it (HIDDEN flashes). */
  readonly hidden: number;
}

/** The part of a menu the meter drives (src/ui/menu-host.ts Menu). */
export interface StealthMenu {
  call(name: string, ...args: unknown[]): unknown;
  invoke(path: string, ...args: unknown[]): unknown;
  set(path: string, value: unknown): void;
}

const METER = '_root.HUDMovieBaseInstance.StealthMeterInstance';
const EYE = `${METER}.SneakAnimInstance`;
const TEXT_HOLDER = `${METER}.SneakTextHolder`;
const TEXT = `${TEXT_HOLDER}.SneakTextClip.SneakTextInstance`;
/** The eye's frames: shut ("invisible") and open ("visible"). */
const EYE_SHUT = 1;
const EYE_OPEN = 100;
/** The eye opens or shuts this much a second (0..1): fully in a quarter of a second. */
const EYE_SPEED = 4;

/** The eye's frame for how far it is open (0..1). */
export function eyeFrame(open: number): number {
  return EYE_SHUT + Math.round(Math.min(1, Math.max(0, open)) * (EYE_OPEN - EYE_SHUT));
}

export class StealthMeter {
  #sneaking = false;
  /** How far the eye is shown open, and its frame. */
  #eye = 0;
  #frame = EYE_SHUT;
  #seen = { detected: 0, hidden: 0 };
  #last: number | undefined;

  /** The HUD was loaded again: its meter is faded out, its eye shut. */
  reset(): void {
    this.#sneaking = false;
    this.#eye = 0;
    this.#frame = EYE_SHUT;
    this.#last = undefined;
  }

  /**
   * Every frame: what the meter shows follows the reading (undefined: no play, the meter is
   * away); `now` in milliseconds; `texts`: sSneakDetected and sSneakHidden.
   */
  update(
    menu: StealthMenu,
    reading: StealthReading | undefined,
    now: number,
    texts: { readonly detected: string; readonly hidden: string },
  ): void {
    const seconds = this.#last === undefined ? 0 : Math.max(0, (now - this.#last) / 1000);
    this.#last = now;
    const sneaking = reading?.sneaking === true;
    if (sneaking !== this.#sneaking) {
      this.#sneaking = sneaking;
      menu.call('ShowElements', 'StealthMode', sneaking);
      menu.invoke(`${METER}.gotoAndPlay`, sneaking ? 'FadeIn' : 'FadeOut');
    }
    if (!reading) return;
    // The eye eases towards how far it should be open.
    const wanted = Math.min(1, Math.max(0, reading.eye));
    const step = EYE_SPEED * seconds;
    this.#eye += Math.max(-step, Math.min(step, wanted - this.#eye));
    const frame = eyeFrame(this.#eye);
    if (frame !== this.#frame) {
      this.#frame = frame;
      menu.invoke(`${EYE}.gotoAndStop`, frame);
    }
    // DETECTED and HIDDEN flash while sneaking.
    const flash =
      reading.detected > this.#seen.detected
        ? texts.detected
        : reading.hidden > this.#seen.hidden
          ? texts.hidden
          : undefined;
    this.#seen = { detected: reading.detected, hidden: reading.hidden };
    if (flash !== undefined && sneaking) {
      menu.set(`${TEXT}.text`, flash);
      menu.invoke(`${TEXT_HOLDER}.gotoAndPlay`, 'Start');
    }
  }
}
