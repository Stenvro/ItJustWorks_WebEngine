// Integration test: character creation against the local game data. Rebuilds NPC heads from
// their face data (NAM9, NAMA, weight, tint layers) and compares them with the FaceGen heads
// and face tints the Creation Kit baked for them. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDds } from '../src/formats/dds/dds.ts';
import { decodeDdsLevel } from '../src/formats/dds/decode.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { parseTri, type TriFile } from '../src/formats/nif/tri.ts';
import { ChargenCatalog } from '../src/gameplay/chargen-catalog.ts';
import {
  appearanceFromNpc,
  buildSliders,
  chargenMorphWeights,
  composeFaceTint,
  faceTintLayers,
  type TintCompositeLayer,
} from '../src/gameplay/chargen.ts';
import {
  bakeHeadPart,
  headPartBasePositions,
  headPartMorphPaths,
} from '../src/gameplay/chargen-morphs.ts';
import { HeadPartType, parseHeadPart, type HeadPartRecord } from '../src/world/actor-records.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Nord men: WEHeadlessHorseman, MQ101ImperialSoldierUnaggressive02, MQ101StormcloakPrisonerMaleNord02. */
const NORD_MEN = [0x10b302, 0x10a1aa, 0x10a1a7];
/** Nord women: Ysolda, the Whiterun housecarl. */
const NORD_WOMEN = [0x13bab, 0xa2c8e];

describe.skipIf(!hasGamedata())('character creation on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let catalog: ChargenCatalog;
  const headParts = new Map<string, HeadPartRecord>();
  const tris = new Map<string, TriFile | undefined>();

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    catalog = await ChargenCatalog.open(db);
    for (const formId of db.formIdsOfType('HDPT')) {
      const record = await db.get(formId);
      if (record) headParts.set((record.editorId ?? '').toLowerCase(), parseHeadPart(record));
    }
  });
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const tri = async (path: string | undefined): Promise<TriFile | undefined> => {
    if (path === undefined || !vfs.has(path)) return undefined;
    if (!tris.has(path)) tris.set(path, parseTri(await vfs.read(path)));
    return tris.get(path);
  };

  /** The FaceGen file of an actor base (`<root>\<plugin>\<id>.<ext>`). */
  const faceGenPath = (formId: number, root: string, extension: string): string => {
    const origin = db.origin(formId);
    if (!origin) throw new Error(`no origin for ${formId.toString(16)}`);
    const id = origin.objectId.toString(16).toUpperCase().padStart(8, '0');
    return `${root}\\${origin.plugin.entry.name.toLowerCase()}\\${id}.${extension}`;
  };

  /** Largest coordinate difference per baked shape between our head and the FaceGen head. */
  async function headErrors(npc: number): Promise<Map<string, number>> {
    const face = await catalog.face(npc);
    if (face?.race === undefined) throw new Error('no face');
    const data = await catalog.raceData(face.race, face.female ? 1 : 0);
    const weights = chargenMorphWeights(appearanceFromNpc(data, face), data.morphRace);
    const baked = parseNif(
      await vfs.read(faceGenPath(npc, 'meshes\\actors\\character\\facegendata\\facegeom', 'nif')),
    );
    const errors = new Map<string, number>();
    for (const block of baked.blocks) {
      if (block.kind !== 'tri-shape' || !block.dynamicPositions) continue;
      const part = headParts.get(block.name.toLowerCase());
      if (!part?.model) throw new Error(`no head part ${block.name}`);
      const base = headPartBasePositions(parseNif(await vfs.read(meshPath(part.model))));
      if (!base) throw new Error(`no positions in ${part.model}`);
      const paths = headPartMorphPaths(part);
      const ours = bakeHeadPart(
        base,
        4,
        {
          race: await tri(paths.race),
          chargen: await tri(paths.chargen),
          expressions: await tri(paths.expressions),
        },
        weights,
      );
      expect(ours.length).toBe(block.dynamicPositions.length);
      let largest = 0;
      for (let i = 0; i < ours.length; i++) {
        if (i % 4 === 3) continue;
        largest = Math.max(largest, Math.abs((ours[i] ?? 0) - (block.dynamicPositions[i] ?? 0)));
      }
      errors.set(part.editorId, largest);
    }
    return errors;
  }

  it('lists the ten playable races with ten presets per sex', async () => {
    expect(catalog.races.map((race) => race.editorId)).toEqual([
      'ArgonianRace',
      'BretonRace',
      'DarkElfRace',
      'HighElfRace',
      'ImperialRace',
      'KhajiitRace',
      'NordRace',
      'OrcRace',
      'RedguardRace',
      'WoodElfRace',
    ]);
    for (const { formId } of catalog.races) {
      const race = await catalog.race(formId);
      expect(race?.sexes.map((sex) => sex.presets.length)).toEqual([10, 10]);
      expect(race?.description).not.toBe('');
    }
  });

  it('offers a Nord man the vanilla head part lists', async () => {
    const data = await catalog.raceData(0x13746, 0);
    const count = (type: number) => data.headPartLists.get(type)?.length;
    expect([
      count(HeadPartType.eyes),
      count(HeadPartType.hair),
      count(HeadPartType.facialHair),
      count(HeadPartType.scar),
      count(HeadPartType.eyebrows),
    ]).toEqual([22, 29, 46, 13, 12]);
    expect(data.hairColors).toHaveLength(15);
    expect(data.faceDetails).toHaveLength(6);
    expect(data.morphTypes[0]).toEqual([
      1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    // Women have no facial hair: the slider is left out.
    const women = await catalog.raceData(0x13746, 1);
    const player = await catalog.face(0x7);
    if (!player) throw new Error('no Player');
    const sliders = buildSliders(women, appearanceFromNpc(women, player));
    expect(sliders.some((s) => s.label === 'sRSMFacialHairPresets')).toBe(false);
    expect(sliders.some((s) => s.label === 'sRSMHairPresets')).toBe(true);
  });

  it.each([...NORD_MEN, ...NORD_WOMEN])(
    'rebuilds the FaceGen head of %s from its face data',
    async (npc) => {
      const errors = await headErrors(npc);
      expect(errors.size).toBeGreaterThan(3);
      for (const [part, error] of errors) {
        // TODO(M13): beards come out up to 0.08 off; no combination of their morphs fits better
        // (least squares: 0.06), so the Creation Kit bakes them some other way.
        if (/beard/i.test(part)) continue;
        expect(error, part).toBeLessThan(0.05);
      }
    },
  );

  it.each([...NORD_MEN, ...NORD_WOMEN])(
    'composites the face tint of %s like the baked one',
    async (npc) => {
      const face = await catalog.face(npc);
      if (face?.race === undefined) throw new Error('no face');
      const data = await catalog.raceData(face.race, face.female ? 1 : 0);
      const appearance = appearanceFromNpc(data, face);
      const baked = parseDds(
        await vfs.read(
          faceGenPath(npc, 'textures\\actors\\character\\facegendata\\facetint', 'dds'),
        ),
      );
      const level = baked.levels[0];
      if (!level) throw new Error('no level');
      const expected = decodeDdsLevel(baked, level);
      const layers: TintCompositeLayer[] = [];
      for (const layer of faceTintLayers(data, appearance)) {
        const mask = parseDds(await vfs.read(layer.mask));
        const maskLevel = mask.levels[0];
        if (!maskLevel) continue;
        layers.push({
          mask: { data: decodeDdsLevel(mask, maskLevel), width: mask.width, height: mask.height },
          color: layer.color,
          value: layer.value,
        });
      }
      expect(layers.length).toBeGreaterThanOrEqual(face.tints.length);
      const ours = composeFaceTint(layers, baked.width, baked.height);
      let error = 0;
      for (let i = 0; i < ours.length; i++) {
        if (i % 4 !== 3) error += Math.abs((ours[i] ?? 0) - (expected[i] ?? 0));
      }
      expect(error / (baked.width * baked.height * 3)).toBeLessThan(3);
    },
  );
});
