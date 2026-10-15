import { describe, expect, it } from 'vitest';
import { trainingCost } from './training.ts';

describe('trainingCost', () => {
  const settings = { multCost: 10, expertCost: 3, masterCost: 5 };
  it('follows UESP: 10b + 50 up to 50, 30b + 50 above, 50b + 50 above 75', () => {
    expect(trainingCost(15, settings)).toBe(200);
    expect(trainingCost(50, settings)).toBe(550);
    expect(trainingCost(60, settings)).toBe(1850);
    expect(trainingCost(80, settings)).toBe(4050);
  });
});
