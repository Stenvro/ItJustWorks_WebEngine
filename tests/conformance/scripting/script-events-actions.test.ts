// Conformance: the scripts' events of the player's own actions and of the engine's own work
// (engine map: Scripting > Script events), in the headless simulation. Each is raised by the
// engine path that raises it in the game: an object coming into being (OnInit), a book read as
// the book menu opens it, an item sold through the barter menu's model, a sleep through the
// sleep and wait menu's passing of the hours, a strongbox searched and closed, a bowl taken
// hold of (Activate held), a ward cast by the player's hand and hit by a spell, a bow drawn
// and let go, a translation asked of a reference not loaded, a package left as the AI picks
// another for the hour, a fast travel through the map's journey. Skipped without game data.
//
// Sources: the base scripts' declarations (Form, ObjectReference, Actor .pex) for each event's
// arguments, the Creation Kit's event pages for when each is sent, and the data (Skyrim.esm):
// - TG01BersiDwemerUrn [0004FCDD] carries TG01BersiDwemerUrnScript (OnInit on PlaceAtMe);
// - SkillBlock5 [0002F83C] teaches Block (a skill book);
// - FoodApple [00064B2E]: Hulda [0001A66E], the Bannered Mare's innkeeper, buys food;
// - TGRStrongbox [000EA737] in the Bannered Mare (locked: unlocked by a script first);
// - BasicWoodenBowl01 [0003199A]: a loose object;
// - WardLesser [00013018] (concentration), Firebolt [00012FD0] (fire and forget);
// - HuntingBow [00013985], IronArrow [0001397D];
// - Carlotta Valentia [0001A675] is in the Bannered Mare from 19:00 for 3 hours
//   (WhiterunCarlottaBanneredMare19x3 [0002C3B1]), then goes home (WhiterunCarlottaHomePackage);
// - the lever [00077C50] in Blind Cliff Cave (not loaded here);
// - Riverwood's map marker [000162A4];
// - PlayerSleepQuest registers for sleep (RegisterForSleep: OnSleepStart, OnSleepStop).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const BERSI_URN = 0x4fcdd;
const SKILL_BOOK = 0x2f83c;
const APPLE = 0x64b2e;
const HULDA = 0x1a66e;
const STRONGBOX = 0xea737;
const BOWL = 0x3199a;
const WARD = 0x13018;
const FIREBOLT = 0x12fd0;
const HUNTING_BOW = 0x13985;
const IRON_ARROW = 0x1397d;
const CARLOTTA = 0x1a675;
const CARLOTTA_INN_PACKAGE = 0x2c3b1;
const BLIND_CLIFF_LEVER = 0x77c50;
const RIVERWOOD_MARKER = 0x162a4;

describe.skipIf(!hasGamedata())(
  'the events of the player’s actions and of the engine’s own work (headless simulation)',
  () => {
    let sim: Sim;
    let urn = 0;
    let book = 0;
    let apple = 0;
    let bowl = 0;
    let opened = false;
    let sold = false;
    /** When each part began (seconds on the simulation's clock). */
    const at = {
      bow: 0,
      place: 0,
      read: 0,
      sell: 0,
      sleep: 0,
      search: 0,
      grab: 0,
      ward: 0,
      translate: 0,
      hour: 0,
      travel: 0,
    };

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(2);
      const { runtime } = sim;
      const handle = (reference: number): ObjectHandle => {
        const value = runtime.referenceHandle(reference);
        if (!(value instanceof ObjectHandle)) throw new Error('no reference');
        return value;
      };

      // A bow drawn and let go, then put away.
      await runtime.addItem(PLAYER_REF, runtime.formHandle(HUNTING_BOW), 1, true);
      await runtime.addItem(PLAYER_REF, runtime.formHandle(IRON_ARROW), 10, true);
      await sim.equip(IRON_ARROW);
      await sim.equip(HUNTING_BOW);
      // (The bow's model and the arrow's projectile load meanwhile.)
      await sim.step(3);
      at.bow = sim.time;
      await sim.attack(2.5);
      await sim.step(2);
      sim.press('Ready Weapon', true);
      await sim.step(0.1);
      sim.press('Ready Weapon', false);
      await sim.step(2);

      // A scripted urn comes into being (PlaceAtMe).
      at.place = sim.time;
      urn = await sim.place(BERSI_URN, PLAYER_REF);
      await sim.step(1);

      // A skill book put down and read where it lies (the book menu opening it).
      book = await sim.place(SKILL_BOOK, PLAYER_REF);
      await sim.step(1);
      at.read = sim.time;
      opened = await sim.read(SKILL_BOOK, book);
      await sim.step(1);

      // An apple put down, taken, and sold to Hulda (the barter menu's ItemSelect).
      apple = await sim.place(APPLE, PLAYER_REF);
      await sim.step(1);
      await sim.native(handle(PLAYER_REF), 'ObjectReference', 'AddItem', [handle(apple), 1, true]);
      at.sell = sim.time;
      sold = await sim.sell(HULDA, APPLE);
      await sim.step(1);

      // Two hours slept (the sleep menu's OK).
      at.sleep = sim.time;
      await sim.rest(2, true);
      await sim.step(1);

      // The strongbox unlocked by a script, searched (its lid opens and closes).
      await sim.native(handle(STRONGBOX), 'ObjectReference', 'Lock', [false, false]);
      at.search = sim.time;
      sim.activate(STRONGBOX);
      await sim.step(4);

      // A bowl put down; the player steps back and takes hold of it, then lets it go.
      bowl = await sim.place(BOWL, PLAYER_REF);
      await sim.step(1);
      const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      const lying = (await sim.position(bowl)) ?? feet;
      // On the bowl's side away from the urn (placed at the player too), so the urn is not in
      // the line of sight; then the bowl settles where it lies once the player has stepped away.
      const urnAt = (await sim.position(urn)) ?? [lying[0], lying[1] + 1, lying[2]];
      const away = Math.atan2(lying[1] - urnAt[1], lying[0] - urnAt[0]);
      await sim.moveTo(
        [lying[0] + 70 * Math.cos(away), lying[1] + 70 * Math.sin(away), feet[2]],
        0,
      );
      await sim.step(1);
      at.grab = sim.time;
      await sim.grab(bowl, 2);
      await sim.step(1);

      // The player raises a ward by hand, facing Hulda, who casts a firebolt at them.
      await runtime.equipment.equipSpell(PLAYER_REF, WARD, 1);
      await sim.step(0.5);
      const hulda = await sim.position(HULDA);
      if (hulda) sim.look(hulda);
      at.ward = sim.time;
      await sim.attack(0.1);
      sim.press('Right Attack/Block', true);
      await sim.step(1);
      // Hulda's firebolt, flown from part of the way to the player: from her own hand it can meet
      // what stands about her at the counter, by how she leans as it leaves.
      const firebolt = await runtime.magic.item(FIREBOLT);
      const standing = await sim.position(PLAYER_REF);
      if (firebolt && standing && hulda) {
        const aim: [number, number, number] = [standing[0], standing[1], standing[2] + 90];
        const away = Math.hypot(hulda[0] - aim[0], hulda[1] - aim[1]);
        const origin: [number, number, number] = [
          aim[0] + ((hulda[0] - aim[0]) / away) * 200,
          aim[1] + ((hulda[1] - aim[1]) / away) * 200,
          aim[2],
        ];
        await sim.world.stage.projectiles.launch(
          await runtime.casting.scripted(HULDA, firebolt),
          origin,
          [aim[0] - origin[0], aim[1] - origin[1], 0],
          { target: PLAYER_REF },
        );
      }
      await sim.step(2);
      sim.press('Right Attack/Block', false);
      await sim.step(1);

      // A script asks a reference far from here (not loaded) to move.
      at.translate = sim.time;
      await sim.native(
        handle(BLIND_CLIFF_LEVER),
        'ObjectReference',
        'TranslateTo',
        [0, 0, 0, 0, 0, 0, 100, 0],
      );
      await sim.step(0.5);

      // Carlotta comes in for the evening; the clock reaches 22:00, where her schedule's next
      // package begins: the AI's own evaluation picks it.
      sim.setHour(20);
      await sim.step(6);
      at.hour = sim.time;
      sim.setHour(22);
      await sim.step(6);

      // Fast travel to Riverwood (the map's journey).
      at.travel = sim.time;
      await sim.fastTravel(RIVERWOOD_MARKER);
      await sim.step(1);
    }, 900_000);
    afterAll(async () => {
      await sim.close();
    });

    /** The events sent to an object's own scripts (not to the aliases holding it). */
    const sent = (event: string, target?: number, since = 0, until = Infinity) =>
      sim
        .scriptEvents({ event, ...(target !== undefined && { target }), since })
        .filter((record) => record.at < until && record.alias === undefined);

    it('sends the urn OnInit as it comes into being (PlaceAtMe)', () => {
      expect(sent('OnInit', urn, at.place, at.read)).toHaveLength(1);
    });

    it('sends the book OnRead as the player reads it where it lies', () => {
      expect(opened).toBe(true);
      expect(sent('OnRead', book, at.read, at.sell).map((e) => e.args)).toEqual([[]]);
    });

    it('sends the apple OnSell(the player) as the player sells it to Hulda', () => {
      expect(sold).toBe(true);
      expect(sent('OnSell', apple, at.sell, at.sleep).map((e) => e.args)).toEqual([
        [{ form: PLAYER_REF }],
      ]);
    });

    it('sends those registered for sleep OnSleepStart(start, end), then OnSleepStop(false)', () => {
      const start = sent('OnSleepStart', undefined, at.sleep, at.search);
      const stop = sent('OnSleepStop', undefined, at.sleep, at.search);
      expect(start.length).toBeGreaterThan(0);
      const [from, to] = start[0]?.args as [number, number];
      // Two hours, in game days.
      expect(to - from).toBeCloseTo(2 / 24, 5);
      expect(stop.map((event) => event.args)).toEqual(start.map(() => [false]));
      expect(stop[0]?.at ?? 0).toBeGreaterThanOrEqual(start[0]?.at ?? Infinity);
    });

    it('sends the strongbox OnOpen, then OnClose(the player), as it is searched', () => {
      const events = sim
        .scriptEvents({ target: STRONGBOX, since: at.search })
        .filter((event) => event.at < at.grab)
        .filter((event) => event.event === 'OnOpen' || event.event === 'OnClose');
      expect(events.map((event) => [event.event, event.args])).toEqual([
        ['OnOpen', [{ form: PLAYER_REF }]],
        ['OnClose', [{ form: PLAYER_REF }]],
      ]);
    });

    it('sends the bowl OnGrab as the player takes hold of it, OnRelease as they let go', () => {
      const events = sim
        .scriptEvents({ target: bowl, since: at.grab })
        .filter((event) => event.at < at.ward)
        .map((event) => event.event)
        .filter((event) => event === 'OnGrab' || event === 'OnRelease');
      expect(events).toEqual(['OnGrab', 'OnRelease']);
    });

    it('sends the player OnSpellCast(the ward) as their hand casts it', () => {
      expect(
        sent('OnSpellCast', PLAYER_REF, at.ward, at.translate).map((e) => e.args),
      ).toContainEqual([{ form: WARD }]);
    });

    it('sends the player OnWardHit(Hulda, the firebolt, absorbed or broken) as it meets the ward', () => {
      const hits = sent('OnWardHit', PLAYER_REF, at.ward, at.translate);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.args.slice(0, 2)).toEqual([{ form: HULDA }, { form: FIREBOLT }]);
      expect([1, 2]).toContain(hits[0]?.args[2]);
    });

    it('sends the player OnPlayerBowShot(the bow, the arrow, its draw, false) as the arrow flies', () => {
      const shots = sent('OnPlayerBowShot', PLAYER_REF, at.bow, at.place);
      expect(shots).toHaveLength(1);
      expect(shots[0]?.args.slice(0, 2)).toEqual([{ form: HUNTING_BOW }, { form: IRON_ARROW }]);
      expect(shots[0]?.args[2] as number).toBeGreaterThan(0);
      expect(shots[0]?.args[3]).toBe(false);
    });

    it('sends OnTranslationFailed at once to a reference asked to move without its 3D', () => {
      expect(sent('OnTranslationFailed', BLIND_CLIFF_LEVER, at.translate, at.hour)).toHaveLength(1);
    });

    it('sends Carlotta OnPackageChange(her inn package) as the AI picks her next one at 22:00', () => {
      expect(sent('OnPackageChange', CARLOTTA, at.hour, at.travel).map((e) => e.args)).toEqual([
        [{ form: CARLOTTA_INN_PACKAGE }],
      ]);
    });

    it('sends the player OnPlayerFastTravelEnd(the hours) as they arrive in Riverwood', () => {
      const ends = sent('OnPlayerFastTravelEnd', PLAYER_REF, at.travel);
      expect(ends).toHaveLength(1);
      expect(ends[0]?.args[0] as number).toBeGreaterThanOrEqual(0);
    });
  },
);
