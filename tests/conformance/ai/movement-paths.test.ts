// Conformance: movement and paths (engine map: AI > Movement, paths): here the navmesh
// obstacles, the engine's cut of the navmesh under objects that block a way while they are there
// (docs/ai.md, "Navmesh obstacles (not built yet)").
//
// Sources:
// - CommonLibSSE: NavMeshObstacleManager, BSNavmeshObstacleData per triangle and
//   BSNavmeshObstacleUndoData to restore the cut, bhkObstacleDeactivationListener (a Havok body
//   come to rest), DoorObstacleAdapter (doors); TESForm record flag bit 25 (kObstacle) on a base
//   object makes its references obstacles.
// - The data: `node tools/navmesh-obstacle-audit.ts` (Skyrim.esm, the DLCs and the Creation Club
//   files of the maintainer's game folder, 2026-10-24): 65 flagged bases, 6,953 references,
//   CollisionMarker [00000021] 4,663 of them (docs/ai.md had 4,664).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';

/** TESForm record flag of a base object: its references are navmesh obstacles. */
const OBSTACLE = 1 << 25;
/** The base types that carry it in the data (tools/navmesh-obstacle-audit.ts). */
const TYPES = ['STAT', 'MSTT', 'ACTI', 'CONT', 'LIGH', 'FURN', 'DOOR', 'TREE', 'FLOR', 'MISC'];
const COLLISION_MARKER = 0x21;

describe.skipIf(!hasGamedata())('navmesh obstacles across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const bases = new Set<number>();
  let references = 0;
  let markers = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const type of TYPES) {
      for (const formId of db.formIdsOfType(type)) {
        const record = await db.get(formId);
        if (record && !record.deleted && (record.flags & OBSTACLE) !== 0) bases.add(formId);
      }
    }
    for (const formId of db.formIdsOfType('REFR')) {
      const record = await db.get(formId);
      const base = record?.formIdField('NAME');
      if (!record || record.deleted || base === undefined || !bases.has(base)) continue;
      references++;
      if (base === COLLISION_MARKER) markers++;
    }
  }, 600_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts 65 obstacle bases with 6,953 references, 4,663 of them collision markers', () => {
    expect(bases.size).toBe(65);
    expect(references).toBe(6953);
    expect(markers).toBe(4663);
  });

  it.todo(
    'cuts the navmesh under an enabled obstacle: no path crosses a quest’s collision box ' +
      '(CollisionMarker XPRM box or sphere) while it is enabled (NavMeshObstacleManager; the ' +
      'shape’s cut to be observed in the original)',
  );
  it.todo(
    'restores the cut as the obstacle is disabled (BSNavmeshObstacleUndoData): MQ101’s Helgen inn ' +
      'rubble (dunCGInnCollisionMarker) shuts the way out of the ground floor’s east room',
  );
  it.todo(
    'cuts again as an animated obstacle moves (a portcullis open or shut: PortGatePole01, 511 ' +
      'references; DoorObstacleAdapter) and as a Havok body comes to rest ' +
      '(bhkObstacleDeactivationListener)',
  );
  it.todo(
    'cuts a triangle partly covered as the engine does (BSNavmeshObstacleData per triangle: ' +
      'whether a part-covered triangle is closed whole is to be observed in the original)',
  );
});
