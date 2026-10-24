import { describe, expect, it } from 'vitest';
import {
  AnomalyLog,
  BodyWatch,
  brokenBone,
  ClipWatch,
  CombatWatch,
  Episode,
  FrameStats,
  isLocomotionClip,
  isReferencePose,
  LeanWatch,
  messageKey,
  RateWindow,
  sceneWait,
  SpeedMeter,
  StateWatch,
  TravelWatch,
} from './detectors.ts';
import type { Condition } from '../../scripting/conditions.ts';
import { DEFAULT_THRESHOLDS } from './types.ts';

describe('Episode', () => {
  it('begins after the condition held long enough and ends after its cooldown', () => {
    const episode = new Episode(0.5, 0.5);
    const changes: (string | undefined)[] = [];
    for (let i = 0; i < 10; i++) changes.push(episode.update(true, 0.1, i));
    expect(changes.indexOf('begin')).toBe(4);
    expect(changes.filter((c) => c === 'begin')).toHaveLength(1);
    expect(episode.duration).toBeCloseTo(1);
    expect(episode.peak).toBe(9);
    // A short gap does not end it.
    expect(episode.update(false, 0.2)).toBeUndefined();
    expect(episode.update(true, 0.1)).toBeUndefined();
    expect(episode.update(false, 0.3)).toBeUndefined();
    expect(episode.update(false, 0.3)).toBe('end');
    expect(episode.active).toBe(false);
  });

  it('never begins for a condition shorter than its minimum', () => {
    const episode = new Episode(0.5);
    for (let i = 0; i < 20; i++) expect(episode.update(i % 4 !== 3, 0.1)).toBeUndefined();
  });
});

describe('RateWindow', () => {
  it('counts the events of the last second', () => {
    const window = new RateWindow(1);
    for (let t = 0; t < 2; t += 0.1) window.add(t);
    expect(window.count(1.95)).toBe(10);
    expect(window.count(5)).toBe(0);
  });
});

describe('SpeedMeter', () => {
  it('measures over its window', () => {
    const meter = new SpeedMeter(0.3);
    expect(meter.ready).toBe(false);
    for (let i = 0; i < 30; i++) meter.add(1 / 60, 100 / 60);
    expect(meter.ready).toBe(true);
    expect(meter.speed).toBeCloseTo(100);
    for (let i = 0; i < 30; i++) meter.add(1 / 60, 0);
    expect(meter.speed).toBeCloseTo(0);
  });
});

describe('clip names', () => {
  it('tells locomotion clips from idles', () => {
    expect(isLocomotionClip('Animations\\male\\MT_WalkForward.hkx')).toBe(true);
    expect(isLocomotionClip('Animations\\Horse\\Horse_GallopForward.hkx')).toBe(true);
    expect(isLocomotionClip('Animations\\MT_TurnRight60.hkx')).toBe(true);
    expect(isLocomotionClip('Animations\\male\\MT_Idle.HKX')).toBe(false);
    expect(isLocomotionClip('Animations\\IdleStudy_enter.hkx')).toBe(false);
  });
});

describe('poses', () => {
  it('sees the reference pose and broken bones', () => {
    const reference = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
    expect(isReferencePose(reference.slice(), reference)).toBe(true);
    const moved = reference.slice();
    moved[6] = 0.2;
    expect(isReferencePose(moved, reference)).toBe(false);
    const worlds = new Float32Array(32);
    worlds[12] = 10;
    expect(brokenBone(worlds, 20000)).toBeUndefined();
    worlds[16 + 13] = 1e6;
    expect(brokenBone(worlds, 20000)?.node).toBe(1);
    worlds[3] = Number.NaN;
    expect(brokenBone(worlds, 20000)?.node).toBe(0);
  });
});

describe('ClipWatch', () => {
  it('reports a clip restarting over and over before it gets anywhere', () => {
    const watch = new ClipWatch();
    let found: ReturnType<ClipWatch['update']>;
    // Restarted every 0.1 s (about 6 frames), reaching 0.08 s.
    for (let frame = 0; frame < 120; frame++) {
      const t = frame / 60;
      found = watch.update(t, [{ animation: 'Idle.hkx', time: (frame % 6) * 0.016 }], 5, 0.2);
    }
    expect(found?.clip).toBe('Idle.hkx');
    expect(found?.restarts).toBeGreaterThanOrEqual(9);
  });

  it('takes a short clip that loops for no restart', () => {
    const watch = new ClipWatch();
    let found: ReturnType<ClipWatch['update']>;
    for (let frame = 0; frame < 120; frame++) {
      const time = (frame % 6) * 0.016;
      found = watch.update(
        frame / 60,
        [{ animation: 'Pose.hkx', time, looped: time === 0 }],
        5,
        0.2,
      );
    }
    expect(found).toBeUndefined();
  });

  it('takes a walk cycle wrapping once a second for no restart', () => {
    const watch = new ClipWatch();
    let found: ReturnType<ClipWatch['update']>;
    for (let frame = 0; frame < 240; frame++) {
      found = watch.update(
        frame / 60,
        [{ animation: 'Walk.hkx', time: (frame % 60) / 60 }],
        5,
        0.2,
      );
    }
    expect(found).toBeUndefined();
  });
});

describe('StateWatch', () => {
  it('reports a machine flipping between states', () => {
    const watch = new StateWatch();
    let found: ReturnType<StateWatch['update']>;
    for (let frame = 0; frame < 60; frame++) {
      const state = frame % 4 < 2 ? 'Idle' : 'Walk';
      found = watch.update(frame / 60, [{ machine: 'Locomotion', state }], 8);
    }
    expect(found?.machine).toBe('Locomotion');
    expect(found?.visited).toContain('Walk');
    const calm = new StateWatch();
    for (let frame = 0; frame < 60; frame++)
      found = calm.update(
        frame / 60,
        [{ machine: 'Locomotion', state: frame < 30 ? 'Idle' : 'Walk' }],
        8,
      );
    expect(found).toBeUndefined();
  });

  it('tells two machines of one name apart', () => {
    const watch = new StateWatch();
    let found: ReturnType<StateWatch['update']>;
    for (let frame = 0; frame < 60; frame++) {
      found = watch.update(
        frame / 60,
        [
          { machine: 'LocomotionBehavior', state: 'ForwardLocomotionState' },
          { machine: 'LocomotionBehavior', state: 'NonCombatForwardLocomotionState_Wolf' },
        ],
        8,
      );
    }
    expect(found).toBeUndefined();
  });
});

describe('BodyWatch', () => {
  it('sees a bouncing body jitter and a spike', () => {
    const watch = new BodyWatch(1);
    let began = false;
    for (let frame = 0; frame < 120; frame++) {
      const vz = frame % 4 < 2 ? 200 : -200;
      const result = watch.update(frame / 60, 1 / 60, [0, 0, vz], DEFAULT_THRESHOLDS);
      if (result.jitter === 'begin') began = true;
    }
    expect(began).toBe(true);
    const spiky = new BodyWatch(1);
    spiky.update(0, 1 / 60, [0, 0, 0], DEFAULT_THRESHOLDS);
    expect(spiky.update(1 / 60, 1 / 60, [3000, 0, 0], DEFAULT_THRESHOLDS).spike).toBe(3000);
  });

  it('lets a falling, landing body be', () => {
    const watch = new BodyWatch(1);
    for (let frame = 0; frame < 120; frame++) {
      const vz = frame < 60 ? -frame * 10 : 0;
      const result = watch.update(frame / 60, 1 / 60, [0, 0, vz], DEFAULT_THRESHOLDS);
      expect(result.jitter).toBeUndefined();
    }
  });
});

describe('TravelWatch', () => {
  it('reports a traveller that gets no nearer', () => {
    const watch = new TravelWatch(10);
    let change: string | undefined;
    for (let t = 0; t < 12; t += 0.25) {
      const result = watch.update(0.25, [0, 0, 0], [1000, 0, 0], 64);
      if (result.change) change = result.change;
    }
    expect(change).toBe('begin');
  });

  it('lets one that walks on be', () => {
    const watch = new TravelWatch(10);
    for (let t = 0; t < 20; t += 0.25) {
      const result = watch.update(0.25, [t * 40, 0, 0], [1000, 0, 0], 64);
      expect(result.change).toBeUndefined();
    }
  });
});

describe('FrameStats', () => {
  it('gives percentiles', () => {
    const stats = new FrameStats();
    for (let i = 1; i <= 100; i++) stats.add(i);
    const result = stats.stats();
    expect(result.frames).toBe(100);
    expect(result.p50).toBe(51);
    expect(result.p99).toBe(100);
    expect(result.worst).toBe(100);
    expect(result.over50).toBe(50);
  });
});

describe('AnomalyLog', () => {
  it('marks the first per subject and keeps the worst when full', () => {
    const log = new AnomalyLog(2);
    const subject = { id: '00000001', name: 'A', kind: 'npc' as const };
    const a = log.add({ kind: 'glide', subject, time: 0, detail: 'a', severity: 1 });
    const b = log.add({ kind: 'glide', subject, time: 1, detail: 'b', severity: 2 });
    expect(a.first).toBe(true);
    expect(b.first).toBe(false);
    log.add({ kind: 'glide', subject, time: 2, detail: 'c', severity: 5 });
    const kept = log.all.map((x) => x.detail);
    expect(kept).toEqual(['a', 'c']);
    expect(log.dropped.glide).toBe(1);
  });
});

describe('sceneWait', () => {
  const condition = (fields: Partial<Condition>): Condition => ({
    function: 0,
    operator: 0,
    or: false,
    comparand: 1,
    form: 0,
    param2: 0,
    raw1: 0,
    form2: 0,
    strings: [],
    runOn: 0,
    reference: 0,
    param3: 0,
    eventMember: '',
    ...fields,
  });
  const name = (formId: number): string => (formId === 0x14 ? 'Player' : formId.toString(16));

  it('writes the conditions out and finds a wait for the player', () => {
    // Sven.GetDistance(Player) < 1000 (RiverwoodIntroSceneHildeSoldierScene's second phase).
    const wait = sceneWait(
      [condition({ function: 1, operator: 4, comparand: 1000, form: 0x14, runOn: 5, param3: 2 })],
      name,
      () => false,
    );
    expect(wait.text).toBe('alias 2.GetDistance(Player) < 1000');
    expect(wait.onPlayer).toBe(true);
    expect(wait.quests).toEqual([]);
  });

  it('names the quests a stage condition reads', () => {
    const wait = sceneWait(
      [
        condition({ function: 59, form: 0x3372b, param2: 32, or: true }),
        condition({ function: 58, operator: 3, comparand: 40, form: 0x3372b }),
      ],
      name,
      (formId) => formId === 0x3372b,
    );
    expect(wait.text).toBe('GetStageDone(3372b) == 1 OR GetStage(3372b) >= 40');
    expect(wait.onPlayer).toBe(false);
    expect(wait.quests).toEqual([0x3372b]);
  });
});

describe('messageKey', () => {
  it('puts numbers and form ids as #', () => {
    expect(messageKey('actor 0001A2B3 at 12.5, -3')).toBe(messageKey('actor 0002FFFF at 1, 7'));
  });
});

describe('LeanWatch', () => {
  it('counts a body pitching back and forth, not a slope leaned into once', () => {
    const rocking = new LeanWatch(4);
    let swings = 0;
    // ±5° twice a second.
    for (let i = 0; i <= 120; i++) {
      const t = i / 60;
      swings = rocking.update(t, 5 * Math.sin(2 * Math.PI * 2 * t));
    }
    expect(swings).toBeGreaterThanOrEqual(6);
    const slope = new LeanWatch(4);
    for (let i = 0; i <= 120; i++) swings = slope.update(i / 60, Math.min(20, i / 2));
    expect(swings).toBe(0);
    // Small bobs under the amplitude are no swings.
    const bob = new LeanWatch(4);
    for (let i = 0; i <= 120; i++) swings = bob.update(i / 60, 1.5 * Math.sin(i / 3));
    expect(swings).toBe(0);
  });

  it('keeps the largest jump from one frame to the next', () => {
    const watch = new LeanWatch(4);
    watch.update(0, 0);
    watch.update(1 / 60, 12);
    watch.update(2 / 60, 13);
    expect(watch.jump).toBe(12);
    watch.reset();
    expect(watch.jump).toBe(0);
  });
});

describe('CombatWatch', () => {
  const base = {
    fighting: true,
    ranged: true,
    inRange: true,
    weaponDrawn: true,
    bowDrawnFor: 0,
    attacks: 0,
    shots: 0,
    hits: 0,
  };

  it('reports an archer that looses nothing within range, and lets one that shoots be', () => {
    const silent = new CombatWatch();
    const changes: (string | undefined)[] = [];
    for (let i = 0; i < 20; i++) changes.push(silent.update(base, 1, DEFAULT_THRESHOLDS).archer);
    expect(changes.indexOf('begin')).toBe(DEFAULT_THRESHOLDS.archerSilentSeconds - 1);
    const shooting = new CombatWatch();
    for (let i = 0; i < 40; i++) {
      const change = shooting.update({ ...base, shots: Math.floor(i / 5) }, 1, DEFAULT_THRESHOLDS);
      expect(change.archer).toBeUndefined();
    }
  });

  it('reports a bow held drawn too long', () => {
    const watch = new CombatWatch();
    expect(watch.update({ ...base, bowDrawnFor: 11 }, 0.25, DEFAULT_THRESHOLDS).archer).toBe(
      'begin',
    );
  });

  it('reports a melee fighter that never attacks, or never hits, within reach', () => {
    const melee = { ...base, ranged: false };
    const passive = new CombatWatch();
    let begun = false;
    for (let i = 0; i < 14; i++)
      begun ||= passive.update(melee, 1, DEFAULT_THRESHOLDS).melee === 'begin';
    expect(begun).toBe(true);
    const missing = new CombatWatch();
    begun = false;
    for (let i = 0; i <= DEFAULT_THRESHOLDS.creatureMisses; i++)
      begun ||= missing.update({ ...melee, attacks: i }, 1, DEFAULT_THRESHOLDS).melee === 'begin';
    expect(begun).toBe(true);
    const hitting = new CombatWatch();
    for (let i = 0; i < 30; i++) {
      const change = hitting.update({ ...melee, attacks: i, hits: i }, 1, DEFAULT_THRESHOLDS);
      expect(change.melee).toBeUndefined();
    }
  });

  it('does not judge one out of range or not fighting', () => {
    const watch = new CombatWatch();
    for (let i = 0; i < 30; i++) {
      const sample = { ...base, inRange: i % 2 === 0, fighting: i < 15 };
      expect(watch.update(sample, 1, DEFAULT_THRESHOLDS).archer).toBeUndefined();
    }
  });
});
