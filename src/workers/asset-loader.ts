// Loads models and textures: the VFS reads stored bytes on the main thread (async I/O),
// a pool of workers decompresses and parses them.

import type { DdsTexture } from '../formats/dds/dds.ts';
import type { ModelData } from '../render/model-data.ts';
import type { Vfs } from '../vfs/vfs.ts';
import type { AssetKind, AssetRequest, AssetResponse } from './protocol.ts';

export interface LoadedModel {
  readonly model: ModelData;
  readonly problems: readonly string[];
  readonly workMs: number;
}

interface Pending {
  readonly worker: Worker;
  readonly resolve: (response: AssetResponse) => void;
  readonly reject: (error: Error) => void;
}

export class AssetLoader {
  readonly #vfs: Vfs;
  readonly #workers: Worker[] = [];
  readonly #load = new Map<Worker, number>();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  /** Uses one worker per spare CPU core (at least 1, at most 8). */
  constructor(vfs: Vfs, size = Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1))) {
    this.#vfs = vfs;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./asset-worker.ts', import.meta.url), {
        type: 'module',
        name: `assets-${i}`,
      });
      worker.addEventListener('message', (event: MessageEvent<AssetResponse>) => {
        this.#settle(event.data);
      });
      worker.addEventListener('error', (event) => {
        this.#failWorker(worker, new Error(`Asset worker crashed: ${event.message}`));
      });
      this.#workers.push(worker);
      this.#load.set(worker, 0);
    }
  }

  get workerCount(): number {
    return this.#workers.length;
  }

  async loadModel(path: string): Promise<LoadedModel> {
    const response = await this.#request('model', path);
    if (!response.ok || response.kind !== 'model') throw new Error(describe(response));
    return { model: response.model, problems: response.problems, workMs: response.workMs };
  }

  async loadTexture(path: string): Promise<DdsTexture> {
    const response = await this.#request('texture', path);
    if (!response.ok || response.kind !== 'texture') throw new Error(describe(response));
    return response.texture;
  }

  dispose(): void {
    for (const worker of this.#workers) worker.terminate();
    for (const pending of this.#pending.values())
      pending.reject(new Error('Asset loader disposed'));
    this.#pending.clear();
  }

  async #request(kind: AssetKind, path: string): Promise<AssetResponse> {
    const payload = await this.#vfs.readPayload(path);
    const worker = this.#leastBusy();
    const id = this.#nextId++;
    const request: AssetRequest = { id, kind, path, payload };
    return new Promise<AssetResponse>((resolve, reject) => {
      this.#pending.set(id, { worker, resolve, reject });
      this.#load.set(worker, (this.#load.get(worker) ?? 0) + 1);
      const buffer = payload.bytes.buffer;
      worker.postMessage(request, buffer instanceof ArrayBuffer ? [buffer] : []);
    });
  }

  #leastBusy(): Worker {
    let best = this.#workers[0];
    if (!best) throw new Error('No asset workers');
    for (const worker of this.#workers) {
      if ((this.#load.get(worker) ?? 0) < (this.#load.get(best) ?? 0)) best = worker;
    }
    return best;
  }

  #settle(response: AssetResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    this.#load.set(pending.worker, Math.max(0, (this.#load.get(pending.worker) ?? 1) - 1));
    pending.resolve(response);
  }

  #failWorker(worker: Worker, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.worker !== worker) continue;
      this.#pending.delete(id);
      pending.reject(error);
    }
    this.#load.set(worker, 0);
  }
}

function describe(response: AssetResponse): string {
  return response.ok ? `Unexpected ${response.kind} response` : response.error;
}
