// What the player's perks call activating a reference (the Set Activate Label entry point: the
// werewolf's "Feed" on a corpse), for the crosshair's prompt. The perk system answers
// asynchronously: each reference is asked again at most every ASK_MS, its last answer shown
// meanwhile (docs/gameplay.md, "Perks").

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { GameSession } from './game-session.ts';

/** How often a reference's label is asked again (ms). */
const ASK_MS = 250;
/** References remembered at most (the cache starts over beyond it). */
const MAX_REMEMBERED = 256;

export class ActivateLabels {
  readonly #session: () => GameSession | undefined;
  readonly #labels = new Map<number, { label: string | undefined; asked: number }>();

  constructor(session: () => GameSession | undefined) {
    this.#session = session;
  }

  /** The label the perks give activating a reference, as last answered (undefined: none). */
  label(reference: number): string | undefined {
    const perks = this.#session()?.scriptsReady?.perks;
    if (!perks) return undefined;
    const now = performance.now();
    const known = this.#labels.get(reference);
    if (known && now - known.asked < ASK_MS) return known.label;
    if (this.#labels.size >= MAX_REMEMBERED) this.#labels.clear();
    const entry = { label: known?.label, asked: now };
    this.#labels.set(reference, entry);
    perks.activateLabel(PLAYER_REF, reference).then(
      (label) => {
        entry.label = label;
      },
      () => undefined,
    );
    return entry.label;
  }
}
