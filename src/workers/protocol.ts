// Messages between the main thread and the asset workers.

import type { BsaPayload } from '../formats/bsa/bsa.ts';
import type { DdsTexture } from '../formats/dds/dds.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { ModelData } from '../render/model-data.ts';

export type AssetKind = 'model' | 'texture';

export interface AssetRequest {
  readonly id: number;
  readonly kind: AssetKind;
  /** For error messages only. */
  readonly path: string;
  readonly payload: BsaPayload;
}

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
      readonly kind: 'texture';
      readonly texture: DdsTexture;
      readonly workMs: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
