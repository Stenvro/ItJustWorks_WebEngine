// Conformance: the scripts' events of items, effects, states, locks, destruction and the
// actor's own changes (engine map: Scripting > Script events), in the headless simulation. Each
// is raised by the engine path that raises it in the game: a potion drunk, a sword equipped and
// unequipped, a treasure map taken (as the book menu's Take does), natives called through the
// VM as a script calls them (Lock, DamageObject, DamageActorValue, SetRace,
// RegisterForAnimationEvent, Disable, StartVampireFeed, SendVampirismStateChanged,
// SendLycanthropyStateChanged), the player walking. Skipped without game data.
//
// Sources: the base scripts' declarations (ObjectReference, Actor, ActiveMagicEffect, Form
// .pex) for each event's arguments, the Creation Kit's event pages for when each is sent, and
// the data (Skyrim.esm):
// - BladesPotion [000E6DF5]: one effect, BladesAlchPotion (a scripted MGEF), for 1 s;
// - SilverSword [00010AA19]: SilverSwordScript handles OnEquipped / OnUnEquipped;
// - dunTreasMapWhiterun [000F33D1]: dunTreasMapScript, auto state waiting; its
//   onContainerChanged there goes to state done (the compiled GotoState: onEndState, then
//   onBeginState);
// - TGRStrongbox [000EA737] in the Bannered Mare is locked;
// - TG01BersiDwemerUrn [0004FCDD] is destructible (TG01BersiDwemerUrnScript);
// - Hulda [0001A66E] keeps the Bannered Mare; made essential (ActorBase.SetEssential), her
//   health run out puts her in bleedout; Brenuin [0002C90F] is there too.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const BLADES_POTION = 0xe6df5;
const SILVER_SWORD = 0x10aa19;
const TREASURE_MAP = 0xf33d1;
const STRONGBOX = 0xea737;
const BERSI_URN = 0x4fcdd;
const HULDA = 0x1a66e;
const BRENUIN = 0x2c90f;

describe.skipIf(!hasGamedata())(
  'the events of items, effects, states and the actor’s own changes (headless simulation)',
  () => {
    let sim: Sim;
    let map = 0;
    let urn = 0;
    /** When each part began (seconds on the simulation's clock). */
    const at = {
      potion: 0,
      sword: 0,
      unequip: 0,
      map: 0,
      lock: 0,
      urn: 0,
      bleedout: 0,
      walk: 0,
      unload: 0,
      race: 0,
      feed: 0,
    };

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(2);
      const { runtime } = sim;
      const { vm } = runtime;
      const player = runtime.actorHandle(PLAYER_REF);
      // Engine work that may wait for frames (a native waits for the next one): the world steps
      // until it is done (at most 10 s).
      const drive = async <T>(work: Promise<T>): Promise<T | undefined> => {
        let result: T | undefined;
        let done = false;
        void work.then((value) => {
          result = value;
          done = true;
        });
        await sim.until(() => done, 10);
        return result;
      };
      // A native called as a script calls it.
      const call = async (
        target: Value | undefined,
        name: string,
        args: Value[],
      ): Promise<Value> => {
        if (!(target instanceof ObjectHandle)) throw new Error(`${name}: no object`);
        return (await drive(vm.call(target, name, args))) ?? null;
      };

      // A potion drunk from the inventory: its scripted effect starts, and ends after 1 s.
      at.potion = sim.time;
      await runtime.addItem(PLAYER_REF, runtime.formHandle(BLADES_POTION), 1, true);
      await drive(runtime.magic.useItem(PLAYER_REF, BLADES_POTION));
      await sim.step(2.5);

      // A silver sword equipped, then unequipped.
      at.sword = sim.time;
      await runtime.addItem(PLAYER_REF, runtime.formHandle(SILVER_SWORD), 1, true);
      await drive(sim.equip(SILVER_SWORD));
      await sim.step(0.5);
      at.unequip = sim.time;
      await drive(runtime.equipment.unequip(PLAYER_REF, SILVER_SWORD));
      await sim.step(0.5);

      // A treasure map put down by the player and taken (the crosshair's activation).
      map = await sim.place(TREASURE_MAP, PLAYER_REF);
      await sim.step(1);
      at.map = sim.time;
      await drive(runtime.pickUp(map, PLAYER_REF));
      await sim.step(1);

      // The strongbox unlocked by a script (ObjectReference.Lock(false)).
      at.lock = sim.time;
      await call(runtime.referenceHandle(STRONGBOX), 'Lock', [false, false]);
      await sim.step(0.5);

      // An urn put down and broken by a script (ObjectReference.DamageObject).
      urn = await sim.place(BERSI_URN, PLAYER_REF);
      await sim.step(1);
      at.urn = sim.time;
      await call(runtime.referenceHandle(urn), 'DamageObject', [1000]);
      await sim.step(1);

      // Hulda made essential, her health run out by a script: she bleeds out.
      at.bleedout = sim.time;
      const hulda = runtime.actorHandle(HULDA);
      const base = await call(hulda, 'GetActorBase', []);
      await call(base, 'SetEssential', [true]);
      await call(hulda, 'DamageActorValue', ['Health', 10_000]);
      await sim.step(2);

      // The player registers for their own and Brenuin's footsteps and walks; Brenuin goes.
      at.walk = sim.time;
      await call(player, 'RegisterForAnimationEvent', [player, 'FootLeft']);
      await call(player, 'RegisterForAnimationEvent', [runtime.actorHandle(BRENUIN), 'FootLeft']);
      const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      await sim.walkTo([feet[0] + 256, feet[1], feet[2]], 3);
      await sim.walkTo(feet, 3);
      at.unload = sim.time;
      await call(runtime.actorHandle(BRENUIN), 'Disable', [false]);
      await sim.step(1);

      // The player's own changes: a race switch, a vampire's feeding, the
      // vampirism and lycanthropy notices.
      at.race = sim.time;
      const race = await call(player, 'GetRace', []);
      await call(player, 'SetRace', [race]);
      await sim.step(3);
      at.feed = sim.time;
      await call(player, 'StartVampireFeed', [hulda]);
      await call(player, 'SendVampirismStateChanged', [true]);
      await call(player, 'SendLycanthropyStateChanged', [true]);
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

    it('sends OnEffectStart(the player, the player) as the potion takes effect, OnEffectFinish as it ends', () => {
      const start = sent('OnEffectStart', undefined, at.potion, at.sword);
      const finish = sent('OnEffectFinish', undefined, at.potion, at.sword);
      expect(start.map((event) => event.args)).toEqual([
        [{ form: PLAYER_REF }, { form: PLAYER_REF }],
      ]);
      expect(finish.map((event) => event.args)).toEqual([
        [{ form: PLAYER_REF }, { form: PLAYER_REF }],
      ]);
      // The effect lasts its second.
      expect((finish[0]?.at ?? 0) - (start[0]?.at ?? 0)).toBeGreaterThan(0.95);
    });

    it('sends the sword OnEquipped(the player) as it is equipped, OnUnequipped as it is not', () => {
      expect(sent('OnEquipped', SILVER_SWORD, at.sword, at.unequip).map((e) => e.args)).toEqual([
        [{ form: PLAYER_REF }],
      ]);
      expect(sent('OnUnequipped', SILVER_SWORD, at.unequip, at.map).map((e) => e.args)).toEqual([
        [{ form: PLAYER_REF }],
      ]);
    });

    it('sends the map OnContainerChanged(the player, None) as the player takes it', () => {
      expect(sent('OnContainerChanged', map, at.map, at.lock).map((e) => e.args)).toEqual([
        [{ form: PLAYER_REF }, null],
      ]);
    });

    it('sends the map onEndState, then onBeginState, as its GotoState leaves waiting for done', () => {
      const states = sim
        .scriptEvents({ target: map, since: at.map })
        .filter((event) => event.at < at.lock)
        .map((event) => event.event)
        .filter((event) => event === 'onEndState' || event === 'onBeginState');
      expect(states).toEqual(['onEndState', 'onBeginState']);
    });

    it('sends the strongbox OnLockStateChanged as a script unlocks it', () => {
      expect(sent('OnLockStateChanged', STRONGBOX, at.lock, at.urn)).toHaveLength(1);
    });

    it('sends the urn OnDestructionStageChanged(old, new) as it is damaged past a stage', () => {
      const stages = sent('OnDestructionStageChanged', urn, at.urn, at.bleedout);
      expect(stages.length).toBeGreaterThan(0);
      expect(stages[0]?.args[0]).toBe(0);
      for (const stage of stages)
        expect(stage.args[1] as number).toBeGreaterThan(stage.args[0] as number);
    });

    it('sends Hulda OnEnterBleedout as an essential actor’s health runs out', () => {
      expect(sent('OnEnterBleedout', HULDA, at.bleedout, at.walk)).toHaveLength(1);
    });

    it('sends the registered player OnAnimationEvent(source, FootLeft) as the player walks', () => {
      const steps = sent('OnAnimationEvent', PLAYER_REF, at.walk, at.unload);
      const sources = new Set(steps.map((event) => (event.args[0] as { form: number }).form));
      expect(sources.has(PLAYER_REF)).toBe(true);
      for (const step of steps) expect(step.args[1]).toMatch(/^footleft$/i);
    });

    it('sends OnAnimationEventUnregistered(Brenuin, footleft) as his graph unloads (disabled)', () => {
      expect(
        sent('OnAnimationEventUnregistered', PLAYER_REF, at.unload, at.race).map((e) => e.args),
      ).toEqual([[{ form: BRENUIN }, 'footleft']]);
    });

    it('sends the player OnRaceSwitchComplete once SetRace’s new 3D stands', () => {
      expect(sent('OnRaceSwitchComplete', PLAYER_REF, at.race, at.feed)).toHaveLength(1);
    });

    it('sends OnVampireFeed(the target), OnVampirismStateChanged and OnLycanthropyStateChanged', () => {
      expect(sent('OnVampireFeed', PLAYER_REF, at.feed).map((e) => e.args)).toEqual([
        [{ form: HULDA }],
      ]);
      expect(sent('OnVampirismStateChanged', PLAYER_REF, at.feed).map((e) => e.args)).toEqual([
        [true],
      ]);
      expect(sent('OnLycanthropyStateChanged', PLAYER_REF, at.feed).map((e) => e.args)).toEqual([
        [true],
      ]);
    });
  },
);
