// Integration test: actor looks resolved from the local game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActorResolver, meshPath } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('actor looks on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let resolver: ActorResolver;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    resolver = new ActorResolver(db);
  });
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("dresses Whiterun's housecarl in her outfit over the Nord skin", async () => {
    const look = await resolver.resolve(0xa2c8e, 0xa2c8e);
    if (!look) throw new Error('no look');
    expect(look.female).toBe(true);
    expect(look.raceEditorId).toBe('NordRace');
    expect(look.scale).toBeCloseTo(1.03, 3);
    expect(look.skeleton).toBe(
      'meshes\\actors\\character\\character assets female\\skeleton_female.nif',
    );
    expect(look.behavior).toBe('meshes\\actors\\character\\defaultfemale.hkx');
    expect(look.faceGen?.geometry).toBe(
      'meshes\\actors\\character\\facegendata\\facegeom\\skyrim.esm\\000A2C8E.nif',
    );
    expect(look.worn.map((worn) => worn.editorId)).toEqual([
      'SteelBootsAA',
      'SteelCuirassAA',
      'SteelGlovesAA',
      'SteelShieldAA',
    ]);
    // The cuirass owns the body; the gauntlets take its forearms, the boots its calves.
    const cuirass = look.worn.find((worn) => worn.editorId === 'SteelCuirassAA');
    expect(look.owners.get(32)).toBe(cuirass?.addon);
    expect(look.owners.get(34)).not.toBe(cuirass?.addon);
    for (const worn of look.worn) expect(vfs.has(meshPath(worn.model.path))).toBe(true);
    expect(vfs.has(look.faceGen?.geometry ?? '')).toBe(true);
    expect(vfs.has(look.faceGen?.tint ?? '')).toBe(true);
  });

  it('shows the naked skin where no armor covers it', async () => {
    // Ysolda: farm clothes and boots, her race's bare hands.
    const look = await resolver.resolve(0x13bab, 0x13bab);
    expect(look?.worn.map((worn) => [worn.editorId, worn.skin])).toEqual([
      ['FarmerTorso04AA', false],
      ['FarmerBoots04AA', false],
      ['NakedHands', true],
    ]);
  });
});
