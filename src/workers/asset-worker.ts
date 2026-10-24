// Asset worker: decompresses and parses NIF and DDS files off the main thread and
// returns the results as transferables (no copies).

import { handleAssetRequest } from './asset-work.ts';
import type { AssetRequest, AssetResponse } from './protocol.ts';

interface WorkerScope {
  postMessage(message: AssetResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<AssetRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  const request = event.data;
  try {
    const [response, transfer] = handleAssetRequest(request);
    scope.postMessage(response, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: request.id, ok: false, error: `${request.path}: ${message}` }, []);
  }
});
