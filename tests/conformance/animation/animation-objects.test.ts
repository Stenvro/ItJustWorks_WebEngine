// Conformance: animation objects (engine map: Animation and bodies > Animation objects): the
// props idles and furniture put in actors' hands (ANIO), loaded, shown and taken away by the
// events their graphs raise.
//
// Sources:
// - The data: the ANIO records (`node tools/anim-object-info.ts`: 80, their unload events, the
//   nodes their models hang on), the graphs' AnimObjLoad / AnimObjDraw payloads and the clips'
//   annotations (`--graphs`, `--clips`).
// - The rule, observed in the original (the load and draw handlers, the list they feed and
//   the reference's graph event sink; docs/animation.md, "Animation objects"): one entry per
//   actor and object, loaded once; a draw shows it (one drawn while loading shows as it
//   attaches); any event that is a held object's unload event takes away every object of that
//   actor with it; the actor's 3D going drops them all.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnimObjectList,
  animObjectPayloads,
  annotatedAnimObjectEvent,
  type AnimObjectForm,
} from '../../../src/animation/anim-objects.ts';
import type { ActorPose } from '../../../src/animation/skeleton.ts';
import { readAnimationContainer } from '../../../src/formats/hkx/animation.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import type { ActorAnimObjects } from '../../../src/shell/actor-anim-objects.ts';
import { readAnimObjects, type AnimObjectRecord } from '../../../src/world/anim-object-records.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const TANKARD: AnimObjectForm = { editorId: 'AnimObjectTankard', unloadEvent: 'AnimObjectUnequip' };
const LUTE: AnimObjectForm = { editorId: 'AnimObjectLute', unloadEvent: 'AnimObjectUnequip' };
const BOOK: AnimObjectForm = { editorId: 'AnimObjectSeekerBook', unloadEvent: 'AnimObjUnequip' };
const ACTOR = 0x1000;
const OTHER = 0x2000;

describe('the list (original)', () => {
  it('loads an object once per actor', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    expect(list.load(ACTOR, TANKARD)).toBeDefined();
    expect(list.load(ACTOR, TANKARD)).toBeUndefined();
    expect(list.load(OTHER, TANKARD)).toBeDefined();
  });
  it('a draw while loading shows it as it attaches; a draw without an entry does nothing', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    const entry = list.load(ACTOR, TANKARD);
    expect(entry).toBeDefined();
    list.draw(ACTOR, TANKARD);
    expect(entry?.shown).toBe(false);
    if (entry) list.loaded(entry, 'model');
    expect(entry?.shown).toBe(true);
    expect(list.draw(OTHER, LUTE)).toBeUndefined();
  });
  it('an unload event takes away every object of that actor that it unloads, no other', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    list.load(ACTOR, TANKARD);
    list.load(ACTOR, LUTE);
    list.load(ACTOR, BOOK);
    list.load(OTHER, TANKARD);
    expect(list.unloadEvent(ACTOR, 'AnimObjectUnequip')).toHaveLength(2);
    expect(list.of(ACTOR).map((entry) => entry.form.editorId)).toEqual(['AnimObjectSeekerBook']);
    expect(list.of(OTHER)).toHaveLength(1);
  });
  it('the actor’s 3D going drops them all', () => {
    const list = new AnimObjectList<AnimObjectForm, string>();
    list.load(ACTOR, TANKARD);
    list.load(ACTOR, BOOK);
    expect(list.unloadActor(ACTOR)).toHaveLength(2);
    expect(list.of(ACTOR)).toHaveLength(0);
  });
});

describe.skipIf(!hasGamedata())('the animation objects of the load order (data)', () => {
  let sim: Sim;
  let objects = new Map<string, AnimObjectRecord>();
  /** Lower-case editor ids loaded by an actor graph's state or clip trigger, or a clip. */
  const loaded = new Set<string>();
  const payloads = new Set<string>();

  beforeAll(async () => {
    sim = await openSim();
    const vfs = sim.world.session.vfs;
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    objects = await readAnimObjects(sim.db);
    const projects = vfs
      .list('meshes\\actors')
      .filter(
        (path) =>
          path.endsWith('.hkx') &&
          !/\\(animations|behaviors|characters|character assets)/.test(path),
      );
    for (const project of projects) {
      let behavior: string | undefined;
      try {
        behavior = (await loadCharacterInfo(project, read)).behavior;
      } catch {
        continue;
      }
      if (behavior === undefined) continue;
      const { files } = await loadBehaviorFiles(project, behavior, read);
      const found = animObjectPayloads(files.values());
      for (const events of [...found.states.values(), ...found.clips.values()]) {
        for (const event of events) {
          payloads.add(event.editorId.toLowerCase());
          if (event.kind === 'load') loaded.add(event.editorId.toLowerCase());
        }
      }
    }
    for (const path of vfs.list('meshes')) {
      if (!path.endsWith('.hkx') || !path.includes('\\animations\\')) continue;
      let bindings;
      try {
        bindings = readAnimationContainer(Packfile.parse(await read(path))).bindings;
      } catch {
        continue;
      }
      for (const { animation } of bindings) {
        for (const annotation of animation.annotations) {
          const event = annotatedAnimObjectEvent(annotation.text);
          if (event?.kind === 'load') loaded.add(event.editorId.toLowerCase());
        }
      }
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('has 80, 78 of them unloaded by AnimObjectUnequip', () => {
    expect(objects.size).toBe(80);
    const unloads = new Map<string, number>();
    for (const record of objects.values()) {
      const event = record.unloadEvent ?? '';
      unloads.set(event, (unloads.get(event) ?? 0) + 1);
    }
    expect(Object.fromEntries(unloads)).toEqual({
      AnimObjectUnequip: 78,
      AnimObjUnequip: 1,
      '': 1,
    });
  });

  it('every payload of an actor graph names an ANIO', () => {
    for (const id of payloads) expect(objects.has(id)).toBe(true);
  });

  it('72 of them are loaded by an actor graph or clip; 8 by none (unused in vanilla graphs)', () => {
    const never = [...objects.values()]
      .filter((record) => !loaded.has(record.editorId.toLowerCase()))
      .map((record) => record.editorId)
      .sort();
    expect(never).toEqual([
      'AnimObjectBasket',
      'AnimObjectBoundKneesLeatherCuffs',
      'AnimObjectElderScroll',
      'AnimObjectHammerTable',
      'AnimObjectHammerWall',
      'AnimObjectLog',
      'BlackSmithHammerAnimObject',
      'BlackSmithHotIronAnimObject',
    ]);
  });
});

// The Bannered Mare in the evening: its patrons drink, Hulda wipes the counter, Mikael plays.

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())('the Bannered Mare in the evening (headless simulation)', () => {
  let sim: Sim;
  const heldShown = new Map<number, Set<string>>();
  const loads: { actor: number; editorId: string | undefined }[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 20 });
    sim.world.stage.graphEvents.dispatch.listen((source, events) => {
      for (const event of events) {
        if (event.name.toLowerCase() === 'animobjload')
          loads.push({ actor: source.reference, editorId: event.payload });
      }
    });
    // A minute of the evening, and on until Hulda has wiped the counter (four minutes at most).
    // From the counter's idle loop her graph goes to one of two actions about every 20 s, by
    // its own draw (mt_behavior.hkx, AnimObjectBarCounterRandomActionRight_Behavior: a random
    // start state, AnimObjectBarCounterWipeRight or AnimObjectBarCounterRightToArm, the arms
    // folded, each of probability 1): which one comes first is the graph's dice. She wiped at
    // 3 s while actors glided to their furniture in the idle they stood in; walking to the
    // counter (a walk to furniture plays its movement's actions), her graph draws the folded
    // arms twice and wipes at 64 s.
    const wiped = (): boolean =>
      loads.some((load) => load.actor === HULDA && load.editorId === 'AnimObjectBarRag');
    for (let second = 0; second < 240 && (second < 60 || !wiped()); second++) {
      await sim.step(1);
      for (const staged of sim.actors()) {
        for (const held of sim.world.stage.animObjects.held(staged.reference)) {
          if (!held.shown) continue;
          const set = heldShown.get(staged.reference) ?? new Set<string>();
          set.add(held.editorId);
          heldShown.set(staged.reference, set);
        }
      }
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('a patron drinks with a tankard in hand (AnimObjLoad and AnimObjDraw of the drinking states)', () => {
    const drinkers = [...heldShown].filter(([, held]) => held.has('AnimObjectTankard'));
    expect(drinkers.length).toBeGreaterThan(0);
  });

  it('Hulda wipes the counter with the bar rag in hand', () => {
    expect(loads.some((load) => load.actor === HULDA && load.editorId === 'AnimObjectBarRag')).toBe(
      true,
    );
  });

  it('every object loaded is one the graph’s payload names', () => {
    for (const load of loads) expect(load.editorId).toBeDefined();
  });
});

// The engine's rules around an object held (docs/animation.md, "Animation objects"), in the
// Bannered Mare: Hulda (female) given a tankard, the player given one, a book whose model is
// read without its "Prn", a save made and loaded with Hulda holding hers.

const RIGHT_HAND = 'NPC R Hand [RHnd]';
const LEFT_HAND = 'NPC L Hand [LHnd]';

/** A node's scale in a pose's world: its basis's length over its parent's. */
function worldScale(pose: ActorPose, name: string): number {
  const node = pose.skeleton.nodeByName.get(name.toLowerCase()) ?? -1;
  const parent = pose.skeleton.rig.parents[node] ?? -1;
  const length = (at: number): number =>
    Math.hypot(
      pose.worlds[at * 16] ?? 0,
      pose.worlds[at * 16 + 1] ?? 0,
      pose.worlds[at * 16 + 2] ?? 0,
    );
  return length(node) / length(parent);
}

describe.skipIf(!hasGamedata())('an object held (headless simulation)', () => {
  let sim: Sim;
  let loaded: Sim | undefined;
  const animObjects = (): ActorAnimObjects => sim.world.stage.animObjects;
  const holds = (reference: number, editorId: string, world = sim): boolean =>
    world.world.stage.animObjects
      .held(reference)
      .some((held) => held.editorId === editorId && held.node !== undefined);

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 20 });
    await sim.step(2);
  }, 600_000);
  afterAll(async () => {
    await loaded?.close();
    await sim.close();
  });

  it('an object whose model has no Prn is never shown, drawn or not', async () => {
    // The book's model read without its "Prn" (every vanilla object's has one).
    const session = sim.world.session;
    const original = session.damagedModel.bind(session);
    let read = false;
    session.damagedModel = async (path, stage, swaps) => {
      const model = await original(path, stage, swaps);
      if (!model || !path.toLowerCase().endsWith('animobjectbook.nif')) return model;
      read = true;
      return new Proxy(model, {
        get: (target, key): unknown => {
          if (key === 'attachTo') return undefined;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    };
    try {
      animObjects().animObject(HULDA, 'load', 'AnimObjectBook');
      animObjects().animObject(HULDA, 'draw', 'AnimObjectBook');
      expect(await sim.until(() => read, 10)).toBe(true);
      await sim.step(0.5);
      const book = animObjects()
        .held(HULDA)
        .find((held) => held.editorId === 'AnimObjectBook');
      expect(book).toBeDefined();
      expect(book?.shown).toBe(false);
      expect(book?.node).toBeUndefined();
    } finally {
      session.damagedModel = original;
      animObjects().animObject(HULDA, 'unequip', undefined);
    }
  });

  it('a female actor holding one in a hand has both hands’ scale 1, 0.85 after', async () => {
    const hulda = sim.actor(HULDA);
    expect(hulda?.placed.look.female).toBe(true);
    const pose = (): ActorPose => {
      const placed = sim.actor(HULDA)?.placed.pose;
      if (!placed) throw new Error('Hulda has no pose');
      return placed;
    };
    /**
     * Steps with her own idles' objects kept out of her hands (her bar rag): what she holds is
     * only what this case gives her.
     */
    const stepHoldingNothingElse = async (seconds: number): Promise<void> => {
      const objects = animObjects();
      const original = objects.animObject.bind(objects);
      objects.animObject = (reference, kind, editorId) => {
        if (reference === HULDA && kind !== 'unequip') return;
        original(reference, kind, editorId);
      };
      try {
        await sim.step(seconds);
      } finally {
        objects.animObject = original;
      }
    };
    /** Her hands in her pose's world as her clips put them now. */
    const handsInWorld = (): [number, number] => [
      worldScale(pose(), RIGHT_HAND),
      worldScale(pose(), LEFT_HAND),
    ];
    animObjects().animObject(HULDA, 'unequip', undefined);
    await stepHoldingNothingElse(0.2);
    expect(animObjects().held(HULDA)).toHaveLength(0);
    // Her skeleton's own: 0.852, under every clip (a clip's own hand scale is 1).
    expect(sim.actor(HULDA)?.placed.behavior?.playing().length ?? 0).toBeGreaterThan(0);
    expect(pose().scale(RIGHT_HAND)).toBeCloseTo(0.85, 2);
    expect(pose().scale(LEFT_HAND)).toBeCloseTo(0.85, 2);
    const [right, left] = handsInWorld();
    expect(right).toBeCloseTo(0.852, 2);
    expect(left).toBeCloseTo(0.852, 2);
    // A tankard in her right hand: both hands at 1.
    animObjects().animObject(HULDA, 'load', 'AnimObjectTankard');
    animObjects().animObject(HULDA, 'draw', 'AnimObjectTankard');
    expect(await sim.until(() => holds(HULDA, 'AnimObjectTankard'), 10)).toBe(true);
    expect(pose().scale(RIGHT_HAND)).toBe(1);
    expect(pose().scale(LEFT_HAND)).toBe(1);
    await sim.step(0.1);
    const [rightHeld, leftHeld] = handsInWorld();
    expect(rightHeld).toBeCloseTo(1, 3);
    expect(leftHeld).toBeCloseTo(1, 3);
    // It goes: back to 0.85, in her pose's world as her clips go on.
    animObjects().animObject(HULDA, 'unequip', undefined);
    expect(pose().scale(RIGHT_HAND)).toBeCloseTo(0.85, 2);
    expect(pose().scale(LEFT_HAND)).toBeCloseTo(0.85, 2);
    await stepHoldingNothingElse(0.2);
    expect(animObjects().held(HULDA)).toHaveLength(0);
    const [rightAfter, leftAfter] = handsInWorld();
    expect(rightAfter).toBeCloseTo(0.852, 2);
    expect(leftAfter).toBeCloseTo(0.852, 2);
  });

  it('while the player holds one, the POV switch is off', async () => {
    const player = sim.world.player;
    expect(player.pov).toBe('first');
    animObjects().animObject(PLAYER_REF, 'load', 'AnimObjectTankard');
    expect(await sim.until(() => holds(PLAYER_REF, 'AnimObjectTankard'), 10)).toBe(true);
    expect(player.povSwitchAllowed?.()).toBe(false);
    const toggle = async (): Promise<void> => {
      sim.press('Toggle POV', true);
      await sim.step(0.1);
      sim.press('Toggle POV', false);
      await sim.step(0.1);
    };
    await toggle();
    expect(player.pov).toBe('first');
    // It goes: the switch is on again.
    animObjects().animObject(PLAYER_REF, 'unequip', undefined);
    expect(player.povSwitchAllowed?.()).toBe(true);
    await toggle();
    expect(player.pov).toBe('third');
  });

  it('saves keep each entry (actor, object, shown) and load it again', async () => {
    animObjects().animObject(HULDA, 'unequip', undefined);
    animObjects().animObject(HULDA, 'load', 'AnimObjectTankard');
    animObjects().animObject(HULDA, 'draw', 'AnimObjectTankard');
    expect(await sim.until(() => holds(HULDA, 'AnimObjectTankard'), 10)).toBe(true);
    const tankard = await sim.formId('ANIO', 'AnimObjectTankard');
    expect(animObjects().save()).toContainEqual({
      actor: HULDA,
      animObject: tankard,
      shown: true,
    });
    const bytes = await sim.save();
    // One simulation at a time: the first goes before the save is loaded.
    await sim.close();
    loaded = await loadSim(bytes);
    const again = loaded;
    expect(await again.until(() => holds(HULDA, 'AnimObjectTankard', again), 30)).toBe(true);
    const held = again.world.stage.animObjects
      .held(HULDA)
      .find((object) => object.editorId === 'AnimObjectTankard');
    expect(held?.shown).toBe(true);
    expect(held?.node).toBe('npc r hand [rhnd]');
  }, 600_000);
});
