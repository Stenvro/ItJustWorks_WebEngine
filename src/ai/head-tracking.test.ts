import { describe, expect, it } from 'vitest';
import { HeadTracker, LookRequests, noticesPlayer, VANILLA_HEAD_TRACK } from './head-tracking.ts';

describe('head tracking', () => {
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

  it('notices the player near and in front, not behind or far', () => {
    const head = [0, 0, 120] as const;
    expect(noticesPlayer(head, 0, [50, 300, 120])).toBe(true);
    expect(noticesPlayer(head, 0, [0, -300, 120])).toBe(false);
    expect(noticesPlayer(head, 0, [0, 2000, 120])).toBe(false);
    // Facing east (compass 90°), the player to the east is in front.
    expect(noticesPlayer(head, Math.PI / 2, [300, 0, 120])).toBe(true);
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
