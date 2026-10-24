// Conformance: the Papyrus VM (engine map: Scripting > Papyrus VM). Its threads, locks, latent
// natives, frame budget and the engine's handling of script events. The case list is started;
// the cases are still to be written in full.
//
// Sources:
// - The Creation Kit wiki's "Threading Notes (Papyrus)": events run on threads of their own, and
//   the engine does not wait for a script's handler to return.
// - The game data: WIDeadBodyCleanupScript (on placed town actors, the Bannered Mare's patrons
//   among them) loops Utility.WaitGameTime(DaysBeforeCleanUp × 24) in OnDeath until the body is
//   cleaned up, so its OnDeath returns only after half a game day or more.
// - The [Papyrus] INI settings' defaults (fUpdateBudgetMS, fExtraTaskletBudgetMS, ...).

import { describe, it } from 'vitest';

describe('the Papyrus VM', () => {
  // Found 2026-10-24 (the Bannered Mare's patrons): Actor.Kill waits for every death handler to
  // return (actor-engine.ts kill awaits the hub's 'death' events, whose script listener awaits
  // the handlers), so OnDeath is sent only after OnDying returns, and the murder, the crime
  // report and the story manager's Kill Actor event wait half a game day for
  // WIDeadBodyCleanupScript's OnDeath. TODO(M13): the event's producer must not wait for the
  // scripts' handlers, only start them in order.
  it.todo(
    'a death does not wait for its script handlers: OnDying and OnDeath are both sent at once, ' +
      'and the crime and story manager events follow without waiting for them  [CK threading notes]',
  );
  it.todo(
    'every vanilla OnDeath handler of a placed actor in a sample of cells returns within N ' +
      'frames, or waits on a clock its script names (WaitGameTime)  [data: the scripts]',
  );
  it.todo(
    'threads run on the [Papyrus] fUpdateBudgetMS budget per frame, with fExtraTaskletBudgetMS ' +
      'for the handed-off natives, by the engine’s rule  [original; settings]',
  );
  it.todo(
    'the natives handed to the main thread run where the engine runs them in its frame, as ' +
      'many a frame as it runs (one a frame per thread is assumed now)  [original]',
  );
});
