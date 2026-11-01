// Doors and containers opening and closing (docs/scripting.md, "Events"). Observed in the
// original: an object's open and close are told when its animation raises "Open" or "Close" at
// the end of its swing (TESOpenCloseEvent: the object's OnOpen, OnClose), with the one who
// activated it (the player, an actor going through, none for a script's SetOpen). Objects without
// an open sequence (sacks, barrels, load doors that take one through at once) tell nothing. A swing
// turned back before its end tells only the last one.

import type { ModelSequences, Playback } from '../render/animation.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

/**
 * Swings a door (or container) to `to` ("open" or "close") at `now`: turned back before the
 * swing it plays has ended, the new one starts where that one is (the open and close sequences
 * are each other's way back: a door a third of the way open closes from a third open), not from
 * its own start; an ended swing (or none) starts the new one at its start. Before, a door shut
 * a moment after it began to open jumped to wide open and closed from there (the keep's doors as
 * actors came and went flickered open and shut). TODO(M13): whether the original turns a swing
 * back from where it is or plays the other sequence from its start was not measured; the doors
 * here are drawn and collide where their sequence has them either way.
 */
export function turnSwing(
  playback: Playback,
  sequences: Pick<ModelSequences, 'byName'> | undefined,
  to: 'open' | 'close',
  now: number,
): void {
  const from = playback.sequence;
  const length = (name: string): number => sequences?.byName.get(name)?.duration ?? 0;
  const before = from === undefined ? 0 : length(from);
  const after = length(to);
  // How much of the swing under way is left to play (0: none under way, or it has ended).
  const left =
    from !== undefined && from !== to && before > 0
      ? Math.min(1, Math.max(0, 1 - (now - playback.start) / before))
      : 0;
  playback.sequence = to;
  // The new swing is as far along as the old one had still to go.
  playback.start = now - left * after;
}

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
  // A swing turned back part-way started before now (turnSwing): it ends sooner.
  const elapsed = performance.now() / 1000 - start;
  const left = elapsed > 0 && elapsed < seconds ? seconds - elapsed : seconds;
  setTimeout(() => {
    // Turned back meanwhile: that swing tells.
    if (playback.sequence !== sequence || playback.start !== start) return;
    runtime.swung(reference, sequence === 'open' ? 1 : 3);
    runtime.events.emit('openClose', { reference, actor, opened: sequence === 'open' });
  }, left * 1000);
}
