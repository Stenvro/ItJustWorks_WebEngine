// Integration test: the visual-effect rules on the local game data (docs/rendering.md, "Spot
// lights" and "Effects and particles"; docs/gameplay.md, "A hand's cast"). Bleak Falls
// Barrow's sunbeam is a spot light whose cone points down and misses Arvel's web, with its
// fade lowered by its XLIG offset; the web's shapes are lit, blended greyscale-palette
// effects; the cobweb walls flagged as having editor markers draw their cobweb; a dragon's
// breath leaves one fire per placement radius, not one per spray. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif } from '../src/formats/nif/nif.ts';
import { ImpactPlacements } from '../src/gameplay/magic/impact-placement.ts';
import { buildModel } from '../src/render/model-data.ts';
import { lightCone } from '../src/world/cell-loader.ts';
import { LightFlag, parseLight, parseReference } from '../src/world/cell-records.ts';
import { parseImpact } from '../src/world/impact-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Skyrim.esm forms. */
const BFB_SUNLIGHT = 0x6ed64; // a BleakFallsSunlight01 in BleakFallsBarrow01
const ARVEL_WEB_AT: readonly [number, number, number] = [3918, -3314, -1779];

describe.skipIf(!hasGamedata())('visual effects on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  const model = async (path: string) => buildModel(parseNif(await vfs.read(path)));

  it("shines Bleak Falls Barrow's sunbeam down its cone, past Arvel's web", async () => {
    const record = await db.require(BFB_SUNLIGHT);
    const reference = parseReference(record);
    const base = await db.require(reference.base);
    const light = parseLight(base);
    expect(light.flags & LightFlag.shadowSpotlight).not.toBe(0);
    // Its fade with the reference's XLIG offset: 5 − 2.97.
    expect(light.fade + reference.lightFadeOffset).toBeCloseTo(2.03, 2);
    const { spot } = lightCone(light, reference);
    expect(spot).toBeDefined();
    if (!spot) return;
    // Down, within a few degrees.
    expect(spot.direction[2]).toBeLessThan(-0.95);
    // The web lies outside the cone (it was lit as if the light shone every way).
    const to = ARVEL_WEB_AT.map((value, i) => value - (reference.position[i] ?? 0));
    const [dx = 0, dy = 0, dz = 0] = to;
    const length = Math.hypot(...to);
    const along =
      (dx * spot.direction[0] + dy * spot.direction[1] + dz * spot.direction[2]) / length;
    expect(along).toBeLessThan(spot.cosHalfAngle);
  });

  it("draws Arvel's web as lit, blended greyscale-palette effects", async () => {
    const web = await model('meshes\\furniture\\fxspiderwebkitdoorspecial.nif');
    const effects = web.parts.filter((part) => part.material?.kind === 'effect');
    expect(effects.length).toBe(5);
    for (const part of effects) {
      const material = part.material;
      if (material?.kind !== 'effect') continue;
      // SLSF2 Effect_Lighting and SLSF1 greyscale-to-palette alpha, blended (no alpha test).
      expect(material.flags2 & 0x40000000).not.toBe(0);
      expect(material.flags1 & 0x20).not.toBe(0);
      expect((part.alpha?.flags ?? 0) & 0x1).toBe(1);
      expect((part.alpha?.flags ?? 0) & 0x200).toBe(0);
    }
  });

  it('draws the cobweb walls that are flagged as having an editor marker', async () => {
    const wall = await model('meshes\\effects\\fxcobwebwall01.nif');
    expect(wall.editorMarker).toBe(false);
    expect(wall.parts.map((part) => part.name)).toEqual(['Cylinder01']);
  });

  it("spaces a dragon's breath fires by the impact's placement radius", async () => {
    let impactId: number | undefined;
    for (const formId of db.formIdsOfType('IPCT'))
      if ((await db.get(formId))?.editorId === 'MAGDragonFireImpact01') impactId = formId;
    expect(impactId).toBeDefined();
    if (impactId === undefined) return;
    const impact = parseImpact(await db.require(impactId));
    expect(impact.placementRadius).toBe(200);
    expect(impact.hazard).toBeDefined();
    // A 3-second breath: a spray every 0.1 s, sweeping 40 units a spray across the ground.
    const placements = new ImpactPlacements();
    let placed = 0;
    for (let spray = 0; spray < 30; spray++)
      if (placements.place(impact, [spray * 40, 0, 0], spray * 0.1)) placed++;
    // One fire every 200 units (each spray placed one before).
    expect(placed).toBe(6);
  });
});
