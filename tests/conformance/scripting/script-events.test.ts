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

  it.todo(
    'sends OnActivate to a reference whose activation a script blocks (BlockActivation) without ' +
      'its default action or its children (CK, ObjectReference.BlockActivation; TrapTriggerBase)',
  );
  it.todo(
    'refuses a script’s Activate on a Parent Activate Only reference by one that is not its ' +
      'parent, if the engine does (XAPD; the engine’s rule for scripts is unread)  [original]',
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

// The events vanilla scripts wait for that no interaction case above covers yet, each with when
// the original sends it, its arguments and to whom (the Creation Kit's event pages, the base
// scripts' declarations; CommonLibSSE's event sources). "Produced:" names our producer where one
// exists; the case is to be written in the simulation. "Not produced" ones are missing.
const TO_WRITE: Readonly<Record<string, string>> = {
  OnActivate: 'by an NPC’s AI (an actor going through a door: akActionRef the actor)  [CK]',
  OnTriggerEnter:
    'to a trigger volume as a reference enters it (akActionRef)  [CK; produced: trigger-volumes.ts]',
  OnTriggerLeave: 'to a trigger volume as a reference leaves it (akActionRef)  [CK; produced]',
  OnTrigger:
    'to a trigger volume while a reference stays in it, again each fTriggerEventDelayMS (500 ms)  [CK; produced]',
  OnUpdate:
    'to a form registered with RegisterForUpdate/RegisterForSingleUpdate, in real seconds  [CK; produced: VM]',
  OnUpdateGameTime:
    'to a form registered with RegisterForUpdateGameTime/RegisterForSingleUpdateGameTime, in game hours  [CK; produced: VM]',
  OnInit:
    'to every script as its object comes into being, before its other events  [CK; produced: VM]',
  OnBeginState:
    'to a script as GotoState enters a state (the compiler’s GotoState)  [PEX; produced: VM]',
  OnEndState: 'to a script as GotoState leaves a state  [PEX; produced: VM]',
  OnEffectStart:
    'to an active magic effect’s scripts as it starts (akTarget, akCaster)  [CK; produced: magic-engine.ts]',
  OnEffectFinish:
    'to an active magic effect’s scripts as it ends (akTarget, akCaster)  [CK; produced]',
  OnContainerChanged:
    'to an item reference that moves between containers or the world (akNewContainer, akOldContainer)  [CK; produced]',
  OnItemRemoved:
    'to the container an item left (akBaseItem, aiItemCount, akItemReference, akDestContainer)  [CK; produced]',
  OnCombatStateChanged:
    'to an NPC whose combat state changes (akTarget, aeCombatState 0 none, 1 combat, 2 searching)  [CK; produced: actor-combat-ai.ts]',
  OnAnimationEvent:
    'to a form registered for a reference’s animation event as its graph raises it (akSource, asEventName)  [CK; produced]',
  OnAnimationEventUnregistered:
    'to a form registered for an animation event that the reference’s graph unloads (akSource, asEventName)  [CK; not produced]',
  OnReset:
    'to a reference as its cell resets (not one deleted)  [CK, TESResetEvent; not produced: cell reset]',
  OnEquipped:
    'to an item with scripts as an actor equips it (akActor)  [CK; produced: equipment-engine.ts]',
  OnUnequipped: 'to an item with scripts as an actor unequips it (akActor)  [CK; produced]',
  OnObjectUnequipped:
    'to an actor that unequips an item (akBaseObject, akReference)  [CK; produced]',
  OnRead: 'to a book reference as it is read (opened)  [CK; produced: book-menu.ts]',
  OnEnterBleedout:
    'to an actor whose life state turns to bleeding out  [CK; produced: actor-combat.ts]',
  OnGetUp:
    'to an actor as it gets up from furniture (akFurniture)  [CK; produced: actor-furniture.ts]',
  OnOpen:
    'to a container as it opens (akActionRef: who opened it; doors: covered above)  [CK, TESOpenCloseEvent; produced]',
  OnClose: 'to a door or container as it closes (akActionRef)  [CK, TESOpenCloseEvent; produced]',
  OnDestructionStageChanged:
    'to a destructible reference as it goes to another stage (aiOldStage, aiCurrentStage)  [CK; produced]',
  OnAttachedToCell:
    'to a reference moved into the attached area by itself (not with its cell)  [CK, TESMoveAttachDetachEvent; produced]',
  OnDetachedFromCell: 'to a reference moved out of the attached area by itself  [CK; produced]',
  OnPlayerLoadGame:
    'to the player (and its aliases) as a saved game finishes loading  [CK, TESLoadGameEvent; not produced: M12]',
  OnSpellCast:
    'to the caster as a spell, power, scroll or shout takes effect (akSpell), not a script’s Cast  [CK, TESSpellCastEvent; produced]',
  OnTrapHitStart:
    'to a trap as it starts touching a living actor (akTarget, velocity, position, aeMaterial, abInitialHit, aeMotionType)  [CK, TESTrapHitEvent; not produced: traps]',
  OnTrapHit:
    'to a trap each step it touches a living actor (as OnTrapHitStart)  [CK; not produced: traps]',
  OnTrapHitStop:
    'to a trap as it stops touching a living actor (akTarget)  [CK; not produced: traps]',
  OnGainLOS:
    'to a form registered with RegisterForLOS/RegisterForSingleLOSGain as the viewer gains sight of the target  [CK; produced]',
  OnLostLOS:
    'to a form registered with RegisterForLOS/RegisterForSingleLOSLost as the viewer loses sight  [CK; produced]',
  OnTranslationComplete: 'to a reference whose TranslateTo reached its end  [CK; produced]',
  OnTranslationAlmostComplete:
    'to a reference past fRefTranslationAlmostDonePercent (0.9) of its TranslateTo  [CK; produced]',
  OnTranslationFailed: 'to a reference whose TranslateTo failed (no 3D)  [CK; produced]',
  OnGrab: 'to an object the player grabs (Z key, Telekinesis)  [CK, TESGrabReleaseEvent; produced]',
  OnRelease: 'to an object the player lets go  [CK; produced]',
  OnRaceSwitchComplete: 'to an actor whose race switch (SetRace) ended  [CK; produced]',
  OnSleepStart:
    'to the forms registered with RegisterForSleep as the player’s sleep starts (afSleepStartTime, afDesiredSleepEndTime)  [CK; produced]',
  OnSleepStop:
    'to the forms registered with RegisterForSleep as it ends (abInterrupted)  [CK; produced]',
  OnLockStateChanged:
    'to a reference whose lock is locked or unlocked  [CK, TESLockChangedEvent; produced]',
  OnTrackedStatsEvent:
    'to the forms registered with RegisterForTrackedStatsEvent as an engine stat changes (arStatName, aiStatValue)  [CK; produced]',
  OnWardHit:
    'to an actor whose ward a spell meets (akCaster, akSpell, aiStatus 0 friendly, 1 absorbed, 2 broken)  [CK; produced]',
  OnVampirismStateChanged:
    'to an actor whose vampirism changes (abIsVampire)  [CK; produced: natives]',
  OnVampireFeed: 'to the player feeding on an actor (akTarget)  [CK; produced: natives]',
  OnLycanthropyStateChanged:
    'to an actor whose lycanthropy changes (abIsWerewolf)  [CK; produced: natives]',
  OnPackageChange:
    'to an actor whose package changes (akOldPackage)  [CK, TESPackageEvent; produced]',
  OnPackageEnd: 'to an actor whose package ends (akOldPackage)  [CK; produced]',
  OnPlayerFastTravelEnd:
    'to the player as fast travel ends (afTravelGameTimeHours)  [CK; produced]',
  OnPlayerBowShot:
    'to the player as their bow’s arrow leaves (akWeapon, akAmmo, afPower, abSunGazing)  [CK; produced]',
  OnSell: 'to an item reference the player sells (akSeller)  [CK, TESSellEvent; produced]',
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
];

describe('the events still to check in the simulation', () => {
  for (const [event, when] of Object.entries(TO_WRITE)) it.todo(`sends ${event} ${when}`);
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
    const listed = new Set([...COVERED, ...Object.keys(TO_WRITE)].map((e) => e.toLowerCase()));
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
