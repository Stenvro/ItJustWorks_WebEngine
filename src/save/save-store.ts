// The saves in the browser (IndexedDB), keyed by save name: the headers in one store (the save
// list reads only these), the files in another. Browser only.

import { readSaveHeader, type SaveHeader } from './save-codec.ts';

const DATABASE = 'itjustworks-saves';
const HEADERS = 'headers';
const FILES = 'files';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export class SaveStore {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<SaveStore> {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(HEADERS)) db.createObjectStore(HEADERS);
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    return new SaveStore(await request(opening));
  }

  /** Every save's header, newest first (the save list's order). */
  async list(): Promise<SaveHeader[]> {
    const store = this.#db.transaction(HEADERS, 'readonly').objectStore(HEADERS);
    const headers = (await request(store.getAll())) as SaveHeader[];
    return headers.sort((a, b) => b.realTime - a.realTime);
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    const store = this.#db.transaction(FILES, 'readonly').objectStore(FILES);
    const bytes = (await request(store.get(name))) as Uint8Array | undefined;
    return bytes;
  }

  /** Writes a save (replacing one of the same name). */
  async write(bytes: Uint8Array): Promise<SaveHeader> {
    const { header } = readSaveHeader(bytes);
    const transaction = this.#db.transaction([HEADERS, FILES], 'readwrite');
    transaction.objectStore(HEADERS).put(header, header.name);
    transaction.objectStore(FILES).put(bytes, header.name);
    await done(transaction);
    return header;
  }

  async delete(name: string): Promise<void> {
    const transaction = this.#db.transaction([HEADERS, FILES], 'readwrite');
    transaction.objectStore(HEADERS).delete(name);
    transaction.objectStore(FILES).delete(name);
    await done(transaction);
  }
}
