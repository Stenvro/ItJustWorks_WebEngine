// Gathers everything needed to show a cell: every placed object that can appear (enabled or
// not) with its world transform, the lights, the enable-parent structure and the cell's
// lighting. Which references are enabled is decided by cell-upgrades.ts. Platform-
// independent; models are loaded separately.

import { RecordFlag } from '../formats/esm/record.ts';
import { identity, multiply, type Mat4 } from '../render/math.ts';
import {
  baseModelPath,
  LightFlag,
  parseCell,
  parseLight,
  parseLightingTemplate,
  parseReference,
  resolveCellLighting,
  type CellLighting,
  type CellRecord,
  type PlacedReference,
  type Rgb,
} from './cell-records.ts';
import { parseTextureSet, placeDecal, type PlacedDecal, type TextureSet } from './decal.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

export interface CellObject {
  readonly reference: number;
  readonly baseType: string;
  readonly editorId: string;
  readonly model: string;
  readonly world: Mat4;
  /** Water activators (ACTI WNAM): the type of the model's water surfaces. */
  readonly water: number | undefined;
}

/** A decal reference: a texture set (TXST with decal data) projected inside a box. */
export interface CellDecal extends PlacedDecal {
  readonly reference: number;
  readonly textureSet: TextureSet;
  /** The TXST form id (decals sharing it share textures). */
  readonly base: number;
}

export interface CellLight {
  readonly reference: number;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly color: Rgb;
  /** LIGH fade: brightness multiplier. */
  readonly fade: number;
  readonly flags: number;
  /** Flicker and pulse (LIGH DATA). */
  readonly period: number;
  readonly intensityAmplitude: number;
  readonly movementAmplitude: number;
}

/** What decides whether a reference is enabled. */
export interface ReferenceState {
  readonly editorId: string;
  readonly initiallyDisabled: boolean;
  readonly parent: { readonly formId: number; readonly opposite: boolean } | undefined;
}

export interface CellData {
  readonly cell: CellRecord;
  readonly lighting: CellLighting | undefined;
  /** Every object that can appear in the cell; filter with `enabledReferences`. */
  readonly objects: readonly CellObject[];
  /** Every light that can be on; filter with `enabledReferences`. */
  readonly lights: readonly CellLight[];
  /** Every decal that can appear; filter with `enabledReferences`. */
  readonly decals: readonly CellDecal[];
  /** The cell's references and the enable parents they follow (also outside the cell). */
  readonly references: ReadonlyMap<number, ReferenceState>;
  /** Things not shown yet, with the milestone that adds them. */
  readonly skipped: readonly string[];
  /** Where to start the camera: a door into the cell, or its centre. */
  readonly entrance: readonly [number, number, number];
}

/**
 * Placement matrix of a reference: translation · rotation · uniform scale. Rotation angles
 * are clockwise (compass heading for Z), composed X·Y·Z like Gamebryo's
 * NiMatrix3::FromEulerAnglesXYZ.
 */
const nonZeroId = (id: number | undefined): number | undefined => (id === 0 ? undefined : id);

export function referenceMatrix(ref: PlacedReference): Mat4 {
  const [rx, ry, rz] = ref.rotation;
  const axis = (cos: number, sin: number, a: number, b: number): Mat4 => {
    // Rotation by −angle in the (a, b) plane: [cos sin; −sin cos].
    const m = identity();
    m[a * 4 + a] = cos;
    m[b * 4 + a] = sin;
    m[a * 4 + b] = -sin;
    m[b * 4 + b] = cos;
    return m;
  };
  const x = axis(Math.cos(rx), Math.sin(rx), 1, 2);
  const y = axis(Math.cos(ry), Math.sin(ry), 2, 0);
  const z = axis(Math.cos(rz), Math.sin(rz), 0, 1);
  const rotation = multiply(multiply(x, y), z);
  const m = identity();
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      m[col * 4 + row] = (rotation[col * 4 + row] ?? 0) * ref.scale;
    }
  }
  m[12] = ref.position[0];
  m[13] = ref.position[1];
  m[14] = ref.position[2];
  return m;
}

function referenceState(ref: PlacedReference): ReferenceState {
  return {
    editorId: ref.editorId,
    initiallyDisabled: ref.initiallyDisabled,
    parent: ref.enableParent,
  };
}

/** Cell children that are not placed objects. */
const NOT_PLACED = new Set(['NAVM', 'LAND', 'PGRD']);

/**
 * Loads a cell's objects, lights and enable structure. `extraReferences` adds references
 * stored elsewhere (an exterior cell's persistent references live in the world's
 * persistent cell).
 */
export async function loadCellData(
  db: RecordDatabase,
  cellFormId: number,
  extraReferences: readonly number[] = [],
): Promise<CellData> {
  const cell = parseCell(await db.require(cellFormId));
  const objects: CellObject[] = [];
  const lights: CellLight[] = [];
  const decals: CellDecal[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };

  const template =
    cell.lightingTemplate === undefined ? undefined : await db.get(cell.lightingTemplate);
  let templateLighting: CellLighting | undefined;
  try {
    templateLighting = template && parseLightingTemplate(template);
  } catch (error) {
    skip(
      `unreadable lighting template (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const lighting = resolveCellLighting(cell, templateLighting);
  let entrance: [number, number, number] | undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  // A cell's children also hold its navigation mesh (NAVM) and, outside, its landscape;
  // only placed references are objects.
  const ids = [...db.cellReferences(cellFormId), ...extraReferences];
  const records = (await Promise.all(ids.map((id) => db.get(id)))).filter(
    (record): record is GameRecord =>
      record !== undefined && !record.deleted && !NOT_PLACED.has(record.type),
  );
  const placed = records.map((record) => ({ record, ref: parseReference(record) }));

  // Enable structure, including parents placed in other cells.
  const references = new Map<number, ReferenceState>();
  for (const { ref } of placed) references.set(ref.formId, referenceState(ref));
  // Every parent is looked at once (cells like Lakeview Manor have thousands of children).
  const pending = [
    ...new Set(placed.flatMap(({ ref }) => (ref.enableParent ? [ref.enableParent.formId] : []))),
  ];
  const looked = new Set<number>();
  while (pending.length > 0) {
    const formId = pending.pop() ?? 0;
    if (references.has(formId) || looked.has(formId)) continue;
    looked.add(formId);
    const record = await db.get(formId);
    if (!record) {
      skip('enable parent that does not exist');
      continue;
    }
    const ref = parseReference(record);
    references.set(formId, referenceState(ref));
    if (ref.enableParent) pending.push(ref.enableParent.formId);
  }

  for (const { record, ref } of placed) {
    const base = await db.get(ref.base);
    if (!base) {
      skip('reference to a missing base object');
      continue;
    }
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, ref.position[k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, ref.position[k] ?? 0);
    }
    if (record.type === 'ACHR') {
      skip('actors (TODO(M7))');
      continue;
    }
    if (base.type === 'DOOR' && !entrance && record.fields.has('XTEL')) {
      entrance = [...ref.position];
    }
    if ((base.flags & RecordFlag.isMarker) !== 0) continue;

    if (base.type === 'LIGH') {
      const light = parseLight(base);
      if ((light.flags & LightFlag.offByDefault) === 0) {
        lights.push({
          reference: ref.formId,
          position: ref.position,
          radius: Math.max(0, light.radius + ref.radiusOffset),
          color: light.color,
          fade: light.fade,
          flags: light.flags,
          period: light.period,
          intensityAmplitude: light.intensityAmplitude,
          movementAmplitude: light.movementAmplitude,
        });
      }
    }

    if (base.type === 'TXST') {
      const textureSet = parseTextureSet(base);
      if (textureSet.decal) {
        decals.push({
          reference: ref.formId,
          base: ref.base,
          textureSet,
          ...placeDecal(textureSet.decal, ref.formId, referenceMatrix(ref)),
        });
      } else {
        skip('texture set without decal data');
      }
      continue;
    }

    const model = baseModelPath(base);
    if (!model) {
      if (base.type !== 'LIGH' && base.type !== 'SOUN') skip(`${base.type} without a world model`);
      continue;
    }
    objects.push({
      reference: ref.formId,
      baseType: base.type,
      editorId: base.editorId ?? '',
      model,
      world: referenceMatrix(ref),
      water: base.type === 'ACTI' ? nonZeroId(base.formIdField('WNAM')) : undefined,
    });
  }

  const centre: [number, number, number] = [0, 1, 2].map((k) =>
    Number.isFinite(min[k]) ? ((min[k] ?? 0) + (max[k] ?? 0)) / 2 : 0,
  ) as [number, number, number];
  return {
    cell,
    lighting,
    objects,
    lights,
    decals,
    references,
    skipped: [...skipped].map(([reason, count]) => `${count}× ${reason}`),
    entrance: entrance ?? centre,
  };
}
