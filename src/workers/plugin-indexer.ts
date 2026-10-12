// Indexes plugins in workers: each gets the plugin's File (or dev-server URL) and returns its
// header index, so the main thread stays free while ~1.2 million record headers are read.
// Sources that cannot travel to a worker (a plugin decompressed into memory) are indexed here.

import type { ByteSource } from '../formats/byte-source.ts';
import { indexPlugin, type PluginIndex } from '../formats/esm/plugin-index.ts';
import { BlobByteSource } from '../vfs/browser/browser-game-folder.ts';
import { HttpByteSource } from '../vfs/browser/http-game-folder.ts';
import type { IndexRequest, IndexResponse, IndexSource } from './index-protocol.ts';

interface Pending {
  readonly resolve: (index: PluginIndex) => void;
  readonly reject: (error: Error) => void;
}

export class PluginIndexer {
  readonly #workers: Worker[] = [];
  readonly #pending = new Map<number, Pending>();
  #next = 0;
  #nextId = 1;

  /** A few workers: the plugins are indexed in parallel, the largest takes the longest. */
  constructor(size = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./index-worker.ts', import.meta.url), {
        type: 'module',
        name: `plugin-index-${String(i)}`,
      });
      worker.addEventListener('message', (event: MessageEvent<IndexResponse>) => {
        const response = event.data;
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        this.#pending.delete(response.id);
        if (response.ok) pending.resolve(response.index);
        else pending.reject(new Error(response.error));
      });
      this.#workers.push(worker);
    }
  }

  /** The index of a plugin, read in a worker when its source can be sent to one. */
  index(name: string, source: ByteSource): Promise<PluginIndex> {
    const portable: IndexSource | undefined =
      source instanceof BlobByteSource
        ? { kind: 'blob', blob: source.blob }
        : source instanceof HttpByteSource
          ? { kind: 'http', url: source.url, size: source.size }
          : undefined;
    const worker = this.#workers[this.#next++ % Math.max(1, this.#workers.length)];
    if (!portable || !worker) return indexPlugin(source);
    const id = this.#nextId++;
    const request: IndexRequest = { id, name, source: portable };
    return new Promise<PluginIndex>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  /** Stops the workers (once the plugins are indexed). */
  dispose(): void {
    for (const worker of this.#workers) worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Plugin indexer disposed'));
    }
    this.#pending.clear();
  }
}
