// Audits the classes of visual effects against the real files (docs/rendering.md, "Effects and
// particles"; docs/gameplay.md, "Casting and shouts"):
//
//   node tools/effect-audit.ts --markers     models with BSXFlags Editor Marker: how many are only
//                                            a marker (never drawn), how many draw more than it
//                                            (cobweb walls, doors, puzzle pillars), by folder
//   node tools/effect-audit.ts --lit         effect-shader shapes lit by the scene (SLSF2
//                                            Effect_Lighting): by greyscale palette and blending,
//                                            the cobwebs among them
//   node tools/effect-audit.ts --spots       spot lights (LIGH Shadow Spotlight) and their placed
//                                            references: cone (FOV + XLIG offset), fade offsets,
//                                            which local axis points down (the cone's axis)
//   node tools/effect-audit.ts --impacts     impacts (IPCT): placement radius, hazards they leave
//                                            (their lifetime and limit), and the projectiles
//                                            whose effects' impact data sets leave them, by kind
//
// Without an option: all of them.

import { parseArgs } from 'node:util';
import { parseNif } from '../src/formats/nif/nif.ts';
import { isMarkerNode } from '../src/render/model-data.ts';
import type { NifFile } from '../src/formats/nif/nif.ts';
import { referenceMatrix } from '../src/world/cell-loader.ts';
import { LightFlag, parseLight, parseReference } from '../src/world/cell-records.ts';
import { parseHazard } from '../src/world/hazard-records.ts';
import { parseImpact, parseImpactDataSet } from '../src/world/impact-records.ts';
import { parseMagicEffect } from '../src/world/magic-effects.ts';
import { parseProjectile } from '../src/world/projectile-data.ts';
import { flightKind } from '../src/gameplay/magic/projectile-flight.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    markers: { type: 'boolean', default: false },
    lit: { type: 'boolean', default: false },
    spots: { type: 'boolean', default: false },
    impacts: { type: 'boolean', default: false },
  },
});
const all = !values.markers && !values.lit && !values.spots && !values.impacts;

const vfs = await Vfs.mount(openGameFolder());
const count = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};
const sorted = <K>(map: Map<K, number>): [K, number][] => [...map].sort((a, b) => b[1] - a[1]);
const folder = (path: string): string => path.split('\\').slice(0, 3).join('\\');

/** Every NIF of the load order, parsed (unreadable ones counted apart). */
async function* nifs(): AsyncGenerator<[string, NifFile]> {
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.nif')) continue;
    try {
      yield [path, parseNif(await vfs.read(path))];
    } catch {
      // A file the parser cannot read is nif-stats' to report.
    }
  }
}

const BSX_EDITOR_MARKER = 0x20;
const SHAPES = new Set(['tri-shape', 'particle-system']);

if (all || values.markers || values.lit) {
  let models = 0;
  let flagged = 0;
  let markerOnly = 0;
  let drawn = 0;
  const drawnByFolder = new Map<string, number>();
  const drawnSamples: string[] = [];
  // Lit effect shapes: by palette (none, colour, alpha, both) and blend (normal, additive).
  const lit = new Map<string, number>();
  let litShapes = 0;
  let litModels = 0;
  let webs = 0;
  for await (const [path, nif] of nifs()) {
    models++;
    // Editor markers: the shapes outside the EditorMarker objects' subtrees.
    let bsx = 0;
    for (const block of nif.blocks)
      if (block.kind === 'integer-extra-data' && block.name === 'BSX') bsx = block.value;
    const parents = new Map<number, number>();
    nif.blocks.forEach((block, index) => {
      if (block.kind === 'node') for (const child of block.children) parents.set(child, index);
    });
    const underMarker = (index: number): boolean => {
      for (let at: number | undefined = index; at !== undefined; at = parents.get(at)) {
        const block = nif.blocks[at];
        if (block && 'name' in block && isMarkerNode(block.name)) return true;
      }
      return false;
    };
    if ((bsx & BSX_EDITOR_MARKER) !== 0) {
      flagged++;
      const other = nif.blocks.some(
        (block, index) =>
          SHAPES.has(block.kind) &&
          'flags' in block &&
          (block.flags & 1) === 0 &&
          !underMarker(index),
      );
      if (other) {
        drawn++;
        count(drawnByFolder, folder(path));
        if (drawnSamples.length < 12) drawnSamples.push(path);
      } else markerOnly++;
    }
    // Effect shapes lit by the scene.
    let litHere = false;
    for (const block of nif.blocks) {
      if (block.kind !== 'tri-shape' || block.shaderProperty < 0) continue;
      const shader = nif.blocks[block.shaderProperty];
      if (shader?.kind !== 'effect-shader' || (shader.flags2 & 0x40000000) === 0) continue;
      const alpha = block.alphaProperty >= 0 ? nif.blocks[block.alphaProperty] : undefined;
      const flags = alpha?.kind === 'alpha' ? alpha.flags : 0;
      const palette =
        ['none', 'colour', 'alpha', 'colour+alpha'][(shader.flags1 >> 4) & 3] ?? 'none';
      const blend =
        (flags & 1) === 0 ? 'opaque' : ((flags >> 5) & 15) === 0 ? 'additive' : 'blended';
      count(lit, `palette ${palette}, ${blend}`);
      litShapes++;
      litHere = true;
      if (/web/i.test(shader.sourceTexture)) webs++;
    }
    if (litHere) litModels++;
  }
  if (all || values.markers) {
    console.log(`Editor markers (${models} models):`);
    console.log(`  BSXFlags Editor Marker: ${flagged}`);
    console.log(`  only the marker (never drawn): ${markerOnly}`);
    console.log(`  drawn beside the marker (were dropped whole before): ${drawn}`);
    for (const [name, n] of sorted(drawnByFolder).slice(0, 15)) console.log(`    ${n}  ${name}`);
    for (const path of drawnSamples) console.log(`    e.g. ${path}`);
  }
  if (all || values.lit) {
    console.log(`\nLit effect shapes (SLSF2 Effect_Lighting): ${litShapes} in ${litModels} models`);
    for (const [key, n] of sorted(lit)) console.log(`  ${n}  ${key}`);
    console.log(`  with a web texture: ${webs}`);
  }
}

const db = await RecordDatabase.open(vfs);

if (all || values.spots) {
  const spots = new Map<number, { editorId: string; fov: number }>();
  for (const formId of db.formIdsOfType('LIGH')) {
    const record = await db.get(formId);
    if (!record) continue;
    const light = parseLight(record);
    if ((light.flags & LightFlag.shadowSpotlight) !== 0)
      spots.set(formId, { editorId: record.editorId ?? '', fov: light.fov });
  }
  const down = new Map<string, number>();
  const cones = new Map<string, number>();
  let references = 0;
  let fadeOffsets = 0;
  let wide = 0;
  for (const formId of db.formIdsOfType('REFR')) {
    const record = await db.get(formId);
    if (!record) continue;
    const reference = parseReference(record);
    const spot = spots.get(reference.base);
    if (!spot) continue;
    references++;
    if (reference.lightFadeOffset !== 0) fadeOffsets++;
    const fov = spot.fov + reference.lightFovOffset;
    if (fov >= 180 || fov <= 0) wide++;
    count(cones, `${Math.round(fov / 10) * 10}°`);
    const m = referenceMatrix({ position: [0, 0, 0], rotation: reference.rotation, scale: 1 });
    const axes: [string, number][] = [
      ['+x', m[2] ?? 0],
      ['-x', -(m[2] ?? 0)],
      ['+y', m[6] ?? 0],
      ['-y', -(m[6] ?? 0)],
      ['+z', m[10] ?? 0],
      ['-z', -(m[10] ?? 0)],
    ];
    const lowest = axes.reduce((best, axis) => (axis[1] < best[1] ? axis : best));
    count(down, lowest[0]);
  }
  console.log(`\nSpot lights: ${spots.size} LIGH, ${references} references`);
  console.log(
    `  the axis pointing down most: ${sorted(down)
      .map(([a, n]) => `${a} ${n}`)
      .join(', ')}`,
  );
  console.log(
    `  cones (FOV + XLIG): ${sorted(cones)
      .map(([a, n]) => `${a} ${n}`)
      .join(', ')}`,
  );
  console.log(`  no cone (FOV outside 0-180°): ${wide}; with an XLIG fade offset: ${fadeOffsets}`);
}

if (all || values.impacts) {
  // Impacts: their placement radius and the hazards they leave.
  const radii = new Map<number, number>();
  const hazards = new Map<string, number>();
  const impacts = new Map<number, { radius: number; hazard: number | undefined }>();
  for (const formId of db.formIdsOfType('IPCT')) {
    const record = await db.get(formId);
    if (!record) continue;
    const impact = parseImpact(record);
    impacts.set(formId, { radius: impact.placementRadius, hazard: impact.hazard });
    count(radii, Math.round(impact.placementRadius));
    if (impact.hazard === undefined) continue;
    const hazardRecord = await db.get(impact.hazard);
    if (!hazardRecord) continue;
    const hazard = parseHazard(hazardRecord);
    count(
      hazards,
      `${hazard.editorId}: lifetime ${hazard.lifetime} s, limit ${hazard.limit || 'none'}`,
    );
  }
  console.log(`\nImpacts: ${impacts.size} IPCT`);
  console.log(
    `  placement radius: ${sorted(radii)
      .map(([r, n]) => `${r} (${n})`)
      .join(', ')}`,
  );
  console.log('  hazards they leave (impacts each):');
  for (const [key, n] of sorted(hazards)) console.log(`    ${n}  ${key}`);
  // Effects whose impact data set leaves hazards, by their projectile's kind.
  const leaving = new Map<string, number>();
  for (const formId of db.formIdsOfType('MGEF')) {
    const record = await db.get(formId);
    if (!record) continue;
    const effect = parseMagicEffect(record);
    if (effect.impactData === undefined || effect.projectile === undefined) continue;
    const set = await db.get(effect.impactData);
    const projectile = await db.get(effect.projectile);
    if (set?.type !== 'IPDS' || projectile?.type !== 'PROJ') continue;
    const hazard = [...parseImpactDataSet(set).impacts.values()].some(
      (impact) => impacts.get(impact)?.hazard !== undefined,
    );
    count(leaving, `${flightKind(parseProjectile(projectile))}${hazard ? ' leaving hazards' : ''}`);
  }
  console.log('  magic effects with a projectile and an impact data set, by flight:');
  for (const [key, n] of sorted(leaving)) console.log(`    ${n}  ${key}`);
}
