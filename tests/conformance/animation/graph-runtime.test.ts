// Conformance: the graph runtime (engine map: Animation and bodies > Graph runtime): how the
// behaviour graphs' events reach the engine with their payloads, and how often a graph updates.
//
// Sources:
// - Havok Behavior: an event carries an hkbStringEventPayload (AnimObjLoad's object,
//   StartAnimatedCamera's node); a clip annotation "Tag.payload" reaches the engine as its tag
//   and the text after the first dot (docs/animation.md, "Graph events").
// - The engine's graph manager update, observed in the original (docs/animation.md, "How often graphs
//   update"), and its [Animation] INI settings: the engine's defaults (bAnimInterpEnable 1,
//   fAnimInterpMinTime 0.08, fAnimInterpMaxTime 0.25, fAnimInterpNearDist 400,
//   fAnimInterpFarDist 800, fAnimInterpSlop 0.25).

import { describe, expect, it } from 'vitest';
import {
  ANIMATION_RATE,
  animationRate,
  animationRateSettings,
} from '../../../src/animation/animated-skeleton.ts';
import { graphEvent } from '../../../src/animation/graph-events.ts';

describe('event payloads (Havok Behavior, the response files)', () => {
  it('a payload of its own is kept whole, the name untouched', () => {
    expect(graphEvent('AnimObjLoad', 'AnimObjectTankard')).toEqual({
      name: 'AnimObjLoad',
      payload: 'AnimObjectTankard',
      text: 'AnimObjLoad',
    });
  });
  it('an annotation’s text splits at its first dot into tag and payload', () => {
    expect(graphEvent('CameraShake.0.5')).toEqual({
      name: 'CameraShake',
      payload: '0.5',
      text: 'CameraShake.0.5',
    });
    expect(graphEvent('SoundPlay.NPCGiantAttackStomp').name).toBe('SoundPlay');
  });
  it('a name without a dot has no payload', () => {
    expect(graphEvent('weaponSwing')).toEqual({ name: 'weaponSwing', text: 'weaponSwing' });
  });
});

describe('how often a graph updates (original, [Animation] settings)', () => {
  const camera = { position: [0, 0, 0] as const, forward: [0, 1, 0] as const, fov: 80 };
  const ini = {
    number: (_section: string, key: string): number =>
      ({
        fAnimInterpMinTime: 0.08,
        fAnimInterpMaxTime: 0.25,
        fAnimInterpNearDist: 400,
        fAnimInterpFarDist: 800,
        fAnimInterpSlop: 0.25,
      })[key] ?? 0,
    bool: (): boolean => true,
  };

  it('reads the INI’s settings by name', () => {
    const settings = animationRateSettings(ini);
    expect(settings.minTime).toBeCloseTo(0.08, 6);
    expect(settings.maxTime).toBe(0.25);
    expect(settings.nearDistance).toBe(400);
    expect(settings.farDistance).toBe(800);
    expect(settings.slop).toBe(0.25);
    expect(ANIMATION_RATE.enabled).toBe(true);
  });
  it('every frame up to fAnimInterpNearDist', () => {
    expect(animationRate([0, 399, 0], camera).interval).toBe(0);
  });
  it('fAnimInterpMinTime just beyond it, rising to fAnimInterpMaxTime at fAnimInterpFarDist', () => {
    expect(animationRate([0, 401, 0], camera).interval).toBeCloseTo(0.08, 2);
    expect(animationRate([0, 600, 0], camera).interval).toBeCloseTo(0.165, 3);
    expect(animationRate([0, 800, 0], camera).interval).toBeCloseTo(0.25, 6);
    expect(animationRate([0, 5000, 0], camera).interval).toBeCloseTo(0.25, 6);
  });
  it('a zoomed view (half the field of view) brings it twice as near', () => {
    expect(animationRate([0, 300, 0], { ...camera, fov: 40 }).interval).toBeCloseTo(0.165, 3);
  });
});

describe('the graph runtime (todo)', () => {
  it.todo('every generator and modifier class of the vanilla graphs runs (a data sweep)  [data]');
  it.todo('the graph’s bDisableInterp: the manager’s own flag, how it is set  [original]');
  it.todo('an event no active node takes reports not handled (the death idle’s check)  [original]');
  it.todo('graph variables and states in saves  [M12]');
});
