// Doors and containers opening and closing (docs/scripting.md, "Events"). Observed in the
// original: an object's open and close are told when its animation raises "Open" or "Close" at
// the end of its swing (TESOpenCloseEvent: the object's OnOpen, OnClose), with the one who
// activated it (the player, an actor going through, none for a script's SetOpen). Objects without
// an open sequence (sacks, barrels, load doors that take one through at once) tell nothing. A swing
// turned back before its end tells only the last one.

import type { ModelSequences, Playback } from '../render/animation.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

/**
 * A door's or container's sequence was just set (its playback's sequence and start): once it has
 * played, the hub tells it opened or closed.
 */
export function tellSwing(
  runtime: ScriptRuntime | undefined,
  reference: number,
  playback: Playback,
  sequences: ModelSequences | undefined,
  actor: number | undefined,
): void {
  const { sequence, start } = playback;
  if (!runtime || (sequence !== 'open' && sequence !== 'close')) return;
  const seconds = sequences?.byName.get(sequence)?.duration ?? 0;
  // GetOpenState follows the swing: opening (closing) until it has played.
  runtime.swung(reference, sequence === 'open' ? 2 : 4);
  setTimeout(() => {
    // Turned back meanwhile: that swing tells.
    if (playback.sequence !== sequence || playback.start !== start) return;
    runtime.swung(reference, sequence === 'open' ? 1 : 3);
    runtime.events.emit('openClose', { reference, actor, opened: sequence === 'open' });
  }, seconds * 1000);
}
