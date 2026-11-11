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
//   A miscellaneous quest (type 6) follows the journal's one switch for them all instead
//   (ToggleShowMiscObjectives): turned off, a miscellaneous objective shown later leaves its
//   quest inactive, as the player chose.
// - The data (Skyrim.esm): DialogueFollower [000750BA] runs from the game's start (Start Game
//   Enabled) with no objective shown; its objective 10 is "<Alias=Follower> is waiting for you".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const DIALOGUE_FOLLOWER = 0x750ba;
/** Miscellaneous quests (type 6): "Use the Arcane Enchanter"; "Talk to Orthus Endario ...". */
const TUTORIAL_ENCHANTING = 0x105a60;
const MS10_MISC_POINTER = 0x10d3bb;

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

  it("a miscellaneous quest's objective follows the player's choice for them all", async () => {
    // The journal's ToggleShowMiscObjectives(false) turned the miscellaneous objectives off
    // (src/shell/journal-menu.ts): one shown later leaves its quest inactive.
    sim.runtime.state.miscObjectivesActive = false;
    const enchanting = sim.runtime.formHandle(TUTORIAL_ENCHANTING);
    if (!(enchanting instanceof ObjectHandle)) throw new Error('no quest');
    await sim.native(enchanting, 'Quest', 'SetObjectiveDisplayed', [10, true, false]);
    expect(await sim.native(enchanting, 'Quest', 'IsObjectiveDisplayed', [10])).toBe(true);
    expect(await sim.native(enchanting, 'Quest', 'IsActive', [])).toBe(false);
    // Turned on again, the next miscellaneous quest's objective makes it active.
    sim.runtime.state.miscObjectivesActive = true;
    const pointer = sim.runtime.formHandle(MS10_MISC_POINTER);
    if (!(pointer instanceof ObjectHandle)) throw new Error('no quest');
    await sim.native(pointer, 'Quest', 'SetObjectiveDisplayed', [10, true, false]);
    expect(await sim.native(pointer, 'Quest', 'IsActive', [])).toBe(true);
  });
});
