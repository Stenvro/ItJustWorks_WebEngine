// Conformance: the scripts' events (engine map: Scripting > Script events). Every event a
// vanilla script handles, when the original sends it, with which arguments and to whom; the
// interaction cases run in the headless simulation, the data case counts the load order's
// scripts that wait for each event. Skipped without game data.
//
// Sources:
// - The base scripts' declarations (Form, ObjectReference, Actor, Quest, Alias, ReferenceAlias,
//   ActiveMagicEffect .pex): each event's name and arguments; `node tools/script-events.ts`.
// - The Creation Kit's event pages (ObjectReference, Actor, ActiveMagicEffect, Form scripts):
//   when each is sent. An event about a reference goes to its scripts, the aliases holding it
//   and, for an actor, the scripts of the magic effects on it (Creation Kit, "ActiveMagicEffect
//   Script": "events received by the actor are also received by the effect").
// - The engine's event sources (CommonLibSSE ScriptEventSourceHolder: TESActivateEvent, ...;
//   observed in the original: one script event sink per source, docs/scripting.md "The scripts' events").
//
// The activation cases, from the data (Skyrim.esm; BlindCliffCave01 [000152B7]):
// - The lever [00077C50] (ACTI NorPullChain01) carries TrapLever, NorLever01SCRIPT and
//   defaultsetStageActSCRIPT { myQuest = dunBlindCliffQST [00039B3B], stage = 20 }; the script
//   sets its stage on OnActivate by the player (requirePlayerActivation's default).
// - The gate [000689C1] (DOOR MetalCageLongGate01) names the lever as its activate parent (XAPR,
//   delay 1 s) and is "Parent Activate Only" (XAPD 1): activating a reference activates its
//   children, by it, after their delays (Creation Kit, Reference > Activate Parents); only its
//   parents activate such a child.
// - A door activated opens: its open state goes to opening (2), then open (1) (GetOpenState),
//   and the engine's open event (TESOpenCloseEvent) names who opened it.
// - A blocked reference does not pass its activation on: the traps' triggers (TrapTriggerBase)
//   unblock themselves, activate themselves and block again to set off their children.

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptRuntime,
  type LivePlacement,
  type WorldBridge,
} from '../../../src/scripting/runtime/runtime.ts';
import { SCRIPT_EVENTS } from '../../../src/scripting/runtime/script-events.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import type { Value } from '../../../src/scripting/values.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage, type ScriptEventUsage } from '../../../tools/script-event-usage.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BLIND_CLIFF_CAVE = 0x152b7;
const LEVER = 0x77c50;
const GATE = 0x689c1;
/** The gate's XAPR delay (seconds). */
const GATE_DELAY = 1;
const DUN_BLIND_CLIFF_QST = 0x39b3b;
const LEVER_STAGE = 20;
/** GetOpenState: 1 open, 2 opening, 3 closed, 4 closing. */
const OPEN = 1;
const OPENING = 2;
const CLOSED = 3;
const CLOSING = 4;

describe.skipIf(!hasGamedata())('activation through the scripts (headless simulation)', () => {
  let sim: Sim;
  let activatedAt = 0;
  let activated = false;
  /** Whether the player's crosshair could activate the gate (it is Parent Activate Only). */
  let gateByPlayer = true;
  /** Whether stage 20 was done before the lever (the cave's entrance trigger sets 10). */
  let doneBefore = true;

  beforeAll(async () => {
    sim = await openSim({ interior: BLIND_CLIFF_CAVE, hour: 12 });
    await sim.step(1);
    doneBefore = sim.stageDone(DUN_BLIND_CLIFF_QST, LEVER_STAGE);
    gateByPlayer = sim.activate(GATE);
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

  it('activates the lever’s activate child, the gate, by the lever', () => {
    const sent = sim.scriptEvents({ event: 'OnActivate', target: GATE, since: activatedAt });
    expect(sent.map((event) => event.args)).toContainEqual([{ form: LEVER }]);
  });

  it('activates the child after its XAPR delay (1 s), not before', () => {
    const sent = sim.scriptEvents({ event: 'OnActivate', target: GATE, since: activatedAt });
    expect(sent[0]?.at).toBeGreaterThanOrEqual(activatedAt + GATE_DELAY - 0.05);
  });

  it('opens the gate as its parent is activated (open state, TESOpenCloseEvent)', () => {
    expect(sim.events('openClose')).toContainEqual({ reference: GATE, actor: LEVER, opened: true });
    expect([OPEN, OPENING]).toContain(sim.openState(GATE));
  });

  it('sends the gate OnOpen(akActionRef = the lever) at the end of its swing', () => {
    const sent = sim.scriptEvents({ event: 'OnOpen', target: GATE, since: activatedAt });
    expect(sent.map((event) => event.args)).toEqual([[{ form: LEVER }]]);
  });

  it('offers a Parent Activate Only child to no one but its parents (the crosshair: none)', () => {
    expect(gateByPlayer).toBe(false);
    // No actor walking by opened it before the lever (an actor opens doors by activating them).
    const before = sim
      .events('openClose')
      .filter((event) => event.reference === GATE && event.actor !== LEVER);
    expect(before).toEqual([]);
  });
});

// The same cave, the lever's and the gate's activation blocked by a script and the gate
// activated by scripts' Activate:
// - ObjectReference.BlockActivation (Creation Kit): "the OnActivate event still fires", the
//   default processing does not; a blocked reference passes nothing on to its activate children
//   (TrapTriggerBase unblocks itself, activates itself and blocks again to set off its
//   children). defaultsetStageActSCRIPT sets its stage in OnActivate, so the blocked lever
//   still sets stage 20.
// - A Parent Activate Only reference takes a script's Activate from its parent and from itself:
//   the vanilla scripts that activate such a reference name its parent (highGateRuinsLeverPuzzle
//   passes its openMarker property, the trap door's parent, to a door with no scripts) or the
//   reference itself (DLC2ApoBook3SeekerDoorScript's CheckDead: `self.Activate(self)` on three
//   Parent Activate Only seeker gates of DLC2Book03Dungeon; TrapTriggerBase on Parent Activate
//   Only trap linkers). By another (the player here) it is taken too: inferred, TODO(M13)
//   (docs/scripting.md "Activation").
describe.skipIf(!hasGamedata())('blocked and taken activation (headless simulation)', () => {
  let sim: Sim;
  let blockedAt = 0;
  let gateBlockedAt = 0;
  let byParentBlocked: unknown;
  let gateStateBlocked = 0;
  let byParentAt = 0;
  let byParent: unknown;
  let gateStateByParent = 0;
  let bySelfAt = 0;
  let bySelf: unknown;
  let gateStateBySelf = 0;
  let byPlayerAt = 0;
  let byPlayer: unknown;
  let gateStateClosed = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BLIND_CLIFF_CAVE, hour: 12 });
    await sim.step(1);
    const handle = (reference: number) => sim.runtime.referenceHandle(reference);
    const activate = (activator: number) =>
      sim.native(handle(GATE), 'ObjectReference', 'Activate', [handle(activator), false]);
    const block = (reference: number, blocked: boolean) =>
      sim.native(handle(reference), 'ObjectReference', 'BlockActivation', [blocked]);
    gateStateClosed = sim.openState(GATE);
    // The player pulls the lever while a script blocks its activation.
    await block(LEVER, true);
    blockedAt = sim.time;
    sim.activate(LEVER);
    await sim.step(GATE_DELAY + 2);
    // The gate's own activation blocked: its parent's Activate reaches its scripts only.
    await block(GATE, true);
    gateBlockedAt = sim.time;
    byParentBlocked = await activate(LEVER);
    await sim.step(2);
    gateStateBlocked = sim.openState(GATE);
    await block(GATE, false);
    byParentAt = sim.time;
    byParent = await activate(LEVER);
    await sim.step(3);
    gateStateByParent = sim.openState(GATE);
    // The gate activates itself (self.Activate(self), as the seeker gates do): it swings shut.
    bySelfAt = sim.time;
    bySelf = await activate(GATE);
    await sim.step(3);
    gateStateBySelf = sim.openState(GATE);
    // A script has the player activate the gate (neither its parent nor itself): it opens.
    byPlayerAt = sim.time;
    byPlayer = await activate(PLAYER_REF);
    await sim.step(3);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  const onActivate = (target: number, since: number, until = Infinity) =>
    sim
      .scriptEvents({ event: 'OnActivate', target, since })
      .filter((event) => event.at < until && event.alias === undefined)
      .map((event) => event.args);
  const gateOpened = (since: number, until = Infinity) =>
    sim
      .records(since)
      .filter(
        (record) =>
          record.kind === 'game' &&
          record.type === 'openClose' &&
          record.at < until &&
          record.event.reference === GATE,
      );

  it(
    'sends OnActivate to a reference whose activation a script blocks (BlockActivation) without ' +
      'its default action or its children (CK, ObjectReference.BlockActivation; TrapTriggerBase)',
    () => {
      expect(onActivate(LEVER, blockedAt, gateBlockedAt)).toEqual([[{ form: PLAYER_REF }]]);
      // Its OnActivate ran its scripts: defaultsetStageActSCRIPT set the stage.
      expect(sim.stageDone(DUN_BLIND_CLIFF_QST, LEVER_STAGE)).toBe(true);
      // No child: the gate got nothing and stayed shut.
      expect(onActivate(GATE, blockedAt, gateBlockedAt)).toEqual([]);
      expect(gateOpened(blockedAt, gateBlockedAt)).toEqual([]);
      // A blocked door gets OnActivate from its parent but does not swing.
      expect(byParentBlocked).toBe(true);
      expect(onActivate(GATE, gateBlockedAt, byParentAt)).toEqual([[{ form: LEVER }]]);
      expect(gateOpened(gateBlockedAt, byParentAt)).toEqual([]);
      expect(gateStateBlocked).toBe(gateStateClosed);
    },
  );

  it('takes a script’s Activate on a Parent Activate Only reference by its parent', () => {
    expect(byParent).toBe(true);
    expect(onActivate(GATE, byParentAt, bySelfAt)).toEqual([[{ form: LEVER }]]);
    expect(sim.events('openClose')).toContainEqual({
      reference: GATE,
      actor: LEVER,
      opened: true,
    });
    expect([OPEN, OPENING]).toContain(gateStateByParent);
  });

  it(
    'takes a script’s Activate on a Parent Activate Only reference by itself ' +
      '(DLC2ApoBook3SeekerDoorScript, TrapTriggerBase: self.Activate(self))',
    () => {
      expect(bySelf).toBe(true);
      expect(onActivate(GATE, bySelfAt, byPlayerAt)).toEqual([[{ form: GATE }]]);
      expect(sim.events('openClose')).toContainEqual({
        reference: GATE,
        actor: GATE,
        opened: false,
      });
      expect([CLOSED, CLOSING]).toContain(gateStateBySelf);
    },
  );

  it(
    'takes a script’s Activate on a Parent Activate Only reference by one that is neither its ' +
      'parent nor itself (inferred: TODO(M13))',
    () => {
      expect(byPlayer).toBe(true);
      expect(onActivate(GATE, byPlayerAt)).toEqual([[{ form: PLAYER_REF }]]);
      expect(sim.events('openClose')).toContainEqual({
        reference: GATE,
        actor: PLAYER_REF,
        opened: true,
      });
      expect([OPEN, OPENING]).toContain(sim.openState(GATE));
    },
  );
});

// A town inn in the morning: its cell attaches and loads, its actors run their packages and sit,
// the player takes and equips an item, a wolf placed by them is struck by a spell and dies, and
// the player leaves for another inn. Expected values from the base scripts' declarations and
// the Creation Kit's event pages (each case names its event):
// - OnCellAttach: "the object's parent cell is attached"; OnLoad: "this object's 3d is loaded";
//   OnCellLoad: "every object in this object's parent cell is loaded" (sent once its cell's 3D
//   is in, after the other two); OnUnload, OnCellDetach as it goes.
// - OnLocationChange(akOldLoc, akNewLoc): to an actor entering another location.
// - OnPackageStart(akNewPackage): to an actor whose package starts.
// - OnSit(akFurniture): to an actor that sits in furniture.
// - OnItemAdded(akBaseItem, aiItemCount, akItemReference, akSourceContainer): to the container
//   an item went into; OnObjectEquipped(akBaseObject, akReference): to the actor that equipped.
// - OnHit(akAggressor, akSource, akProjectile, abPowerAttack, abSneakAttack, abBashAttack,
//   abHitBlocked): to what a hostile spell struck; OnMagicEffectApply(akCaster, akEffect).
// - OnDying(akKiller), then OnDeath(akKiller): to the actor killed.

/** The Bannered Mare (interior CELL), its location, the Sleeping Giant Inn and its location. */
const BANNERED_MARE = 0x1605e;
const BANNERED_MARE_LOCATION = 0x1f86d;
const SLEEPING_GIANT_INN = 0x133c6;
const SLEEPING_GIANT_INN_LOCATION = 0x1cb8c;

describe.skipIf(!hasGamedata())('the world’s events to the scripts (headless simulation)', () => {
  let sim: Sim;
  let opened = 0;
  let took = 0;
  let struck = 0;
  let left = 0;
  let wolf = 0;
  let dagger = 0;
  let firebolt = 0;
  /** The references of the inn that got OnLoad (its scripted objects and actors). */
  let loaded = new Set<number>();

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    opened = sim.time;
    await sim.openInterior(BANNERED_MARE);
    await sim.step(3);
    loaded = new Set(
      sim
        .scriptEvents({ event: 'OnLoad', since: opened })
        .filter((event) => event.alias === undefined)
        .map((event) => event.target),
    );
    took = sim.time;
    dagger = await sim.formId('WEAP', 'IronDagger');
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(dagger), 1, true);
    await sim.equip(dagger);
    await sim.step(0.5);
    // The wolf dies of the spell at once: a live fight in the inn is not part of this case.
    struck = sim.time;
    wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    firebolt = await sim.formId('SPEL', 'Firebolt');
    await sim.cast(firebolt, wolf);
    await sim.step(1.5);
    // Its scripts hear OnDeath as its dying ends (fDyingTimer after the kill: src/world/dying.ts),
    // here before the player leaves (leaving would end the dying too).
    await sim.until(
      () => sim.scriptEvents({ event: 'OnDeath', target: wolf, since: struck }).length > 0,
      5,
    );
    left = sim.time;
    await sim.openInterior(SLEEPING_GIANT_INN);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  /** The events sent to a reference's own scripts (not to the aliases holding it). */
  const sent = (event: string, target?: number, since = 0, until = Infinity) =>
    sim
      .scriptEvents({ event, ...(target !== undefined && { target }), since })
      .filter((record) => record.at < until && record.alias === undefined);

  it('sends OnCellAttach, OnLoad and OnCellLoad to the inn’s scripted references', () => {
    expect(loaded.size).toBeGreaterThan(0);
    for (const reference of loaded) {
      expect(sent('OnCellAttach', reference, opened, took)).toHaveLength(1);
      expect(sent('OnCellLoad', reference, opened, took)).toHaveLength(1);
    }
  });

  it('sends OnCellAttach before OnLoad, and OnCellLoad last', () => {
    for (const reference of loaded) {
      const attach = sent('OnCellAttach', reference, opened, took)[0]?.at ?? Infinity;
      const load = sent('OnLoad', reference, opened, took)[0]?.at ?? -Infinity;
      const cellLoad = sent('OnCellLoad', reference, opened, took)[0]?.at ?? -Infinity;
      expect(attach).toBeLessThanOrEqual(load);
      expect(load).toBeLessThanOrEqual(cellLoad);
    }
  });

  it('sends OnUnload and OnCellDetach to them as the player leaves the cell', () => {
    for (const reference of loaded) {
      if (reference === PLAYER_REF || reference === wolf) continue;
      expect(sent('OnUnload', reference, left)).toHaveLength(1);
      expect(sent('OnCellDetach', reference, left)).toHaveLength(1);
    }
  });

  it('sends the player OnLocationChange(old, new) for each location entered', () => {
    const changes = sent('OnLocationChange', PLAYER_REF, opened).map((event) => event.args);
    expect(changes.map((args) => args[1])).toContainEqual({ form: BANNERED_MARE_LOCATION });
    expect(changes).toContainEqual([
      { form: BANNERED_MARE_LOCATION },
      { form: SLEEPING_GIANT_INN_LOCATION },
    ]);
  });

  it('sends each actor OnPackageStart(the package) as its package starts (TESPackageEvent)', () => {
    const starts = sim.packages().filter((event) => event.type === 'start' && event.package);
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(sent('OnPackageStart', start.actor).map((event) => event.args)).toContainEqual([
        { form: start.package },
      ]);
    }
  });

  it('sends an actor OnSit(the furniture) as it sits', () => {
    const sits = sent('OnSit', undefined, opened, left);
    expect(sits.length).toBeGreaterThan(0);
    for (const sit of sits) expect(sit.args).toEqual([{ form: expect.any(Number) as number }]);
  });

  it('sends OnActivate(akActionRef = the actor) to the furniture an actor’s AI goes to use', () => {
    const sits = sent('OnSit', undefined, opened, left).filter((sit) => sit.target !== PLAYER_REF);
    expect(sits.length).toBeGreaterThan(0);
    for (const sit of sits) {
      const [furniture] = sit.args;
      const chair = (furniture as { form: number }).form;
      const activations = sent('OnActivate', chair, opened, sit.at + 1e-6).map((e) => e.args);
      expect(activations).toContainEqual([{ form: sit.target }]);
    }
  });

  it('sends the player OnItemAdded(item, 1, None, None) for an item added from nowhere', () => {
    expect(sent('OnItemAdded', PLAYER_REF, took, struck).map((event) => event.args)).toEqual([
      [{ form: dagger }, 1, null, null],
    ]);
  });

  it('sends the player OnObjectEquipped(item, None) as they equip it', () => {
    expect(sent('OnObjectEquipped', PLAYER_REF, took, struck).map((event) => event.args)).toEqual([
      [{ form: dagger }, null],
    ]);
  });

  it('sends the wolf OnHit(the player, the spell, ...) as a hostile spell strikes it', () => {
    const hits = sent('OnHit', wolf, struck);
    expect(hits).toHaveLength(1);
    const [aggressor, source, , power, sneak, bash, blocked] = hits[0]?.args ?? [];
    expect([aggressor, source]).toEqual([{ form: PLAYER_REF }, { form: firebolt }]);
    expect([power, sneak, bash, blocked]).toEqual([false, false, false, false]);
  });

  it('sends the wolf OnMagicEffectApply(the player, the effect) for the spell’s effect', () => {
    const applied = sent('OnMagicEffectApply', wolf, struck);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]?.args[0]).toEqual({ form: PLAYER_REF });
  });

  it('sends the wolf OnDying(the player), then OnDeath(the player) (TESDeathEvent)', () => {
    const dying = sent('OnDying', wolf, struck);
    const death = sent('OnDeath', wolf, struck);
    expect(dying.map((event) => event.args)).toEqual([[{ form: PLAYER_REF }]]);
    expect(death.map((event) => event.args)).toEqual([[{ form: PLAYER_REF }]]);
    expect(dying[0]?.at ?? Infinity).toBeLessThanOrEqual(death[0]?.at ?? -Infinity);
  });
});

// Mercer Frey's house (Riften), from the data: a plain trigger box [00094027] (L_TRIGGER) the
// player arrives in, and in the cellar a spear trap [00050C22] (TrapSpear01, its hits told
// to its scripts: tests/conformance/physics/traps.test.ts). An item lying in the Bannered Mare
// (its first MISC reference) is out of the attached area until a script moves it to the player
// and back (MoveTo, MoveToMyEditorLocation); others are moved as a script moves the player out
// and down and they come back by themselves (below). Expected, from the Creation Kit's event
// pages and the base scripts' declarations:
// - OnTriggerEnter(akActionRef), OnTrigger(akActionRef) again each fTriggerEventDelayMS (500 ms)
//   while it stays inside, OnTriggerLeave(akActionRef) as it leaves: to the trigger.
// - OnTrapHitStart, then OnTrapHit while the trap keeps touching a living actor, OnTrapHitStop
//   (akTarget) as the contact ends: to the trap (the spear's contact as the player lands is
//   short of the hits' delay: OnTrapHit is the spike bed's case below).
// - OnAttachedToCell / OnDetachedFromCell: to a reference moved into or out of the attached
//   area by itself (TESMoveAttachDetachEvent), not with its cell.
const MERCER_FREY_HOUSE = 0x37cc6;
const TRIGGER_BOX = 0x94027;
const IN_THE_BOX: [number, number, number] = [-1026, 1346, -60];
const SPEAR_TRAP = 0x50c22;
const ON_THE_TRAP: [number, number, number] = [-2371.1, 2148.9, -814.6];
// The house's front door outside [0004227E] (its load door's XTEL: in RiftenWorld [00016BB4],
// persistent, so in the worldspace's persistent cell [00016BE0], not the grid cell the world
// shows the player in) and its cellar's door into RiftenRatway02 [000A1BFD] ([00052A8C]),
// with three more items lying in the Bannered Mare.
const RIFTEN_WORLD = 0x16bb4;
const FRONT_DOOR = 0x4227e;
const RIFTEN_RATWAY = 0xa1bfd;
const RATWAY_DOOR = 0x52a8c;
const SENT_OUT = 0x6170d;
const LEFT_OUT = 0x6170c;
const BROUGHT_UP = 0x6170b;

describe.skipIf(!hasGamedata())('triggers, traps and moves (headless simulation)', () => {
  let sim: Sim;
  let arrived = 0;
  let left = 0;
  let offTheTrap = 0;
  let movedIn = 0;
  let movedOut = 0;
  let item = 0;
  let sentOut = 0;
  /** The cell the world showed the player in as the item followed them out. */
  let shownAsSent: number | undefined;
  let outside = false;
  let cameIn = 0;
  let leftOut = 0;
  let sentDown = 0;
  let down = false;
  let cameUp = 0;
  let broughtUp = 0;

  const handle = (reference: number) => sim.runtime.referenceHandle(reference);
  /** MoveTo called as a script calls it: its work waits in the frame's post-render queue. */
  const moveTo = (target: number, to: number): Promise<unknown> => {
    const native = sim.runtime.native('objectreference', 'moveto');
    if (!native) throw new Error('No native ObjectReference.MoveTo');
    const args: Value[] = [handle(to), 0, 0, 0, true];
    return Promise.resolve(
      native({
        vm: sim.runtime.vm,
        self: handle(target),
        args,
        name: 'objectreference.moveto',
        latent: (promise) => promise,
        where: () => '',
      }),
    );
  };
  /** Calls made together (in one frame's queue), the world stepping until all are done. */
  const together = async (...calls: Promise<unknown>[]) => {
    let done = false;
    void Promise.allSettled(calls).then(() => {
      done = true;
    });
    await sim.until(() => done, 30);
  };
  /** Where the world shows the player. */
  const shownIn = () => sim.runtime.world.livePlacement?.(PLAYER_REF);

  beforeAll(async () => {
    sim = await openSim({
      interior: MERCER_FREY_HOUSE,
      hour: 10,
      arrival: { position: IN_THE_BOX, heading: 0 },
    });
    arrived = 0;
    await sim.step(1.5);
    // A script brings an item from the Bannered Mare (MoveTo the player), then sends it back.
    for (const reference of sim.db.cellReferences(BANNERED_MARE)) {
      const base = await sim.runtime.baseOf(reference);
      if (base !== undefined && (await sim.db.get(base))?.type === 'MISC') {
        item = reference;
        break;
      }
    }
    movedIn = sim.time;
    await sim.native(handle(item), 'ObjectReference', 'MoveTo', [
      handle(PLAYER_REF),
      0,
      0,
      0,
      true,
    ]);
    await sim.step(1);
    movedOut = sim.time;
    await sim.native(handle(item), 'ObjectReference', 'MoveToMyEditorLocation', []);
    await sim.step(1);
    // The player goes down to the spear trap and stands on it, then comes back up.
    left = sim.time;
    await sim.moveTo(ON_THE_TRAP);
    await sim.step(3);
    offTheTrap = sim.time;
    await sim.moveTo(IN_THE_BOX);
    await sim.step(1.5);
    // A script sends the player out to the house's front door in Riften and, in the same frame's
    // queue (before the world has taken them there), an item to it too.
    sentOut = sim.time;
    const door = await sim.runtime.placement(FRONT_DOOR);
    if (door) {
      // As MoveTo's work moves them (ScriptRuntime.move), back to back in one queue run: the
      // world has not reacted to the player's move yet as the item moves.
      for (const reference of [PLAYER_REF, SENT_OUT])
        sim.runtime.move(reference, [...door.position], [...door.rotation], door.cell, door.world);
      shownAsSent = shownIn()?.cell;
    }
    outside = await sim.until(() => shownIn()?.world === RIFTEN_WORLD, 30);
    await sim.step(1);
    // They come back in by themselves (as through the door: no script moves them), and a
    // script moves another item out to the front door, then to the player.
    cameIn = sim.time;
    await sim.openInterior(MERCER_FREY_HOUSE, { position: IN_THE_BOX, heading: 0 });
    await sim.step(1);
    await together(moveTo(LEFT_OUT, FRONT_DOOR));
    await sim.step(0.5);
    leftOut = sim.time;
    await together(moveTo(LEFT_OUT, PLAYER_REF));
    await sim.step(0.5);
    // A script sends the player down into the Ratway; they come back up before any other
    // reference moves, and a script brings a third item to them.
    sentDown = sim.time;
    await together(moveTo(PLAYER_REF, RATWAY_DOOR));
    down = await sim.until(() => shownIn()?.cell === RIFTEN_RATWAY, 30);
    await sim.step(1);
    cameUp = sim.time;
    await sim.openInterior(MERCER_FREY_HOUSE, { position: IN_THE_BOX, heading: 0 });
    await sim.step(1);
    broughtUp = sim.time;
    await together(moveTo(BROUGHT_UP, PLAYER_REF));
    await sim.step(0.5);
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  const sent = (event: string, target: number, since = 0, until = Infinity) =>
    sim
      .scriptEvents({ event, target, since })
      .filter((record) => record.at < until && record.alias === undefined);

  /** What the player set off: events whose akActionRef is the player. */
  const byPlayer = (records: ReturnType<typeof sent>) =>
    records.filter(
      (record) => JSON.stringify(record.args[0]) === JSON.stringify({ form: PLAYER_REF }),
    );

  it('sends a trigger OnTriggerEnter(the player) as they come into it (with its cell)', () => {
    expect(byPlayer(sent('OnTriggerEnter', TRIGGER_BOX, arrived, left))).toHaveLength(1);
    expect(sent('OnTriggerEnter', TRIGGER_BOX, arrived, movedIn).map((e) => e.args)).toEqual([
      [{ form: PLAYER_REF }],
    ]);
  });

  it('sends it OnTrigger(the player) again each fTriggerEventDelayMS (500 ms) while they stay', () => {
    const told = byPlayer(sent('OnTrigger', TRIGGER_BOX, arrived, left));
    // 1.5 s, then 2 more inside: at least five tellings, half a second or more apart.
    expect(told.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < told.length; i++) {
      expect((told[i]?.at ?? 0) - (told[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(0.5 - 1e-6);
    }
  });

  it('sends it OnTriggerLeave(the player) as they leave, and OnTrigger no more', () => {
    const leaves = byPlayer(sent('OnTriggerLeave', TRIGGER_BOX, left, offTheTrap));
    expect(leaves.map((e) => e.args)).toEqual([[{ form: PLAYER_REF }]]);
    const leftAt = leaves[0]?.at ?? Infinity;
    expect(byPlayer(sent('OnTrigger', TRIGGER_BOX, leftAt + 1e-6, offTheTrap))).toEqual([]);
  });

  it('sends the trap OnTrapHitStop(the player) as its contact with them ends', () => {
    // The contact as the player lands on the trap is short (shorter than the hits' delay:
    // OnTrapHit, a lasting contact, is the spike bed's case below).
    const start = sent('OnTrapHitStart', SPEAR_TRAP, left, offTheTrap);
    expect(start.length).toBeGreaterThan(0);
    const stops = sent('OnTrapHitStop', SPEAR_TRAP, left);
    expect(stops.map((e) => e.args)).toContainEqual([{ form: PLAYER_REF }]);
    // The stop comes after the start and every hit.
    const stop = stops.at(-1)?.at ?? -Infinity;
    const hits = sent('OnTrapHit', SPEAR_TRAP, left);
    for (const event of [...start, ...hits]) expect(event.at).toBeLessThanOrEqual(stop);
  });

  it('sends an item OnAttachedToCell as a script moves it into the attached area', () => {
    expect(item).not.toBe(0);
    expect(sent('OnAttachedToCell', item, movedIn, movedOut)).toHaveLength(1);
    expect(sent('OnDetachedFromCell', item, movedIn, movedOut)).toEqual([]);
  });

  it('sends it OnDetachedFromCell as a script moves it back out of it', () => {
    expect(sent('OnDetachedFromCell', item, movedOut, left)).toHaveLength(1);
    expect(sent('OnAttachedToCell', item, movedOut, left)).toEqual([]);
  });

  it('reads the area round where a script just sent the player, before the world takes them', () => {
    expect(outside).toBe(true);
    // Sent to the front door with the player while the world still showed them inside.
    expect(shownAsSent).toBe(MERCER_FREY_HOUSE);
    expect(sent('OnAttachedToCell', SENT_OUT, sentOut, cameIn)).toHaveLength(1);
    expect(sent('OnDetachedFromCell', SENT_OUT, sentOut, cameIn)).toEqual([]);
  });

  it('reads it round where the world shows them once they arrive outside and come back in', () => {
    // Back inside by the door: the front door is out of the area, the player in it.
    expect(sent('OnAttachedToCell', LEFT_OUT, cameIn, leftOut)).toEqual([]);
    expect(sent('OnAttachedToCell', LEFT_OUT, leftOut, sentDown)).toHaveLength(1);
    expect(sent('OnDetachedFromCell', LEFT_OUT, cameIn, sentDown)).toEqual([]);
  });

  it('reads it round where they are after leaving an interior a script sent them to', () => {
    expect(down).toBe(true);
    expect(sent('OnAttachedToCell', BROUGHT_UP, cameUp, broughtUp)).toEqual([]);
    expect(sent('OnAttachedToCell', BROUGHT_UP, broughtUp)).toHaveLength(1);
  });
});

// The trap test hall (WarehouseTraps [000243DF]), from the data: a bed of wooden spikes
// [0001F863] (TrapWoodSpikeBed01, meshes\traps\norplatformtrap: its spikes static, over them a
// phantom box on L_TRAP the one who lies on them is in) the player falls onto and stays on,
// then is taken off. Expected, from the Creation Kit's ObjectReference event pages and the base
// scripts' declarations: OnTrapHitStart as the trap first touches them, OnTrapHit again while
// it keeps touching (each fTrapHitEventDelayMS, 500 ms), OnTrapHitStop(akTarget) as the contact
// ends: to the trap.
const WAREHOUSE_TRAPS = 0x243df;
const SPIKE_BED = 0x1f863;

describe.skipIf(!hasGamedata())('a spike bed the player lies on (headless simulation)', () => {
  let sim: Sim;
  let onIt = 0;
  let offIt = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: WAREHOUSE_TRAPS, hour: 10 });
    await sim.step(0.5);
    const at = await sim.position(SPIKE_BED);
    if (!at) return;
    onIt = sim.time;
    await sim.moveTo([at[0], at[1], at[2] + 48]);
    await sim.step(3);
    offIt = sim.time;
    await sim.moveTo([at[0], at[1] + 400, at[2] + 48]);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  const sent = (event: string, since = 0, until = Infinity) =>
    sim
      .scriptEvents({ event, target: SPIKE_BED, since })
      .filter((record) => record.at < until && record.alias === undefined);

  it('sends the trap OnTrapHit while it keeps touching the player, then OnTrapHitStop', () => {
    expect(onIt).toBeGreaterThan(0);
    const start = sent('OnTrapHitStart', onIt, offIt);
    expect(start.map((e) => e.args[0])).toEqual([{ form: PLAYER_REF }]);
    const hits = sent('OnTrapHit', onIt, offIt);
    // On it 3 s: told again at least once, the delay or more apart.
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      // As OnTrapHitStart: the target, its velocity and position, the material, the flags.
      expect(hit.args[0]).toEqual({ form: PLAYER_REF });
      expect(hit.args).toHaveLength(start[0]?.args.length ?? 0);
    }
    const times = [...start, ...hits].map((e) => e.at);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(0.5 - 1e-6);
    }
    const stops = sent('OnTrapHitStop', onIt);
    expect(stops.map((e) => e.args)).toEqual([[{ form: PLAYER_REF }]]);
    for (const at of times) expect(at).toBeLessThanOrEqual(stops[0]?.at ?? -Infinity);
  });
});

// The attached area round the player in the script runtime alone, the world's view of the player
// set frame by frame (WorldBridge.livePlacement): the cases above, with the world's part fixed.
// Outside, the world shows the player in the grid cell they stand in (RiftenWorld's [00042247]
// at the front door), never in the worldspace's persistent cell a persistent marker reads as in.
const DOOR_GRID_CELL = 0x42247;

describe.skipIf(!hasGamedata())('the attached area round the player (data, the runtime)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  let shown: LivePlacement | undefined;
  const told: { reference: number; attached: boolean }[] = [];
  const world: WorldBridge = {
    livePlacement: (reference) => (reference === PLAYER_REF ? shown : undefined),
  };
  const inside: LivePlacement = {
    position: IN_THE_BOX,
    rotation: [0, 0, 0],
    cell: MERCER_FREY_HOUSE,
  };
  /** A frame: the runtime's update, then its detached work (record reads) done. */
  const frame = async () => {
    runtime.update(1 / 60, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  const moveTo = async (reference: number, target: number) => {
    const at = await runtime.placement(target);
    if (!at) throw new Error(`No place for ${target.toString(16)}`);
    runtime.move(reference, [...at.position], [...at.rotation], at.cell, at.world);
    return at;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library, { world });
    runtime.events.on('moveAttachDetach', (event) => {
      told.push(event);
    });
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const toldOf = (reference: number) =>
    told.filter((event) => event.reference === reference).map((event) => event.attached);

  it('reads it round the front door a script sent the player to until the world shows them there', async () => {
    shown = inside;
    await frame();
    expect(db.cellOfReference(FRONT_DOOR)).not.toBe(DOOR_GRID_CELL);
    expect(db.worldOfCell(DOOR_GRID_CELL)).toBe(RIFTEN_WORLD);
    const door = await moveTo(PLAYER_REF, FRONT_DOOR);
    // Before the world has taken the player out: an item sent to the door is with them.
    await moveTo(SENT_OUT, FRONT_DOOR);
    await frame();
    expect(toldOf(SENT_OUT)).toEqual([true]);
    // The world shows them outside, in the door's grid cell; then they come back in by the door.
    shown = {
      position: door.position,
      rotation: [0, 0, 0],
      world: RIFTEN_WORLD,
      cell: DOOR_GRID_CELL,
    };
    await frame();
    shown = inside;
    await frame();
    // The front door is out of the area round them now; the player's own place is in it.
    await moveTo(LEFT_OUT, FRONT_DOOR);
    await frame();
    expect(toldOf(LEFT_OUT)).toEqual([]);
    await moveTo(LEFT_OUT, PLAYER_REF);
    await frame();
    expect(toldOf(LEFT_OUT)).toEqual([true]);
  });

  it('reads it round where they are once they have left an interior a script sent them to', async () => {
    shown = inside;
    await frame();
    const down = await moveTo(PLAYER_REF, RATWAY_DOOR);
    expect(down.cell).toBe(RIFTEN_RATWAY);
    // The world takes them down, and they come back up before anything else moves.
    shown = { position: down.position, rotation: [0, 0, 0], cell: RIFTEN_RATWAY };
    await frame();
    shown = inside;
    await frame();
    runtime.move(BROUGHT_UP, [...IN_THE_BOX], [0, 0, 0], MERCER_FREY_HOUSE, undefined);
    await frame();
    expect(toldOf(BROUGHT_UP)).toEqual([true]);
  });
});

// Breezehome (Whiterun), from the data: the player sits in one of its chairs and gets up
// (OnSit, then OnGetUp(akFurniture) to the actor: TESFurnitureEvent).
const BREEZEHOME = 0x165a8;

describe.skipIf(!hasGamedata())('getting up from furniture (headless simulation)', () => {
  let sim: Sim;
  let chair = 0;
  let sat = false;
  let gotUp = false;

  beforeAll(async () => {
    sim = await openSim({ interior: BREEZEHOME, hour: 12 });
    await sim.step(1);
    const seat = sim.world
      .placedObjects()
      .find(({ object }) => object.furniture?.sit === true && object.baseType === 'FURN');
    chair = seat?.object.reference ?? 0;
    if (chair !== 0 && sim.activate(chair)) {
      sat = await sim.until(
        () => sim.scriptEvents({ event: 'OnSit', target: PLAYER_REF }).length > 0,
        10,
      );
      sim.press('Forward', true);
      gotUp = await sim.until(
        () => sim.scriptEvents({ event: 'OnGetUp', target: PLAYER_REF }).length > 0,
        10,
      );
      sim.press('Forward', false);
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('sends the player OnGetUp(the chair) as they get up from it, after OnSit(the chair)', () => {
    expect(chair).not.toBe(0);
    expect(sat).toBe(true);
    expect(gotUp).toBe(true);
    const sits = sim.scriptEvents({ event: 'OnSit', target: PLAYER_REF });
    const ups = sim.scriptEvents({ event: 'OnGetUp', target: PLAYER_REF });
    expect(sits.filter((e) => e.alias === undefined).map((e) => e.args)).toEqual([
      [{ form: chair }],
    ]);
    expect(ups.filter((e) => e.alias === undefined).map((e) => e.args)).toEqual([
      [{ form: chair }],
    ]);
    expect(sits[0]?.at ?? Infinity).toBeLessThanOrEqual(ups[0]?.at ?? -Infinity);
  });
});

// The events vanilla scripts wait for that the cases of this suite do not cover, each checked in
// the simulation by another suite of tests/conformance (its file named): what each sends, when
// and with which arguments is written there (the Creation Kit's event pages, the base scripts'
// declarations; CommonLibSSE's event sources).
const CHECKED_ELSEWHERE: Readonly<Record<string, string>> = {
  OnUpdate: 'scripting/script-events-registered.test.ts (RegisterForSingleUpdate)',
  OnUpdateGameTime: 'scripting/script-events-registered.test.ts',
  OnInit: 'scripting/script-events-actions.test.ts (PlaceAtMe)',
  OnBeginState: 'scripting/script-events-items.test.ts (the map’s GotoState)',
  OnEndState: 'scripting/script-events-items.test.ts',
  OnEffectStart: 'scripting/script-events-items.test.ts (a potion)',
  OnEffectFinish: 'scripting/script-events-items.test.ts',
  OnContainerChanged: 'scripting/script-events-items.test.ts (the map taken)',
  OnItemRemoved: 'scripting/script-events-registered.test.ts',
  OnCombatStateChanged: 'scripting/script-events-registered.test.ts (the wolf)',
  OnAnimationEvent: 'scripting/script-events-items.test.ts (FootLeft)',
  OnAnimationEventUnregistered: 'scripting/script-events-items.test.ts',
  OnReset: 'scripting/respawn-cell-reset.test.ts',
  OnEquipped: 'scripting/script-events-items.test.ts (the sword)',
  OnUnequipped: 'scripting/script-events-items.test.ts',
  OnObjectUnequipped: 'scripting/script-events-registered.test.ts',
  OnRead: 'scripting/script-events-actions.test.ts (a book where it lies)',
  OnEnterBleedout: 'scripting/script-events-items.test.ts (Hulda, essential)',
  OnClose: 'scripting/script-events-actions.test.ts (the strongbox)',
  OnDestructionStageChanged: 'scripting/script-events-items.test.ts (the urn)',
  OnPlayerLoadGame: 'scripting/save-load.test.ts',
  OnSpellCast: 'scripting/script-events-actions.test.ts (the ward)',
  OnTrapHitStart: 'physics/traps.test.ts (the spear trap, the swinging log)',
  OnGainLOS: 'scripting/script-events-registered.test.ts',
  OnLostLOS: 'scripting/script-events-registered.test.ts',
  OnTranslationComplete: 'scripting/script-events-registered.test.ts',
  OnTranslationAlmostComplete: 'scripting/script-events-registered.test.ts',
  OnTranslationFailed: 'scripting/script-events-actions.test.ts',
  OnGrab: 'scripting/script-events-actions.test.ts (the bowl)',
  OnRelease: 'scripting/script-events-actions.test.ts',
  OnRaceSwitchComplete: 'scripting/script-events-items.test.ts (SetRace)',
  OnSleepStart: 'scripting/script-events-actions.test.ts',
  OnSleepStop: 'scripting/script-events-actions.test.ts',
  OnLockStateChanged: 'scripting/script-events-items.test.ts (the strongbox)',
  OnTrackedStatsEvent: 'scripting/script-events-registered.test.ts',
  OnWardHit: 'scripting/script-events-actions.test.ts',
  OnVampirismStateChanged: 'scripting/script-events-items.test.ts',
  OnVampireFeed: 'scripting/script-events-items.test.ts',
  OnLycanthropyStateChanged: 'scripting/script-events-items.test.ts',
  OnPackageChange: 'scripting/script-events-actions.test.ts (Carlotta at 22:00)',
  OnPackageEnd: 'scripting/script-events-registered.test.ts',
  OnPlayerFastTravelEnd: 'scripting/script-events-actions.test.ts (to Riverwood)',
  OnPlayerBowShot: 'scripting/script-events-actions.test.ts',
  OnSell: 'scripting/script-events-actions.test.ts (the apple)',
};

/** The events the cases above cover in the simulation. */
const COVERED = [
  'OnActivate',
  'OnOpen',
  'OnCellAttach',
  'OnLoad',
  'OnCellLoad',
  'OnUnload',
  'OnCellDetach',
  'OnLocationChange',
  'OnPackageStart',
  'OnSit',
  'OnItemAdded',
  'OnObjectEquipped',
  'OnHit',
  'OnMagicEffectApply',
  'OnDying',
  'OnDeath',
  'OnTriggerEnter',
  'OnTrigger',
  'OnTriggerLeave',
  'OnTrapHit',
  'OnTrapHitStop',
  'OnAttachedToCell',
  'OnDetachedFromCell',
  'OnGetUp',
];

describe('the events checked in the simulation', () => {
  it('names, for each event checked in another suite, a suite that sends it', () => {
    const suites = new URL('../', import.meta.url);
    for (const [event, where] of Object.entries(CHECKED_ELSEWHERE)) {
      const file = where.split(' ')[0] ?? '';
      const text = fs.readFileSync(new URL(file, suites), 'utf8').toLowerCase();
      expect(
        text.includes(`'${event.toLowerCase()}'`) || text.includes(event.toLowerCase()),
        event,
      ).toBe(true);
    }
    for (const event of COVERED) expect(CHECKED_ELSEWHERE[event], event).toBeUndefined();
  });
});

describe.skipIf(!hasGamedata())('the events the load order’s scripts wait for (data)', () => {
  let usage: ScriptEventUsage;
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    usage = await scriptEventUsage(vfs);
  }, 300_000);
  afterAll(async () => {
    await vfs.close();
  });

  it('counts, for each event the base scripts declare, the scripts that handle it', () => {
    const rows = [...usage.declared.keys()]
      .map((event) => ({
        event: usage.names.get(event) ?? event,
        scripts: usage.handlers.get(event)?.length ?? 0,
      }))
      .sort((a, b) => b.scripts - a.scripts);
    console.log(rows.map((row) => `${String(row.scripts).padStart(5)} ${row.event}`).join('\n'));
    const handled = rows.filter((row) => row.scripts > 0);
    // OnActivate is the most handled (the base scripts' declarations and the load order's .pex).
    expect(rows[0]?.event.toLowerCase()).toBe('onactivate');
    expect(handled.reduce((sum, row) => sum + row.scripts, 0)).toBeGreaterThan(4000);
  });

  it('lists a case for every event a base script declares (besides the story events)', () => {
    const listed = new Set(
      [...COVERED, ...Object.keys(CHECKED_ELSEWHERE)].map((e) => e.toLowerCase()),
    );
    const missing = [...usage.declared.keys()].filter(
      (event) => !event.startsWith('onstory') && !listed.has(event),
    );
    expect(missing).toEqual([]);
  });

  it('relays every hub kind to an event the base scripts declare (names and spelling)', () => {
    for (const events of Object.values(SCRIPT_EVENTS)) {
      for (const event of events) expect(usage.declared.has(event.toLowerCase())).toBe(true);
    }
  });
});
