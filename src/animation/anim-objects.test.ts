import { describe, expect, it } from 'vitest';
import type { BehaviorGraph } from '../formats/hkx/behavior.ts';
import {
  AnimObjectList,
  animObjectEventKind,
  animObjectPayloads,
  annotatedAnimObjectEvent,
  stateKey,
  type AnimObjectForm,
} from './anim-objects.ts';

const HAMMER: AnimObjectForm = {
  editorId: 'AnimObjectBlacksmithForgeHammer',
  unloadEvent: 'AnimObjectUnequip',
};
const IRON: AnimObjectForm = {
  editorId: 'AnimObjectBlacksmithForgeIron',
  unloadEvent: 'AnimObjectUnequip',
};
const SEEKER_BOOK: AnimObjectForm = {
  editorId: 'AnimObjectSeekerBook',
  unloadEvent: 'AnimObjUnequip',
};
const LOG: AnimObjectForm = { editorId: 'AnimObjectLog', unloadEvent: undefined };
const SMITH = 0x1000;
const OTHER = 0x2000;

describe('AnimObjectList', () => {
  it('loads an object once per actor', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    expect(list.load(SMITH, HAMMER)).toBeDefined();
    expect(list.load(SMITH, HAMMER)).toBeUndefined();
    expect(list.load(OTHER, HAMMER)).toBeDefined();
    expect(list.of(SMITH)).toHaveLength(1);
  });

  it('shows a loaded object at its draw, and one drawn while loading as it attaches', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    const hammer = list.load(SMITH, HAMMER);
    const iron = list.load(SMITH, IRON);
    if (!hammer || !iron) throw new Error('not loaded');
    // The draw comes before the hammer's model is in: it is shown as it attaches.
    list.draw(SMITH, HAMMER);
    expect(hammer.shown).toBe(false);
    expect(list.loaded(hammer, 'hammer')).toBe(true);
    expect(hammer.shown).toBe(true);
    // The iron is attached hidden, and shown at its draw.
    list.loaded(iron, 'iron');
    expect(iron.shown).toBe(false);
    list.draw(SMITH, IRON);
    expect(iron.shown).toBe(true);
  });

  it('draws nothing the actor did not load, nor what could not be attached', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    expect(list.draw(SMITH, HAMMER)).toBeUndefined();
    const hammer = list.load(SMITH, HAMMER);
    if (!hammer) throw new Error('not loaded');
    list.loaded(hammer, undefined);
    list.draw(SMITH, HAMMER);
    expect(hammer.shown).toBe(false);
  });

  it("takes away an actor's objects at their unload event, of that actor only", () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    list.load(SMITH, HAMMER);
    list.load(SMITH, IRON);
    list.load(SMITH, SEEKER_BOOK);
    list.load(SMITH, LOG);
    list.load(OTHER, HAMMER);
    expect(list.unloadEvent(SMITH, 'animobjectunequip').map((entry) => entry.form)).toEqual([
      HAMMER,
      IRON,
    ]);
    expect(list.of(SMITH).map((entry) => entry.form)).toEqual([SEEKER_BOOK, LOG]);
    expect(list.of(OTHER)).toHaveLength(1);
    expect(list.unloadEvent(SMITH, 'AnimObjUnequip')).toHaveLength(1);
    // An object without an unload event stays until the actor's 3D goes.
    expect(list.unloadEvent(SMITH, '')).toHaveLength(0);
    expect(list.unloadActor(SMITH).map((entry) => entry.form)).toEqual([LOG]);
  });

  it('drops a model that comes in after its entry went', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    const hammer = list.load(SMITH, HAMMER);
    if (!hammer) throw new Error('not loaded');
    list.unloadEvent(SMITH, 'AnimObjectUnequip');
    expect(list.loaded(hammer, 'hammer')).toBe(false);
    // Loaded again, it is a new entry.
    expect(list.load(SMITH, HAMMER)).toBeDefined();
    expect(list.clear()).toHaveLength(1);
  });
});

describe('animation object events', () => {
  it('names the two handlers and reads annotations', () => {
    expect(animObjectEventKind('AnimObjLoad')).toBe('load');
    expect(animObjectEventKind('animobjdraw')).toBe('draw');
    expect(animObjectEventKind('AnimObjectUnequip')).toBeUndefined();
    expect(annotatedAnimObjectEvent('AnimObjLoad.AnimObjectSkeletonKey')).toEqual({
      kind: 'load',
      editorId: 'AnimObjectSkeletonKey',
    });
    expect(annotatedAnimObjectEvent('SoundPlay.NPCKillGore')).toBeUndefined();
    expect(annotatedAnimObjectEvent('AnimObjDraw.')).toBeUndefined();
  });

  it("finds the payloads of states' enter events and clips' triggers", () => {
    const clip = {
      kind: 'clip',
      name: 'ChairDrinkingIdleStart',
      animation: 'Animations\\AnimObjectChairDrinkingIdleStart.hkx',
      triggers: [
        {
          localTime: 1,
          event: { id: 1, payload: 'AnimObjectTankard' },
          relativeToEndOfClip: false,
          acyclic: false,
          isAnnotation: false,
        },
      ],
    };
    const machine = {
      kind: 'state-machine',
      name: 'Furniture_BehaviorGraph',
      states: [
        {
          id: 0,
          name: 'BlackSmith_State',
          probability: 1,
          enable: true,
          generator: clip,
          transitions: [],
          enterNotifyEvents: [
            { id: 0, payload: 'AnimObjectBlacksmithForgeHammer' },
            { id: 1, payload: 'AnimObjectBlacksmithForgeHammer' },
            { id: 2 },
          ],
        },
      ],
      wildcardTransitions: [],
    };
    const graph = {
      name: 'mt_behavior',
      events: ['AnimObjLoad', 'AnimObjDraw', 'AnimObjectUnequip'],
      variables: [],
      root: machine,
    } as unknown as BehaviorGraph;
    const payloads = animObjectPayloads([graph]);
    expect(payloads.states.get(stateKey('Furniture_BehaviorGraph', 'BlackSmith_State'))).toEqual([
      { kind: 'load', editorId: 'AnimObjectBlacksmithForgeHammer' },
      { kind: 'draw', editorId: 'AnimObjectBlacksmithForgeHammer' },
    ]);
    expect(payloads.clips.get('animations\\animobjectchairdrinkingidlestart.hkx')).toEqual([
      { kind: 'draw', editorId: 'AnimObjectTankard' },
    ]);
  });
});
