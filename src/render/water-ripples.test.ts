import { describe, expect, it } from 'vitest';
import {
  MAX_RIPPLES,
  RIPPLE_LIFETIME,
  WAKE_IDLE_INTERVAL,
  WAKE_SPACING,
  WaterRipples,
} from './water-ripples.ts';

describe('water ripples', () => {
  it('spreads a ring from a splash and lets it die out', () => {
    const ripples = new WaterRipples();
    ripples.splash([100, 200, 0], 0.8, 10);
    expect(ripples.active(11)).toEqual([{ x: 100, y: 200, age: 1, strength: 0.8 }]);
    expect(ripples.active(10 + RIPPLE_LIFETIME)).toEqual([]);
  });

  it('leaves a wake ring each time an actor has moved on, or stood a while', () => {
    const ripples = new WaterRipples();
    ripples.wake(7, [0, 0, 0], 0);
    ripples.wake(7, [10, 0, 0], 0.1);
    expect(ripples.active(0.1)).toHaveLength(1);
    ripples.wake(7, [WAKE_SPACING + 1, 0, 0], 0.2);
    expect(ripples.active(0.2)).toHaveLength(2);
    ripples.wake(7, [WAKE_SPACING + 1, 0, 0], 0.2 + WAKE_IDLE_INTERVAL);
    expect(ripples.active(0.2 + WAKE_IDLE_INTERVAL)).toHaveLength(3);
  });

  it('keeps the newest rings when there are too many', () => {
    const ripples = new WaterRipples();
    for (let i = 0; i < MAX_RIPPLES + 5; i++) ripples.splash([i, 0, 0], 1, i * 0.01);
    const active = ripples.active(0.5);
    expect(active).toHaveLength(MAX_RIPPLES);
    expect(active[0]?.x).toBe(MAX_RIPPLES + 4);
  });
});
