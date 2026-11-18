// Conformance: the process levels and their budget (engine map: AI > Process levels, budget).
//
// Sources:
// - The budget rule, observed in the original (src/ai/process-levels.ts): the process lists'
//   update gets fProcessListsUpdateTimeMax ms a frame at fProcessListsUpdateHighFrameRate frames a
//   second or more, fProcessListsUpdateTimeMin below fProcessListsUpdateLowFrameRate, and
//   (Min + Max) × frame rate / (Low + High) between. One deadline the lists share in order: the
//   middle-high list from its cursor (the clock read after every tenth actor, never past the
//   list's end), then the middle-low, then the low with what is left (observed in the original).
// - The settings' built-in values ([General], the engine's defaults): fProcessListsUpdateTimeMin 0.5,
//   fProcessListsUpdateTimeMax 5, fProcessListsUpdateLowFrameRate 10, …HighFrameRate 30,
//   bRunMiddleLowLevelProcess 1; iLowProcessingMilliseconds 2 is registered and never read by
//   the original; Skyrim_Default.ini sets none.
// - The levels: CommonLibSSE ProcessLists (high, middle-high, middle-low, low actor handles);
//   observed in the original: an actor's level follows its cell's state (attached: high;
//   loading or loaded: middle-high; without 3D or its cell not loaded: middle-low or low), with
//   no distance from the player in it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_DEFAULTS } from '../../../src/ai/ai-settings.ts';
import {
  CLOCK_EVERY,
  processLevel,
  ProcessLevel,
  processListsBudget,
  ProcessSlicer,
} from '../../../src/ai/process-levels.ts';
import type { Space } from '../../../src/ai/package-start.ts';
import type { RouteDoor } from '../../../src/ai/routes.ts';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { spacesNextTo, type AwayPlace } from '../../../src/shell/actors-away.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe('process lists: the update budget by frame rate', () => {
  it('gives 5 ms a frame at 30 frames a second and more', () => {
    expect(processListsBudget(1 / 60, AI_DEFAULTS)).toBe(5);
    expect(processListsBudget(1 / 30, AI_DEFAULTS)).toBe(5);
  });

  it('gives 0.5 ms below 10 frames a second', () => {
    expect(processListsBudget(1 / 5, AI_DEFAULTS)).toBe(0.5);
  });

  it('gives (0.5 + 5) × rate / 40 between: 2.75 ms at 20 frames a second', () => {
    expect(processListsBudget(1 / 20, AI_DEFAULTS)).toBeCloseTo(2.75, 6);
    expect(processListsBudget(1 / 10, AI_DEFAULTS)).toBeCloseTo(1.375, 6);
  });
});

describe('process levels: the level of an actor, by its cell', () => {
  it('puts every actor of an attached cell in the high process, however far from the player', () => {
    expect(processLevel({ cell: 'attached' })).toBe(ProcessLevel.high);
    expect(processLevel({ cell: 'attached', shown: true })).toBe(ProcessLevel.high);
  });

  it('puts an actor of a cell loading or loaded but not attached in the middle-high process', () => {
    expect(processLevel({ cell: 'loaded' })).toBe(ProcessLevel.middleHigh);
  });

  it('puts an actor without its 3D in the middle-low process while its cell is loaded', () => {
    expect(processLevel({ cell: 'attached', shown: false })).toBe(ProcessLevel.middleLow);
    expect(processLevel({ cell: 'loaded', shown: false })).toBe(ProcessLevel.middleLow);
  });

  it('puts actors of cells not loaded in the middle-low process near the player, else the low', () => {
    expect(processLevel({ cell: 'unloaded', nearby: true })).toBe(ProcessLevel.middleLow);
    expect(processLevel({ cell: 'unloaded' })).toBe(ProcessLevel.low);
  });
});

describe('process levels: the middle-high list within the budget', () => {
  const FRAME = 1 / 60;
  /** Twenty-five middle-high actors whose updates cost 1 ms each, two of the high process. */
  function setUp(budget: number): {
    slicer: ProcessSlicer;
    frame: () => { updated: number[]; owed: Map<number, number> };
  } {
    let now = 0;
    const slicer = new ProcessSlicer(() => now);
    const levels = new Map<number, ProcessLevel>();
    for (let reference = 1; reference <= 25; reference++) {
      levels.set(reference, ProcessLevel.middleHigh);
    }
    levels.set(100, ProcessLevel.high);
    levels.set(101, ProcessLevel.high);
    const frame = (): { updated: number[]; owed: Map<number, number> } => {
      slicer.begin(levels, budget);
      const updated: number[] = [];
      const owed = new Map<number, number>();
      for (const reference of levels.keys()) {
        slicer.turn('packages', reference, FRAME, (seconds) => {
          now += 1;
          updated.push(reference);
          owed.set(reference, seconds);
        });
      }
      return { updated, owed };
    };
    return { slicer, frame };
  }
  const run = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('reads the clock after every tenth actor: ten a frame past a 3 ms budget, from its cursor on', () => {
    const { frame } = setUp(3);
    // Their cost not yet known: all have a turn, and it is measured.
    expect(frame().updated).toHaveLength(27);
    expect(CLOCK_EVERY).toBe(10);
    expect(frame().updated).toEqual([...run(1, 10), 100, 101]);
    expect(frame().updated).toEqual([...run(11, 20), 100, 101]);
  });

  it('never goes past the list’s end in a frame; the next frame starts it from its first', () => {
    const { frame } = setUp(3);
    frame();
    frame();
    frame();
    // Five left: the list ends there, though the budget would take more.
    expect(frame().updated).toEqual([...run(21, 25), 100, 101]);
    expect(frame().updated).toEqual([...run(1, 10), 100, 101]);
  });

  it('runs the whole list in a frame while its cost is within the budget', () => {
    const { frame } = setUp(30);
    frame();
    expect(frame().updated).toEqual([...run(1, 25), 100, 101]);
  });

  it('gives each turn the time owed since its last', () => {
    const { frame } = setUp(3);
    frame();
    frame();
    const third = frame();
    expect(third.owed.get(15)).toBeCloseTo(2 * FRAME, 9);
    expect(third.owed.get(100)).toBeCloseTo(FRAME, 9);
  });

  it('leaves the low processes what the middle-high list did not take of the budget', () => {
    const { slicer, frame } = setUp(30);
    expect(slicer.left).toBeUndefined();
    frame();
    frame();
    // 25 actors at 1 ms of 30.
    expect(slicer.left).toBeCloseTo(5, 9);
    const tight = setUp(3);
    tight.frame();
    tight.frame();
    expect(tight.slicer.left).toBe(0);
  });

  it('gives at least one turn a frame however small the budget', () => {
    const slicer = new ProcessSlicer(() => 0);
    const levels = new Map<number, ProcessLevel>([[7, ProcessLevel.middleHigh]]);
    slicer.begin(levels, 0);
    expect([...slicer.turns]).toEqual([7]);
  });
});

describe('process levels: the middle-low process’s cells', () => {
  /** A worldspace with two load doors: one in the loaded area, one far off in it. */
  const world: Space = { kind: 'world', world: 0x3c };
  const door = (destination: number, x: number): RouteDoor => ({
    door: destination + 1,
    space: world,
    position: [x, 0, 0],
    navmeshes: [],
    destination,
    arrivalSpace: { kind: 'interior', cell: destination },
    arrival: [0, 0, 0],
    arrivalHeading: 0,
    arrivalNavmeshes: [],
  });
  const routes = { doorsInSpace: () => [door(0x100, 1000), door(0x200, 90000)] };
  const loaded = (place: AwayPlace): boolean => Math.abs(place.position[0]) < 10240;

  it('marks the cells behind the loaded area’s load doors, not those behind every door of the worldspace', () => {
    expect(spacesNextTo(routes, world, loaded)).toEqual([{ kind: 'interior', cell: 0x100 }]);
  });
});

/** The Bannered Mare (Whiterun): the player waits there. */
const BANNERED_MARE = 0x1605e;
/** Whiterun's worldspace. */
const WHITERUN = 0x1a26f;
/** CarlottaValentinaREF: at home before 8, at her market stall from 8 (WhiterunCarlottaMarketplace8x11). */
const CARLOTTA = 0x1a675;
/** The marker her market package sends her to (the package's Sit Location). */
const CARLOTTA_STALL = 0x2be20;

describe.skipIf(!hasGamedata())('actors away: the low process (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 6 });
    await sim.step(1);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('has a shopkeeper two doors from the player at her market stall once the clock passes her hour', async () => {
    // At 6 she is at home: an interior two load doors from the inn (through Whiterun).
    const home = await sim.runtime.placement(CARLOTTA, false);
    expect(home?.world).toBeUndefined();
    const homeCell = home?.cell;
    sim.setHour(9);
    const there = await sim.until(() => sim.world.stage.away.scheduling.last?.far === true, 30);
    expect(there).toBe(true);
    const at = await sim.runtime.placement(CARLOTTA, false);
    expect(at?.cell).not.toBe(homeCell);
    expect(at?.world).toBe(WHITERUN);
    const stall = await sim.runtime.placement(CARLOTTA_STALL, false);
    expect(
      stall &&
        at &&
        Math.hypot(at.position[0] - stall.position[0], at.position[1] - stall.position[1]),
    ).toBeLessThan(512);
  }, 120_000);
});

describe.skipIf(!hasGamedata())('process levels: Whiterun’s actors (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ exterior: { world: WHITERUN, cell: [4, -2] }, hour: 10 });
    await sim.step(2);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('has the loaded area’s living actors beyond a cell from the player in the high process too', async () => {
    const player = await sim.position(PLAYER_REF);
    if (!player) throw new Error('no player');
    const stage = sim.world.stage;
    const far = sim
      .actors()
      .filter(
        (staged) =>
          !staged.dead &&
          !staged.visibility.hidden &&
          Math.hypot(staged.position[0] - player[0], staged.position[1] - player[1]) > 4096,
      );
    // Whiterun's districts are wider than a cell: some of its people stand farther off.
    expect(far.length).toBeGreaterThan(0);
    for (const staged of far) {
      expect(stage.process.level(staged.reference)).toBe(ProcessLevel.high);
    }
    expect(far.some((staged) => stage.movers.inHighProcess(staged.reference))).toBe(true);
  }, 60_000);
});
