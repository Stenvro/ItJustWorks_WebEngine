// Gathers everything needed to show a cell: the placed objects with their world transforms,
// the lights and the cell's lighting. Platform-independent; models are loaded separately.

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
import type { GameRecord, RecordDatabase } from './record-db.ts';

export interface CellObject {
  readonly reference: number;
  readonly baseType: string;
  readonly editorId: string;
  readonly model: string;
  readonly world: Mat4;
}

export interface CellLight {
  readonly reference: number;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly color: Rgb;
  /** LIGH fade: brightness multiplier. */
  readonly fade: number;
  readonly flags: number;
}

export interface CellData {
  readonly cell: CellRecord;
  readonly lighting: CellLighting | undefined;
  readonly objects: readonly CellObject[];
  readonly lights: readonly CellLight[];
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

/**
 * Which references are enabled:
 * - `game-start`: as at the start of a new game (initially-disabled flags, enable parents);
 * - `all-enabled`: every enable parent switched on, e.g. a player home with all upgrades
 *   bought. References that follow a parent with the "opposite" flag are then hidden.
 */
export type EnableState = 'game-start' | 'all-enabled';

export interface LoadCellOptions {
  readonly enableState?: EnableState;
}

interface EnableContext {
  readonly db: RecordDatabase;
  readonly state: EnableState;
  readonly cache: Map<number, boolean>;
  /** All-enabled: "...Start" markers whose upgraded counterpart exists (lowercase). */
  readonly replaced: ReadonlySet<string>;
}

/** Enabled state of a reference, following enable parents (and their opposite flag). */
async function isEnabled(
  context: EnableContext,
  ref: PlacedReference,
  depth = 0,
): Promise<boolean> {
  const cached = context.cache.get(ref.formId);
  if (cached !== undefined) return cached;
  let enabled =
    context.state === 'all-enabled'
      ? !context.replaced.has(ref.editorId.toLowerCase())
      : !ref.initiallyDisabled;
  if (ref.enableParent && depth < 16) {
    const parentRecord = await context.db.get(ref.enableParent.formId);
    if (parentRecord) {
      const parentEnabled = await isEnabled(context, parseReference(parentRecord), depth + 1);
      enabled = ref.enableParent.opposite ? !parentEnabled : parentEnabled;
    }
  }
  context.cache.set(ref.formId, enabled);
  return enabled;
}

/**
 * Player homes keep their unfurnished look behind "<Room>Start" markers that the upgrade
 * scripts disable once "<Room>" is bought. With every upgrade on, those Start markers must
 * be off, or old crates and hay overlap the new furniture.
 * TODO(M8): run the real Papyrus upgrade scripts instead of this naming rule.
 */
async function replacedStartMarkers(
  db: RecordDatabase,
  refs: readonly PlacedReference[],
): Promise<Set<string>> {
  const parents = new Set<string>();
  for (const ref of refs) {
    if (!ref.enableParent) continue;
    const parent = await db.get(ref.enableParent.formId);
    const editorId = parent?.editorId;
    if (editorId) parents.add(editorId.toLowerCase());
  }
  return new Set(
    [...parents].filter((name) => name.endsWith('start') && parents.has(name.slice(0, -5))),
  );
}

export async function loadCellData(
  db: RecordDatabase,
  cellFormId: number,
  options: LoadCellOptions = {},
): Promise<CellData> {
  const enableState = options.enableState ?? 'game-start';
  const cell = parseCell(await db.require(cellFormId));
  const template =
    cell.lightingTemplate === undefined ? undefined : await db.get(cell.lightingTemplate);
  const lighting = resolveCellLighting(cell, template && parseLightingTemplate(template));

  const objects: CellObject[] = [];
  const lights: CellLight[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };
  let entrance: [number, number, number] | undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  const records = (await Promise.all(db.cellReferences(cellFormId).map((id) => db.get(id)))).filter(
    (record): record is GameRecord => record !== undefined && !record.deleted,
  );
  const references = records.map((record) => ({ record, ref: parseReference(record) }));
  const context: EnableContext = {
    db,
    state: enableState,
    cache: new Map(),
    replaced:
      enableState === 'all-enabled'
        ? await replacedStartMarkers(
            db,
            references.map((entry) => entry.ref),
          )
        : new Set(),
  };

  for (const { record, ref } of references) {
    const refId = ref.formId;
    if (!(await isEnabled(context, ref))) continue;
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
    if (base.type === 'DOOR' && !entrance && record.fields.has('XTEL'))
      entrance = [...ref.position];
    if ((base.flags & RecordFlag.isMarker) !== 0) continue;

    if (base.type === 'LIGH') {
      const light = parseLight(base);
      if ((light.flags & LightFlag.offByDefault) === 0) {
        lights.push({
          reference: refId,
          position: ref.position,
          radius: Math.max(0, light.radius + ref.radiusOffset),
          color: light.color,
          fade: light.fade,
          flags: light.flags,
        });
      }
    }

    const model = baseModelPath(base);
    if (!model) {
      if (base.type !== 'LIGH' && base.type !== 'SOUN') skip(`${base.type} without a world model`);
      continue;
    }
    objects.push({
      reference: refId,
      baseType: base.type,
      editorId: base.editorId ?? '',
      model,
      world: referenceMatrix(ref),
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
    skipped: [...skipped].map(([reason, count]) => `${count}× ${reason}`),
    entrance: entrance ?? centre,
  };
}
