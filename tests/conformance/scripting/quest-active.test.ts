// Conformance: a quest given to the player is an active one (its objectives' targets on the
// compass and the map) without a script asking for it, in the headless simulation. Skipped
// without game data.
//
// Sources:
// - Observed in the original's saves (docs/formats/ess.md; the maintainer's own saves of a new
//   game, read at run time): at MQ101 [0003372B] stage 180 the quest's change form has the
//   Active flag (0x800), though no script of the load order calls SetActive on MQ101 (its
//   scripts QF_MQ101_0003372B, MQ101QuestScript and its aliases' scripts do not call it); at
//   stage 70, before its first objective is shown, it does not. So showing an objective makes
//   its quest active. Without it the compass showed nothing in Helgen: MQ101's "Make your way
//   to the Keep" marks Ralof, then Hadvar, but MQ101 never became active.
// - Inferred (TODO(M13) in src/scripting/runtime/natives/quest.ts): that each objective newly
//   shown makes its quest active again (also one the player made inactive in the journal).
// - The data (Skyrim.esm): DialogueFollower [000750BA] runs from the game's start (Start Game
//   Enabled) with no objective shown; its objective 10 is "<Alias=Follower> is waiting for you".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const DIALOGUE_FOLLOWER = 0x750ba;

describe.skipIf(!hasGamedata())('a quest whose objective is shown (headless simulation)', () => {
  let sim: Sim;
  let quest: ObjectHandle;

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    const handle = sim.runtime.formHandle(DIALOGUE_FOLLOWER);
    if (!(handle instanceof ObjectHandle)) throw new Error('no quest');
    quest = handle;
  }, 300_000);

  afterAll(async () => {
    await sim.close();
  });

  it('is not active while it runs with no objective shown', async () => {
    expect(sim.runtime.quests.isRunning(DIALOGUE_FOLLOWER)).toBe(true);
    expect(await sim.native(quest, 'Quest', 'IsObjectiveDisplayed', [10])).toBe(false);
    expect(await sim.native(quest, 'Quest', 'IsActive', [])).toBe(false);
  });

  it('becomes active as its objective is shown, with no SetActive', async () => {
    await sim.native(quest, 'Quest', 'SetObjectiveDisplayed', [10, true, false]);
    expect(await sim.native(quest, 'Quest', 'IsObjectiveDisplayed', [10])).toBe(true);
    expect(await sim.native(quest, 'Quest', 'IsActive', [])).toBe(true);
  });
});
