// Asset worker: decompresses and parses NIF and DDS files off the main thread and
// returns the results as transferables (no copies).

import { decodeBsaPayload } from '../formats/bsa/bsa.ts';
import { parseDds } from '../formats/dds/dds.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { buildModel } from '../render/model-data.ts';
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

  if (request.kind === 'model') {
    const nif = parseNif(bytes);
    const model = buildModel(nif);
    for (const part of model.parts) {
      own(part.vertices);
      own(part.indices);
      own(part.world);
    }
    const response: AssetResponse = {
      id: request.id,
      ok: true,
      kind: 'model',
      model,
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
