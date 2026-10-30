// Every native function the engine provides, by lowercase "script.function". Natives not
// registered warn once when called and return their type's default; tools/papyrus-natives.ts
// lists any the scripts call that are missing (none in the vanilla scripts).
// Platform-independent. Notes: docs/scripting.md ("Natives").

import type { NativeCall, NativeFunction } from '../../papyrus-vm.ts';
import { QUEUED_NATIVES } from '../../latent-queues.ts';
import type { NativeRegistry, ScriptRuntime } from '../runtime.ts';
import { registerActor } from './actor.ts';
import { registerCore } from './core.ts';
import { registerEquipment } from './equipment.ts';
import { registerForms } from './forms.ts';
import { registerMagic } from './magic.ts';
import { registerGame } from './game.ts';
import { registerQuest } from './quest.ts';
import { registerReference } from './reference.ts';
import type { Register } from './args.ts';
import { withNoneChecks } from './none-arguments.ts';

export function registerNatives(registry: NativeRegistry, runtime: ScriptRuntime): void {
  const register: Register = (name, fn) => {
    // Each native's own checks of a None argument come first (none-arguments.ts): their lines
    // are the game's own faults, logged as the original's. Then the natives whose work the
    // original queues for a point of the frame queue it (src/scripting/latent-queues.ts).
    registry.set(
      name,
      withNoneChecks(name, queuedWork(name, fn, runtime), (message) => {
        runtime.gameLog(message);
      }),
    );
  };
  registerCore(register, runtime);
  registerQuest(register, runtime);
  registerReference(register, runtime);
  registerGame(register, runtime);
  registerActor(register, runtime);
  registerEquipment(register, runtime);
  registerForms(register, runtime);
  registerMagic(register, runtime);
}

/**
 * A native whose work the original queues (QUEUED_NATIVES): the call queues the native's work
 * in its queue; a latent one's thread waits for it (unlocking its script, as a latent call
 * does), a NoWait one returns None at once.
 */
function queuedWork(name: string, fn: NativeFunction, runtime: ScriptRuntime): NativeFunction {
  const queued = QUEUED_NATIVES.get(name);
  if (!queued) return fn;
  return (call: NativeCall) => {
    const queues = runtime.vm.scheduler.latent;
    // Without frames the work is done in the call, as before the queues.
    if (!queues.waits) return fn(call);
    const work = queues.queue(queued.queue, () => fn(call));
    if (queued.latent) return call.latent(work);
    work.catch((error: unknown) => {
      runtime.vm.warn(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return null;
  };
}
