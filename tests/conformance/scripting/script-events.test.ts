// Conformance: activation through the scripts (engine map: Scripting > Script events, with
// Per-reference state's activate parents and the quests' stages). The player activates a lever
// in the headless simulation; its scripts get OnActivate, one of them sets a quest's stage, and
// the lever's activate child (a gate) is activated by it and opens. Skipped without game data.
//
// Expected output, from the data (Skyrim.esm; BlindCliffCave01 [000152B7]):
// - The lever [00077C50] (ACTI NorPullChain01) carries TrapLever, NorLever01SCRIPT and
//   defaultsetStageActSCRIPT { myQuest = dunBlindCliffQST [00039B3B], stage = 20 }; the script
//   sets its stage on OnActivate by the player (requirePlayerActivation's default).
// - The gate [000689C1] (DOOR MetalCageLongGate01) names the lever as its activate parent (XAPR,
//   no delay): activating a reference activates its children, by it (Creation Kit, Reference >
//   Activate Parents: "when the parent is activated, this reference is activated as well").
// - A door activated opens: its open state goes to opening (2), then open (1) (GetOpenState),
//   and the engine's open event (TESOpenCloseEvent) names who opened it.
// - Activation is TESActivateEvent (target, action ref): the target's scripts get
//   OnActivate(akActionRef); setting a stage starts the quest if it is not running and sends
//   TESQuestStageEvent.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BLIND_CLIFF_CAVE = 0x152b7;
const LEVER = 0x77c50;
const GATE = 0x689c1;
const DUN_BLIND_CLIFF_QST = 0x39b3b;
const LEVER_STAGE = 20;
/** GetOpenState: 1 open, 2 opening. */
const OPEN = 1;
const OPENING = 2;

describe.skipIf(!hasGamedata())('activation through the scripts (headless simulation)', () => {
  let sim: Sim;
  let activatedAt = 0;
  let activated = false;
  /** Whether stage 20 was done before the lever (the cave's entrance trigger sets 10). */
  let doneBefore = true;

  beforeAll(async () => {
    sim = await openSim({ interior: BLIND_CLIFF_CAVE, hour: 12 });
    await sim.step(1);
    doneBefore = sim.stageDone(DUN_BLIND_CLIFF_QST, LEVER_STAGE);
    activatedAt = sim.time;
    activated = sim.activate(LEVER);
    await sim.step(3);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('offers the lever to the player’s activation', () => {
    expect(activated).toBe(true);
  });

  it('tells the activation (TESActivateEvent) with the player as the action ref', () => {
    expect(sim.events('activate')).toContainEqual({ target: LEVER, actor: PLAYER_REF });
  });

  it('sends the lever’s scripts OnActivate(akActionRef = the player)', () => {
    const sent = sim.scriptEvents({ event: 'OnActivate', target: LEVER, since: activatedAt });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toEqual([{ form: PLAYER_REF }]);
  });

  it('sets dunBlindCliffQST’s stage 20 (defaultsetStageActSCRIPT)', () => {
    expect(doneBefore).toBe(false);
    expect(sim.stageDone(DUN_BLIND_CLIFF_QST, LEVER_STAGE)).toBe(true);
    expect(sim.stagesSet(DUN_BLIND_CLIFF_QST)).toContainEqual({
      quest: DUN_BLIND_CLIFF_QST,
      stage: LEVER_STAGE,
    });
    expect(sim.isRunning(DUN_BLIND_CLIFF_QST)).toBe(true);
  });

  // TODO(M13): the player's activation does not reach the activate children; only a script's
  // Activate runs them (ScriptRuntime.activate). The engine activates them for both.
  it.fails('activates the lever’s activate child, the gate, by the lever', () => {
    const sent = sim.scriptEvents({ event: 'OnActivate', target: GATE, since: activatedAt });
    expect(sent.map((event) => event.args)).toContainEqual([{ form: LEVER }]);
  });

  // TODO(M13): as above (the gate only opens when someone walks through it).
  it.fails('opens the gate as its parent is activated (open state, TESOpenCloseEvent)', () => {
    expect(sim.events('openClose')).toContainEqual({ reference: GATE, actor: LEVER, opened: true });
    expect([OPEN, OPENING]).toContain(sim.openState(GATE));
  });

  it.todo(
    'activates a child after its XAPR delay, in the game’s real seconds (6,527 vanilla pairs, ' +
      '1,626 with a delay: tools/activate-children-audit.ts)',
  );
  it.todo(
    'sends OnActivate to a reference whose activation a script blocks (BlockActivation) without ' +
      'its default action (Creation Kit, ObjectReference.BlockActivation)',
  );
  it.todo(
    'opens and closes doors by their open and close sequences with OnOpen and OnClose for ' +
      'containers too (engine map: Script events, OnOpen/OnClose)',
  );
});
