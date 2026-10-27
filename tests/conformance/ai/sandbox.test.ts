// Conformance: the Sandbox procedure (engine map: AI > Sandbox): what a sandboxing actor does
// next, for how long, and its day's plan.
//
// Sources:
// - The rule, observed in the original (src/ai/sandbox.ts, docs/ai.md "Furniture and idle
//   markers"): an activity's length is fSandboxDurationBase × its kind's fSandboxDurationMult… ×
//   (1 + fSandboxEnergyMult × its kind's fSandboxEnergyMult… × Energy) game hours, ± (1 ±
//   fSandboxDurationRangeMult); the pick is at random weighted by each kind's count of activities
//   since it was last done; the day's plan (sleep, breakfast, lunch, dinner) outweighs all while
//   on (100000; eating standing 100 at a meal).
// - The settings' built-in values: the engine's defaults (fSandboxDurationBase 0.02, Sitting 2,
//   Sleeping 2, Furniture 2, IdleMarker 1, EatSitting 0.75, EatStanding 0.75, Wandering 0.5;
//   fSandboxEnergyMult 0.05, …Sitting −0.1, …Wandering 0.2; fSandboxDurationRangeMult 0.25;
//   breakfast 6–9, lunch 11.5–12.5, dinner 18–19, meals 0.1–0.25 h; sleep from 19–1 for 6–10 h).
//   Skyrim.esm sets fSandboxDurationBase 0.2, …MultFurniture 3, …MultIdleMarker 1.5,
//   …MultEatSitting and …EatStanding 1.5, fSandboxEnergyMultIdleMarker −0.05
//   (`node tools/gmst-info.ts --prefix fSandbox`).
// - The data: `node tools/package-census.ts` (2,874 packages run a Sandbox).

import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS, readAiSettings } from '../../../src/ai/ai-settings.ts';
import type { PackageInput } from '../../../src/ai/package-records.ts';
import type { SandboxSpot } from '../../../src/ai/package-runtime.ts';
import { PROCEDURES } from '../../../src/ai/procedure-runs.ts';
import {
  nextSandboxEvent,
  pickSandbox,
  sandboxDuration,
  sandboxEventOn,
  SandboxKind,
  SandboxPlan,
} from '../../../src/ai/sandbox.ts';
import { pack, packageActor, procedure, tick } from '../../helpers/packages.ts';

/** Skyrim.esm's values of the sandbox's settings (the rest keep the engine's). */
const ESM: Readonly<Record<string, number>> = {
  fSandboxDurationBase: 0.2,
  fSandboxDurationMultFurniture: 3,
  fSandboxDurationMultIdleMarker: 1.5,
  fSandboxDurationMultEatSitting: 1.5,
  fSandboxDurationMultEatStanding: 1.5,
  fSandboxEnergyMultIdleMarker: -0.05,
  fSandboxCylinderBottom: -100,
};
const SKYRIM = readAiSettings((name) => ESM[name]);
const middle = (): number => 0.5;

describe('sandbox: how long an activity lasts', () => {
  it('reads the settings by kind, in the engine’s order', () => {
    expect(AI_DEFAULTS.sandboxDurationMults).toEqual([2, 2, 0.75, 0.75, 0.5, 1, 2]);
    expect(AI_DEFAULTS.sandboxEnergyMults).toEqual([-0.1, -0.1, -0.05, -0.05, 0.2, 0.05, -0.1]);
    expect(SKYRIM.sandboxDurationMults).toEqual([2, 2, 1.5, 1.5, 0.5, 1.5, 3]);
  });

  it('sits 0.3 game hours at Energy 50 (Skyrim.esm: 0.2 × 2 × (1 − 0.05 × 0.1 × 50))', () => {
    expect(sandboxDuration(SandboxKind.sitting, 50, SKYRIM, middle)).toBeCloseTo(0.3, 6);
  });

  it('varies it by fSandboxDurationRangeMult either way (0.225 to 0.375 h)', () => {
    expect(sandboxDuration(SandboxKind.sitting, 50, SKYRIM, () => 0)).toBeCloseTo(0.225, 6);
    expect(sandboxDuration(SandboxKind.sitting, 50, SKYRIM, () => 1)).toBeCloseTo(0.375, 6);
  });

  it('makes an energetic actor wander longer and sit shorter', () => {
    const wander = (energy: number): number =>
      sandboxDuration(SandboxKind.wandering, energy, SKYRIM, middle);
    const sit = (energy: number): number =>
      sandboxDuration(SandboxKind.sitting, energy, SKYRIM, middle);
    // 0.2 × 0.5 × (1 + 0.05 × 0.2 × 100) = 0.2; at 0: 0.1. Sitting at 100: 0.2 × 2 × 0.5 = 0.2.
    expect(wander(100)).toBeCloseTo(0.2, 6);
    expect(wander(0)).toBeCloseTo(0.1, 6);
    expect(sit(100)).toBeCloseTo(0.2, 6);
    expect(sit(0)).toBeCloseTo(0.4, 6);
  });

  it('uses special furniture longest (fSandboxDurationMultFurniture 3: 0.6 h at Energy 0)', () => {
    expect(sandboxDuration(SandboxKind.furniture, 0, SKYRIM, middle)).toBeCloseTo(0.6, 6);
  });
});

describe('sandbox: what it does next', () => {
  it('weighs each kind by the activities begun since it was last done', () => {
    const plan = new SandboxPlan();
    plan.began(SandboxKind.sitting);
    plan.began(SandboxKind.idleMarker);
    expect(plan.counts[SandboxKind.sitting]).toBe(2);
    expect(plan.counts[SandboxKind.idleMarker]).toBe(1);
    expect(plan.counts[SandboxKind.wandering]).toBe(3);
  });

  it('picks at random by those weights', () => {
    const plan = new SandboxPlan();
    plan.began(SandboxKind.sitting);
    plan.began(SandboxKind.idleMarker);
    // Sitting 2, idle marker 1, wandering 3: of 600 even rolls, 200, 100 and 300.
    const candidates = [
      { kind: SandboxKind.sitting, reference: 1 },
      { kind: SandboxKind.idleMarker, reference: 2 },
      { kind: SandboxKind.wandering },
    ];
    const weights = plan.weights(0, 10, { bed: false, seat: true }, SKYRIM, middle);
    const picked = new Map<number, number>();
    for (let i = 0; i < 600; i++) {
      const pick = pickSandbox(candidates, weights, () => (i + 0.5) / 600);
      if (pick) picked.set(pick.kind, (picked.get(pick.kind) ?? 0) + 1);
    }
    expect(Object.fromEntries(picked)).toEqual({
      [SandboxKind.sitting]: 200,
      [SandboxKind.idleMarker]: 100,
      [SandboxKind.wandering]: 300,
    });
  });

  it('caps a count at 255', () => {
    const plan = new SandboxPlan();
    for (let i = 0; i < 300; i++) plan.began(SandboxKind.sitting);
    expect(plan.counts[SandboxKind.wandering]).toBe(255);
  });
});

describe('sandbox: the daily plan', () => {
  it('has lunch next at 10:00 (fSandboxLunchMin..Max 11.5–12.5)', () => {
    const event = nextSandboxEvent(0, 10, SKYRIM, middle);
    expect(event.slot).toBe(2);
    expect(event.start).toBeCloseTo(12, 6);
    expect(event.hours).toBeCloseTo(0.175, 6);
  });

  it('sleeps next in the evening (from 19:00 to 1:00, 6–10 h)', () => {
    const event = nextSandboxEvent(0, 20, SKYRIM, middle);
    expect(event.slot).toBe(0);
    expect(event.start).toBeCloseTo(22, 6);
    expect(event.hours).toBeCloseTo(8, 6);
    expect(sandboxEventOn(event, 0, 23)).toBe(true);
    expect(sandboxEventOn(event, 0, 21)).toBe(false);
  });

  it('makes the event’s kind outweigh all while it is on (a meal: eating sitting 100000)', () => {
    const plan = new SandboxPlan();
    const weights = plan.weights(0, 12.05, { bed: true, seat: true }, SKYRIM, middle);
    expect(weights[SandboxKind.eatSitting]).toBe(100_000);
    expect(weights[SandboxKind.eatStanding]).toBe(100);
    expect(weights[SandboxKind.sitting]).toBe(1);
  });

  it('keeps its counts while the event needs what the sandbox lacks (no bed to sleep in)', () => {
    const plan = new SandboxPlan();
    const weights = plan.weights(0, 23, { bed: false, seat: true }, SKYRIM, middle);
    expect(weights[SandboxKind.sleeping]).toBe(1);
    expect(weights[SandboxKind.wandering]).toBe(1);
  });
});

describe('sandbox: a sandboxing actor’s activities in game time', () => {
  it('stays at what it picked for the game hours of its kind, then picks again', async () => {
    // A sandbox at a place with one chair and one idle marker, Allow Sitting and Idle Markers,
    // Energy 50; the game's clock at 20 game seconds a real one (timescale 20).
    const inputs: PackageInput[] = [
      {
        id: 0,
        type: 'Location',
        value: { kind: 'location', location: { type: 12, form: 0, radius: 500 } },
      },
      { id: 4, type: 'Bool', value: { kind: 'bool', value: true } },
      { id: 5, type: 'Bool', value: { kind: 'bool', value: true } },
      { id: 6, type: 'Bool', value: { kind: 'bool', value: false } },
      { id: 8, type: 'Float', value: { kind: 'float', value: 50 } },
    ];
    const branch = {
      ...procedure('Sandbox'),
      inputs: [0, 255, 255, 255, 4, 5, 6, 255, 8, 255, 255],
    };
    const spots: SandboxSpot[] = [
      { reference: 0x100, kind: 'sit', position: [100, 0, 0] },
      { reference: 0x200, kind: 'idle', position: [-200, 0, 0] },
    ];
    const used: { reference: number; at: number }[] = [];
    const { actor, time } = packageActor([pack(1, branch, { inputs })], PROCEDURES, {
      settings: SKYRIM,
      mind: {
        place: () => Promise.resolve({ position: [0, 0, 0], radius: 500 }),
        around: () => Promise.resolve(spots),
        idleMarker: (reference) =>
          Promise.resolve(
            reference === 0x200
              ? {
                  reference,
                  position: [-200, 0, 0],
                  heading: 0,
                  flags: 0,
                  count: 0,
                  timer: 0,
                  idles: [],
                }
              : undefined,
          ),
      },
      body: {
        useFurniture: (reference) => {
          used.push({ reference, at: time.hour });
          return Promise.resolve(true);
        },
        takeIdleMarker: (reference) => {
          used.push({ reference, at: time.hour });
          return true;
        },
      },
    });
    for (let second = 0; second < 600; second++) {
      time.hour += 20 / 3600;
      await tick(actor, 1);
    }
    // Sitting 0.3 h ± 25 %, the idle marker 0.2 × 1.5 × (1 − 0.05 × 0.05 × 50) = 0.2625 h ± 25 %:
    // between two picks at least 0.19 game hours (the shorter's least).
    expect(used.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < used.length; i++) {
      const gap = (used[i]?.at ?? 0) - (used[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(0.19);
      expect(gap).toBeLessThanOrEqual(0.375 + 0.01);
    }
  });
});

/** A Sandbox package with these Bool inputs (slot → value), at a place, Energy 50. */
function sandboxer(
  bools: Readonly<Record<number, boolean>>,
  place: { position: [number, number, number]; radius: number; reference?: number },
  options: Parameters<typeof packageActor>[2] = {},
) {
  const inputs: PackageInput[] = [
    {
      id: 0,
      type: 'Location',
      value: { kind: 'location', location: { type: 12, form: 0, radius: place.radius } },
    },
    { id: 8, type: 'Float', value: { kind: 'float', value: 50 } },
  ];
  const slots = [0, 255, 255, 255, 255, 255, 255, 255, 8, 255, 255];
  for (const [slot, value] of Object.entries(bools)) {
    const id = 20 + Number(slot);
    inputs.push({ id, type: 'Bool', value: { kind: 'bool', value } });
    slots[Number(slot)] = id;
  }
  const branch = { ...procedure('Sandbox'), inputs: slots };
  return packageActor([pack(1, branch, { inputs })], PROCEDURES, {
    settings: SKYRIM,
    ...options,
    mind: { place: () => Promise.resolve(place), ...options.mind },
  });
}

describe('sandbox: scans, radius and the chair it sits on', () => {
  it('scans its place every fMin..fMaxSandboxRescanSeconds (3–6 s), also while it sits', async () => {
    let scans = 0;
    const { actor } = sandboxer(
      { 5: true, 6: false },
      { position: [0, 0, 0], radius: 500 },
      {
        mind: {
          around: () => {
            scans++;
            return Promise.resolve([{ reference: 0x100, kind: 'sit', position: [100, 0, 0] }]);
          },
        },
        body: { useFurniture: () => Promise.resolve(true) },
      },
    );
    for (let second = 0; second < 20; second++) await tick(actor, 1);
    // At 0, 3, 6, ..., 18 s (the least interval: the harness rolls 0).
    expect(scans).toBeGreaterThanOrEqual(6);
  });

  it('searches fSandBoxSearchRadius round a place with no reference and no radius', async () => {
    const radii: number[] = [];
    const { actor } = sandboxer(
      { 6: false },
      { position: [0, 0, 0], radius: 0 },
      {
        mind: {
          around: (_center, radius) => {
            radii.push(radius);
            return Promise.resolve([]);
          },
        },
      },
    );
    await tick(actor, 1);
    expect(radii[0]).toBe(6000);
  });

  it('eats at the chair it sits on without getting up', async () => {
    let seated = false;
    const sat: number[] = [];
    let left = 0;
    const eaten: number[] = [];
    let eatenSeated = false;
    let leftAtSit = -1;
    const { actor, time } = sandboxer(
      { 1: true, 5: true, 6: false },
      { position: [0, 0, 0], radius: 500 },
      {
        mind: {
          // The chair is free only while it does not sit on it.
          around: () =>
            Promise.resolve(
              seated ? [] : [{ reference: 0x100, kind: 'sit', position: [100, 0, 0] }],
            ),
          fakeFood: () => Promise.resolve(0x999),
        },
        body: {
          useFurniture: (reference) => {
            sat.push(reference);
            leftAtSit = left;
            seated = true;
            return Promise.resolve(true);
          },
          leaveFurniture: () => {
            left++;
            seated = false;
            return Promise.resolve();
          },
          useItem: (item) => {
            eaten.push(item);
            if (seated && sat.length === 1 && left === leftAtSit) eatenSeated = true;
            return Promise.resolve(true);
          },
        },
      },
    );
    for (let second = 0; second < 120; second++) {
      time.hour += 20 / 3600;
      await tick(actor, 1);
    }
    expect(eaten).toContain(0x999);
    // Sat down once, never up, before it ate.
    expect(eatenSeated).toBe(true);
  });

  it('goes back into its place only once outside it by more than fSandBoxRadiusHysteresis', async () => {
    const travels = async (x: number): Promise<number> => {
      let count = 0;
      const { actor } = sandboxer(
        { 6: false },
        { position: [0, 0, 0], radius: 500 },
        {
          body: {
            position: () => [x, 0, 0],
            travel: () => {
              count++;
              return Promise.resolve(true);
            },
          },
        },
      );
      for (let second = 0; second < 12; second++) await tick(actor, 1);
      return count;
    };
    // 540: within the band (500 + 50): only the walk there as it starts.
    expect(await travels(540)).toBe(1);
    expect(await travels(600)).toBeGreaterThan(1);
  });
});

describe('sandbox: the rest of the engine’s rule (not built yet)', () => {
  it.todo(
    'talks with others within fSandBoxExtraDialogueRange (384) beyond its place (the engine's defaults)',
  );
  it.todo(
    'waits fSandBoxDelayEvalSeconds (5 s) before it is evaluated again on arrival (observed in the original: ' +
      'the sandbox update reads it three times)',
  );
});
