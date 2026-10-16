// Integration test: the navigation meshes' links, the navmesh info map (NAVI) and the navmesh
// graph, on the local game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellNavmeshes, triangleNeighbour } from '../src/world/navmesh.ts';
import { loadNavmeshGraph } from '../src/world/navmesh-graph.ts';
import { loadNavmeshInfo, type NavmeshInfoMap } from '../src/world/navmesh-info.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const TAMRIEL = 0x3c;

describe.skipIf(!hasGamedata())('navmeshes on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let info: NavmeshInfoMap;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    info = await loadNavmeshInfo(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const breezehome = async (): Promise<number> => {
    const cell = (await db.interiorCells()).find((c) => c.editorId === 'WhiterunBreezehome');
    if (!cell) throw new Error('WhiterunBreezehome missing');
    return cell.formId;
  };

  it('merges the NAVI record of every plugin', () => {
    expect(info.infos.size).toBeGreaterThan(18_000);
    expect(info.roadMarkers).toHaveLength(10);
    expect(info.paths).toHaveLength(100);
  });

  it('lists the navmeshes a navmesh links into, as its edge links do (Riverwood)', async () => {
    const riverwood = await db.exteriorCell(TAMRIEL, 5, -12);
    if (riverwood === undefined) throw new Error('Riverwood cell missing');
    const meshes = await cellNavmeshes(db, riverwood);
    expect(meshes.length).toBeGreaterThan(0);
    for (const navmesh of meshes) {
      const linked = new Set<number>();
      navmesh.triangles.forEach((_, index) => {
        for (let edge = 0; edge < 3; edge++) {
          const across = triangleNeighbour(navmesh, index, edge);
          if (typeof across === 'object' && across.navmesh !== navmesh.formId) {
            linked.add(across.navmesh);
          }
        }
      });
      const entry = info.infos.get(navmesh.formId);
      expect(entry?.cell).toEqual({ x: 5, y: -12 });
      expect(new Set([...(entry?.edgeLinks ?? []), ...(entry?.preferredEdgeLinks ?? [])])).toEqual(
        linked,
      );
    }
  });

  it("connects Breezehome to Tamriel's roads through its doors", async () => {
    const graph = await loadNavmeshGraph(db);
    const [inside] = await cellNavmeshes(db, await breezehome());
    if (!inside) throw new Error('no navmesh in Breezehome');
    const node = graph.nodes.get(inside.formId);
    // Its front door leads out into Whiterun.
    expect(node?.doors).toHaveLength(1);
    expect(node?.doors[0]?.navmeshes.length).toBeGreaterThan(0);
    // The largest component holds most of Tamriel, Whiterun and Breezehome.
    const main = graph.components[0] ?? [];
    expect(main.length).toBeGreaterThan(10_000);
    expect(node?.component).toBe(0);
    const marker = info.roadMarkers[0]?.navmesh ?? 0;
    expect(graph.connected(inside.formId, marker)).toBe(true);
  }, 60_000);
});
