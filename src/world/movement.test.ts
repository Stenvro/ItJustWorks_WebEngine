import { describe, expect, it } from 'vitest';
import { stickPace } from './movement.ts';

describe('the stick’s pace', () => {
  it('runs from the walk to the run, and walks up to the walk, by the deflection', () => {
    expect(stickPace(100, 300, true, 1)).toBe(300);
    expect(stickPace(100, 300, true, 0.5)).toBe(200);
    expect(stickPace(100, 300, false, 0.5)).toBe(50);
    expect(stickPace(100, 300, false, 2)).toBe(100);
  });
});
