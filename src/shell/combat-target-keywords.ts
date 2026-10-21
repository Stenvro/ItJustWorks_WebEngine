// The keywords of the player's combat target, for the music's conditions (the boss tracks for
// dragons: GetCombatTargetHasKeyword ActorTypeDragon), which are checked synchronously: read
// once as the target changes, none until they are.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

export class CombatTargetKeywords {
  #target: number | undefined;
  #keywords: ReadonlySet<number> = new Set();

  /** Whether the player's combat target now has a keyword (as last read). */
  of(runtime: ScriptRuntime | undefined): (keyword: number) => boolean {
    const target = runtime?.world.combat?.(PLAYER_REF)?.combatTarget;
    if (target !== this.#target) {
      this.#target = target;
      this.#keywords = new Set();
      if (runtime && target !== undefined) {
        void runtime.keywords(target).then((keywords) => {
          if (this.#target === target) this.#keywords = new Set(keywords);
        });
      }
    }
    return (keyword) => this.#keywords.has(keyword);
  }
}
