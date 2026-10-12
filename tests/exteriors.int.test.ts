// Integration test: exterior worldspaces, their cells and landscape, on the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTerrainCell } from '../src/render/terrain-data.ts';
import { landTexture } from '../src/world/land.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
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

  it('uses the world default where a cell sets no water height', async () => {
    const tamriel = await Worldspace.open(db, await worldId('Tamriel'));
    expect(tamriel.record.defaultWaterHeight).toBeLessThan(0);
    const height = await tamriel.waterHeight(4, -3);
    expect(Number.isFinite(height)).toBe(true);
  }, 30_000);
});
