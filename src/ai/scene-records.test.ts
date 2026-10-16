import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  DEFAULT_ACTOR_BEHAVIOUR,
  parseScene,
  SceneActionFlag,
  SceneActorBehaviour,
  SceneActorFlag,
  SceneBehaviourSetting,
  SceneFlag,
} from './scene-records.ts';

const empty = new Uint8Array(0);
const u16s = (...values: number[]): Uint8Array => new Uint8Array(Uint16Array.from(values).buffer);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const i32s = (...values: number[]): Uint8Array => new Uint8Array(Int32Array.from(values).buffer);
const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][]) => ({
  formId: 0x100,
  editorId: 'TestScene',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});
/** A CTDA: GetStageDone (59) of quest 0x50 stage `stage` == 1. */
const stageDone = (stage: number): Uint8Array => {
  const data = new Uint8Array(32);
  const v = new DataView(data.buffer);
  v.setFloat32(4, 1, true);
  v.setUint16(8, 59, true);
  v.setUint32(12, 0x50, true);
  v.setInt32(16, stage, true);
  return data;
};
/** The leftovers of earlier Creation Kit versions that sit in phases and actions. */
const leftovers = (): [string, Uint8Array][] => [
  ['SCHR', new Uint8Array(20)],
  ['QNAM', u32s(0x50)],
];

describe('scenes', () => {
  it('read phases with their start and completion conditions, actors and actions', () => {
    const scene = parseScene(
      record([
        ['EDID', text('TestScene')],
        ['FNAM', u32s(SceneFlag.beginOnQuestStart | SceneFlag.showAllText)],
        // Phase 0: starts when stage 10 is done.
        ['HNAM', empty],
        ['NAM0', text('Wait for the cart')],
        ['CTDA', stageDone(10)],
        ['NEXT', empty],
        ['NEXT', empty],
        ['WNAM', u32s(200)],
        ['HNAM', empty],
        // Phase 1: completes when stage 20 is done.
        ['HNAM', empty],
        ['NAM0', text('')],
        ['NEXT', empty],
        ['CTDA', stageDone(20)],
        ...leftovers(),
        ['NEXT', empty],
        ['WNAM', u32s(250)],
        ['HNAM', empty],
        // Actors: Ralof (alias 12, optional), and an early scene's actor with only its ALID.
        ['ALID', i32s(12)],
        ['LNAM', u32s(SceneActorFlag.optional)],
        ['DNAM', u32s(SceneActorBehaviour.deathEnd | SceneActorBehaviour.combatPause)],
        ['ALID', i32s(4)],
        // A line: Ralof says topic 0xbecbd in phase 0, looking at alias 4.
        ['ANAM', u16s(0)],
        ['NAM0', text('Ralof talks')],
        ['ALID', i32s(12)],
        ['INAM', u32s(15)],
        ['FNAM', u32s(SceneActionFlag.headtrackPlayer)],
        ['SNAM', u32s(0)],
        ['ENAM', u32s(0)],
        ['DATA', u32s(0xbecbd)],
        ['HTID', i32s(4)],
        ['DMAX', f32s(10)],
        ['DMIN', f32s(1)],
        ['DEMO', u32s(3)],
        ['DEVA', u32s(25)],
        ['ANAM', empty],
        // Packages for alias 4 over both phases.
        ['ANAM', u16s(1)],
        ['NAM0', text('')],
        ['ALID', i32s(4)],
        ['LNAM', u32s(0)],
        ['INAM', u32s(16)],
        ['SNAM', u32s(0)],
        ['ENAM', u32s(1)],
        ['PNAM', u32s(0x1074b)],
        ['PNAM', u32s(0x1074c)],
        ...leftovers(),
        ['ANAM', empty],
        // A 45 second timer in phase 1: its seconds in the second SNAM.
        ['ANAM', u16s(2)],
        ['NAM0', text('')],
        ['ALID', i32s(12)],
        ['INAM', u32s(17)],
        ['SNAM', u32s(1)],
        ['ENAM', u32s(1)],
        ['SNAM', f32s(45)],
        ['ANAM', empty],
        ['NEXT', empty],
        ['PNAM', u32s(0x3372b)],
        ['INAM', u32s(17)],
        ['VNAM', u32s(3, 1, 3, 2)],
        ['CTDA', stageDone(5)],
      ]),
    );
    expect(scene).toMatchObject({
      formId: 0x100,
      editorId: 'TestScene',
      flags: SceneFlag.beginOnQuestStart | SceneFlag.showAllText,
      quest: 0x3372b,
      lastActionIndex: 17,
      behaviourSettings: {
        death: SceneBehaviourSetting.dontSetAll,
        combat: SceneBehaviourSetting.setAllPause,
        dialogue: SceneBehaviourSetting.dontSetAll,
        observeCombat: SceneBehaviourSetting.setAllEnd,
      },
      scripts: undefined,
    });
    expect(scene.phases.map((phase) => [phase.name, phase.editorWidth])).toEqual([
      ['Wait for the cart', 200],
      ['', 250],
    ]);
    expect(scene.phases[0]?.startConditions.map((c) => c.param2)).toEqual([10]);
    expect(scene.phases[0]?.completionConditions).toEqual([]);
    expect(scene.phases[1]?.startConditions).toEqual([]);
    expect(scene.phases[1]?.completionConditions.map((c) => c.param2)).toEqual([20]);
    expect(scene.conditions.map((c) => c.param2)).toEqual([5]);
    expect(scene.actors).toEqual([
      {
        alias: 12,
        flags: SceneActorFlag.optional,
        behaviour: SceneActorBehaviour.deathEnd | SceneActorBehaviour.combatPause,
      },
      { alias: 4, flags: 0, behaviour: DEFAULT_ACTOR_BEHAVIOUR },
    ]);
    expect(scene.actions).toEqual([
      {
        type: 'dialogue',
        name: 'Ralof talks',
        alias: 12,
        index: 15,
        flags: SceneActionFlag.headtrackPlayer,
        startPhase: 0,
        endPhase: 0,
        unknown: undefined,
        topic: 0xbecbd,
        headtrackAlias: 4,
        loopingMax: 10,
        loopingMin: 1,
        emotion: 3,
        emotionValue: 25,
      },
      {
        type: 'package',
        name: '',
        alias: 4,
        index: 16,
        flags: 0,
        startPhase: 0,
        endPhase: 1,
        unknown: 0,
        packages: [0x1074b, 0x1074c],
      },
      {
        type: 'timer',
        name: '',
        alias: 12,
        index: 17,
        flags: 0,
        startPhase: 1,
        endPhase: 1,
        unknown: undefined,
        seconds: 45,
      },
    ]);
  });

  it('read a line without a topic, skip unknown action types, keep corrupt scripts out', () => {
    const scene = parseScene(
      record([
        ['VMAD', u16s(9, 9)],
        ['ANAM', u16s(7)],
        ['ALID', i32s(1)],
        ['ANAM', empty],
        ['ANAM', u16s(0)],
        ['ALID', i32s(1)],
        ['SNAM', u32s(0)],
        ['ENAM', u32s(0)],
        ['DATA', u32s(0)],
        ['HTID', i32s(-1)],
        ['ANAM', empty],
      ]),
    );
    expect(scene.scripts).toBeUndefined();
    expect(scene.actions).toHaveLength(1);
    expect(scene.actions[0]).toMatchObject({ type: 'dialogue', topic: undefined, alias: 1 });
    expect(scene.quest).toBeUndefined();
    expect(scene.behaviourSettings).toBeUndefined();
  });

  it("read the scene's fragments from its VMAD", () => {
    // Version 5, object format 2, no scripts; the end fragment and one phase fragment.
    const wstring = (value: string): number[] => [
      ...u16s(value.length),
      ...new TextEncoder().encode(value),
    ];
    const header = [...u16s(5, 2, 0)];
    const fragments = [2, 0b10, ...wstring('SF_Test')];
    const end = [1, ...wstring('SF_Test'), ...wstring('Fragment_1')];
    // One phase fragment: on completion (0x2) of phase 0.
    const phases = [...u16s(1), 2, ...u32s(0), 1, ...wstring('SF_Test'), ...wstring('Fragment_0')];
    const vmad = Uint8Array.from([...header, ...fragments, ...end, ...phases]);
    const scene = parseScene(record([['VMAD', vmad]]));
    expect(scene.scripts?.fragmentScript).toBe('SF_Test');
    expect(scene.scripts?.fragments.map((f) => [f.stage, f.function])).toEqual([
      ['end', 'Fragment_1'],
    ]);
    expect(scene.scripts?.phaseFragments).toEqual([
      { phase: 0, when: 2, script: 'SF_Test', function: 'Fragment_0' },
    ]);
  });
});
