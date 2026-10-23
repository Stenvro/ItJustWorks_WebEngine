import { describe, expect, it } from 'vitest';
import { readDetectionSettings } from './detection.ts';
import { Detections, type DetectionEvent } from './detection-states.ts';

const settings = readDetectionSettings();
const GUARD = 0x1001;
const BANDIT = 0x1002;
const PLAYER = 0x14;
const here = [0, 0, 0] as const;
const there = [500, 0, 0] as const;

function book(): { detections: Detections; events: DetectionEvent[] } {
  const detections = new Detections(() => settings);
  const events: DetectionEvent[] = [];
  detections.listen((event) => events.push(event));
  return { detections, events };
}

describe('detection states', () => {
  it('go from unseen to noticed to detected, and lost to searching, then unseen', () => {
    const { detections, events } = book();
    expect(detections.state(GUARD, PLAYER)).toBe('unseen');
    // At or below fSneakNoticeMin: still unseen, nothing told.
    expect(detections.observe(GUARD, PLAYER, -25, here, 0)).toBe('unseen');
    expect(events).toEqual([]);
    expect(detections.observe(GUARD, PLAYER, -10, here, 1)).toBe('noticed');
    expect(detections.observe(GUARD, PLAYER, 5, there, 2)).toBe('detected');
    expect(detections.detects(GUARD, PLAYER)).toBe(true);
    expect(detections.lastKnown(GUARD, PLAYER)).toEqual(there);
    // Lost from sight: it searches where it last saw the target.
    expect(detections.observe(GUARD, PLAYER, -30, here, 3)).toBe('searching');
    expect(detections.lastKnown(GUARD, PLAYER)).toEqual(there);
    // Not yet fDetectionStateExpireTime later: still searching.
    detections.tick(20);
    expect(detections.state(GUARD, PLAYER)).toBe('searching');
    detections.tick(33);
    expect(detections.state(GUARD, PLAYER)).toBe('unseen');
    expect(events.map((event) => event.kind)).toEqual(['noticed', 'detected', 'searching', 'lost']);
  });

  it('search for a target lost beyond reach, and for one only noticed after detecting it', () => {
    const { detections } = book();
    detections.observe(GUARD, PLAYER, 10, there, 0);
    expect(detections.observe(GUARD, PLAYER, undefined, there, 1)).toBe('searching');
    expect(detections.level(GUARD, PLAYER)).toBeUndefined();
    detections.observe(BANDIT, PLAYER, 10, there, 0);
    expect(detections.observe(BANDIT, PLAYER, -5, there, 1)).toBe('searching');
    // Found again.
    expect(detections.observe(BANDIT, PLAYER, 1, there, 2)).toBe('detected');
  });

  it('detect above 0 only, in combat too (the engine never reads iAICombatMinDetection)', () => {
    const { detections } = book();
    expect(detections.observe(BANDIT, PLAYER, 1, here, 0)).toBe('detected');
    expect(detections.observe(GUARD, PLAYER, -40, here, 0)).toBe('unseen');
    expect(detections.observe(GUARD, PLAYER, 0, here, 0)).toBe('noticed');
  });

  it('alert an observer that hears a noise, searching for its owner there', () => {
    const { detections, events } = book();
    expect(detections.hear(GUARD, there, PLAYER, -5, 0)).toBe(false);
    expect(detections.hear(GUARD, there, PLAYER, 0, 0)).toBe(false);
    expect(detections.alerted(GUARD)).toBeUndefined();
    expect(detections.hear(GUARD, there, PLAYER, 3, 1)).toBe(true);
    expect(detections.alerted(GUARD)).toEqual(there);
    expect(detections.state(GUARD, PLAYER)).toBe('searching');
    expect(events.map((event) => event.kind)).toEqual(['searching', 'heard']);
    // A noise of no one alerts it all the same.
    expect(detections.hear(BANDIT, here, undefined, 1, 1)).toBe(true);
    expect(detections.alerted(BANDIT)).toEqual(here);
    detections.tick(40);
    expect(detections.alerted(GUARD)).toBeUndefined();
    expect(detections.state(GUARD, PLAYER)).toBe('unseen');
  });

  it('report the observers that detect an actor as witnesses of what it does', () => {
    const { detections, events } = book();
    detections.observe(GUARD, PLAYER, 10, here, 0);
    detections.observe(BANDIT, PLAYER, -10, here, 0);
    expect(detections.witness(PLAYER, 'steal', 0x2000)).toEqual([GUARD]);
    expect(events.at(-1)).toEqual({
      kind: 'witnessed',
      observer: GUARD,
      actor: PLAYER,
      act: 'steal',
      victim: 0x2000,
    });
    // While trespassing, one that comes to detect the player witnesses it too.
    expect(detections.offence(PLAYER, 'trespass')).toEqual([GUARD]);
    detections.observe(BANDIT, PLAYER, 3, here, 1);
    expect(events.at(-1)).toMatchObject({ kind: 'witnessed', observer: BANDIT, act: 'trespass' });
    detections.offence(PLAYER, undefined);
    detections.observe(BANDIT, PLAYER, -50, here, 2);
    detections.observe(BANDIT, PLAYER, 3, here, 3);
    expect(events.at(-1)).toMatchObject({ kind: 'detected', observer: BANDIT });
  });

  it('keep alarms, attacks and who knows of whom', () => {
    const { detections, events } = book();
    detections.alarm(GUARD, [BANDIT], 0, PLAYER, 'attack');
    expect(detections.alarmed(GUARD)).toBe(true);
    expect(detections.alarmed(BANDIT)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'alarm', actor: GUARD, criminal: PLAYER, act: 'attack' });
    detections.stopAlarm(GUARD);
    expect(detections.alarmed(GUARD)).toBe(false);
    detections.attack(BANDIT, PLAYER, there, 1);
    expect(detections.attackedBy(BANDIT)).toBe(PLAYER);
    expect(detections.state(BANDIT, PLAYER)).toBe('searching');
    expect([...detections.detectors(PLAYER)]).toEqual([
      { observer: BANDIT, state: 'searching', level: undefined },
    ]);
    detections.tick(40);
    expect(detections.alarmed(BANDIT)).toBe(false);
    expect(detections.attackedBy(BANDIT)).toBeUndefined();
    detections.observe(GUARD, BANDIT, 5, here, 41);
    expect([...detections.known(GUARD)]).toEqual([{ target: BANDIT, state: 'detected', level: 5 }]);
    detections.forget(BANDIT);
    expect([...detections.known(GUARD)]).toEqual([]);
  });

  it('open the stealth eye by the state: shut, slightly, half, open', () => {
    const { detections } = book();
    expect(detections.eye(GUARD, PLAYER)).toBe(0);
    detections.observe(GUARD, PLAYER, -19, here, 0);
    expect(detections.eye(GUARD, PLAYER)).toBeCloseTo(0.1 + 0.4 * (1 / 20), 9);
    detections.observe(GUARD, PLAYER, -1, here, 0);
    expect(detections.eye(GUARD, PLAYER)).toBeCloseTo(0.1 + 0.4 * (19 / 20), 9);
    detections.observe(GUARD, PLAYER, 1, here, 0);
    expect(detections.eye(GUARD, PLAYER)).toBe(1);
    detections.observe(GUARD, PLAYER, -50, here, 1);
    expect(detections.eye(GUARD, PLAYER)).toBe(0.5);
  });
});
