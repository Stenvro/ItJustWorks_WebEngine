// Integration test: where coc puts the player (src/world/coc-spot.ts, the engine's choice) in the
// cells of the maintainer's playtest, from the local game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellPlacement, exteriorCells } from '../src/shell/cell-placement.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('coc spots on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let cells: Map<string, number>;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    cells = await exteriorCells(db);
  }, 120000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const at = async (name: string): Promise<readonly number[]> => {
    const placement = await cellPlacement(db, name, (cell) => Promise.resolve(cells.get(cell)));
    if (typeof placement === 'string') throw new Error(placement);
    return placement.position;
  };

  it("puts the player on Windhelm's market, not 12,000 units over it", async () => {
    // Its COCMarkerHeading is persistent (in the worldspace's persistent cell).
    const [, , z] = await at('WindhelmMarketplaceExterior');
    expect(z).toBeLessThan(-12000);
    expect(z).toBeGreaterThan(-12400);
  });

  it("puts the player at Riften's marker, not in the walls under the walkway", async () => {
    const [x, y, z] = await at('RiftenCityNorth');
    // The cell's middle (174080, -92160) lies in the masonry; the XMarkerHeading is on the street.
    expect(Math.hypot((x ?? 0) - 174080, (y ?? 0) + 92160)).toBeGreaterThan(500);
    expect(z).toBeGreaterThan(11000);
  });

  it("keeps Whiterun's COC marker", async () => {
    const [x, y] = await at('WhiterunPlainsDistrict03');
    expect(Math.round(x ?? 0)).toBe(23961);
    expect(Math.round(y ?? 0)).toBe(-7776);
  });
});
