import { describe, expect, it } from 'vitest';
import { readSave, writeSave } from '../../save/save-codec.ts';
import { CrimeEngine } from './crime-engine.ts';
import { EventHub } from './event-hub.ts';
import { ProgressionEngine } from './progression-engine.ts';
import type { ScriptRuntime } from './runtime.ts';
import { TrapHits, type TrapTouchNow } from './trap-hits.ts';

const TRAP = 0x100;
const TARGET = 0x200;
const touch: TrapTouchNow = { position: [0, 0, 0], velocity: [0, 0, -100], motionType: 1 };
const runtime = {} as unknown as ScriptRuntime;

/** A value through our save's own encoding, as a save and a load put it. */
async function roundTrip<T>(value: T): Promise<T> {
  const bytes = await writeSave({
    header: {
      version: 1,
      name: 'Test',
      kind: 'save',
      number: 1,
      playerName: '',
      playerLevel: 1,
      location: '',
      gameDays: 0,
      realTime: 0,
      plugins: [],
    },
    thumbnail: new Uint8Array(),
    body: value,
  });
  return (await readSave(bytes)).body as T;
}

describe("the engines' timers in our save", () => {
  it("keeps a trap's contact: after a load it hits at its delay, without starting again", async () => {
    let now = 0;
    const events = new EventHub();
    const told: string[] = [];
    events.on('trapHit', (event) => told.push(event.phase));
    const before = new TrapHits(events, () => now);
    before.touching(TARGET, new Map([[TRAP, touch]]));
    const saved = await roundTrip(before.saveData());

    const after = new TrapHits(events, () => now);
    after.loadData(saved);
    now = after.delayMs / 2;
    after.touching(TARGET, new Map([[TRAP, touch]]));
    now = after.delayMs + 1;
    after.touching(TARGET, new Map([[TRAP, touch]]));
    expect(told).toEqual(['start', 'hit']);
  });

  it('keeps the NPC assaults answered and the regeneration delays', async () => {
    const crime = new CrimeEngine(runtime);
    crime.loadData(['5000:5001']);
    const again = new CrimeEngine(runtime);
    again.loadData(await roundTrip(crime.saveData()));
    expect(again.saveData()).toEqual(['5000:5001']);

    const progression = new ProgressionEngine(runtime);
    progression.loadData([['20:24', 2.5]]);
    const loaded = new ProgressionEngine(runtime);
    loaded.loadData(await roundTrip(progression.saveData()));
    expect(loaded.saveData()).toEqual([['20:24', 2.5]]);
  });
});
