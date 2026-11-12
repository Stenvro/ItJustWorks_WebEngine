// Conformance: frame time (engine map: Animation and bodies > Frame time). One step for the
// whole frame: at a low frame rate every system moves on by the frame timer's step, so actors
// whose graphs update at different rates stay in step, with each other and with the game's
// clock, the scripts' clock and the game's hour. Skipped without game data.
//
// Sources:
// - The rule, observed in the original (src/world/frame-timer.ts; docs/animation.md, "Frame
//   time"): a frame counts at most 1/6 s; with [Display] bCompensateUnstableFrameTime the step
//   is evened out over the last iUnstableFrameTimeHistorySize (8) frames, their sum less the
//   shortest and less the longest's first 0.05 s, over the size less two: 0.95 / 6 s at a steady
//   7 frames a second, 0.65 / 6 s at 10.
// - The data: the Bannered Mare [0001605E] in the evening, its people about the room; the
//   graphs of those before the camera within [Animation] fAnimInterpNearDist update every
//   frame, those behind it every fAnimInterpMaxTime, ahead of the clock.

import { describe, expect, it } from 'vitest';
import { shownProgress } from '../../../src/animation/animated-skeleton.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;
/** Frames run at the rate before measuring: the timer's history holds that rate alone. */
const LEAD_IN = 10;
const SECONDS = 5;

/** The game's hour clock in seconds of the game's day count. */
function hourSeconds(sim: Sim): number {
  const session = sim.world.session;
  return (session.gameDaysPassed * 24 + session.gameHour) * 3600;
}

describe.skipIf(!hasGamedata())('one step for the whole frame (original)', () => {
  for (const [rate, step] of [
    [7, 0.95 / 6],
    [10, 0.65 / 6],
  ] as const) {
    it(`keeps two actors’ graphs, the clocks and the hour in step at ${String(rate)} frames a second`, async () => {
      const sim = await openSim({ interior: BANNERED_MARE, hour: 20 });
      try {
        await sim.step(2);
        // Beside Hulda, facing her: she is near and before the camera, others are behind it.
        const hulda = await sim.position(HULDA);
        expect(hulda).toBeDefined();
        if (!hulda) return;
        const [px, py] = sim.world.player.feet;
        const away = Math.hypot(px - hulda[0], py - hulda[1]) || 1;
        await sim.moveTo([
          hulda[0] + ((px - hulda[0]) / away) * 150,
          hulda[1] + ((py - hulda[1]) / away) * 150,
          hulda[2],
        ]);
        sim.look([hulda[0], hulda[1], hulda[2] + 100]);
        await sim.step(1);
        sim.look([hulda[0], hulda[1], hulda[2] + 100]);
        const frame = 1 / rate;
        for (let i = 0; i < LEAD_IN; i++) await sim.step(frame, frame);
        // Those whose graphs run (one whose graph has not is not animated: it stays out).
        const actors = sim
          .actors()
          .filter((staged) => !staged.dead && shownProgress(staged.placed) !== undefined);
        const from = new Map(actors.map((staged) => [staged, shownProgress(staged.placed) ?? 0]));
        const clock = sim.time;
        const scripts = sim.runtime.state.realTime;
        const hour = hourSeconds(sim);
        const ahead = new Set<(typeof actors)[number]>();
        const frames = SECONDS * rate;
        for (let i = 0; i < frames; i++) {
          sim.look([hulda[0], hulda[1], hulda[2] + 100]);
          await sim.step(frame, frame);
          // The frame's step is the timer's for this rate, the same for every frame.
          expect(sim.world.frameStep, `frame ${String(i)}`).toBeCloseTo(step, 9);
          for (const staged of actors)
            if ((staged.placed.time ?? 0) > sim.time + 1e-6) ahead.add(staged);
        }
        // The game's clock, the scripts' and the game's hour moved on by the frames' steps: a
        // little more than the real clock's 5 s.
        const passed = sim.time - clock;
        expect(passed).toBeCloseTo(frames * step, 6);
        expect(passed).toBeGreaterThan(SECONDS);
        expect(sim.runtime.state.realTime - scripts).toBeCloseTo(passed, 6);
        expect((hourSeconds(sim) - hour) / sim.world.session.clockRate).toBeCloseTo(passed, 2);
        // Hulda, near and before the camera, is updated every frame; those behind the camera
        // are updated ahead. All of them animated the clock's time: the ones updated every frame
        // to the frame, the ones ahead to within the interval they run ahead by. Before the
        // frame timer (each update every frame cut to 0.1 s), at 7 frames a second Hulda and the
        // three others updated every frame animated 3.5 s of the clock's 5 s and those behind
        // the camera 4.1 to 5.1 s; at 10 a second, frames of exactly 0.1 s, nothing was cut,
        // and with the timer's step of 0.1083 s the old cut left her at 5 s of the clock's 5.42.
        const ran = (staged: (typeof actors)[number]): number =>
          (shownProgress(staged.placed) ?? 0) - (from.get(staged) ?? 0);
        const near = actors.filter((staged) => !ahead.has(staged));
        const far = actors.filter((staged) => ahead.has(staged));
        const her = sim.actor(HULDA);
        expect(her && near.includes(her), 'Hulda updated every frame').toBe(true);
        expect(far.length, 'actors updated ahead').toBeGreaterThan(0);
        const interval = sim.world.session.ini.number('Animation', 'fAnimInterpMaxTime');
        for (const staged of near) {
          const name = staged.reference.toString(16);
          expect(ran(staged), `${name}, updated every frame`).toBeCloseTo(passed, 6);
        }
        for (const staged of far) {
          const name = staged.reference.toString(16);
          const off = Math.abs(ran(staged) - passed);
          expect(off, `${name}, updated ahead`).toBeLessThanOrEqual(interval + 1e-6);
        }
      } finally {
        await sim.close();
      }
    }, 600_000);
  }
});
