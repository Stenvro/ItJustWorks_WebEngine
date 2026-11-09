// Conformance: a quest that does not run once starts over as it is started again (Quest Data
// Tab: Run Once; the engine resets such a quest as it starts), in the headless simulation, by the
// civil war's own script path: CWResetGarrisonScript's StartCWGovernmentQuestIfCapital sends
// CWGovernmentStart with the capital whose hold changed hands, and waits with no time limit for
// CWGovernment's shut-down stage to call it back. Skipped without game data.
//
// The data (Skyrim.esm; `node tools/quest-info.ts 00036626`, `node tools/pex-dump.ts
// QF_CWGovernment_00036626`, `node tools/story-manager.ts SCPT`):
// - CWGovernment [00036626]: no flags (neither Run Once nor Allow Repeated Stages), started by the
//   script event (SCPT) with CWGovernmentStart [00036636]; its RulingHQ alias is the event's
//   location. Its start-up stage 0 installs and exiles the hold's government and stops the quest
//   (Fragment_0); its shut-down stage 9999 calls back the CWResetGarrison quests
//   (sendCallBackToResetGarrisonQuests).
// - The peace council (MQ302 stage 260, TransferHoldControl) hands two holds over, so two
//   capitals change hands one after the other: MarkarthLocation [00018A59] and RiftenLocation
//   [00018A58].
// If the second start kept the first run's stages, neither stage 0 nor 9999 would be set again:
// the quest would run on, and the garrison quest waiting for its call back would wait forever.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const CW_GOVERNMENT = 0x36626;
const CW_GOVERNMENT_START = 0x36636;
const MARKARTH_LOCATION = 0x18a59;
const RIFTEN_LOCATION = 0x18a58;
const SHUT_DOWN = 9999;

describe.skipIf(!hasGamedata())('a quest started again (headless simulation)', () => {
  let sim: Sim;
  /** The stages CWGovernment set, in order, with the capital each start was for. */
  const stages: string[] = [];
  /** Whether it ran on after each start (it stops itself in its start-up stage). */
  const ranOn: boolean[] = [];

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    const { runtime } = sim;
    const handle = (value: Value): ObjectHandle => {
      if (!(value instanceof ObjectHandle)) throw new Error('no object');
      return value;
    };
    let capital = '';
    runtime.events.on('questStage', ({ quest, stage }) => {
      if (quest === CW_GOVERNMENT) stages.push(`${capital} ${stage}`);
    });
    for (const [name, location] of [
      ['Markarth', MARKARTH_LOCATION],
      ['Riften', RIFTEN_LOCATION],
    ] as const) {
      capital = name;
      await sim.native(
        handle(runtime.formHandle(CW_GOVERNMENT_START)),
        'Keyword',
        'SendStoryEvent',
        [handle(runtime.formHandle(location)), null, null, 0, 0],
      );
      await sim.until(() => !runtime.quests.isRunning(CW_GOVERNMENT), 30);
      ranOn.push(runtime.quests.isRunning(CW_GOVERNMENT));
    }
  }, 300_000);

  afterAll(async () => {
    await sim.close();
  });

  it('runs its start-up and shut-down stages on each start', () => {
    expect(stages).toEqual([
      'Markarth 0',
      `Markarth ${SHUT_DOWN}`,
      'Riften 0',
      `Riften ${SHUT_DOWN}`,
    ]);
  });

  it('stops itself each time, as its start-up stage asks', () => {
    expect(ranOn).toEqual([false, false]);
  });
});
