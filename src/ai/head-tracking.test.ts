import { describe, expect, it } from 'vitest';
import {
  chooseLookActor,
  HeadTracker,
  LookPriority,
  lookPriority,
  LookRequests,
  noticesPlayer,
  pathLookPoint,
  VANILLA_HEAD_TRACK,
  type LookInterest,
} from './head-tracking.ts';

describe('head tracking', () => {
  it('chooses the nearest other actor within reach and 120° of its facing', () => {
    // Facing +y (heading 0) from the origin.
    const head = [0, 0, 100] as const;
    const at = (reference: number, x: number, y: number) => ({
      reference,
      head: [x, y, 100] as const,
    });
    const candidates = [at(1, 0, 300), at(2, 100, 150), at(3, 0, -200), at(4, 0, 900)];
    expect(chooseLookActor(head, 0, candidates, 400)?.reference).toBe(2);
    // Behind it (more than 120° off) and beyond fAIMaxHeadTrackDistance: no one.
    expect(chooseLookActor(head, 0, [at(3, 0, -200), at(4, 0, 900)], 400)).toBeUndefined();
    // Turned around, the one behind is in front.
    expect(chooseLookActor(head, Math.PI, candidates, 400)?.reference).toBe(3);
  });

  it('prefers the player close or talking, then a speaker, then one moving', () => {
    const head = [0, 0, 100] as const;
    const at = (reference: number, y: number, interest: LookInterest) => ({
      reference,
      head: [0, y, 100] as const,
      interest,
    });
    const idle = at(1, 50, {});
    const moving = at(2, 150, { moving: true });
    const speaker = at(3, 250, { speaking: true });
    const playerFar = at(0x14, 300, { player: true });
    const playerNear = at(0x14, 180, { player: true });
    const choose = (...candidates: ReturnType<typeof at>[]) =>
      chooseLookActor(head, 0, candidates, 400)?.reference;
    expect(choose(idle, moving)).toBe(2);
    expect(choose(idle, moving, speaker)).toBe(3);
    // The player beyond half the reach counts as anyone; close, before all.
    expect(choose(idle, playerFar)).toBe(1);
    expect(choose(idle, moving, speaker, playerNear)).toBe(0x14);
    // In a conversation, the player is looked at from farther.
    expect(choose(speaker, at(0x14, 300, { player: true, talking: true }))).toBe(0x14);
    expect(lookPriority({ moving: true }, 100, 400)).toBe(LookPriority.moving);
    // One chosen a moment ago stays unless one worth more comes.
    expect(chooseLookActor(head, 0, [idle, at(4, 100, {})], 400, 4)?.reference).toBe(4);
    expect(chooseLookActor(head, 0, [moving, at(4, 100, {})], 400, 4)?.reference).toBe(2);
  });

  it('looks along its path while it walks', () => {
    const feet = [0, 0, 0] as const;
    // A corner 100 ahead, then off to +x: 256 along is 156 down the second leg.
    const point = pathLookPoint(feet, 120, [
      [0, 100, 0],
      [400, 100, 0],
    ]);
    expect(point?.[0]).toBeCloseTo(156, 6);
    expect(point?.[1]).toBeCloseTo(100, 6);
    expect(point?.[2]).toBe(120);
    // A short way: its end.
    expect(pathLookPoint(feet, 120, [[0, 50, 0]])).toEqual([0, 50, 120]);
    expect(pathLookPoint(feet, 120, [])).toBeUndefined();
  });

  it('looks at the highest kind asked for, and lets go of one kind only', () => {
    const looks = new LookRequests();
    looks.lookAt(1, 0x14, 'script');
    looks.lookAt(1, [10, 20, 30], 'dialogue');
    expect(looks.target(1)).toEqual({ target: [10, 20, 30], kind: 'dialogue' });
    looks.lookAt(1, undefined, 'dialogue');
    expect(looks.target(1)).toEqual({ target: 0x14, kind: 'script' });
    looks.lookAt(1, undefined, 'script');
    expect(looks.target(1)).toBeUndefined();
    looks.setHeadTracking(1, false);
    expect(looks.headTracking(1)).toBe(false);
  });

  it('notices the player as any actor: within fAIMaxHeadTrackDistance and 120°', () => {
    const head = [0, 0, 120] as const;
    expect(noticesPlayer(head, 0, [50, 300, 120], 400)).toBe(true);
    expect(noticesPlayer(head, 0, [0, -300, 120], 400)).toBe(false);
    expect(noticesPlayer(head, 0, [0, 450, 120], 400)).toBe(false);
    // Beside it (90° off) is within 120°.
    expect(noticesPlayer(head, 0, [300, 0, 120], 400)).toBe(true);
    // Facing east (compass 90°), the player to the east is in front.
    expect(noticesPlayer(head, Math.PI / 2, [300, 0, 120], 400)).toBe(true);
  });

  it('moves the look at the head tracking speed: fast while far off, slow near', () => {
    const tracker = new HeadTracker(() => 0.5);
    const head = [0, 0, 0] as const;
    const forward = [0, 1, 0] as const;
    const target = [100, 0, 0] as const; // 90° to the right
    const aim = tracker.update(0.1, head, forward, target, VANILLA_HEAD_TRACK, false);
    // 200° a second for 0.1 s: 20° of the 90°.
    const angle = (Math.atan2(aim?.[0] ?? 0, aim?.[1] ?? 0) * 180) / Math.PI;
    expect(angle).toBeCloseTo(20, 1);
    // Within fHeadTrackSpeedMinAngle (5°) at 60° a second.
    const close = new HeadTracker(() => 0.5);
    const near = [Math.sin(0.06), Math.cos(0.06), 0] as const; // 3.4° off
    close.update(0, head, forward, [0, 100, 0], VANILLA_HEAD_TRACK, false);
    const step = close.update(0.01, head, forward, near, VANILLA_HEAD_TRACK, false);
    expect((Math.atan2(step?.[0] ?? 0, step?.[1] ?? 0) * 180) / Math.PI).toBeCloseTo(0.6, 2);
    expect(
      tracker.update(0.1, head, forward, undefined, VANILLA_HEAD_TRACK, false),
    ).toBeUndefined();
  });
});
