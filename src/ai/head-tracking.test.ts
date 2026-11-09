import { describe, expect, it } from 'vitest';
import {
  chooseLookActor,
  HeadTracker,
  LookRequests,
  lookParty,
  noticesPlayer,
  pathLookAhead,
  pathLookPoint,
  raceHeadTracks,
  VANILLA_HEAD_TRACK,
} from './head-tracking.ts';

describe('head tracking', () => {
  it('drives the look-at only of a race with Use Head Track Anims', () => {
    // A race with the flag (bit 0x8000; NordRace) and one without (TrollRace).
    expect(raceHeadTracks(0x0001_8000)).toBe(true);
    expect(raceHeadTracks(0x0000_0001)).toBe(false);
  });

  it('chooses the first other actor within reach and 120° of its facing, none nearer than 100', () => {
    // Facing +y (heading 0) from the origin.
    const head = [0, 0, 100] as const;
    const at = (reference: number, x: number, y: number) => ({
      reference,
      head: [x, y, 100] as const,
    });
    // No favourites: the first it may look at in the list, not the nearest.
    const candidates = [at(1, 0, 300), at(2, 100, 150), at(3, 0, -200), at(4, 0, 900)];
    expect(chooseLookActor(head, 0, candidates, 400)?.reference).toBe(1);
    // Behind it (more than 120° off) and beyond fAIMaxHeadTrackDistance: no one.
    expect(chooseLookActor(head, 0, [at(3, 0, -200), at(4, 0, 900)], 400)).toBeUndefined();
    // Turned around, the one behind is in front.
    expect(chooseLookActor(head, Math.PI, candidates, 400)?.reference).toBe(3);
    // Too close to choose, unless it looks at it already.
    expect(chooseLookActor(head, 0, [at(5, 0, 60)], 400)).toBeUndefined();
    expect(chooseLookActor(head, 0, [at(5, 0, 60)], 400, 5)?.reference).toBe(5);
    // The one it looks at may stand behind it.
    expect(chooseLookActor(head, 0, [at(3, 0, -200)], 400, 3)?.reference).toBe(3);
  });

  it('asks the player first, near or far; speaking or moving counts for nothing', () => {
    const head = [0, 0, 100] as const;
    const someone = { reference: 1, head: [0, 150, 100] as const };
    const player = { reference: 0x14, head: [0, 390, 100] as const, player: true };
    expect(chooseLookActor(head, 0, [someone, player], 400)?.reference).toBe(0x14);
    // The player within 100 still counts.
    const close = { reference: 0x14, head: [0, 50, 100] as const, player: true };
    expect(chooseLookActor(head, 0, [someone, close], 400)?.reference).toBe(0x14);
    // Behind it: the other.
    const behind = { reference: 0x14, head: [0, -300, 100] as const, player: true };
    expect(chooseLookActor(head, 0, [someone, behind], 400)?.reference).toBe(1);
  });

  it('two in furniture do not look at each other; the player still counts', () => {
    const head = [0, 0, 100] as const;
    const seated = { reference: 1, head: [0, 200, 100] as const, inFurniture: true };
    expect(chooseLookActor(head, 0, [seated], 400, undefined, true)).toBeUndefined();
    expect(chooseLookActor(head, 0, [seated], 400, undefined, false)?.reference).toBe(1);
    const player = {
      reference: 0x14,
      head: [0, 200, 100] as const,
      player: true,
      inFurniture: true,
    };
    expect(chooseLookActor(head, 0, [player], 400, undefined, true)?.reference).toBe(0x14);
  });

  it('who goes with it: its commander, its commanded, the player’s teammates (inferred)', () => {
    // A thrall (commanded by the player) and a follower (teammate): one party.
    const thrall = { reference: 1, commander: 0x14 };
    const follower = { reference: 2, teammate: true };
    const stranger = { reference: 3 };
    expect(lookParty(thrall, follower)).toBe(true);
    expect(lookParty(follower, thrall)).toBe(true);
    expect(lookParty(follower, stranger)).toBe(false);
    expect(lookParty(stranger, follower)).toBe(false);
    // A necromancer and its skeletons; another necromancer's skeleton is not of it.
    const necromancer = { reference: 10 };
    const skeleton = { reference: 11, commander: 10 };
    const other = { reference: 12, commander: 20 };
    expect(lookParty(necromancer, skeleton)).toBe(true);
    expect(lookParty(skeleton, necromancer)).toBe(true);
    expect(lookParty(skeleton, other)).toBe(false);
    expect(lookParty(necromancer, other)).toBe(false);
  });

  it('one of its party is chosen as the player is: within 100, and between two in furniture', () => {
    const head = [0, 0, 100] as const;
    const close = { reference: 1, head: [0, 60, 100] as const, party: true };
    expect(chooseLookActor(head, 0, [close], 400)?.reference).toBe(1);
    const seated = { reference: 1, head: [0, 200, 100] as const, inFurniture: true, party: true };
    expect(chooseLookActor(head, 0, [seated], 400, undefined, true)?.reference).toBe(1);
    // Still not behind it, nor beyond reach.
    const behind = { reference: 1, head: [0, -200, 100] as const, party: true };
    expect(chooseLookActor(head, 0, [behind], 400)).toBeUndefined();
  });

  it('looks along its path as far as its speed takes it in fPathLookAtPointTime', () => {
    // Its speed × 2 s, at least 128 and its radius, at most 512.
    expect(pathLookAhead(0, 30)).toBe(158);
    expect(pathLookAhead(100, 30)).toBe(200);
    expect(pathLookAhead(400, 30)).toBe(512);
    const feet = [0, 0, 0] as const;
    // A corner 100 ahead, then off to +x: 256 along is 156 down the second leg.
    const point = pathLookPoint(
      feet,
      120,
      [
        [0, 100, 0],
        [400, 100, 0],
      ],
      256,
      158,
    );
    expect(point?.[0]).toBeCloseTo(156, 6);
    expect(point?.[1]).toBeCloseTo(100, 6);
    expect(point?.[2]).toBe(120);
    // A way shorter than it looks: its end, at the height over that end.
    expect(pathLookPoint(feet, 120, [[0, 200, 10]], 256, 158)).toEqual([0, 200, 130]);
    // Shorter than the least: it looks nowhere along it.
    expect(pathLookPoint(feet, 120, [[0, 50, 0]], 256, 158)).toBeUndefined();
    expect(pathLookPoint(feet, 120, [], 256, 158)).toBeUndefined();
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
