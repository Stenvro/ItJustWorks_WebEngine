// Gathers everything needed to show a cell: every placed object that can appear (enabled or
// not) with its world transform, the lights, the enable-parent structure and the cell's
// lighting. Which references are enabled is decided by cell-upgrades.ts. Platform-
// independent; models are loaded separately.

import { view } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { identity, multiply, type Mat4 } from '../render/math.ts';
import {
  baseModelPath,
  enabledAtGameStart,
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
  parseTeleport,
  type Teleport,
  linkedReferences,
} from './cell-records.ts';
export { parseTeleport, type Teleport } from './cell-records.ts';
import { parseTextureSet, placeDecal, type PlacedDecal, type TextureSet } from './decal.ts';
import { parseItem } from './item-records.ts';
import { parseStaticDirectional, type StaticDirectional } from './material-object.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

export interface CellObject {
  readonly reference: number;
  /** The base object (its form id) and its record type. */
  readonly base: number;
  readonly baseType: string;
  readonly editorId: string;
  /** The base object's name (FULL), e.g. "Door"; empty if it has none. */
  readonly name: string;
  readonly model: string;
  readonly world: Mat4;
  /** Water activators (ACTI WNAM): the type of the model's water surfaces. */
  readonly water: number | undefined;
  /** Statics (STAT DNAM): the snow, ash, moss or ice laid over its upward-facing parts. */
  readonly directional?: StaticDirectional;
  /** Trees (TREE CNAM): how their leaves flutter in the wind. */
  readonly leafAnimation?: LeafAnimation;
  /** Trees (TREE CNAM): how the wind moves their trunk and branch bones (BSTreeNode). */
  readonly treeSway?: TreeSwaySettings;
  /** XEMI: the light or region whose colour drives the External_Emittance shapes. */
  readonly emittance?: number;
  /**
   * REFR flag "Don't Havok Settle": a simulated object stays where it was placed until
   * something touches it, instead of settling when its cell loads.
   */
  readonly dontHavokSettle?: boolean;
  /** XTEL: a load door's destination (the door it leads to and where the player arrives). */
  readonly teleport?: Teleport;
  /** Sounds of using it (SNDR): doors and containers opening and closing, activators. */
  readonly sounds?: ObjectSounds;
  /** Carryable items: what the crosshair shows of them (weight and value). */
  readonly item?: { readonly weight: number; readonly value: number };
  /** ACTI / FLOR RNAM: the verb its activation prompt shows instead of the default. */
  readonly activateText?: string;
  /** Furniture: whether it is slept in (a sleep marker), its workbench (WBDT type; 0 none). */
  readonly furniture?: { readonly sleep: boolean; readonly workbench: number };
}

/**
 * FURN: a marker of type 2 (FNPR: u16 type, 1 sit, 2 sleep, 4 lean; u16 entry points) is slept
 * in; WBDT's first byte is its workbench (1 create object, 2 smithing weapons, 3 enchanting,
 * 5 alchemy, 7 smithing armor, ...) (UESP FURN).
 */
export function furnitureOf(base: Pick<GameRecord, 'fields'>): {
  readonly sleep: boolean;
  readonly workbench: number;
} {
  return {
    sleep: base.fields
      .all('FNPR')
      .some((data) => data.length >= 2 && (view(data).getUint16(0, true) & 0x2) !== 0),
    workbench: base.fields.first('WBDT')?.[0] ?? 0,
  };
}

/** A placed actor (ACHR): its base and placement; its look is resolved when it is shown. */
export interface CellActor {
  readonly reference: number;
  readonly editorId: string;
  /** The actor base (NPC_, or a leveled list LVLN). */
  readonly base: number;
  readonly position: readonly [number, number, number];
  /** Radians (actors stand upright: only the turn about z counts). */
  readonly rotation: readonly [number, number, number];
  /** The reference's own scale (XSCL). */
  readonly scale: number;
  /** XLKR: its linked references by keyword (0: none). */
  readonly links: ReadonlyMap<number, number>;
  /** Dead when the game starts (ACHR flag 0x200). */
  readonly startsDead: boolean;
}

/** The sounds an object makes when used (SNDR form ids). */
export interface ObjectSounds {
  readonly open?: number;
  readonly close?: number;
  readonly activate?: number;
}

/**
 * Something placed that keeps sounding while the player is near: a sound marker (SOUN), an
 * activator's, moveable static's or talking activator's looping sound, a light's, a door's
 * loop (SNDR form id).
 */
export interface CellSoundEmitter {
  readonly reference: number;
  readonly position: readonly [number, number, number];
  readonly descriptor: number;
}

/** A placed acoustic space (ASPC reference): inside its box its ambience and reverb apply. */
/** A water activator's surface: its box (OBND) placed in the world, and its water type. */
export interface CellWaterArea {
  readonly reference: number;
  /** WATR. */
  readonly type: number;
  readonly world: Mat4;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface CellAcousticArea {
  readonly reference: number;
  readonly space: number;
  /** The reference's placement (with its scale). */
  readonly world: Mat4;
  /** The base's object bounds (OBND), in its own frame. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * A collision primitive (a CollisionMarker with XPRM): an invisible box or sphere on a
 * collision layer, e.g. a wall that keeps the player out.
 */
export interface CellPrimitive {
  readonly reference: number;
  readonly shape: 'box' | 'sphere';
  /** Box: full size along x, y, z. Sphere: radius in x. */
  readonly bounds: readonly [number, number, number];
  /** The reference's placement (with its scale). */
  readonly world: Mat4;
  /** XTRI, else the collision box layer. */
  readonly layer: number;
}

/** REFR record flag: "Don't Havok Settle". */
const DONT_HAVOK_SETTLE = 0x20000000;
/** The engine's collision primitive marker (STAT). */
const COLLISION_MARKER = 0x21;
/** SkyrimLayer L_COLLISIONBOX: the layer of collision primitives without XTRI. */
const COLLISION_BOX_LAYER = 35;

/** Where a load door leads: the destination cell, its worldspace, and its name. */
export interface DoorDestination {
  readonly cell: number;
  /** The worldspace of an exterior destination; undefined for interiors. */
  readonly world: number | undefined;
  /** The cell's name, else its worldspace's (exterior cells are mostly unnamed). */
  readonly name: string;
}

export async function doorDestination(
  db: RecordDatabase,
  teleport: Teleport,
): Promise<DoorDestination | undefined> {
  const cell = db.cellOfReference(teleport.door);
  if (cell === undefined) return undefined;
  const world = db.worldOfCell(cell);
  let name = (await db.get(cell))?.text('FULL') ?? '';
  if (!name && world !== undefined) name = (await db.get(world))?.text('FULL') ?? '';
  return { cell, world, name };
}

/**
 * Where the player arrives in a cell through its doors: a load door in the cell leads to a
 * door elsewhere, whose own XTEL is the arrival point in front of the first door (of those
 * there at the start of a new game, on both sides; else of any).
 */
export async function cellArrival(
  db: RecordDatabase,
  data: CellData,
): Promise<{ position: readonly [number, number, number]; heading: number } | undefined> {
  let fallback: { position: readonly [number, number, number]; heading: number } | undefined;
  for (const object of data.objects) {
    if (!object.teleport) continue;
    const other = await db.get(object.teleport.door);
    const back = other && parseTeleport(other);
    if (!back) continue;
    const arrival = { position: back.position, heading: back.rotation[2] };
    if (
      (await enabledAtGameStart(db, object.reference)) &&
      (await enabledAtGameStart(db, object.teleport.door))
    ) {
      return arrival;
    }
    fallback ??= arrival;
  }
  return fallback;
}

/** XPRM of a collision marker: type 1 box, 2 sphere (3 portal box, 4 line are not solid). */
function primitiveOf(record: GameRecord, world: Mat4): CellPrimitive | undefined {
  const xprm = record.fields.first('XPRM');
  if (!xprm || xprm.length < 32) return undefined;
  const v = view(xprm);
  const type = v.getUint32(28, true);
  if (type !== 1 && type !== 2) return undefined;
  const xtri = record.fields.first('XTRI');
  return {
    reference: record.formId,
    shape: type === 1 ? 'box' : 'sphere',
    bounds: [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true)],
    world,
    layer: xtri && xtri.length >= 4 ? view(xtri).getUint32(0, true) : COLLISION_BOX_LAYER,
  };
}

/** TREE CNAM leaf amplitude and frequency (the lighting shader's TreeParams). */
export interface LeafAnimation {
  readonly amplitude: number;
  readonly frequency: number;
}

/** TREE CNAM: how the wind moves a BSTreeNode tree's trunk and branch bones. */
export interface TreeSwaySettings {
  readonly trunkFlexibility: number;
  readonly branchFlexibility: number;
  readonly trunkAmplitude: number;
  /** Front, back and side: how far (amplitude) and how fast (frequency). */
  readonly amplitudes: readonly [number, number, number];
  readonly frequencies: readonly [number, number, number];
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
  /** XEMI: the light or region whose colour the light takes (e.g. sunlight through windows). */
  readonly emittance?: number;
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
  /** Every actor that can appear in the cell; filter with `enabledReferences`. */
  readonly actors: readonly CellActor[];
  /** Every light that can be on; filter with `enabledReferences`. */
  readonly lights: readonly CellLight[];
  /** Every decal that can appear; filter with `enabledReferences`. */
  readonly decals: readonly CellDecal[];
  /** Collision primitives; filter with `enabledReferences`. */
  readonly primitives: readonly CellPrimitive[];
  /** Looping sound sources; filter with `enabledReferences`. */
  readonly emitters: readonly CellSoundEmitter[];
  /** Placed acoustic spaces; filter with `enabledReferences`. */
  readonly acousticAreas: readonly CellAcousticArea[];
  /** Water activators' surfaces (ACTI WNAM; their bounds), for the sound of water. */
  readonly waterAreas: readonly CellWaterArea[];
  /** The cell's references and the enable parents they follow (also outside the cell). */
  readonly references: ReadonlyMap<number, ReferenceState>;
  /** Things not shown yet, with the milestone that adds them. */
  readonly skipped: readonly string[];
  /** Where to start the camera: a door into the cell, or its centre. */
  readonly entrance: readonly [number, number, number];
}

/** The looping sound a base object makes where it is placed (SNDR), if any. */
function loopingSoundOf(base: GameRecord): number | undefined {
  const field =
    base.type === 'SOUN'
      ? 'SDSC'
      : base.type === 'DOOR'
        ? 'BNAM'
        : ['ACTI', 'MSTT', 'TACT', 'LIGH'].includes(base.type)
          ? 'SNAM'
          : undefined;
  return field === undefined ? undefined : nonZeroId(base.formIdField(field));
}

/** Sounds of using a door, container or activator, as a spreadable field. */
function objectSoundsOf(base: GameRecord): { sounds?: ObjectSounds } {
  const id = (type: string): number | undefined => nonZeroId(base.formIdField(type));
  const sounds: { open?: number; close?: number; activate?: number } = {};
  const set = (key: keyof ObjectSounds, value: number | undefined): void => {
    if (value !== undefined) sounds[key] = value;
  };
  if (base.type === 'DOOR') {
    set('open', id('SNAM'));
    set('close', id('ANAM'));
  } else if (base.type === 'CONT') {
    set('open', id('SNAM'));
    set('close', id('QNAM'));
  } else if (base.type === 'ACTI') {
    set('activate', id('VNAM'));
  }
  return Object.keys(sounds).length > 0 ? { sounds } : {};
}

/** OBND: six s16, the corners of the object's box. */
function objectBounds(
  base: GameRecord,
): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const data = base.fields.first('OBND');
  if (!data || data.length < 12) return undefined;
  const v = view(data);
  return {
    min: [v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true)],
    max: [v.getInt16(6, true), v.getInt16(8, true), v.getInt16(10, true)],
  };
}

/**
 * A tree's leaf animation, as a spreadable field. TREE CNAM (12 f32): trunk flexibility,
 * branch flexibility, trunk amplitude, front / back / side amplitude, front / back / side
 * frequency, leaf flexibility, leaf amplitude, leaf frequency.
 */
function leafAnimationOf(base: GameRecord): {
  leafAnimation?: LeafAnimation;
  treeSway?: TreeSwaySettings;
} {
  const data = base.type === 'TREE' ? base.fields.first('CNAM') : undefined;
  if (!data || data.length < 48) return {};
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f = (i: number): number => view.getFloat32(i * 4, true);
  return {
    leafAnimation: { amplitude: f(10), frequency: f(11) },
    treeSway: {
      trunkFlexibility: f(0),
      branchFlexibility: f(1),
      trunkAmplitude: f(2),
      amplitudes: [f(3), f(4), f(5)],
      frequencies: [f(6), f(7), f(8)],
    },
  };
}

/** A reference's emittance source (XEMI), as a spreadable field. */
function emittanceOf(record: GameRecord): { emittance?: number } {
  const emittance = nonZeroId(record.formIdField('XEMI'));
  return emittance === undefined ? {} : { emittance };
}

/** A static's directional material, as a spreadable field. */
function directionalOf(base: GameRecord): { directional?: StaticDirectional } {
  if (base.type !== 'STAT') return {};
  const directional = parseStaticDirectional(base);
  return directional ? { directional } : {};
}

/**
 * Placement matrix of a reference: translation · rotation · uniform scale. Rotation angles
 * are clockwise (compass heading for Z), composed X·Y·Z like Gamebryo's
 * NiMatrix3::FromEulerAnglesXYZ.
 */
const nonZeroId = (id: number | undefined): number | undefined => (id === 0 ? undefined : id);

export function referenceMatrix(
  ref: Pick<PlacedReference, 'position' | 'rotation' | 'scale'>,
): Mat4 {
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
 * A reference's placement from a matrix (the inverse of referenceMatrix): its position, its
 * rotation (radians, as REFR DATA has it) and its scale.
 */
export function matrixPlacement(m: Mat4): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
} {
  const scale = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0) || 1;
  const at = (i: number): number => (m[i] ?? 0) / scale;
  // referenceMatrix's rotation is X(−rx)·Y(−ry)·Z(−rz); its transpose Z(rz)·Y(ry)·X(rx).
  const ry = Math.asin(Math.max(-1, Math.min(1, -at(8))));
  return {
    position: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0],
    rotation: [Math.atan2(at(9), at(10)), ry, Math.atan2(at(4), at(0))],
    scale,
  };
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
  const actors: CellActor[] = [];
  const lights: CellLight[] = [];
  const decals: CellDecal[] = [];
  const primitives: CellPrimitive[] = [];
  const emitters: CellSoundEmitter[] = [];
  const acousticAreas: CellAcousticArea[] = [];
  const waterAreas: CellWaterArea[] = [];
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
      actors.push({
        reference: ref.formId,
        editorId: ref.editorId,
        base: ref.base,
        position: ref.position,
        rotation: ref.rotation,
        scale: ref.scale,
        links: linkedReferences(record),
        startsDead: (record.flags & RecordFlag.startsDead) !== 0,
      });
      continue;
    }
    if (base.type === 'DOOR' && !entrance && record.fields.has('XTEL')) {
      entrance = [...ref.position];
    }
    if (base.formId === COLLISION_MARKER) {
      const primitive = primitiveOf(record, referenceMatrix(ref));
      if (primitive) primitives.push(primitive);
      continue;
    }
    if ((base.flags & RecordFlag.isMarker) !== 0) continue;

    const loopingSound = loopingSoundOf(base);
    if (loopingSound !== undefined) {
      emitters.push({ reference: ref.formId, position: ref.position, descriptor: loopingSound });
    }
    const waterType = base.type === 'ACTI' ? nonZeroId(base.formIdField('WNAM')) : undefined;
    const waterBounds = waterType === undefined ? undefined : objectBounds(base);
    if (waterType !== undefined && waterBounds) {
      waterAreas.push({
        reference: ref.formId,
        type: waterType,
        world: referenceMatrix(ref),
        ...waterBounds,
      });
    }
    if (base.type === 'ASPC') {
      const bounds = objectBounds(base);
      if (bounds) {
        acousticAreas.push({
          reference: ref.formId,
          space: base.formId,
          world: referenceMatrix(ref),
          ...bounds,
        });
      }
      continue;
    }

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
          ...emittanceOf(record),
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
    const item = parseItem(base);
    const activateText =
      base.type === 'ACTI' || base.type === 'FLOR' ? base.text('RNAM') : undefined;
    objects.push({
      reference: ref.formId,
      base: ref.base,
      baseType: base.type,
      editorId: base.editorId ?? '',
      name: base.text('FULL') ?? '',
      model,
      world: referenceMatrix(ref),
      water: base.type === 'ACTI' ? nonZeroId(base.formIdField('WNAM')) : undefined,
      ...directionalOf(base),
      ...leafAnimationOf(base),
      ...emittanceOf(record),
      ...((record.flags & DONT_HAVOK_SETTLE) !== 0 && { dontHavokSettle: true }),
      ...(base.type === 'DOOR' && { teleport: parseTeleport(record) }),
      ...objectSoundsOf(base),
      ...(item && { item: { weight: item.weight, value: item.value } }),
      ...(activateText && { activateText }),
      ...(base.type === 'FURN' && { furniture: furnitureOf(base) }),
    });
  }

  const centre: [number, number, number] = [0, 1, 2].map((k) =>
    Number.isFinite(min[k]) ? ((min[k] ?? 0) + (max[k] ?? 0)) / 2 : 0,
  ) as [number, number, number];
  return {
    cell,
    lighting,
    objects,
    actors,
    lights,
    decals,
    primitives,
    emitters,
    acousticAreas,
    waterAreas,
    references,
    skipped: [...skipped].map(([reason, count]) => `${count}× ${reason}`),
    entrance: entrance ?? centre,
  };
}
