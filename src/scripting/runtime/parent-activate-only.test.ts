// A script's Activate of a Parent Activate Only reference (XAPD bit 0): taken from its parent,
// from the reference itself (DLC2ApoBook3SeekerDoorScript's CheckDead and TrapTriggerBase call
// self.Activate(self) on such references) and, inferred (TODO(M13)), from any other activator.

import { describe, expect, it } from 'vitest';
import type { GameRecord, RecordDatabase } from '../../world/record-db.ts';
import { ScriptLibrary } from '../script-library.ts';
import { PLAYER_REF } from './forms.ts';
import { ScriptRuntime } from './runtime.ts';

/** A seeker gate (Parent Activate Only) and its activate parent. */
const GATE = 0x0403cf3f;
const PARENT = 0x0403cf41;

/** The gate's record: XAPD 1, XAPR naming its parent. */
const gateRecord = {
  formId: GATE,
  type: 'REFR',
  fields: {
    first: (type: string) => (type === 'XAPD' ? new Uint8Array([1]) : undefined),
    all: (type: string) => (type === 'XAPR' ? [new Uint8Array(8)] : []),
    has: (type: string) => type === 'XAPD' || type === 'XAPR',
  },
  formIdAt: () => PARENT,
} as unknown as GameRecord;

/** A runtime without plugins whose activations the test records. */
function runtime(): { scripts: ScriptRuntime; activated: [number, number | undefined][] } {
  const database = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  const scripts = new ScriptRuntime(database, new ScriptLibrary(() => Promise.resolve(undefined)));
  scripts.forms.record = (formId) => Promise.resolve(formId === GATE ? gateRecord : undefined);
  const activated: [number, number | undefined][] = [];
  scripts.activateRef = (reference, activator) => {
    activated.push([reference, activator]);
    return true;
  };
  return { scripts, activated };
}

describe('a script’s Activate of a Parent Activate Only reference', () => {
  it('is taken from the reference itself (self.Activate(self): the seeker gates open)', async () => {
    const { scripts, activated } = runtime();
    expect(await scripts.activate(GATE, GATE, false)).toBe(true);
    expect(activated).toEqual([[GATE, GATE]]);
  });

  it('is taken from its activate parent', async () => {
    const { scripts, activated } = runtime();
    expect(await scripts.activate(GATE, PARENT, false)).toBe(true);
    expect(activated).toEqual([[GATE, PARENT]]);
  });

  it('is taken from any other activator (inferred: TODO(M13))', async () => {
    const { scripts, activated } = runtime();
    expect(await scripts.activate(GATE, PLAYER_REF, false)).toBe(true);
    expect(activated).toEqual([[GATE, PLAYER_REF]]);
  });
});
