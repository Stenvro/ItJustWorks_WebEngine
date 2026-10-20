import { describe, expect, it } from 'vitest';
import {
  dismountPlace,
  inFrame,
  mountPlace,
  ownsHorse,
  partnerEvent,
  riddenRequest,
  saddlePlace,
  toFrame,
  type MountOffsets,
} from './mounts.ts';

/** HorseRace's mount data (DATA 128..163). */
const HORSE: MountOffsets = {
  mountOffset: [-63.479, 0, 0],
  dismountOffset: [-50, 0, 65],
  mountCameraOffset: [0, -300, 0],
};

describe('mounting', () => {
  it("stands the rider at the horse's left, facing it", () => {
    const place = mountPlace({ position: [100, 200, 10], heading: 0 }, HORSE);
    expect(place.position[0]).toBeCloseTo(100 - 63.479);
    expect(place.position[1]).toBeCloseTo(200);
    expect(place.position[2]).toBeCloseTo(10);
    // A quarter right of the horse's way: east.
    expect(place.heading).toBeCloseTo(Math.PI / 2);
  });

  it('turns the offsets with the horse', () => {
    // A horse facing east has its left to the north.
    const place = mountPlace({ position: [0, 0, 0], heading: Math.PI / 2 }, HORSE);
    expect(place.position[0]).toBeCloseTo(0);
    expect(place.position[1]).toBeCloseTo(63.479);
    expect(place.heading).toBeCloseTo(Math.PI);
  });

  it('round-trips points through a frame', () => {
    const at = { position: [5, -7, 3] as const, heading: 1.1 };
    const point = inFrame(at, [12, -30, 4]);
    const back = toFrame(at, point);
    expect(back[0]).toBeCloseTo(12);
    expect(back[1]).toBeCloseTo(-30);
    expect(back[2]).toBeCloseTo(4);
  });

  it("puts the rider on the saddle and off at the dismount's end", () => {
    const horse = { position: [0, 0, 0] as const, heading: 0 };
    expect(saddlePlace(horse, [1.7, -1, 135]).position).toEqual([1.7, -1, 135]);
    expect(saddlePlace(horse, undefined).position).toEqual([0, 0, 0]);
    const off = dismountPlace(horse);
    expect(off.position[0]).toBeCloseTo(-111.6);
    expect(off.heading).toBe(0);
  });

  it('names the horse its paired events', () => {
    expect(partnerEvent('HorseEnter')).toBe('pa_HorseEnter');
  });
});

describe('riding', () => {
  const still = { x: 0, y: 0, running: true, sprinting: false };

  it('stands without a key', () => {
    expect(riddenRequest(still, 0, 0)).toBeUndefined();
  });

  it('goes where the camera looks, running or galloping', () => {
    const run = riddenRequest({ ...still, y: 1 }, Math.PI / 2, 0);
    expect(run?.gait).toBe('run');
    expect(run?.direction?.[0]).toBeCloseTo(1);
    expect(run?.face).toBeUndefined();
    const gallop = riddenRequest({ ...still, y: 1, sprinting: true }, 0, 0);
    expect(gallop?.gait).toBe('sprint');
    const walk = riddenRequest({ ...still, y: 1, running: false }, 0, 0);
    expect(walk?.gait).toBe('walk');
  });

  it('turns to the side the keys point and backs up facing on', () => {
    const left = riddenRequest({ ...still, x: -1 }, 0, 0);
    expect(left?.direction?.[0]).toBeCloseTo(-1);
    const back = riddenRequest({ ...still, y: -1 }, 2, 0.5);
    expect(back?.face).toBe(0.5);
    expect(back?.direction?.[0]).toBeCloseTo(-Math.sin(0.5));
    expect(back?.gait).toBe('walk');
  });
});

describe('owning a horse', () => {
  const rider = { base: 7, factions: new Set([0x68d78]) };

  it('lets one ride its own, its factions and those no one owns', () => {
    expect(ownsHorse({}, rider)).toBe(true);
    expect(ownsHorse({ actor: 7 }, rider)).toBe(true);
    expect(ownsHorse({ faction: 0x68d78 }, rider)).toBe(true);
  });

  it("counts riding another's horse as stealing it, not the last one ridden", () => {
    expect(ownsHorse({ faction: 0x39f26 }, rider)).toBe(false);
    expect(ownsHorse({ actor: 9 }, rider)).toBe(false);
    expect(ownsHorse({ actor: 9 }, { ...rider, lastRidden: true })).toBe(true);
  });
});
