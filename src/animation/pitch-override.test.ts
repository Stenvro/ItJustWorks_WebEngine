import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import type { BehaviorGenerator } from '../formats/hkx/behavior.ts';
import { BehaviorRuntime } from './behavior-runtime.ts';
import { CameraPitchOverride, OverriddenPitch, PITCH_OVERRIDE_RATE } from './pitch-override.ts';

describe('the player’s pitch under PitchOverride', () => {
  it('follows the view, eases level while overridden and back once it ends', () => {
    const held = new OverriddenPitch();
    // No override: the view's pitch at once, however fast it turns.
    expect(held.step(0.6, false, 1 / 60)).toBe(0.6);
    expect(held.step(-0.9, false, 1 / 60)).toBe(-0.9);
    // An equip begins: level at PITCH_OVERRIDE_RATE, then held there.
    const step = 0.1;
    expect(held.step(-0.9, true, step)).toBeCloseTo(-0.9 + PITCH_OVERRIDE_RATE * step);
    expect(held.step(-0.9, true, 1)).toBe(0);
    expect(held.step(0.5, true, 1)).toBe(0);
    // It ends: back toward the view at the same rate, then with the view at once again.
    expect(held.step(0.5, false, step)).toBeCloseTo(PITCH_OVERRIDE_RATE * step);
    expect(held.step(0.5, false, 1)).toBe(0.5);
    expect(held.step(-0.2, false, 1 / 60)).toBe(-0.2);
  });
});

/** One bone, held still: the clips here only carry their annotations. */
const skeleton: HkxSkeleton = {
  name: 'Root',
  bones: [{ name: 'Root', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

function binding(
  duration: number,
  annotations: { time: number; text: string }[],
): AnimationBinding {
  return {
    skeletonName: 'Root',
    animation: {
      duration,
      trackCount: 1,
      floatTrackCount: 0,
      annotations,
      motion: undefined,
      sample: (_time, out) => {
        out.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
      },
    },
    trackToBone: undefined,
    floatTrackToSlot: undefined,
    additive: false,
  };
}

/**
 * The player's body graph, cut down: an equip clip that raises PitchOverrideStart at its first
 * frame and PitchOverrideEnd at 0.59 s (1HM_Equip's), which a stagger cuts off.
 */
function equipGraph(): BehaviorRuntime {
  const clip = (name: string, mode: number): BehaviorGenerator => ({
    kind: 'clip',
    name,
    animation: name,
    mode,
    playbackSpeed: 1,
  });
  const to = (eventId: number, toStateId: number) => ({
    eventId,
    toStateId,
    flags: 0,
    priority: 0,
    conditional: false,
    duration: 0,
  });
  const machine: BehaviorGenerator = {
    kind: 'state-machine',
    name: 'Machine',
    startStateId: { value: 0 },
    startStateMode: 0,
    states: [
      {
        id: 0,
        name: 'Equip',
        probability: 1,
        enable: true,
        generator: clip('equip', 0),
        transitions: [to(0, 1)],
      },
      {
        id: 1,
        name: 'Stagger',
        probability: 1,
        enable: true,
        generator: clip('stagger', 0),
        transitions: [],
      },
    ],
    wildcardTransitions: [],
  };
  return new BehaviorRuntime({
    root: { name: 'test', events: ['staggerStart'], variables: [], root: machine },
    host: {
      clip: (name) =>
        name === 'equip'
          ? binding(1, [
              { time: 0, text: 'PitchOverrideStart' },
              { time: 0.59, text: 'PitchOverrideEnd' },
            ])
          : name === 'stagger'
            ? binding(1, [])
            : undefined,
      behavior: () => undefined,
    },
    skeleton,
  });
}

describe('the third-person camera’s PitchOverride flag', () => {
  it('is set in third person only, and ends on a switch to first person for good', () => {
    const graph = equipGraph();
    graph.update(0);
    const flag = new CameraPitchOverride();
    flag.start('first');
    expect(flag.on).toBe(false);
    flag.start('third');
    expect(flag.on).toBe(true);
    // PitchOverrideEnd ends it in either view.
    flag.end();
    expect(flag.on).toBe(false);
    // A draw in third person, then a quick switch to first person (where the equip's
    // PitchOverrideEnd comes): off at the switch.
    flag.start('third');
    flag.follow('third', [graph]);
    expect(flag.on).toBe(true);
    flag.follow('first', [graph]);
    expect(flag.on).toBe(false);
    // Back to third person while the equip still plays: the flag is not on again by itself, so
    // the bow's spine twist follows the view.
    flag.follow('third', [graph]);
    expect(flag.on).toBe(false);
  });

  it('ends with the equip clip that raised it when a stagger cuts it off before its end', () => {
    const graph = equipGraph();
    graph.update(0);
    expect(graph.playsClipRaising(['PitchOverrideEnd'])).toBe(true);
    const flag = new CameraPitchOverride();
    flag.start('third');
    graph.update(0.2);
    flag.follow('third', [graph, undefined]);
    // The equip plays on: its end will clear it.
    expect(flag.on).toBe(true);
    // A stagger before 0.59 s: its PitchOverrideEnd never comes.
    graph.sendEvent('staggerStart');
    graph.update(0.1);
    expect(graph.states()).toEqual([{ machine: 'Machine', state: 'Stagger' }]);
    expect(graph.playsClipRaising(['PitchOverrideEnd'])).toBe(false);
    flag.follow('third', [graph, undefined]);
    expect(flag.on).toBe(false);
  });
});
