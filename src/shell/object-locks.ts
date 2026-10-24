// A door's or container's lock now (docs/gameplay.md, "Locks"): as scripts left it (Lock,
// SetLockLevel: the reference's state), else as placed (XLOC). One rule for every reader: the
// crosshair's prompt and the lockpicking (play-mode.ts), and the actors' doors (actor-doors.ts),
// which also run in the headless simulation, where there is no HUD.

import type { GameState } from '../scripting/runtime/game-state.ts';
import type { CellObject, ObjectLock } from '../world/cell-loader.ts';

/** The lock an object has now, if it is locked. */
export function lockNow(
  object: Pick<CellObject, 'reference' | 'lock'>,
  state: Pick<GameState, 'references'> | undefined,
): ObjectLock | undefined {
  const reference = state?.references.get(object.reference);
  if (reference?.locked === false) return undefined;
  if (reference?.locked === true) {
    return { level: reference.lockLevel ?? object.lock?.level ?? 1, key: object.lock?.key };
  }
  return object.lock;
}
