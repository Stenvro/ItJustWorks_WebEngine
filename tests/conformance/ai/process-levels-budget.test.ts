// Conformance: the process levels and their budget (engine map: AI > Process levels, budget).
//
// Sources:
// - The budget rule, observed in the original (src/ai/process-levels.ts): the process lists'
//   update gets fProcessListsUpdateTimeMax ms a frame at fProcessListsUpdateHighFrameRate frames a
//   second or more, fProcessListsUpdateTimeMin below fProcessListsUpdateLowFrameRate, and
//   (Min + Max) × frame rate / (Low + High) between.
// - The settings' built-in values ([General], the engine's defaults): fProcessListsUpdateTimeMin 0.5,
//   fProcessListsUpdateTimeMax 5, fProcessListsUpdateLowFrameRate 10, …HighFrameRate 30,
//   iLowProcessingMilliseconds 2, bRunMiddleLowLevelProcess 1; Skyrim_Default.ini sets none.
// - The levels: CommonLibSSE ProcessLists (high, middle-high, middle-low, low actor handles).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_DEFAULTS } from '../../../src/ai/ai-settings.ts';
import {
  processLevel,
  ProcessLevel,
  processListsBudget,
  ProcessSlicer,
} from '../../../src/ai/process-levels.ts';
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

describe('process levels: the level of an actor', () => {
  it('puts the loaded area’s actors near the player in the high process, the farther ones in the middle-high', () => {
    expect(processLevel({ loaded: true, distance: 1000 })).toBe(ProcessLevel.high);
    expect(processLevel({ loaded: true, distance: 5000 })).toBe(ProcessLevel.middleHigh);
  });

  it('keeps an actor in the high process a little beyond the edge it came in by (no churn)', () => {
    expect(processLevel({ loaded: true, distance: 4500, wasHigh: true })).toBe(ProcessLevel.high);
    expect(processLevel({ loaded: true, distance: 4500, wasHigh: false })).toBe(
      ProcessLevel.middleHigh,
    );
    expect(processLevel({ loaded: true, distance: 6000, wasHigh: true })).toBe(
      ProcessLevel.middleHigh,
    );
  });

  it('keeps an actor in combat, a scene, dialogue or head tracking in the high process', () => {
    expect(processLevel({ loaded: true, distance: 20000, kept: true })).toBe(ProcessLevel.high);
  });

  it('puts actors outside the loaded area in the middle-low process near the player, else the low', () => {
    expect(processLevel({ loaded: false, distance: 0, nearby: true })).toBe(ProcessLevel.middleLow);
    expect(processLevel({ loaded: false, distance: 0 })).toBe(ProcessLevel.low);
  });
});

describe('process levels: the middle-high process’s turns within the budget', () => {
  const FRAME = 1 / 60;
  /** Ten middle-high actors whose updates cost 1 ms each, two of the high process. */
  function setUp(): {
    slicer: ProcessSlicer;
    frame: () => { updated: number[]; owed: Map<number, number> };
  } {
    let now = 0;
    const slicer = new ProcessSlicer(() => now);
    const levels = new Map<number, ProcessLevel>();
    for (let reference = 1; reference <= 10; reference++) {
      levels.set(reference, ProcessLevel.middleHigh);
    }
    levels.set(100, ProcessLevel.high);
    levels.set(101, ProcessLevel.high);
    const frame = (): { updated: number[]; owed: Map<number, number> } => {
      slicer.begin(levels, 3);
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

  it('updates the high process every frame, the middle-high round-robin as their cost fits', () => {
    const { frame } = setUp();
    // Their cost not yet known: all have a turn, and it is measured.
    expect(frame().updated).toHaveLength(12);
    expect(frame().updated).toEqual([1, 2, 3, 100, 101]);
    expect(frame().updated).toEqual([4, 5, 6, 100, 101]);
    expect(frame().updated).toEqual([7, 8, 9, 100, 101]);
    // The list's cursor wraps round.
    expect(frame().updated).toEqual([1, 2, 10, 100, 101]);
  });

  it('gives each turn the time owed since its last', () => {
    const { frame } = setUp();
    frame();
    frame();
    const third = frame();
    expect(third.owed.get(4)).toBeCloseTo(2 * FRAME, 9);
    expect(third.owed.get(100)).toBeCloseTo(FRAME, 9);
  });

  it('gives at least one turn a frame however small the budget', () => {
    const slicer = new ProcessSlicer(() => 0);
    const levels = new Map<number, ProcessLevel>([[7, ProcessLevel.middleHigh]]);
    slicer.begin(levels, 0);
    expect([...slicer.turns]).toEqual([7]);
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
