// Every native function the engine provides, by lowercase "script.function". Natives not
// registered warn once when called and return their type's default; tools/papyrus-natives.ts
// lists any the scripts call that are missing (none in the vanilla scripts).
// Platform-independent. Notes: docs/scripting.md ("Natives").

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

export function registerNatives(registry: NativeRegistry, runtime: ScriptRuntime): void {
  const register: Register = (name, fn) => {
    registry.set(name, fn);
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
