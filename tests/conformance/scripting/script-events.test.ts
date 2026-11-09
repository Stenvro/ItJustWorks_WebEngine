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
import { SCRIPT_EVENTS } from '../../../src/scripting/runtime/script-events.ts';
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
/** GetOpenState: 1 open, 2 opening. */
const OPEN = 1;
const OPENING = 2;

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
// - A Parent Activate Only reference takes a script's Activate only from one of its activate
//   parents (inferred from the data: the vanilla scripts that activate such a reference all
//   name its parent as the activator, e.g. highGateRuinsLeverPuzzle passes its openMarker
//   property, the trap door's parent, to a door with no scripts; docs/scripting.md
//   "Activation"). Refused, it gets no OnActivate and Activate returns false.
describe.skipIf(!hasGamedata())('blocked and refused activation (headless simulation)', () => {
  let sim: Sim;
  let blockedAt = 0;
  let byPlayerAt = 0;
  let byPlayer: unknown;
  let gateBlockedAt = 0;
  let byParentBlocked: unknown;
  let gateStateBlocked = 0;
  let byParentAt = 0;
  let byParent: unknown;
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
    // A script has the player activate the gate (not its parent).
    byPlayerAt = sim.time;
    byPlayer = await activate(PLAYER_REF);
    await sim.step(2);
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
      expect(onActivate(LEVER, blockedAt, byPlayerAt)).toEqual([[{ form: PLAYER_REF }]]);
      // Its OnActivate ran its scripts: defaultsetStageActSCRIPT set the stage.
      expect(sim.stageDone(DUN_BLIND_CLIFF_QST, LEVER_STAGE)).toBe(true);
      // No child: the gate got nothing and stayed shut.
      expect(onActivate(GATE, blockedAt, byPlayerAt)).toEqual([]);
      expect(gateOpened(blockedAt, byPlayerAt)).toEqual([]);
      // A blocked door gets OnActivate from its parent but does not swing.
      expect(byParentBlocked).toBe(true);
      expect(onActivate(GATE, gateBlockedAt, byParentAt)).toEqual([[{ form: LEVER }]]);
      expect(gateOpened(gateBlockedAt, byParentAt)).toEqual([]);
      expect(gateStateBlocked).toBe(gateStateClosed);
    },
  );

  it(
    'refuses a script’s Activate on a Parent Activate Only reference by one that is not its ' +
      'parent (XAPD; inferred from the scripts that activate one: they name its parent)',
    () => {
      expect(byPlayer).toBe(false);
      expect(onActivate(GATE, byPlayerAt, gateBlockedAt)).toEqual([]);
      expect(gateOpened(byPlayerAt, gateBlockedAt)).toEqual([]);
      // Its parent's Activate is taken: the gate opens, by the lever.
      expect(byParent).toBe(true);
      expect(onActivate(GATE, byParentAt)).toEqual([[{ form: LEVER }]]);
      expect(sim.events('openClose')).toContainEqual({
        reference: GATE,
        actor: LEVER,
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
// and back (MoveTo, MoveToMyEditorLocation). Expected,
// from the Creation Kit's event pages and the base scripts' declarations:
// - OnTriggerEnter(akActionRef), OnTrigger(akActionRef) again each fTriggerEventDelayMS (500 ms)
//   while it stays inside, OnTriggerLeave(akActionRef) as it leaves: to the trigger.
// - OnTrapHitStart, then OnTrapHit while the trap keeps touching a living actor, OnTrapHitStop
//   (akTarget) as the contact ends: to the trap.
// - OnAttachedToCell / OnDetachedFromCell: to a reference moved into or out of the attached
//   area by itself (TESMoveAttachDetachEvent), not with its cell.
const MERCER_FREY_HOUSE = 0x37cc6;
const TRIGGER_BOX = 0x94027;
const IN_THE_BOX: [number, number, number] = [-1026, 1346, -60];
const SPEAR_TRAP = 0x50c22;
const ON_THE_TRAP: [number, number, number] = [-2371.1, 2148.9, -814.6];

describe.skipIf(!hasGamedata())('triggers, traps and moves (headless simulation)', () => {
  let sim: Sim;
  let arrived = 0;
  let left = 0;
  let offTheTrap = 0;
  let movedIn = 0;
  let movedOut = 0;
  let item = 0;

  beforeAll(async () => {
    sim = await openSim({
      interior: MERCER_FREY_HOUSE,
      hour: 10,
      arrival: { position: IN_THE_BOX, heading: 0 },
    });
    arrived = 0;
    await sim.step(1.5);
    // A script brings an item from the Bannered Mare (MoveTo the player), then sends it back.
    const handle = (reference: number) => sim.runtime.referenceHandle(reference);
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
  }, 600_000);
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

  it('sends the trap OnTrapHit while it keeps touching the player, OnTrapHitStop as it ends', () => {
    const start = sent('OnTrapHitStart', SPEAR_TRAP, left, offTheTrap);
    expect(start.length).toBeGreaterThan(0);
    const hits = sent('OnTrapHit', SPEAR_TRAP, left);
    for (const hit of hits) {
      // As OnTrapHitStart: the target, its velocity and position, the material, the flags.
      expect(hit.args[0]).toEqual({ form: PLAYER_REF });
      expect(hit.args).toHaveLength(start[0]?.args.length ?? 0);
    }
    const stops = sent('OnTrapHitStop', SPEAR_TRAP, left);
    expect(stops.map((e) => e.args)).toContainEqual([{ form: PLAYER_REF }]);
    // The stop comes after the start and every hit.
    const stop = stops.at(-1)?.at ?? -Infinity;
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
