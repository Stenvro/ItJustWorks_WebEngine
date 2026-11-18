import { describe, expect, it } from 'vitest';
import type { Condition } from '../scripting/conditions.ts';
import { pickLoadingScreen, type LoadingScreen } from './loading-screens.ts';

const screen = (
  formId: number,
  conditioned: boolean,
  model: number | undefined,
): LoadingScreen => ({
  formId,
  editorId: `Screen${String(formId)}`,
  text: '',
  conditions: conditioned ? [{} as Condition] : [],
  model,
  scale: 1,
  rotation: [0, 0, 0],
  rotationLimits: undefined,
  translation: [0, 0, 0],
  cameraPath: undefined,
});

describe('pickLoadingScreen (observed in the original)', () => {
  const plain = screen(1, false, 0x100);
  const conditioned = screen(2, true, 0x200);
  const failing = screen(3, true, 0x300);
  const noModel = screen(4, true, undefined);
  const holds = (candidate: LoadingScreen): boolean => candidate !== failing;

  it('takes a screen whose conditions hold before those without conditions', () => {
    for (const roll of [0, 0.5, 0.99]) {
      expect(pickLoadingScreen([plain, conditioned, failing], holds, () => roll)).toBe(conditioned);
    }
  });

  it('takes one without conditions when none with conditions holds', () => {
    expect(pickLoadingScreen([plain, failing], holds, () => 0.5)).toBe(plain);
  });

  it('never takes a screen without a model to show, even one whose conditions hold', () => {
    expect(pickLoadingScreen([plain, noModel], holds, () => 0)).toBe(plain);
    expect(pickLoadingScreen([noModel], holds, () => 0)).toBeUndefined();
  });
});
