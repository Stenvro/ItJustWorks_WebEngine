// Integration test: flying combat on the local game data (docs/ai.md, "Flying combat"): the
// dragons' races, movement types, combat styles, shouts and the flight settings read from the
// plugins; the idle tree's flight actions; the dragon behavior graph flown offline with the
// events the flight sends (take-off, hover, landing, perch, breath), its clips' root motion
// and tweeners moving it. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCombatStyle } from '../src/ai/combat-style-records.ts';
import {
  chooseFlightManeuver,
  fliesByRace,
  headingRotation,
  readFlightSettings,
} from '../src/ai/flight.ts';
import { readIdleTree, type IdleTree } from '../src/ai/idle-records.ts';
import { parseNpcCombat, parseRaceCombat } from '../src/ai/race-combat-records.ts';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { BehaviorRuntime, type BehaviorHost } from '../src/animation/behavior-runtime.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { RaceFlag } from '../src/world/actor-records.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { parseMovementType } from '../src/world/movement.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { CastType, parseShout, parseSpell } from '../src/world/spell-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PROJECT = 'meshes\\actors\\dragon\\dragonproject.hkx';
const DRAGON_RACE = 0x12e82;
const CS_DRAGON = 0x48c83;
const ENC_DRAGON_FIRE = 0x1ca03;

/** The dragon graph flown offline: its root motion moves it, its raised events kept. */
interface Flown {
  readonly runtime: BehaviorRuntime;
  readonly place: { x: number; y: number; z: number; heading: number };
  readonly raised: string[];
  /** Runs it for `seconds` (30 updates a second). */
  run(seconds: number): Promise<void>;
  state(machine: string): string | undefined;
}

describe.skipIf(!hasGamedata())('flying combat on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let tree: IdleTree;
  const record = async (formId: number): Promise<GameRecord> => {
    const found = await db.get(formId);
    if (!found) throw new Error(`no record ${formId.toString(16)}`);
    return found;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    tree = await readIdleTree(db);
  }, 120_000);
  afterAll(async () => {
    await vfs.close();
  });

  it("reads the dragons' race: it flies, its flying movement type and its attacks", async () => {
    const race = parseRaceCombat(await record(DRAGON_RACE));
    expect(fliesByRace(race.flags)).toBe(true);
    expect(race.flags & RaceFlag.walks).not.toBe(0);
    const fly = race.movementTypes.fly;
    expect(fly).toBeDefined();
    const movement = parseMovementType(await record(fly ?? 0));
    expect(movement.editorId).toBe('Dragon_Flying_MT');
    expect(movement.walk.forward).toBe(2000);
    expect(movement.run.forward).toBe(7400);
    expect(movement.rotateWhileMoving).toBeCloseTo(Math.PI / 2, 3);
    expect(race.injuredHealthPct).toBeCloseTo(0.35);
    expect(race.attacks.map((attack) => attack.event)).toEqual(
      expect.arrayContaining(['attackStartBite', 'attackStartTail', 'attackStartWingLeft']),
    );
  });

  it("reads a dragon's combat style and the flight settings", async () => {
    const npc = parseNpcCombat(await record(ENC_DRAGON_FIRE));
    expect(npc.combatStyle).toBe(CS_DRAGON);
    const flight = parseCombatStyle(await record(CS_DRAGON)).flight;
    expect(flight.hoverChance).toBeCloseTo(0.52);
    expect(flight.diveBombChance).toBeCloseTo(0.36);
    expect(flight.groundAttackChance).toBeCloseTo(0.85);
    expect(flight.perchAttackChance).toBeCloseTo(0.5);
    expect(flight.flyingAttackChance).toBeCloseTo(0.75);
    const settings = readFlightSettings(
      (
        (game) => (name: string) =>
          game.number(name)
      )(await GameSettings.read(db)),
    );
    expect(settings.hoverTimeMin).toBe(5.5);
    expect(settings.perchAttackTimeMin).toBe(4);
    expect(settings.groundAttackTimeMin).toBe(8);
    expect(settings.groundAttackTimeMax).toBe(17);
    expect(settings.orbitDistance).toBe(4000);
    // No plugin sets the flight chances' or the orbit time's scale: the engine's own.
    expect(settings.diveBombChanceMax).toBe(1);
    expect(settings.orbitTimeMin).toBe(3);
    expect(settings.orbitTimeMax).toBe(12);
    // Its style chooses every maneuver it has.
    const seen = new Set<string>();
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 200; i++) {
      seen.add(chooseFlightManeuver(flight, { canLand: true, perch: true }, random, settings));
    }
    expect([...seen].sort()).toEqual(['diveBomb', 'hover', 'land', 'orbit', 'perch']);
  });

  it("reads a dragon's breath: its shouts, the fire breath a concentration flame", async () => {
    const npc = await record(ENC_DRAGON_FIRE);
    const shouts: string[] = [];
    let breath: { castType: number; projectile: number | undefined } | undefined;
    for (const data of npc.fields.all('SPLO')) {
      const form = await db.get(npc.formIdAt(data, 0));
      if (form?.type !== 'SHOU') continue;
      const shout = parseShout(form);
      shouts.push(shout.editorId);
      if (shout.editorId !== 'DragonFireBreathShout01') continue;
      const spell = parseSpell(await record(shout.words[0]?.spell ?? 0));
      breath = { castType: spell.castType, projectile: spell.effects[0]?.effect };
    }
    expect(shouts.sort()).toEqual(['DragonFireBallShout01', 'DragonFireBreathShout01']);
    expect(breath?.castType).toBe(CastType.concentration);
  });

  it("finds the flight actions in the dragon's idle tree", () => {
    const events = (action: string): string[] => {
      const found: string[] = [];
      const walk = (parent: number): void => {
        for (const idle of tree.children(parent)) {
          if (idle.event) found.push(idle.event);
          walk(idle.formId);
        }
      };
      const root = tree.action(action);
      if (root) walk(root.formId);
      return found;
    };
    expect(events('ActionFlyStart')).toEqual(
      expect.arrayContaining(['TakeOff', 'TakeOff_Vertical', 'FlyStartHover', 'FlyStartCruise']),
    );
    expect(events('ActionFlyStop')).toEqual(
      expect.arrayContaining([
        'FlyStopDefault',
        'FlyStopCrash',
        'FlyStopHasty',
        'FlyStopInjured',
        'FlyStopPerchTower',
      ]),
    );
    expect(events('ActionHoverStart')).toContain('HoverStart');
    expect(events('ActionHoverStop')).toContain('HoverStop');
    expect(events('ActionVoice')).toEqual(expect.arrayContaining(['shoutStart']));
  });

  /** The dragon graph, flown from the origin facing +y. */
  async function fly(): Promise<Flown> {
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no dragon behavior');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no dragon skeleton');
    const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const data = (await AnimationDataLibrary.load(read)).project('DragonProject');
    const clips = new Map<string, AnimationBinding | undefined>();
    // The clips are read before the graph runs (none waits for its clip as it plays).
    for (const animation of character.animations) {
      const bytes = await read(animation).catch(() => undefined);
      if (bytes) clips.set(animation, readAnimationContainer(Packfile.parse(bytes)).bindings[0]);
    }
    const host: BehaviorHost = {
      clip: (animation) => clips.get(projectRelative(PROJECT, animation)),
      behavior: (name) => files.get(projectRelative(PROJECT, name)),
      rootMotion: (generator, from, to) => data?.rootMotionDelta(generator, from, to),
    };
    const runtime = new BehaviorRuntime({ root, host, skeleton, random: () => 0.5 });
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    runtime.world = { worldFromModel: matrix };
    const place = { x: 0, y: 0, z: 0, heading: 0 };
    const raised: string[] = [];
    return {
      runtime,
      place,
      raised,
      run: (seconds) => {
        for (let t = 0; t < seconds; t += 1 / 30) {
          runtime.update(1 / 30, false);
          raised.push(...runtime.takeRaised().map((event) => event.text));
          // Its root motion moves it (as src/shell/actor-flight.ts moves an animation-driven
          // flier).
          const { translation, yaw } = runtime.rootMotion();
          const [x, y, z] = translation;
          const sin = Math.sin(place.heading);
          const cos = Math.cos(place.heading);
          place.x += x * cos + y * sin;
          place.y += -x * sin + y * cos;
          place.z += z;
          place.heading -= yaw;
          const s = Math.sin(place.heading);
          const c = Math.cos(place.heading);
          matrix.set([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, place.x, place.y, place.z, 1]);
        }
        return Promise.resolve();
      },
      state: (machine) => runtime.states().find((entry) => entry.machine === machine)?.state,
    };
  }

  it('takes off, hovers, breathes and lands where the flight asks', async () => {
    const dragon = await fly();
    const { runtime, place, raised } = dragon;
    await dragon.run(0.2);
    expect(dragon.state('BHR_Default')).toBe('ST_Ground');
    // Take-off (ActionFlyStart's TakeOff): up and away, into its cruise.
    runtime.setVector('TweenRotation', headingRotation(0));
    expect(runtime.sendEvent('TakeOff')).toBe(true);
    await dragon.run(6);
    expect(raised).toEqual(expect.arrayContaining(['FlightTakeOff', 'FlightCruising']));
    expect(dragon.state('BHR_Default')).toBe('ST_Flight');
    expect(place.z).toBeGreaterThan(1500);
    // Hover (ActionHoverStart's HoverStart): the tweener takes it to the hover point.
    const hover = [0, place.y + 3000, place.z - 500] as const;
    runtime.setVector('TweenPosition', [...hover, 0]);
    runtime.setVector('TweenRotation', headingRotation(Math.PI / 2));
    runtime.setVariable('TweenEntryDirection', 0.25);
    raised.length = 0;
    expect(runtime.sendEvent('HoverStart')).toBe(true);
    await dragon.run(4);
    expect(raised).toContain('FlightHovering');
    expect(dragon.state('BHR_Hover')).toBe('ST_Hover_Idle');
    expect(Math.hypot(place.x - hover[0], place.y - hover[1], place.z - hover[2])).toBeLessThan(1);
    expect(place.heading).toBeCloseTo(Math.PI / 2, 2);
    // Its breath (ActionVoice's shoutStart, then ActionVoiceRelease's shoutRelease).
    raised.length = 0;
    expect(runtime.sendEvent('shoutStart')).toBe(true);
    await dragon.run(0.5);
    expect(dragon.state('BHR_Hover_Idle_Neck')).toBe('ST_Hover_Shout_Neck');
    runtime.sendEvent('shoutRelease');
    await dragon.run(3.5);
    expect(raised).toContain('shoutStop');
    expect(dragon.state('BHR_Hover_Idle_Neck')).toBe('ST_Hover_Idle_Neck');
    // Out of the hover (ActionHoverStop) into its cruise again.
    raised.length = 0;
    expect(runtime.sendEvent('HoverStop')).toBe(true);
    await dragon.run(3);
    expect(raised).toContain('FlightCruising');
    // Landing (ActionFlyStop's FlyStopDefault): to its spot on the ground, on its feet there.
    const spot = [place.x + 2048, place.y, 0] as const;
    runtime.setVector('TweenPosition', [...spot, 0]);
    runtime.setVector('TweenRotation', headingRotation(Math.PI / 2));
    runtime.setVariable('TweenEntryDirection', 0);
    raised.length = 0;
    expect(runtime.sendEvent('FlyStopDefault')).toBe(true);
    await dragon.run(7);
    expect(raised).toEqual(expect.arrayContaining(['FlightLanding', 'FlightLanded', 'LandEnd']));
    expect(dragon.state('BHR_Default')).toBe('ST_Ground');
    expect(Math.hypot(place.x - spot[0], place.y - spot[1], place.z - spot[2])).toBeLessThan(1);
  }, 120_000);

  it('lands on a perch and takes off from it again', async () => {
    const dragon = await fly();
    const { runtime, place, raised } = dragon;
    runtime.setVector('TweenRotation', headingRotation(0));
    runtime.sendEvent('TakeOff');
    await dragon.run(6);
    const perch = [0, place.y + 2048, 300] as const;
    runtime.setVector('TweenPosition', [...perch, 0]);
    runtime.setVector('TweenRotation', headingRotation(0));
    raised.length = 0;
    expect(runtime.sendEvent('FlyStopPerchTower')).toBe(true);
    await dragon.run(6);
    expect(raised).toEqual(expect.arrayContaining(['FlightLanding', 'PerchLandEnd']));
    expect(raised).toContain('FlightPerching');
    expect(dragon.state('BHR_Default')).toBe('ST_Perch');
    expect(Math.hypot(place.x - perch[0], place.y - perch[1], place.z - perch[2])).toBeLessThan(1);
    raised.length = 0;
    expect(runtime.sendEvent('TakeOff')).toBe(true);
    await dragon.run(3);
    expect(raised).toContain('FlightTakeOff');
    expect(place.z).toBeGreaterThan(perch[2] + 200);
  }, 120_000);
});
