// Plugin index worker: reads a plugin's record and group headers (Skyrim.esm: close to a
// million records) off the main thread and returns the index as transferables.

import type { ByteSource } from '../formats/byte-source.ts';
import { indexPlugin, type PluginIndex } from '../formats/esm/plugin-index.ts';
import { BlobByteSource } from '../vfs/browser/browser-game-folder.ts';
import { HttpByteSource } from '../vfs/browser/http-game-folder.ts';
import type { IndexRequest, IndexResponse } from './index-protocol.ts';

interface WorkerScope {
  postMessage(message: IndexResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<IndexRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

/** Every typed array of an index (their buffers move to the main thread). */
function buffers(index: PluginIndex): ArrayBuffer[] {
  const arrays = Object.values(index).filter(
    (value): value is Uint32Array => value instanceof Uint32Array,
  );
  return [...new Set(arrays.map((array) => array.buffer))].filter(
    (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
  );
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  const source: ByteSource =
    request.source.kind === 'blob'
      ? new BlobByteSource(request.source.blob)
      : new HttpByteSource(request.source.url, request.source.size);
  indexPlugin(source).then(
    (index) => {
      scope.postMessage({ id: request.id, ok: true, index }, buffers(index));
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage({ id: request.id, ok: false, error: `${request.name}: ${message}` }, []);
    },
  );
});
