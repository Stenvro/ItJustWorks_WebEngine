// Conformance: the scripts' events a script registers for, and the world's events that go on
// without one (engine map: Scripting > Script events), in the headless simulation. The
// registrations are made through the VM as a script makes them (Form.RegisterForSingleUpdate,
// RegisterForSingleUpdateGameTime, RegisterForSingleLOSGain / Lost,
// ObjectReference.TranslateTo); the world's events come from what the player does (an item
// unequipped and given away, a wolf fought and killed). Skipped without game data.
//
// Sources: the base scripts' declarations (Form, ObjectReference, Actor .pex) for each event's
// arguments, and the Creation Kit's event pages for when each is sent:
// - OnUpdate / OnUpdateGameTime: once the registered real seconds / game hours have passed;
// - OnGainLOS(akViewer, akTarget) / OnLostLOS: when the viewer first sees / stops seeing the
//   target (a single registration ends with its event);
// - OnTranslationAlmostComplete / OnTranslationComplete: a TranslateTo nearing / reaching its end;
// - OnObjectUnequipped(akBaseObject, akReference), OnItemRemoved(akBaseItem, aiItemCount,
//   akItemReference, akDestContainer): to the actor / container;
// - OnCombatStateChanged(akTarget, aeCombatState): to the actor whose combat state changed;
// - OnPackageEnd(akOldPackage): to the actor whose package ended;
// - OnTrackedStatsEvent(arStatName, aiStatValue): to those registered as a tracked stat goes up.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())(
  'the registered events and the fight’s (headless simulation)',
  () => {
    let sim: Sim;
    let dagger = 0;
    let wolf = 0;
    let rival = 0;
    let moved = 0;
    /** When each part began (seconds on the simulation's clock). */
    const at = {
      unequip: 0,
      remove: 0,
      update: 0,
      wolf: 0,
      lost: 0,
      translate: 0,
      fight: 0,
      kill: 0,
    };

    beforeAll(async () => {
      sim = await openSim({ hour: 10 });
      await sim.openInterior(BANNERED_MARE);
      await sim.step(2);
      const { runtime } = sim;
      const { vm } = runtime;
      const player = runtime.actorHandle(PLAYER_REF);
      dagger = await sim.formId('WEAP', 'IronDagger');
      await runtime.addItem(PLAYER_REF, runtime.formHandle(dagger), 2, true);
      await sim.equip(dagger);
      await sim.step(0.5);
      at.unequip = sim.time;
      await runtime.equipment.unequip(PLAYER_REF, dagger);
      await sim.step(0.5);
      at.remove = sim.time;
      await runtime.removeItem(PLAYER_REF, runtime.formHandle(dagger), 1, true, undefined);
      await sim.step(0.5);
      at.update = sim.time;
      void vm.call(player, 'RegisterForSingleUpdate', [0.5]);
      void vm.call(player, 'RegisterForSingleUpdateGameTime', [0.05]);
      await sim.step(5);
      at.wolf = sim.time;
      wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      void vm.call(player, 'RegisterForSingleLOSGain', [player, runtime.actorHandle(wolf)]);
      // At the player's feet it is below the camera's frame. Where it wanders from there is the
      // dice's, so it is brought into view: straight ahead of the player, who looks along +Y.
      await sim.step(0.5);
      void vm.call(runtime.actorHandle(wolf), 'MoveTo', [player, 0, 250, 0, true]);
      await sim.step(1);
      at.lost = sim.time;
      void vm.call(player, 'RegisterForSingleLOSLost', [player, runtime.actorHandle(wolf)]);
      void vm.call(runtime.actorHandle(wolf), 'Disable', []);
      await sim.step(2);
      at.translate = sim.time;
      moved = await sim.place(dagger, PLAYER_REF);
      const from = (await sim.position(moved)) ?? [0, 0, 0];
      void vm.call(runtime.referenceHandle(moved), 'TranslateTo', [
        from[0] + 50,
        from[1],
        from[2] + 20,
        0,
        0,
        0,
        100,
        0,
      ]);
      await sim.step(3);
      at.fight = sim.time;
      rival = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      at.kill = sim.time;
      await sim.kill(rival, PLAYER_REF);
      await sim.step(3);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    /** The events sent to a reference's own scripts (not to the aliases holding it). */
    const sent = (event: string, target?: number, since = 0, until = Infinity) =>
      sim
        .scriptEvents({ event, ...(target !== undefined && { target }), since })
        .filter((record) => record.at < until && record.alias === undefined);

    it('sends the player OnObjectUnequipped(the dagger, None) as they unequip it', () => {
      expect(sent('OnObjectUnequipped', PLAYER_REF, at.unequip, at.remove)).toEqual([
        expect.objectContaining({ args: [{ form: dagger }, null] }),
      ]);
    });

    it('sends the player OnItemRemoved(the dagger, 1, None, None) as it goes to nowhere', () => {
      expect(sent('OnItemRemoved', PLAYER_REF, at.remove, at.update)).toEqual([
        expect.objectContaining({ args: [{ form: dagger }, 1, null, null] }),
      ]);
    });

    it('sends one OnUpdate half a second after RegisterForSingleUpdate', () => {
      const updates = sent('OnUpdate', PLAYER_REF, at.update, at.wolf);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.at ?? 0).toBeGreaterThanOrEqual(at.update + 0.5);
    });

    it('sends one OnUpdateGameTime once the registered game hours have passed', () => {
      expect(sent('OnUpdateGameTime', PLAYER_REF, at.update)).toHaveLength(1);
    });

    it('sends the player OnGainLOS(the player, the wolf) once, as it comes into view', () => {
      expect(sent('OnGainLOS', PLAYER_REF, at.wolf).map((event) => event.args)).toEqual([
        [{ form: PLAYER_REF }, { form: wolf }],
      ]);
    });

    it('sends the player OnLostLOS(the player, the wolf) once, as it is disabled', () => {
      expect(sent('OnLostLOS', PLAYER_REF, at.lost).map((event) => event.args)).toEqual([
        [{ form: PLAYER_REF }, { form: wolf }],
      ]);
    });

    it('sends the wolf OnCombatStateChanged(target, 1) as it fights, and 0 as it is disabled', () => {
      const states = sent('OnCombatStateChanged', wolf, at.wolf).map((event) => event.args[1]);
      expect(states[0]).toBe(1);
      expect(states.at(-1)).toBe(0);
    });

    it('sends OnTranslationAlmostComplete, then OnTranslationComplete, to the moved dagger', () => {
      const events = sim
        .scriptEvents({ target: moved, since: at.translate })
        .map((event) => event.event);
      expect(events).toEqual(['OnTranslationAlmostComplete', 'OnTranslationComplete']);
    });

    it('sends OnPackageEnd(the package) to the actors whose package ends', () => {
      const ends = sent('OnPackageEnd');
      expect(ends.length).toBeGreaterThan(0);
      for (const end of ends) expect(end.args).toEqual([{ form: expect.any(Number) as number }]);
    });

    it('sends OnTrackedStatsEvent(stat, value) to the registered scripts as a kill is counted', () => {
      const tracked = sim.scriptEvents({ event: 'OnTrackedStatsEvent', since: at.kill });
      expect(tracked.length).toBeGreaterThan(0);
      for (const event of tracked) {
        expect(typeof event.args[0]).toBe('string');
        expect(typeof event.args[1]).toBe('number');
      }
    });
  },
);
