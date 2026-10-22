// Messages between the main thread and the asset workers.

import type { RigData } from '../animation/skeleton.ts';
import type { BsaPayload } from '../formats/bsa/bsa.ts';
import type { DdsTexture } from '../formats/dds/dds.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { ModelTextureSwaps } from '../render/actor-model.ts';
import type { MorphData } from '../render/face-morphs.ts';
import type { ModelData } from '../render/model-data.ts';

export type AssetKind = 'model' | 'texture' | 'actor-part' | 'rig' | 'expressions';

export type AssetRequest =
  | {
      readonly id: number;
      readonly kind: 'model' | 'texture' | 'rig' | 'expressions';
      /** For error messages only. */
      readonly path: string;
      readonly payload: BsaPayload;
      /** Models: the child every NiSwitchNode shows (flora harvested). */
      readonly switchChild?: number;
      /** Models: a destructible object's model damage stage (BSDamageStage nodes). */
      readonly damageStage?: number;
      /** Models: texture sets swapped onto its shapes (a destruction stage's DMDS). */
      readonly swaps?: ModelTextureSwaps;
    }
  | {
      readonly id: number;
      /** A model an actor wears: blended by weight, with texture sets swapped in. */
      readonly kind: 'actor-part';
      readonly path: string;
      /** The model (the heavy _1 one of a weighted addon). */
      readonly payload: BsaPayload;
      /** The thin _0 model of a weighted addon. */
      readonly thin: BsaPayload | undefined;
      /** 0..100. */
      readonly weight: number;
      readonly swaps: ModelTextureSwaps;
    };

export type AssetResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'model';
      readonly model: ModelData;
      /** The model's Havok collision. */
      readonly collision: CollisionData;
      /** NIF blocks that could not be parsed. */
      readonly problems: readonly string[];
      /** Milliseconds spent in the worker (decompress + parse + build). */
      readonly workMs: number;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'actor-part';
      readonly model: ModelData;
      readonly problems: readonly string[];
      readonly workMs: number;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'rig';
      readonly rig: RigData;
      readonly workMs: number;
    }
  | {
      readonly id: number;
      readonly ok: true;
      /** A head part's expression TRI file, packed for the GPU. */
      readonly kind: 'expressions';
      readonly morphs: MorphData;
      readonly workMs: number;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'texture';
      readonly texture: DdsTexture;
      readonly workMs: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
