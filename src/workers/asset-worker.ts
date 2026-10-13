// Asset worker: decompresses and parses NIF and DDS files off the main thread and
// returns the results as transferables (no copies).

import { decodeBsaPayload } from '../formats/bsa/bsa.ts';
import { parseDds } from '../formats/dds/dds.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { parseTri } from '../formats/nif/tri.ts';
import { buildCollision } from '../physics/collision-data.ts';
import { buildRig } from '../animation/skeleton.ts';
import { blendWeight, swapTextures } from '../render/actor-model.ts';
import { packMorphs } from '../render/face-morphs.ts';
import { buildModel, type ModelData } from '../render/model-data.ts';
import type { AssetRequest, AssetResponse } from './protocol.ts';

interface WorkerScope {
  postMessage(message: AssetResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<AssetRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

function handle(request: AssetRequest): [AssetResponse, ArrayBuffer[]] {
  const start = performance.now();
  const bytes = decodeBsaPayload(request.payload);
  const buffers = new Set<ArrayBuffer>();
  const own = (array: { buffer: ArrayBufferLike }): void => {
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  };

  const ownModel = (model: ModelData): void => {
    for (const part of model.parts) {
      own(part.vertices);
      own(part.indices);
      own(part.world);
    }
  };

  if (request.kind === 'actor-part') {
    const nif = parseNif(bytes);
    let model = buildModel(nif);
    const problems = [...nif.problems];
    if (request.thin) {
      const thin = parseNif(decodeBsaPayload(request.thin));
      problems.push(...thin.problems);
      model = blendWeight(buildModel(thin), model, request.weight);
    }
    model = swapTextures(model, request.swaps);
    ownModel(model);
    const response: AssetResponse = {
      id: request.id,
      ok: true,
      kind: 'actor-part',
      model,
      problems,
      workMs: performance.now() - start,
    };
    return [response, [...buffers]];
  }

  if (request.kind === 'expressions') {
    const morphs = packMorphs(parseTri(bytes));
    own(morphs.deltas);
    const response: AssetResponse = {
      id: request.id,
      ok: true,
      kind: 'expressions',
      morphs,
      workMs: performance.now() - start,
    };
    return [response, [...buffers]];
  }

  if (request.kind === 'rig') {
    const rig = buildRig(parseNif(bytes));
    own(rig.parents);
    own(rig.local);
    const response: AssetResponse = {
      id: request.id,
      ok: true,
      kind: 'rig',
      rig,
      workMs: performance.now() - start,
    };
    return [response, [...buffers]];
  }

  if (request.kind === 'model') {
    const nif = parseNif(bytes);
    const model = buildModel(nif);
    const collision = buildCollision(nif);
    for (const body of collision.bodies) {
      for (const shape of body.shapes) {
        if (shape.type === 'mesh') {
          own(shape.vertices);
          own(shape.indices);
        } else if (shape.type === 'convex') {
          own(shape.points);
        }
      }
    }
    ownModel(model);
    for (const system of model.particles) {
      for (const mesh of system.emitters.flatMap((emitter) => emitter.meshes)) {
        own(mesh.positions);
        own(mesh.normals);
        own(mesh.indices);
      }
    }
    const response: AssetResponse = {
      id: request.id,
      ok: true,
      kind: 'model',
      model,
      collision,
      problems: nif.problems,
      workMs: performance.now() - start,
    };
    return [response, [...buffers]];
  }

  const texture = parseDds(bytes);
  own(texture.data);
  const response: AssetResponse = {
    id: request.id,
    ok: true,
    kind: 'texture',
    texture,
    workMs: performance.now() - start,
  };
  return [response, [...buffers]];
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  try {
    const [response, transfer] = handle(request);
    scope.postMessage(response, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: request.id, ok: false, error: `${request.path}: ${message}` }, []);
  }
});
