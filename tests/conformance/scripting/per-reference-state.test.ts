// Conformance: per-reference state (engine map: Scripting, events, world state > Per-reference
// state). What the game keeps on a reference over its plugin's record (its place, open and lock
// state, destruction, harvest, owner, souls, names) and when it shows. Skipped without game data.
//
// Sources:
// - The Creation Kit's ObjectReference functions (MoveTo, SetOpen, Lock, SetLockLevel,
//   SetDestroyed, DamageObject, SetActorOwner, SetFactionOwner, DropObject, ...): what each
//   changes; its ReferenceAlias page (Alias Display Name: the reference is named so while the
//   alias holds it); its soul gem page (a gem holds a soul smaller than it can, as such).
// - The engine's rule, observed in the original (src/scripting/runtime/cell-reset.ts): what the game changed
//   on a reference lasts until its cell resets (then what the reset restores goes: its lock,
//   open state, destruction, harvest, its place unless persistent; the rest stays).
// - The data (Skyrim.esm): WhiterunBanneredMare [0001605E], the first object of the cell whose
//   instance moves; its inner doors (WRDoor02 [000C8FB8]), cupboards (Cupboard01 [0006033E],
//   [0006033F], [0006034E]), the locked TGRStrongbox [000EA737] (level 25), tankards
//   (BasicTankard01 [00058CCE], [00058CCF], [00058CD0]) owned with the cell by
//   WhiterunBanneredMareFaction [0009E1B4]; RiftenPawnedPrawn [00016BD9] and its urn
//   TG01BersiDwemerUrn [000A0306] (destructible, initially disabled); TGCrown [0009DD77] alias
//   27 (display name "Stone of Barenziah"); SoulGemGreater [0002E4F4] (an empty gem that holds a
//   Greater soul). FortNeugrad01 [00015277]: its commander's door dunFortNeugradCommanderDoor
//   [000587B4] is the activate parent of the bandit boss [000CC59A] standing in Tamriel's
//   persistent cell (`node tools/activate-children-audit.ts`: 158 of the 6,527 pairs have a
//   child beyond the parent's cell, its worldspace's persistent cell and the exterior cells
//   round it, and every one of those parents is persistent). BilegulchMine [0001B147], its
//   ore vein [000B5153] and bucket [000EC8E3].

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const BANNERED_MARE = 0x1605e;

/** Steps the world until engine work is done (at most 10 s); its result. */
async function drive<T>(sim: Sim, work: Promise<T>): Promise<T | undefined> {
  let result: T | undefined;
  let done = false;
  void work.then((value) => {
    result = value;
    done = true;
  });
  await sim.until(() => done, 10);
  return result;
}

/** A function called on a reference as a script calls it. */
async function call(sim: Sim, reference: number, name: string, args: Value[] = []): Promise<Value> {
  return (
    (await drive(sim, sim.runtime.vm.call(sim.runtime.referenceHandle(reference), name, args))) ??
    null
  );
}

const form = (sim: Sim, formId: number): Value => sim.runtime.formHandle(formId);

describe.skipIf(!hasGamedata())('a script moves a moving object (headless simulation)', () => {
  let sim: Sim;
  let reference = 0;
  let editor: Vec3 = [0, 0, 0];
  let target: Vec3 = [0, 0, 0];
  let after: Vec3 | undefined;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(2);
    for (const id of sim.db.cellReferences(BANNERED_MARE)) {
      const world = sim.world.placed(id)?.instance;
      if (world?.motion && (await sim.enabled(id))) {
        reference = id;
        editor = [world.world[12] ?? 0, world.world[13] ?? 0, world.world[14] ?? 0];
        break;
      }
    }
    target = [editor[0] + 40, editor[1], editor[2] + 10];
    sim.runtime.move(reference, target);
    await sim.step(0.2);
    const world = sim.world.placed(reference)?.instance.world;
    after = world && [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('takes it where the script put it, though physics moves it (MoveTo, SetPosition)', () => {
    expect(reference).not.toBe(0);
    expect(after).toBeDefined();
    // Sideways where it was sent (it may fall from there: the height is physics').
    expect(Math.abs((after?.[0] ?? 0) - target[0])).toBeLessThan(4);
    expect(Math.abs((after?.[1] ?? 0) - target[1])).toBeLessThan(4);
  });

  it('keeps where the script put it as the reference’s state', () => {
    expect(sim.runtime.state.references.get(reference)?.position).toEqual(target);
  });
});

const PAWNED_PRAWN = 0x16bd9;
const WR_DOOR = 0xc8fb8;
const CUPBOARD = 0x6033e;
const LOCKED_CUPBOARD = 0x6033f;
const NAMED_CUPBOARD = 0x6034e;
const STRONGBOX = 0xea737;
const BERSI_URN = 0xa0306;
const TANKARDS = [0x58cce, 0x58ccf, 0x58cd0] as const;
const PLAYER_BASE = 0x7;
const PLAYER_FACTION = 0xdb1;
const TANKARD = 0x319e3;
const TG_CROWN = 0x9dd77;
const CROWN_STONE_ALIAS = 27;
const SOUL_GEM_GREATER = 0x2e4f4;
/** A Lesser soul (1 Petty .. 5 Grand). */
const LESSER_SOUL = 2;

/** What a reference shows of its lock, open state, destruction and owner. */
interface Kept {
  readonly doorOpen: string | undefined;
  readonly cupboardOpen: string | undefined;
  readonly openStates: readonly Value[];
  readonly locks: readonly Value[];
  readonly owners: readonly (readonly (number | null)[])[];
  readonly mayTake: readonly boolean[];
}

describe.skipIf(!hasGamedata())('what a reference keeps (headless simulation)', () => {
  let sim: Sim;
  let before: Kept | undefined;
  let after: Kept | undefined;
  let urnBefore: { stage: Value; hidden: boolean | undefined } | undefined;
  let urnAfter: { stage: Value; hidden: boolean | undefined } | undefined;
  /** The crosshair's name for the cupboard: before its alias holds it, while, once let go. */
  const named: (string | undefined)[] = [];
  let aliasName: string | undefined;
  /** A gem's partial soul after a trip into a cupboard and back, and dropped and taken. */
  const souls = { stored: 0, takenBack: 0, dropped: 0, droppedTaken: 0, listed: [] as number[] };

  const kept = async (): Promise<Kept> => {
    const owner = async (reference: number): Promise<(number | null)[]> => {
      const actor = await call(sim, reference, 'GetActorOwner');
      const faction = await call(sim, reference, 'GetFactionOwner');
      const id = (value: Value): number | null =>
        value instanceof ObjectHandle ? value.formId : null;
      return [id(actor), id(faction)];
    };
    // One call at a time (each steps the world until it is done).
    const owners: (number | null)[][] = [];
    for (const tankard of TANKARDS) owners.push(await owner(tankard));
    return {
      doorOpen: sim.world.placed(WR_DOOR)?.instance.playback?.sequence,
      cupboardOpen: sim.world.placed(CUPBOARD)?.instance.playback?.sequence,
      openStates: [
        await call(sim, WR_DOOR, 'GetOpenState'),
        await call(sim, CUPBOARD, 'GetOpenState'),
      ],
      locks: [
        await call(sim, STRONGBOX, 'IsLocked'),
        await call(sim, STRONGBOX, 'GetLockLevel'),
        await call(sim, LOCKED_CUPBOARD, 'IsLocked'),
        await call(sim, LOCKED_CUPBOARD, 'GetLockLevel'),
      ],
      owners,
      mayTake: await Promise.all(
        TANKARDS.map((tankard) => sim.runtime.crime.mayTake(PLAYER_REF, tankard)),
      ),
    };
  };

  /** The crosshair's name as the player looks at a reference from a step away. */
  const crosshairOn = async (reference: number): Promise<string | undefined> => {
    const at = await sim.position(reference);
    if (!at) return undefined;
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      await sim.moveTo([at[0] + Math.sin(angle) * 90, at[1] + Math.cos(angle) * 90, at[2]]);
      await sim.step(0.3);
      sim.look([at[0], at[1], at[2] + 40]);
      await sim.step(0.3);
      if (sim.crosshair() !== undefined) return sim.crosshair();
    }
    return undefined;
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(2);
    const { runtime } = sim;
    // A door and a cupboard opened, locks changed, owners set by scripts.
    await call(sim, WR_DOOR, 'SetOpen', [true]);
    await call(sim, CUPBOARD, 'SetOpen', [true]);
    await call(sim, STRONGBOX, 'SetLockLevel', [75]);
    await call(sim, LOCKED_CUPBOARD, 'Lock', [true, false]);
    await call(sim, LOCKED_CUPBOARD, 'SetLockLevel', [50]);
    await call(sim, TANKARDS[0], 'SetActorOwner', [form(sim, PLAYER_BASE)]);
    await call(sim, TANKARDS[1], 'SetFactionOwner', [form(sim, PLAYER_FACTION)]);
    await sim.step(2);
    before = await kept();

    // The cupboard named by an alias that holds it (Alias Display Name), and let go.
    named.push(await crosshairOn(NAMED_CUPBOARD));
    runtime.forceAlias(TG_CROWN, CROWN_STONE_ALIAS, NAMED_CUPBOARD);
    await sim.step(0.5);
    named.push(sim.crosshair());
    runtime.clearAlias(TG_CROWN, CROWN_STONE_ALIAS);
    await sim.step(0.5);
    named.push(sim.crosshair());
    aliasName = (await runtime.forms.record(0x6d626))?.text('FULL');

    // A Lesser soul in a Greater gem: into a cupboard and back, then dropped and taken again.
    await runtime.addItem(PLAYER_REF, form(sim, SOUL_GEM_GREATER), 1, true);
    runtime.crafting.addSoul(PLAYER_REF, SOUL_GEM_GREATER, LESSER_SOUL);
    await runtime.removeItem(PLAYER_REF, form(sim, SOUL_GEM_GREATER), 1, true, CUPBOARD);
    souls.stored = runtime.crafting.partialSoul(CUPBOARD, SOUL_GEM_GREATER);
    await sim.take(CUPBOARD, SOUL_GEM_GREATER);
    souls.takenBack = runtime.crafting.partialSoul(PLAYER_REF, SOUL_GEM_GREATER);
    const dropped = await call(sim, PLAYER_REF, 'DropObject', [form(sim, SOUL_GEM_GREATER), 1]);
    await sim.step(1);
    souls.dropped = runtime.crafting.partialSoul(PLAYER_REF, SOUL_GEM_GREATER);
    if (dropped instanceof ObjectHandle)
      await drive(sim, runtime.pickUp(dropped.formId, PLAYER_REF));
    souls.droppedTaken = runtime.crafting.partialSoul(PLAYER_REF, SOUL_GEM_GREATER);
    souls.listed = (await runtime.crafting.soulGems(PLAYER_REF))
      .filter((gem) => gem.formId === SOUL_GEM_GREATER)
      .map((gem) => gem.soul);

    // Away, an urn enabled and broken to its last stage; back, then back to the urn.
    await sim.openInterior(PAWNED_PRAWN);
    await sim.step(1);
    await call(sim, BERSI_URN, 'Enable', [false]);
    await sim.step(0.5);
    await call(sim, BERSI_URN, 'DamageObject', [1000]);
    await sim.step(1);
    urnBefore = {
      stage: await call(sim, BERSI_URN, 'GetCurrentDestructionStage'),
      hidden: sim.world.placed(BERSI_URN)?.instance.visibility?.hidden,
    };
    await sim.openInterior(BANNERED_MARE);
    await sim.step(2);
    after = await kept();
    await sim.openInterior(PAWNED_PRAWN);
    await sim.step(2);
    urnAfter = {
      stage: await call(sim, BERSI_URN, 'GetCurrentDestructionStage'),
      hidden: sim.world.placed(BERSI_URN)?.instance.visibility?.hidden,
    };
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  it('keeps a door’s or a container’s open state as its cell unloads and loads  [CK] (sim)', () => {
    expect(before?.doorOpen).toBe('open');
    expect(before?.cupboardOpen).toBe('open');
    // The door's and the cupboard's 3D come back open, as GetOpenState says (1: open).
    expect(after?.doorOpen).toBe('open');
    expect(after?.cupboardOpen).toBe('open');
    expect(after?.openStates).toEqual([1, 1]);
  });

  it('keeps a lock’s state and level as its cell unloads and loads  [CK] (sim)', () => {
    expect(before?.locks).toEqual([true, 75, true, 50]);
    expect(after?.locks).toEqual(before?.locks);
  });

  it('keeps a destructible object’s stage as its cell unloads and loads  [CK] (sim)', () => {
    expect(urnBefore).toEqual({ stage: 3, hidden: true });
    // Its last stage's look stands in for its own model again.
    expect(urnAfter).toEqual(urnBefore);
  });

  it('keeps an owner a script set (SetActorOwner, SetFactionOwner)  [CK] (sim)', () => {
    const expected = [
      [PLAYER_BASE, null],
      [null, PLAYER_FACTION],
      [null, null],
    ];
    expect(before?.owners).toEqual(expected);
    expect(after?.owners).toEqual(expected);
    // The player's to take now; the third is the inn's (its cell's owner) as before.
    expect(after?.mayTake).toEqual([true, true, false]);
    expect(sim.runtime.crime.stolenCount(PLAYER_REF, TANKARD)).toBe(0);
  });

  it('keeps a soul gem’s partial soul (the soul it holds, not only full or empty)  [CK]', () => {
    expect(souls).toEqual({
      stored: LESSER_SOUL,
      takenBack: LESSER_SOUL,
      dropped: 0,
      droppedTaken: LESSER_SOUL,
      listed: [LESSER_SOUL],
    });
  });

  it('shows an alias’s display name on the reference it fills (Alias Display Name)  [CK] (sim)', () => {
    expect(aliasName).toBe('Stone of Barenziah');
    expect(named).toEqual(['Cupboard', aliasName, 'Cupboard']);
  });
});

const FORT_NEUGRAD = 0x15277;
const COMMANDER_DOOR = 0x587b4;
const BANDIT_BOSS = 0xcc59a;

describe.skipIf(!hasGamedata())('a parent and its child far apart (headless simulation)', () => {
  let sim: Sim;
  let activated: number[] = [];
  let boss: string[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: FORT_NEUGRAD, hour: 10 });
    await sim.step(1);
    const since = sim.time;
    sim.activate(COMMANDER_DOOR);
    await sim.step(2);
    activated = sim
      .records(since)
      .flatMap((record) =>
        record.kind === 'game' && record.type === 'activate' ? [record.event.target] : [],
      );
    boss = sim
      .scriptEvents({ target: BANDIT_BOSS, since })
      .map((event) => event.event.toLowerCase());
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it(
    'activates an activate child that lies beyond the cells searched (158 of 6,527 pairs)  ' +
      '[data: tools/activate-children-audit.ts] (sim)',
    () => {
      expect(activated).toContain(COMMANDER_DOOR);
      expect(activated).toContain(BANDIT_BOSS);
      // Its ambush script hears it (masterambushscript's OnActivate).
      expect(boss).toContain('onactivate');
    },
  );
});

const BILEGULCH_MINE = 0x1b147;
/** BarrelFood01 [00000845]: CONT DATA 0x02, its inventory respawns (it may reset). */
const BARREL = 0x62210;
/** MineDoor01Load: persistent (its place is its record's anyway). */
const MINE_DOOR = 0x1b154;
const BUCKET = 0xec8e3;

describe.skipIf(!hasGamedata())('a mine reset eleven days later (headless simulation)', () => {
  let sim: Sim;
  let editor: Vec3 | undefined;
  const states: Record<string, Value>[] = [];
  /** The bucket where it stands: moved, a day later, after the reset. */
  const bucketAt: (Vec3 | undefined)[] = [];
  let moved: Vec3 | undefined;

  const read = async (): Promise<Record<string, Value>> => {
    const id = (value: Value): number | null =>
      value instanceof ObjectHandle ? value.formId : null;
    return {
      barrelLocked: await call(sim, BARREL, 'IsLocked'),
      barrelLevel: await call(sim, BARREL, 'GetLockLevel'),
      barrelGems: await call(sim, BARREL, 'GetItemCount', [form(sim, SOUL_GEM_GREATER)]),
      barrelOwner: id(await call(sim, BARREL, 'GetActorOwner')),
      doorOpen: await call(sim, MINE_DOOR, 'GetOpenState'),
      doorOwner: id(await call(sim, MINE_DOOR, 'GetFactionOwner')),
      bucketOwner: id(await call(sim, BUCKET, 'GetFactionOwner')),
    };
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    await sim.step(1);
    editor = await sim.position(BUCKET);
    const { runtime } = sim;
    // The barrel locked, given a gem and owned; the door opened and owned; the bucket moved and
    // owned.
    await call(sim, BARREL, 'Lock', [true, false]);
    await call(sim, BARREL, 'SetLockLevel', [50]);
    await call(sim, BARREL, 'AddItem', [form(sim, SOUL_GEM_GREATER), 1, true]);
    await call(sim, BARREL, 'SetActorOwner', [form(sim, PLAYER_BASE)]);
    await call(sim, MINE_DOOR, 'SetOpen', [true]);
    await call(sim, MINE_DOOR, 'SetFactionOwner', [form(sim, PLAYER_FACTION)]);
    await call(sim, BUCKET, 'SetFactionOwner', [form(sim, PLAYER_FACTION)]);
    moved = editor && [editor[0] + 64, editor[1], editor[2] + 8];
    if (moved) runtime.move(BUCKET, moved);
    await sim.step(1);
    states.push(await read());
    bucketAt.push(await sim.position(BUCKET));
    // A day away: nothing resets; eleven more: the mine does (iHoursToRespawnCell 240).
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 1);
    await sim.openInterior(BILEGULCH_MINE);
    await sim.step(1);
    states.push(await read());
    bucketAt.push(await sim.position(BUCKET));
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 11);
    await sim.openInterior(BILEGULCH_MINE);
    await sim.step(2);
    states.push(await read());
    bucketAt.push(await sim.position(BUCKET));
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  it('drops what the reset restores as its cell resets, and keeps the rest  [original] (sim)', () => {
    const changed = {
      barrelLocked: true,
      barrelLevel: 50,
      barrelGems: 1,
      barrelOwner: PLAYER_BASE,
      doorOpen: 1,
      doorOwner: PLAYER_FACTION,
      bucketOwner: PLAYER_FACTION,
    };
    expect(states[0]).toEqual(changed);
    expect(states[1]).toEqual(changed);
    // Its lock, its inventory and its open state go; the owners scripts set stay.
    expect(states[2]).toEqual({
      barrelLocked: false,
      barrelLevel: 0,
      barrelGems: 0,
      barrelOwner: PLAYER_BASE,
      doorOpen: 3,
      doorOwner: PLAYER_FACTION,
      bucketOwner: PLAYER_FACTION,
    });
    // The bucket (not persistent) stayed where it was moved, and went back to its editor place
    // with the reset.
    const sideways = (a: Vec3 | undefined, b: Vec3 | undefined): number =>
      a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
    // (Sent there, it came to rest by it: physics'.)
    expect(sideways(bucketAt[0], moved)).toBeLessThan(32);
    expect(sideways(bucketAt[0], editor)).toBeGreaterThan(32);
    expect(sideways(bucketAt[1], bucketAt[0])).toBeLessThan(8);
    expect(sideways(bucketAt[2], editor)).toBeLessThan(8);
    expect(sim.runtime.state.references.get(BUCKET)?.position).toBeUndefined();
  });
});
