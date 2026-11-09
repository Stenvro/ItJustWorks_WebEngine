// Conformance: an actor's first search and its first spectating (engine map: AI > Detection,
// reactions), in the headless simulation. An actor whose running package lets it react (its
// interrupt flags: Reaction To Player Actions for searching, Observe Combat Behavior for
// spectating) reacts the first time it hears a noise of the player or notices a fight, as on
// every later occasion; the reactions end by their settings and give the actor back to its
// package. A spectator whose alias names a spectator override package list (SPOR) runs that
// list instead, for as long as the engine's spectating would last. Skipped without game data.
//
// Sources:
// - The interrupt flags (PKDT, xEdit TES5: 0x4 Observe Combat Behavior, 0x10 Reaction To Player
//   Actions) and the general flag No Combat Alert (0x8000000).
// - The settings, the load order's else the engine's built-in ones (src/ai/detection.ts):
//   fDetectEventDistancePlayer (1536) and the noise's level (eventLevel); fSneakMaxDistance ×
//   fSneakExteriorDistanceMult (3000 outdoors): how far an actor notices another;
//   fDetectionStateExpireTime (30, built in) bounds a search; fCombatSearchLocationInvestigate-
//   Distance (256, built in): the searcher goes this near the noise; fAIExteriorSpectatorDetection
//   (1000, built in): how far a fight is noticed; fAIExteriorSpectatorDistance (450, built in): how
//   far a spectator keeps from it; fAISpectatorRememberThreatTimer (5 in Skyrim.esm): it watches
//   until the fight's last blow is that old (docs/ai.md, Detection).
// - The reactions run as the running package's flags allow at once: no record is read for them
//   first, so the first occasion is not lost (as it was while the senses read the package's
//   record before the first reaction of each package).
// - Inferred (TODO(M13) in src/shell/actor-senses.ts): a spectator's override list lasts as the
//   engine's spectating does (within fDetectionStateExpireTime), by the fight it watches.
// - The data (Skyrim.esm): DB09Noble1 [0005A92D] runs DefaultStayAtEditorLocation [00025BFC],
//   whose interrupt flags are 0xFEFF (both reactions allowed) and whose general flags lack No
//   Combat Alert. Brenuin [00013BA7] and a second DB09Noble1 are the fight's two sides. Tamriel
//   2,-3 is open tundra west of Whiterun. ccBGSSSE025-AdvDSGS.esm (Saints & Seducers, in every
//   install's Skyrim.ccc): the alias ElytraMania (3) of ccBGSSSE025_ElytraPetAcquisition_Mania
//   names the spectator list ccBGSSSE025_CombatOverride.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDetectionSettings, type DetectionSettings } from '../../../src/ai/detection.ts';
import { InterruptFlag, PackageFlag } from '../../../src/ai/package-records.ts';
import { Layer } from '../../../src/physics/collision-layers.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { CELL_SIZE } from '../../../src/world/land.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const TAMRIEL = 0x3c;
const CELL: readonly [number, number] = [2, -3];
const OBSERVER = 0x5a92d;
const BRENUIN = 0x13ba7;
const STAY_AT_EDITOR_LOCATION = 0x25bfc;
/** iSoundLevelLoud's level (SoundLevel.loud). */
const LOUD = 0;
/** The player stands this far behind the searcher: beyond its reach (3000 outdoors). */
const PLAYER_AWAY = 3500;
const ELYTRA_QUEST = 'ccBGSSSE025_ElytraPetAcquisition_Mania';
const ELYTRA_ALIAS = 3;
const ELYTRA_SPECTATOR_LIST = 'ccBGSSSE025_CombatOverride';

interface Tundra {
  sim: Sim;
  observer: number;
  settings: DetectionSettings;
  ground: (at: readonly [number, number]) => number | undefined;
}

/** Opens the tundra with the observer placed at the player. */
async function openTundra(): Promise<Tundra> {
  const sim = await openSim({ hour: 10 });
  const land = await (await sim.world.session.worldspace(TAMRIEL)).land(CELL[0], CELL[1]);
  const x = (CELL[0] + 0.5) * CELL_SIZE;
  const y = (CELL[1] + 0.5) * CELL_SIZE;
  const middle = land ? land.heights[Math.floor(land.heights.length / 2)] : undefined;
  await sim.world.openExterior(TAMRIEL, {
    arrival: { position: [x, y, (middle ?? 0) + 10], heading: 0 },
  });
  await sim.step(2);
  const settings = readDetectionSettings(await sim.world.session.settings());
  const physics = sim.world.play?.physics;
  if (!physics) throw new Error('no physics');
  const ground = (at: readonly [number, number]): number | undefined =>
    physics.raycast([at[0], at[1], 10_000], [0, 0, -1], 20_000, Layer.charController)?.point[2];
  const observer = await sim.place(OBSERVER, PLAYER_REF);
  await sim.step(2);
  return { sim, observer, settings, ground };
}

/** A point `distance` from `from` at a heading (radians clockwise from north), on the ground. */
function along(from: Vec3, heading: number, distance: number, ground: Tundra['ground']): Vec3 {
  const x = from[0] + Math.sin(heading) * distance;
  const y = from[1] + Math.cos(heading) * distance;
  return [x, y, ground([x, y]) ?? from[2]];
}

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Two fighters placed 250 units before the observer, 100 apart; the player 1500 behind it. */
async function stageFight(
  tundra: Tundra,
): Promise<{ attacker: number; victim: number; at: Vec3; from: number }> {
  const { sim, observer, ground } = tundra;
  const staged = sim.actor(observer);
  const feet = await sim.position(observer);
  if (!staged || !feet) throw new Error('the observer has no place');
  const heading = staged.heading;
  const middle = along(feet, heading, 250, ground);
  const left = along(middle, heading - Math.PI / 2, 50, ground);
  const right = along(middle, heading + Math.PI / 2, 50, ground);
  await sim.moveTo([left[0], left[1], left[2] + 5]);
  const attacker = await sim.place(BRENUIN, PLAYER_REF);
  await sim.moveTo([right[0], right[1], right[2] + 5]);
  const victim = await sim.place(OBSERVER, PLAYER_REF);
  const behind = along(feet, heading + Math.PI, 1500, ground);
  await sim.moveTo([behind[0], behind[1], behind[2] + 5]);
  // Long enough for the observer's detection to weigh them (and its profile to be read).
  await sim.step(5);
  const a = await sim.position(attacker);
  const b = await sim.position(victim);
  if (!a || !b) throw new Error('the fighters have no place');
  const at: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2]];
  return { attacker, victim, at, from: flat((await sim.position(observer)) ?? feet, at) };
}

describe.skipIf(!hasGamedata())(
  'the first noise of the player an actor hears: it searches (headless simulation)',
  () => {
    let tundra: Tundra;
    let interrupts = 0;
    let flags = 0;
    let runningBefore: number | undefined;
    let heard: readonly number[] = [];
    let first: string | undefined;
    let startDistance = NaN;
    let least = Infinity;
    let heldWhile = false;
    let endedAfter = NaN;
    let foundThePlayer = true;
    let runningAfter: number | undefined;
    let heldAfter = true;

    beforeAll(async () => {
      tundra = await openTundra();
      const { sim, observer, settings, ground } = tundra;
      const ai = sim.world.stage.ai;
      const senses = sim.world.stage.senses;
      const running = ai.current(observer);
      runningBefore = running?.id;
      interrupts = running?.interrupts ?? 0;
      flags = running?.flags ?? 0;
      const staged = sim.actor(observer);
      const feet = await sim.position(observer);
      if (!staged || !feet) throw new Error('the observer has no place');
      // The player steps away behind the actor, beyond its reach (it cannot find them); the
      // noise is theirs, 500 units before it.
      const behind = along(feet, staged.heading + Math.PI, PLAYER_AWAY, ground);
      await sim.moveTo([behind[0], behind[1], behind[2] + 5]);
      await sim.step(3);
      const noiseAt = along(feet, staged.heading, 500, ground);
      startDistance = flat((await sim.position(observer)) ?? feet, noiseAt);
      heard = senses.noise(noiseAt, PLAYER_REF, LOUD);
      first = senses.reacting(observer);
      for (let time = 0; time < settings.stateExpireTime + 10; time += 0.25) {
        await sim.step(0.25);
        const here = await sim.position(observer);
        if (here) least = Math.min(least, flat(here, noiseAt));
        if (senses.reacting(observer) === 'search') {
          if (ai.held(observer)) heldWhile = true;
          continue;
        }
        endedAfter = time + 0.25;
        foundThePlayer = senses.detections.detects(observer, PLAYER_REF);
        break;
      }
      await sim.step(1);
      runningAfter = ai.current(observer)?.id;
      heldAfter = ai.held(observer);
    }, 600_000);
    afterAll(async () => {
      await tundra.sim.close();
    });

    it('the actor runs DefaultStayAtEditorLocation, whose flags let it react to the player', () => {
      expect(runningBefore).toBe(STAY_AT_EDITOR_LOCATION);
      expect(interrupts & InterruptFlag.reactionToPlayerActions).not.toBe(0);
      expect(flags & PackageFlag.noCombatAlert).toBe(0);
    });

    it('it hears the loud noise 500 units off, within fDetectEventDistancePlayer', () => {
      expect(startDistance).toBeLessThan(tundra.settings.eventDistancePlayer);
      expect(heard).toContain(tundra.observer);
    });

    it('it searches on the first noise it hears (its first reaction), its package held', () => {
      expect(first).toBe('search');
      expect(heldWhile).toBe(true);
    });

    it('it goes to within fCombatSearchLocationInvestigateDistance of the noise', () => {
      expect(least).toBeLessThan(tundra.settings.searchInvestigateDistance + 64);
    });

    it('it looks round and gives up within fDetectionStateExpireTime; its package goes on', () => {
      // Turned for fCombatSearchLookTime, three looks of fCombatSearchInvestigateTime: the
      // search ends by itself (the player is beyond its reach, never found).
      expect(foundThePlayer).toBe(false);
      expect(endedAfter).toBeGreaterThan(
        tundra.settings.searchLookTime + 3 * tundra.settings.searchInvestigateTime,
      );
      expect(endedAfter).toBeLessThan(tundra.settings.stateExpireTime);
      expect(heldAfter).toBe(false);
      expect(runningAfter).toBe(STAY_AT_EDITOR_LOCATION);
    });
  },
);

describe.skipIf(!hasGamedata())(
  'the first fight an actor notices: it watches it (headless simulation)',
  () => {
    let tundra: Tundra;
    let interrupts = 0;
    let runningBefore: number | undefined;
    let detected = false;
    let first: string | undefined;
    let startDistance = NaN;
    let watched = true;
    let farthest = 0;
    let endedAfter = NaN;
    let runningAfter: number | undefined;
    let heldAfter = true;

    beforeAll(async () => {
      tundra = await openTundra();
      const { sim, observer } = tundra;
      const ai = sim.world.stage.ai;
      const senses = sim.world.stage.senses;
      const running = ai.current(observer);
      runningBefore = running?.id;
      interrupts = running?.interrupts ?? 0;
      const fight = await stageFight(tundra);
      startDistance = fight.from;
      detected =
        senses.detections.detects(observer, fight.attacker) ||
        senses.detections.detects(observer, fight.victim);
      // The blows (combat's attackedBy: 5.2), every half second for 6 seconds; the actor is
      // looked at between them.
      senses.fight(fight.attacker, fight.victim);
      first = senses.reacting(observer);
      for (let blow = 0; blow < 12; blow++) {
        for (let half = 0; half < 2; half++) {
          await sim.step(0.25);
          if (senses.reacting(observer) !== 'spectator') watched = false;
          const here = await sim.position(observer);
          if (here) farthest = Math.max(farthest, flat(here, fight.at));
        }
        senses.fight(fight.attacker, fight.victim);
      }
      for (let time = 0; time < 20; time += 0.25) {
        await sim.step(0.25);
        if (senses.reacting(observer) === 'spectator') continue;
        endedAfter = time + 0.25;
        break;
      }
      await sim.step(1);
      runningAfter = ai.current(observer)?.id;
      heldAfter = ai.held(observer);
    }, 600_000);
    afterAll(async () => {
      await tundra.sim.close();
    });

    it('the actor’s package lets it observe combat; it sees the fight within fAIExteriorSpectatorDetection', () => {
      expect(runningBefore).toBe(STAY_AT_EDITOR_LOCATION);
      expect(interrupts & InterruptFlag.observeCombatBehavior).not.toBe(0);
      expect(detected).toBe(true);
      expect(startDistance).toBeLessThan(tundra.settings.spectatorDetectionExterior);
    });

    it('it watches on the first blow it notices (its first reaction), while the blows go on', () => {
      expect(first).toBe('spectator');
      expect(watched).toBe(true);
    });

    it('it backs off to about fAIExteriorSpectatorDistance from the fight', () => {
      expect(startDistance).toBeLessThan(tundra.settings.spectatorDistanceExterior - 64);
      expect(farthest).toBeGreaterThan(tundra.settings.spectatorDistanceExterior - 64);
    });

    it('it watches until the last blow is fAISpectatorRememberThreatTimer old, then goes back to its package', () => {
      const remember = tundra.settings.spectatorRememberTimer;
      expect(endedAfter).toBeGreaterThanOrEqual(remember);
      expect(endedAfter).toBeLessThanOrEqual(remember + 0.5);
      expect(heldAfter).toBe(false);
      expect(runningAfter).toBe(STAY_AT_EDITOR_LOCATION);
    });
  },
);

describe.skipIf(!hasGamedata())(
  'a spectator whose alias names a spectator list runs it while it watches (headless simulation)',
  () => {
    let tundra: Tundra;
    let list = 0;
    let started = false;
    let first: string | undefined;
    let firstList: number | undefined;
    let watched = true;
    let listed = true;
    let endedAfter = NaN;
    let listAfter: number | undefined;

    beforeAll(async () => {
      tundra = await openTundra();
      const { sim, observer } = tundra;
      const senses = sim.world.stage.senses;
      const quest = await sim.formId('QUST', ELYTRA_QUEST);
      list = await sim.formId('FLST', ELYTRA_SPECTATOR_LIST);
      // The quest runs and its alias holds the actor (Quest.Start, ReferenceAlias.ForceRefTo).
      await sim.native(sim.runtime.formHandle(quest), 'Quest', 'Start', []);
      started = sim.runtime.state.quests.get(quest)?.running === true;
      await sim.native(
        new ObjectHandle(quest, 'referencealias', ELYTRA_ALIAS),
        'ReferenceAlias',
        'ForceRefTo',
        [sim.runtime.referenceHandle(observer)],
      );
      const fight = await stageFight(tundra);
      senses.fight(fight.attacker, fight.victim);
      first = senses.reacting(observer);
      firstList = senses.overridePackages(observer);
      for (let blow = 0; blow < 8; blow++) {
        for (let half = 0; half < 2; half++) {
          await sim.step(0.25);
          if (senses.reacting(observer) !== 'spectator') watched = false;
          if (senses.overridePackages(observer) !== list) listed = false;
        }
        senses.fight(fight.attacker, fight.victim);
      }
      for (let time = 0; time < 20; time += 0.25) {
        await sim.step(0.25);
        if (senses.reacting(observer) === 'spectator') continue;
        endedAfter = time + 0.25;
        break;
      }
      listAfter = senses.overridePackages(observer);
    }, 600_000);
    afterAll(async () => {
      await tundra.sim.close();
    });

    it('the quest runs with the actor in its alias', () => {
      expect(started).toBe(true);
    });

    it('on the first blow it runs its spectator list', () => {
      expect(first).toBe('spectator');
      expect(firstList).toBe(list);
    });

    it('the list holds between the blows, while the fight goes on', () => {
      expect(watched).toBe(true);
      expect(listed).toBe(true);
    });

    it('it ends as the engine’s spectating would: the last blow fAISpectatorRememberThreatTimer old', () => {
      const remember = tundra.settings.spectatorRememberTimer;
      expect(endedAfter).toBeGreaterThanOrEqual(remember);
      expect(endedAfter).toBeLessThanOrEqual(remember + 0.5);
      expect(listAfter).toBeUndefined();
    });
  },
);
