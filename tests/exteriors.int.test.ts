// Integration test: exterior worldspaces, their cells and landscape, on the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkyObjectType } from '../src/formats/nif/types.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { atmosphereProfile, skyShapes } from '../src/render/sky-data.ts';
import { buildTerrainCell } from '../src/render/terrain-data.ts';
import { landTexture } from '../src/world/land.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { skyState } from '../src/world/sky-state.ts';
import {
  cellWeathers,
  parseClimate,
  parseRegionWeather,
  parseWeather,
} from '../src/world/weather.ts';
import { ParentUse, Worldspace } from '../src/world/worldspace.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('exteriors on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const worldId = async (editorId: string): Promise<number> => {
    const world = (await db.worldspaces()).find((w) => w.editorId === editorId);
    if (!world) throw new Error(`${editorId} missing`);
    return world.formId;
  };

  it('lists the worldspaces of all masters', async () => {
    const ids = (await db.worldspaces()).map((w) => w.editorId);
    for (const id of ['Tamriel', 'WhiterunWorld', 'DLC01SoulCairn', 'DLC2SolstheimWorld']) {
      expect(ids).toContain(id);
    }
  });

  it('WhiterunWorld takes its landscape, water and climate from Tamriel', async () => {
    const world = await Worldspace.open(db, await worldId('WhiterunWorld'));
    expect(world.record.parentUse & ParentUse.land).toBe(ParentUse.land);
    expect(world.landWorld.editorId).toBe('Tamriel');
    expect(world.climateWorld.editorId).toBe('Tamriel');
    expect(world.waterWorld.editorId).toBe('Tamriel');
    // Whiterun's persistent references (the city's NPCs and doors) sit around cell 4,-3.
    expect(world.persistentReferences(4, -3).length).toBeGreaterThan(0);
  }, 30_000);

  it('finds exterior cells by grid position and reads their landscape', async () => {
    const tamriel = await Worldspace.open(db, await worldId('Tamriel'));
    expect(tamriel.persistentReferences(4, -3).length).toBeGreaterThan(0);
    const cell = await tamriel.cell(4, -3);
    expect(cell).toBeDefined();
    const land = await tamriel.land(4, -3);
    if (!land) throw new Error('no landscape at 4,-3');
    expect(land.heights.every(Number.isFinite)).toBe(true);
    expect(land.normals).toBeDefined();
    const quadrants = buildTerrainCell(land, 4, -3);
    expect(quadrants.length).toBe(4);
    for (const quadrant of quadrants) {
      expect(Number.isFinite(quadrant.radius)).toBe(true);
      for (const ltex of quadrant.textures) {
        if (ltex === undefined) continue;
        const texture = await landTexture((id) => db.get(id), ltex);
        if (texture) expect(vfs.has(texture.diffuse)).toBe(true);
      }
    }
    // Cells outside the map have no record.
    expect(await tamriel.cell(500, 500)).toBeUndefined();
  }, 30_000);

  it("takes a cell's weathers from its weather region", async () => {
    const tamriel = await Worldspace.open(db, await worldId('Tamriel'));
    const regions = await Promise.all(
      (await tamriel.regions(4, -3)).map(async (id) => {
        const record = await db.get(id);
        return record ? parseRegionWeather(record) : undefined;
      }),
    );
    const list = cellWeathers(regions, undefined);
    expect(list.length).toBeGreaterThan(2);
    const names = await Promise.all(
      list.map(async (entry) => (await db.get(entry.weather))?.editorId),
    );
    expect(names).toContain('SkyrimClearTU');
  }, 30_000);

  it('blends a weather by time of day: clear noon is bright, its night dark with stars', async () => {
    let record: GameRecord | undefined;
    for (const id of db.formIdsOfType('WTHR')) {
      const candidate = await db.get(id);
      if (candidate?.editorId === 'SkyrimClear') record = candidate;
    }
    if (!record) throw new Error('SkyrimClear missing');
    const weather = parseWeather(record);
    const climateRecord = await db.get(0x15f); // DefaultClimate
    const climate = climateRecord ? parseClimate(climateRecord) : undefined;
    const noon = skyState({ weather, climate, hour: 13, daysPassed: 0, seconds: 0 });
    const night = skyState({ weather, climate, hour: 1, daysPassed: 0, seconds: 0 });
    const brightness = (c: readonly number[]): number => c.reduce((a, b) => a + b, 0);
    expect(brightness(noon.skyUpper)).toBeGreaterThan(brightness(night.skyUpper));
    expect(brightness(noon.sunlight)).toBeGreaterThan(1);
    expect(noon.clouds.length).toBeGreaterThan(3);
    expect(night.starsAlpha).toBe(1);
    expect(night.masser.visible).toBe(true);
  });

  it('reads the sky meshes: one dome, a shape per cloud layer and the star sphere', async () => {
    const shapes = async (path: string) => skyShapes(parseNif(await vfs.read(path)));
    const [atmosphere] = await shapes('meshes\\sky\\atmosphere.nif');
    expect(atmosphere?.objectType).toBe(SkyObjectType.sky);
    const clouds = await shapes('meshes\\sky\\clouds.nif');
    expect(clouds.length).toBe(29);
    expect(clouds.every((c) => c.objectType === SkyObjectType.clouds)).toBe(true);
    const stars = await shapes('meshes\\sky\\stars.nif');
    expect(stars.map((s) => s.texture)).toContain('textures\\sky\\skystars.dds');
    if (!atmosphere) throw new Error('no dome');
    const profile = atmosphereProfile(atmosphere);
    // Horizon colour at the bottom, upper sky at the top.
    expect(profile[0]).toBeGreaterThan(0.9);
    expect(profile[profile.length - 2]).toBeGreaterThan(0.9);
  });

  it('uses the world default where a cell sets no water height', async () => {
    const tamriel = await Worldspace.open(db, await worldId('Tamriel'));
    expect(tamriel.record.defaultWaterHeight).toBeLessThan(0);
    const height = await tamriel.waterHeight(4, -3);
    expect(Number.isFinite(height)).toBe(true);
  }, 30_000);
});
