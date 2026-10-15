// The player's body as the engine sizes it: the race (from the Player NPC_ record) and its
// height, the skeleton's collision bound ("BBX", which the character controller is made
// from) and the camera nodes of the third- and first-person skeletons, in their rest pose.
// Platform-independent.

import type { NifFile } from '../formats/nif/nif.ts';
import { nodeWorlds } from '../render/model-data.ts';
import type { Vec3 } from '../render/math.ts';
import type { RecordDatabase } from './record-db.ts';

/** The Player actor (NPC_). */
export const PLAYER_ACTOR = 0x7;
/** The first-person skeleton (the engine's own path; the same for every playable race). */
export const FIRST_PERSON_SKELETON = 'meshes\\actors\\character\\_1stperson\\skeleton.nif';
/** Camera nodes: the first-person camera, and what the third-person camera looks at. */
const FIRST_PERSON_CAMERA = 'Camera1st [Cam1]';
const THIRD_PERSON_CAMERA = 'Camera3rd [Cam3]';

export interface PlayerBody {
  readonly race: number;
  readonly raceEditorId: string;
  readonly female: boolean;
  /** The race's height for the player's sex (RACE DATA); the skeleton is scaled by it. */
  readonly height: number;
  /** The skeleton's collision bound, scaled: centre and half extents (game units). */
  readonly bound: { readonly center: Vec3; readonly halfExtents: Vec3 };
  /** First-person camera above the feet, scaled. */
  readonly eyeHeight: number;
  /** The third-person camera's target above the feet, scaled. */
  readonly thirdPersonTarget: Vec3;
}

/** The skeleton's BBX bound and the rest-pose positions of named nodes. */
export function skeletonInfo(file: NifFile): {
  bound: { center: Vec3; halfExtents: Vec3 } | undefined;
  nodes: Map<string, Vec3>;
} {
  let bound: { center: Vec3; halfExtents: Vec3 } | undefined;
  for (const block of file.blocks) {
    if (block.kind === 'bound' && block.name === 'BBX') {
      bound = { center: block.center, halfExtents: block.halfExtents };
    }
  }
  const nodes = new Map<string, Vec3>();
  for (const [ref, world] of nodeWorlds(file)) {
    const block = file.blocks[ref];
    if (block?.kind === 'node')
      nodes.set(block.name, [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0]);
  }
  return { bound, nodes };
}

/** The bound of the vanilla human skeleton, if a skeleton has none. */
const HUMAN_BOUND = { center: [0, 0, 64] as Vec3, halfExtents: [22, 14, 64] as Vec3 };

/**
 * The player's body: of the Player record's race and sex, or of `as` (the race and sex the
 * race menu chose, a race Actor.SetRace gave the player).
 */
export async function readPlayerBody(
  db: RecordDatabase,
  readNif: (path: string) => Promise<NifFile>,
  as?: { readonly race: number; readonly female: boolean },
): Promise<PlayerBody> {
  const player = await db.require(PLAYER_ACTOR);
  // ACBS flags bit 0: female.
  const acbs = player.fields.first('ACBS');
  const female =
    as?.female ?? (acbs !== undefined && acbs.length >= 4 && ((acbs[0] ?? 0) & 0x1) !== 0);
  const raceId = as?.race ?? player.formIdField('RNAM') ?? 0;
  const race = await db.require(raceId);
  // DATA: skill boosts (16 bytes), then male height, female height.
  const data = race.fields.first('DATA');
  const view = data && new DataView(data.buffer, data.byteOffset, data.byteLength);
  const height = view && data.length >= 24 ? view.getFloat32(female ? 20 : 16, true) : 1;
  // The skeleton model: the ANAM after the race's male (MNAM) or female (FNAM) marker.
  let section = '';
  let skeleton: string | undefined;
  for (const field of race.fields.list) {
    if (field.type === 'MNAM' || field.type === 'FNAM') section = field.type;
    if (field.type === 'ANAM' && section === (female ? 'FNAM' : 'MNAM') && !skeleton) {
      skeleton = String.fromCharCode(...field.data.filter((byte) => byte !== 0));
    }
  }
  const third = skeleton
    ? skeletonInfo(await readNif(`meshes\\${skeleton.replace(/^meshes\\/i, '')}`))
    : undefined;
  const first = skeletonInfo(await readNif(FIRST_PERSON_SKELETON));
  const bound = third?.bound ?? HUMAN_BOUND;
  const scale = (v: Vec3): Vec3 => [v[0] * height, v[1] * height, v[2] * height];
  const cameraTarget = third?.nodes.get(THIRD_PERSON_CAMERA) ?? [0, 0, 121];
  return {
    race: raceId,
    raceEditorId: race.editorId ?? '',
    female,
    height,
    bound: { center: scale(bound.center), halfExtents: scale(bound.halfExtents) },
    eyeHeight: (first.nodes.get(FIRST_PERSON_CAMERA)?.[2] ?? 120.5) * height,
    thirdPersonTarget: scale(cameraTarget),
  };
}
