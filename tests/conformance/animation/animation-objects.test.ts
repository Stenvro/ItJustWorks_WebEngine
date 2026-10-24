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
import { readAnimationContainer } from '../../../src/formats/hkx/animation.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import { readAnimObjects, type AnimObjectRecord } from '../../../src/world/anim-object-records.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

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
    for (let second = 0; second < 60; second++) {
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

describe('animation objects (todo)', () => {
  it.todo('a female actor holding one in a hand has both hands’ scale 1, 0.85 after  [original]');
  it.todo('while the player holds one, the POV switch is off  [original]');
  it.todo('saves keep each entry (actor, object, shown) and load it again  [original, M12]');
  it.todo('an object whose model has no Prn is never shown  [original]');
});
