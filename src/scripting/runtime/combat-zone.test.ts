import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../world/record-db.ts';
import { ScriptLibrary } from '../script-library.ts';
import { ScriptRuntime, type Placement } from './runtime.ts';

const WORLD = 0x3c;
const PERSISTENT = 0xd74;
/** Two exterior cells side by side: x 0 has ZONE, x 1 none. */
const ZONED_CELL = 0x500;
const BARE_CELL = 0x501;
const ZONE = 0x600;
const ACTOR = 0x700;

/** A runtime whose world has the two cells, ACTOR placed as `placement` says. */
function runtime(placement: () => Placement): ScriptRuntime {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    formIdsOfType: () => [],
    cellOfReference: () => undefined,
    worldOfCell: (cell: number) => (cell === ZONED_CELL || cell === BARE_CELL ? WORLD : undefined),
    persistentCell: () => PERSISTENT,
    exteriorCell: (_world: number, x: number) =>
      Promise.resolve(x === 0 ? ZONED_CELL : x === 1 ? BARE_CELL : undefined),
  } as unknown as RecordDatabase;
  const scripts = new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)));
  const record = (formId: number, fields: Record<string, number>): unknown => ({
    formId,
    formIdField: (name: string) => fields[name],
    fields: { first: () => undefined },
  });
  scripts.forms.record = ((formId: number) =>
    Promise.resolve(
      formId === ZONED_CELL
        ? record(formId, { XEZN: ZONE })
        : formId === BARE_CELL || formId === ZONE || formId === WORLD
          ? record(formId, {})
          : undefined,
    )) as typeof scripts.forms.record;
  scripts.placement = () => Promise.resolve(placement());
  return scripts;
}

describe('ProgressionEngine.combatZone', () => {
  it('is the zone of the exterior cell an actor stands over now, not the cell it was put in', async () => {
    // Put in the zoned cell (a schedule's move), it has flown on over the bare one.
    let position: [number, number, number] = [100, 100, 0];
    const scripts = runtime(() => ({
      position,
      rotation: [0, 0, 0],
      cell: ZONED_CELL,
      world: WORLD,
      scale: 1,
    }));
    expect((await scripts.progression.combatZone(ACTOR)).zone).toBe(ZONE);
    position = [4096 + 100, 100, 0];
    expect((await scripts.progression.combatZone(ACTOR)).zone).toBeUndefined();
  });

  it('takes a persistent actor’s zone by its place, as before', async () => {
    const scripts = runtime(() => ({
      position: [100, 100, 0],
      rotation: [0, 0, 0],
      cell: PERSISTENT,
      world: WORLD,
      scale: 1,
    }));
    expect((await scripts.progression.combatZone(ACTOR)).zone).toBe(ZONE);
  });
});
