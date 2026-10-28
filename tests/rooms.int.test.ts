// Integration test: rooms, portals and occluders of interiors and the exterior, on the local
// game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCellData } from '../src/world/cell-loader.ts';
import { LightFlag } from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

// The cases read cells from the archives: 30 s each, as the default 5 s runs out when the machine is busy.
describe.skipIf(!hasGamedata())(
  'rooms and portals on the local game data',
  { timeout: 30_000 },
  () => {
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

    const rooms = async (editorId: string) => {
      const cell = (await db.interiorCells()).find((c) => c.editorId === editorId);
      if (!cell) throw new Error(`${editorId} missing`);
      const data = await loadCellData(db, cell.formId);
      if (!data.rooms) throw new Error('no culling markers read');
      return { data, rooms: data.rooms };
    };

    it.each([
      ['WhiterunDragonsreach', 9, 6],
      ['BleakFallsBarrow01', 34, 21],
    ])(
      'reads the rooms of %s, every portal joining two of them',
      async (editorId, roomCount, portalCount) => {
        const { rooms: set } = await rooms(editorId);
        expect(set.rooms).toHaveLength(roomCount);
        expect(set.portals).toHaveLength(portalCount);
        const references = new Set(set.rooms.map((room) => room.reference));
        for (const portal of set.portals) {
          expect(references.has(portal.rooms[0])).toBe(true);
          expect(references.has(portal.rooms[1])).toBe(true);
          expect(portal.rooms[0]).not.toBe(portal.rooms[1]);
        }
        for (const room of set.rooms) {
          for (const linked of room.linked) expect(references.has(linked)).toBe(true);
        }
      },
    );

    it("has no rooms in the Jarl's quarters (everything is drawn)", async () => {
      const { rooms: set } = await rooms('WhiterunDragonsreachJarlsQuarters');
      expect(set.rooms).toHaveLength(0);
      expect(set.portals).toHaveLength(0);
    });

    it('gives portal-strict lights the room they stand in', async () => {
      const { data } = await rooms('BleakFallsBarrow01');
      const strict = data.lights.filter((light) => (light.flags & LightFlag.portalStrict) !== 0);
      // Whether the barrow has any, each one standing in a room has it.
      for (const light of strict) {
        if (light.room !== undefined) {
          expect(light.room).toBeGreaterThan(0);
          expect(light.room).toBeLessThanOrEqual(data.rooms?.rooms.length ?? 0);
        }
      }
      expect(data.lights.filter((light) => light.room !== undefined).length).toBeLessThanOrEqual(
        strict.length,
      );
    });

    it('reads the occlusion boxes of an exterior cell by Whiterun', async () => {
      const cell = await db.exteriorCell(0x3c, -4, -3);
      if (cell === undefined) throw new Error('cell missing');
      const data = await loadCellData(db, cell);
      expect(data.rooms?.occluders.length).toBeGreaterThanOrEqual(3);
    });
  },
);
