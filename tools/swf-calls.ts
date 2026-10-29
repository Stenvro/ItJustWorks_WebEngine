// What a menu movie asks of the engine and what the engine may call in it, read from its
// ActionScript (shared by tools/swf-actions.ts and tools/menu-inventory.ts).

import { decodeAvm1 } from '../src/formats/swf/avm1.ts';
import { allTags, SwfTagCode, tagBody, type SwfMovie } from '../src/formats/swf/swf.ts';

/**
 * The names a movie passes to GameDelegate.call (requests to the engine) and addCallBack (what
 * the engine calls), and to ExternalInterface.call directly. Read from the pushes before each
 * call: the method name is the value pushed just before the argument count.
 */
export function delegateCalls(swf: SwfMovie): {
  calls: Set<string>;
  callbacks: Set<string>;
  direct: Set<string>;
} {
  const calls = new Set<string>();
  const callbacks = new Set<string>();
  const direct = new Set<string>();
  for (const tag of allTags(swf.tags)) {
    if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
    const body = tagBody(swf, tag);
    const actions = decodeAvm1(
      tag.code === SwfTagCode.doInitAction ? body.subarray(2) : body,
      swf.header.version,
    );
    let pool: readonly string[] = [];
    const text = (index: number): string | undefined => {
      const action = actions[index];
      const value = action?.values?.[action.values.length - 1];
      if (!value) return undefined;
      if (value.kind === 'string') return value.value;
      if (value.kind === 'constant') return pool[value.index];
      return undefined;
    };
    for (const [i, action] of actions.entries()) {
      if (action.pool) pool = action.pool;
      if (action.name !== 'CallMethod') continue;
      const method = text(i - 1);
      if (method !== 'call' && method !== 'addCallBack') continue;
      // Walk back to the push holding the arguments: the one whose last values are
      // [name, count, "gfx" | "flash"] (the object path starts there).
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        const values = actions[j]?.values;
        if (!values || values.length < 3) continue;
        const resolve = (k: number): string | number | undefined => {
          const value = values[k];
          if (!value) return undefined;
          if (value.kind === 'string') return value.value;
          if (value.kind === 'constant') return pool[value.index];
          if (value.kind === 'number') return value.value;
          return undefined;
        };
        const root = resolve(values.length - 1);
        if (root !== 'gfx' && root !== 'flash') continue;
        const count = resolve(values.length - 2);
        const first = resolve(values.length - 3);
        if (typeof count !== 'number' || typeof first !== 'string') break;
        if (root === 'flash' && method === 'call') direct.add(first);
        else if (method === 'call') calls.add(first);
        else callbacks.add(first);
        break;
      }
    }
  }
  return { calls, callbacks, direct };
}
