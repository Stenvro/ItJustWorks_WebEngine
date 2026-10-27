import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../world/record-db.ts';
import { ScriptLibrary } from '../script-library.ts';
import { formatValue, ObjectHandle, type Value } from '../values.ts';
import { ScriptRuntime } from './runtime.ts';

const LEVER = 0x200;
const QUEST = 0x300;

/** A runtime without plugins whose sent events are listed. */
function runtime(): { runtime: ScriptRuntime; sent: string[] } {
  const db = { plugins: [] } as unknown as RecordDatabase;
  const made = new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)));
  const sent: string[] = [];
  made.vm.sendEvent = (target: ObjectHandle, event: string, args: readonly Value[] = []) => {
    sent.push(`${event} ${target.formId.toString(16)} (${args.map(formatValue).join(', ')})`);
    return Promise.resolve();
  };
  return { runtime: made, sent };
}

describe('the registrations the engine ends or answers', () => {
  it('drops animation event registrations as the graph unloads, telling each script', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    const lever = scripts.referenceHandle(LEVER);
    scripts.registerAnimationEvent(quest, lever, 'Pulled', true);
    scripts.animationGraphUnloaded(LEVER);
    await Promise.resolve();
    expect(sent).toEqual([`OnAnimationEventUnregistered 300 (${formatValue(lever)}, pulled)`]);
    // Gone: the graph's event no longer reaches the quest, and a second unload tells nothing.
    scripts.animationEvent(LEVER, 'Pulled');
    scripts.animationGraphUnloaded(LEVER);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  it('tells the menus registered for as they open and close (RegisterForMenu)', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    scripts.registerForMenu(quest, 'InventoryMenu', true);
    scripts.menuOpenClose('InventoryMenu', true);
    scripts.menuOpenClose('MagicMenu', true);
    scripts.menuOpenClose('InventoryMenu', false);
    scripts.registerForMenu(quest, undefined, false);
    scripts.menuOpenClose('InventoryMenu', true);
    await Promise.resolve();
    expect(sent).toEqual(['OnMenuOpen 300 (InventoryMenu)', 'OnMenuClose 300 (InventoryMenu)']);
  });
});
