// Integration test: animation objects on the local game data (src/world/anim-object-records.ts,
// src/animation/anim-objects.ts): the ANIO records, the nodes their models hang on, and the
// payloads of the people's graphs' AnimObjLoad and AnimObjDraw events, which all name a
// record. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { animObjectPayloads, stateKey } from '../src/animation/anim-objects.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../src/formats/hkx/behavior.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildRig } from '../src/animation/skeleton.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { meshPath } from '../src/world/actors.ts';
import { readAnimObjects, type AnimObjectRecord } from '../src/world/anim-object-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PEOPLE = 'meshes\\actors\\character\\defaultmale.hkx';
const FIRST_PERSON = 'meshes\\actors\\character\\_1stperson\\firstperson.hkx';

describe.skipIf(!hasGamedata())('animation objects on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let objects: Map<string, AnimObjectRecord>;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    objects = await readAnimObjects(db);
  });
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('reads the ANIO records with their models and unload events', () => {
    // Skyrim.esm has 63; the official plugins add theirs.
    expect(objects.size).toBeGreaterThanOrEqual(63);
    const hammer = objects.get('animobjectblacksmithforgehammer');
    expect(hammer?.model).toBe('AnimObjects\\AnimObjectBlacksmithForgeHammer.nif');
    expect(hammer?.unloadEvent).toBe('AnimObjectUnequip');
    expect(objects.get('animobjectlog')?.unloadEvent).toBeUndefined();
    const unload = new Set([...objects.values()].map((record) => record.unloadEvent));
    expect(unload.has('AnimObjectUnequip')).toBe(true);
  });

  it("hangs every object's model on a node of the people's skeleton", async () => {
    const skeleton = buildRig(
      parseNif(await read('meshes\\actors\\character\\character assets\\skeleton.nif')),
    );
    const nodes = new Set(skeleton.names.map((name) => name.toLowerCase()));
    for (const name of ['AnimObjectR', 'AnimObjectL', 'AnimObjectA', 'AnimObjectB']) {
      expect(nodes.has(name.toLowerCase())).toBe(true);
    }
    const missing: string[] = [];
    for (const record of objects.values()) {
      if (record.model === undefined) continue;
      const model = buildModel(parseNif(await read(meshPath(record.model))));
      const node = model.attachTo;
      // The Riekling's chisels name their hand nodes as the Riekling's skeleton does.
      if (
        node === undefined ||
        (!nodes.has(node.toLowerCase()) && !/riekling/i.test(record.editorId))
      ) {
        missing.push(`${record.editorId}: ${String(node)}`);
      }
    }
    expect(missing).toEqual([]);
    const hammer = objects.get('animobjectblacksmithforgehammer');
    const model = buildModel(parseNif(await read(meshPath(hammer?.model ?? ''))));
    expect(model.attachTo).toBe('AnimObjectR');
  });

  it("finds a record for every payload of the people's graphs, at the anvil the hammer", async () => {
    for (const project of [PEOPLE, FIRST_PERSON]) {
      const behavior = (await loadCharacterInfo(project, read)).behavior;
      if (behavior === undefined) throw new Error(`${project}: no behavior`);
      const { files } = await loadBehaviorFiles(project, behavior, read);
      const payloads = animObjectPayloads(files.values());
      const unknown = [...payloads.states.values(), ...payloads.clips.values()]
        .flat()
        .filter((event) => !objects.has(event.editorId.toLowerCase()));
      expect(unknown).toEqual([]);
      if (project !== PEOPLE) continue;
      expect(payloads.states.get(stateKey('Furniture_BehaviorGraph', 'BlackSmith_State'))).toEqual([
        { kind: 'load', editorId: 'AnimObjectBlacksmithForgeHammer' },
        { kind: 'load', editorId: 'AnimObjectBlacksmithForgeIron' },
        { kind: 'draw', editorId: 'AnimObjectBlacksmithForgeHammer' },
        { kind: 'draw', editorId: 'AnimObjectBlacksmithForgeIron' },
      ]);
      expect(payloads.states.get(stateKey('NonOffsetIdlesBehavior', 'AnimObjectLute'))).toEqual([
        { kind: 'load', editorId: 'AnimObjectLute' },
        { kind: 'draw', editorId: 'AnimObjectLute' },
      ]);
    }
  }, 120_000);
});
