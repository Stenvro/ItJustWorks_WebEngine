// Bewaart FileSystemHandles in IndexedDB, zodat de gekozen Data-map een
// herstart van de browser overleeft.

const DB_NAME = 'skyrim-web';
const DB_VERSION = 1;
const STORE = 'handles';

function asError(error: DOMException | null, fallback: string): Error {
  return error ?? new Error(fallback);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(asError(request.error, 'Could not open IndexedDB'));
    };
    request.onblocked = () => {
      reject(new Error('IndexedDB is blocked by another tab'));
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        resolve(request.result);
      };
      transaction.onerror = () => {
        reject(asError(transaction.error, 'IndexedDB transaction failed'));
      };
      transaction.onabort = () => {
        reject(asError(transaction.error, 'IndexedDB transaction aborted'));
      };
    });
  } finally {
    db.close();
  }
}

export async function loadDirectoryHandle(
  key: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  const value: unknown = await withStore('readonly', (store) => store.get(key));
  return value instanceof FileSystemDirectoryHandle ? value : undefined;
}

export async function saveDirectoryHandle(
  key: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, key));
}

export async function deleteHandle(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key));
}
