// The dialogue camera: as a conversation with the player begins, the view turns to the
// speaker's head and zooms in a little, keeping on it while the speaker moves; as it ends the
// zoom goes back (docs/ui.md, "Dialogue"). The turn is the player's own: their yaw and pitch
// follow it, so they face the speaker afterwards (first person: the eye turns; third person:
// the camera swings round behind the shoulder the same way). No game setting of the load order
// describes it (no fDialogueCamera*): the turn's rate and the zoom are this file's own,
// TODO(M13): the engine's. Platform-independent.

type Vec3 = readonly [number, number, number];

/** Radians turned toward the speaker: this share of what is left, per second (eased). */
const TURN_RATE = 4;
/** Degrees the field of view narrows, and how fast (degrees a second). */
const ZOOM_DEGREES = 10;
const ZOOM_SPEED = 20;
/** The pitch is kept within this of level (radians), as the player's look is. */
const MAX_PITCH = 1.4;

/** The player's view as the camera has it now. */
export interface DialogueView {
  /** Radians: 0 north (+Y), π/2 east; pitch positive up. */
  readonly yaw: number;
  readonly pitch: number;
  /** Degrees added to the field of view (negative: zoomed in). */
  readonly fov: number;
}

/** The shortest signed turn from one heading to another (radians). */
function turnBetween(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export class DialogueCamera {
  /** Where the speaker's head is now (while the conversation lasts). */
  #target: (() => Vec3 | undefined) | undefined;
  #fov = 0;
  #last: number | undefined;

  /** A conversation begins: the view turns to the speaker's head and zooms in. */
  open(target: () => Vec3 | undefined): void {
    this.#target = target;
  }

  /** The conversation ends: the zoom goes back; the player keeps facing where they do. */
  close(): void {
    this.#target = undefined;
  }

  /** Whether it changes the view (a conversation, or the zoom still going back). */
  get active(): boolean {
    return this.#target !== undefined || this.#fov !== 0;
  }

  /**
   * Advances to `now` (milliseconds): the view from `eye` turned toward the speaker from the
   * player's `yaw` and `pitch`, and the zoom.
   */
  sample(now: number, eye: Vec3, yaw: number, pitch: number): DialogueView {
    const seconds = this.#last === undefined ? 0 : Math.min(0.1, (now - this.#last) / 1000);
    this.#last = this.active ? now : undefined;
    const target = this.#target?.();
    let nextYaw = yaw;
    let nextPitch = pitch;
    if (target) {
      const dx = target[0] - eye[0];
      const dy = target[1] - eye[1];
      const dz = target[2] - eye[2];
      const wantYaw = Math.atan2(dx, dy);
      const wantPitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, Math.atan2(dz, Math.hypot(dx, dy))),
      );
      const ease = 1 - Math.exp(-TURN_RATE * seconds);
      nextYaw = yaw + turnBetween(yaw, wantYaw) * ease;
      nextPitch = pitch + (wantPitch - pitch) * ease;
    }
    const goal = this.#target ? -ZOOM_DEGREES : 0;
    const step = ZOOM_SPEED * seconds;
    const gap = goal - this.#fov;
    this.#fov = Math.abs(gap) <= step ? goal : this.#fov + Math.sign(gap) * step;
    return { yaw: nextYaw, pitch: nextPitch, fov: this.#fov };
  }
}
