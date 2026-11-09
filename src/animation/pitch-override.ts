// The player's pitch under the graphs' PitchOverride (docs/animation.md, "Graph events"): the
// equip and unequip clips (1HM_Equip, 1HM_Unequip, CrossBow_Equip, the bound weapons' equips)
// raise PitchOverrideStart at their first frame and PitchOverrideEnd at their end, which set a
// flag of the third-person camera (observed in the original); a spell's equip sets the graph's
// own PitchOverride variable instead (0_master's Magic_Equip_State: PitchOverride_IsActiveMod, a
// BSIsActiveModifier, in the body's and the first-person graph alike), which nothing in the
// graphs reads. Platform-independent.
//
// Ours: while either is on, the pitch the player's body and arms take from the view is held
// level, so an equip's hand reaches the sheath, the back or the hip where the clip puts it
// rather than turned up or down with the view (the body's Pitch channel, which the bow's spine
// twist reads; the first-person arms, which are placed turned by the view's pitch). It eases
// there and back at PITCH_OVERRIDE_RATE, and follows the view at once again once caught up.
// Inferred, TODO(M13): what the original's camera and the player's update do with the flag and
// the variable was not read (the rule, the easing and its rate are ours).

/** How fast the held pitch eases to level and back to the view (radians a second; ours). */
export const PITCH_OVERRIDE_RATE = Math.PI;

/** The clip events that raise and end the camera's flag. */
export const PITCH_OVERRIDE_EVENTS: readonly string[] = ['PitchOverrideStart', 'PitchOverrideEnd'];

/** A graph as the flag asks it: whether it still plays a clip that raises an event. */
export interface PitchOverrideGraph {
  playsClipRaising(events: readonly string[]): boolean;
}

/**
 * The third-person camera's PitchOverride flag. PitchOverrideStart sets it in third person only
 * (observed in the original: the third-person camera's flag, set while it is the camera's
 * state); PitchOverrideEnd clears it in either view. Besides its End, ours clears it whenever
 * the clip that raised it can no longer end it, so it is never left on with nothing to clear it:
 * - the view changes (the third-person state it was set on is left; a draw, then a quick switch
 *   to first person, raised End where the flag is not set before);
 * - a save is loaded, a new place is entered, the player dies;
 * - no clip of the player's graphs that raises PitchOverrideStart or End plays any more (an
 *   equip cut off before its end annotation by a stagger or a knockdown).
 * Inferred, TODO(M13): what ends the original camera's flag besides PitchOverrideEnd (and whether
 * its leaving the third-person state does) was not read.
 */
export class CameraPitchOverride {
  #on = false;

  /** Whether it is on now. */
  get on(): boolean {
    return this.#on;
  }

  /** PitchOverrideStart, heard in `view`: on in third person only. */
  start(view: 'first' | 'third'): void {
    if (view === 'third') this.#on = true;
  }

  /** PitchOverrideEnd, a change of view, a load, a new place, death: off, in either view. */
  end(): void {
    this.#on = false;
  }

  /**
   * Each update, in `view`: off out of third person, and once none of the player's `graphs`
   * plays a clip that raises or ends it.
   */
  follow(view: 'first' | 'third', graphs: readonly (PitchOverrideGraph | undefined)[]): void {
    if (!this.#on) return;
    if (
      view !== 'third' ||
      !graphs.some((graph) => graph?.playsClipRaising(PITCH_OVERRIDE_EVENTS) === true)
    ) {
      this.#on = false;
    }
  }
}

/** The pitch (radians, up positive) the player's body or arms take from the view's. */
export class OverriddenPitch {
  #pitch = 0;
  /** It follows the view at once (no override since it caught up). */
  #following = true;

  /** The pitch now, for a step of `dt` seconds with the view at `view`. */
  step(view: number, overridden: boolean, dt: number): number {
    if (!overridden && this.#following) {
      this.#pitch = view;
      return view;
    }
    this.#following = false;
    const target = overridden ? 0 : view;
    const most = PITCH_OVERRIDE_RATE * Math.max(0, dt);
    const off = target - this.#pitch;
    if (Math.abs(off) <= most) {
      this.#pitch = target;
      if (!overridden) this.#following = true;
    } else {
      this.#pitch += Math.sign(off) * most;
    }
    return this.#pitch;
  }
}
