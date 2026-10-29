import { describe, expect, it } from 'vitest';
import type { QuestRecord } from '../../../world/quest-records.ts';
import type { RecordDatabase } from '../../../world/record-db.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import { ScriptLibrary } from '../../script-library.ts';
import { ObjectHandle, type Value } from '../../values.ts';
import { ScriptRuntime } from '../runtime.ts';

const QUEST = 0x100;
const SHOWN = 0x200;
const OTHER = 0x201;
const CHEST = 0x300;

/** A runtime without plugins; QUEST shows the global SHOWN in its texts (QTGL). */
function runtime(): ScriptRuntime {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  const scripts = new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)));
  scripts.forms.quest = (formId: number) =>
    Promise.resolve(
      formId === QUEST ? ({ formId, textGlobals: [SHOWN] } as unknown as QuestRecord) : undefined,
    );
  return scripts;
}

async function call(
  scripts: ScriptRuntime,
  name: string,
  self: ObjectHandle,
  args: Value[] = [],
): Promise<Value> {
  const native = scripts.native(name.split('.')[0] ?? '', name.split('.')[1] ?? '');
  if (!native) throw new Error(`no native ${name}`);
  return native({ vm: scripts.vm, self, args, name } as unknown as NativeCall);
}

describe('Quest.UpdateCurrentInstanceGlobal', () => {
  const quest = new ObjectHandle(QUEST, 'quest');
  const global = (formId: number): ObjectHandle => new ObjectHandle(formId, 'globalvariable');

  it('holds a text global’s value for the quest’s run: false the first time, true after', async () => {
    const scripts = runtime();
    expect(await call(scripts, 'quest.updatecurrentinstanceglobal', quest, [global(SHOWN)])).toBe(
      false,
    );
    scripts.state.quest(QUEST).running = true;
    scripts.state.globals.set(SHOWN, 3);
    expect(await call(scripts, 'quest.updatecurrentinstanceglobal', quest, [global(SHOWN)])).toBe(
      false,
    );
    scripts.state.globals.set(SHOWN, 4);
    expect(scripts.state.quest(QUEST).instanceGlobals?.get(SHOWN)).toBe(3);
    expect(await call(scripts, 'quest.updatecurrentinstanceglobal', quest, [global(SHOWN)])).toBe(
      true,
    );
    expect(scripts.state.quest(QUEST).instanceGlobals?.get(SHOWN)).toBe(4);
  });

  it('holds no global the quest’s texts do not list, nor None', async () => {
    const scripts = runtime();
    scripts.state.quest(QUEST).running = true;
    expect(await call(scripts, 'quest.updatecurrentinstanceglobal', quest, [global(OTHER)])).toBe(
      false,
    );
    expect(await call(scripts, 'quest.updatecurrentinstanceglobal', quest, [null])).toBe(false);
    expect(scripts.state.quest(QUEST).instanceGlobals).toBeUndefined();
  });
});

describe('ObjectReference.CalculateEncounterLevel', () => {
  const chest = new ObjectHandle(CHEST, 'objectreference');

  it('scales the encounter’s level by the difficulty’s multiplier, rounded down, at least 1', async () => {
    const scripts = runtime();
    let level = 20;
    scripts.progression.encounterLevel = () => Promise.resolve(level);
    const { leveling } = await scripts.progression.settings();
    const easy = leveling.levelModifierMults[0] ?? 1;
    const encounter = (args: Value[]): Promise<Value> =>
      call(scripts, 'objectreference.calculateencounterlevel', chest, args);
    expect(await encounter([])).toBe(20);
    expect(await encounter([4])).toBe(20);
    expect(await encounter([-1])).toBe(20);
    expect(await encounter([0])).toBe(Math.floor(Math.fround(easy * 20)));
    level = 1;
    expect(await encounter([0])).toBe(1);
  });
});
