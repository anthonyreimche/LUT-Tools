// Where the library lives between sessions: IndexedDB, which this app's
// windows share whatever project is open. One record a LUT, holding its
// packed table, so loading the library is reading bytes, not parsing files.

import type { LutLayout } from "./pack";
import type { EncodingId } from "./encoding";

export interface StoredLut {
  /** SHA-256 of the file the LUT came from, hex. */
  id: string;
  key: number;
  sig: number;
  name: string;
  /** "" for a file added on its own; the folder's path for one added with it. */
  folder: string;
  format: "cube" | "hald";
  layout: LutLayout;
  texels: Uint8Array;
  /** The encodings last chosen with this LUT, offered when it is applied again. */
  inEnc: EncodingId;
  outEnc: EncodingId;
  addedAt: number;
}

export interface LutStore {
  all(): Promise<StoredLut[]>;
  put(entry: StoredLut): Promise<void>;
  delete(id: string): Promise<void>;
}

const DB_NAME = "lut-tools";
const STORE = "luts";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function indexedDbStore(): LutStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("the LUT library can't be opened"));
    });
    return db;
  };
  return {
    async all() {
      const tx = (await open()).transaction(STORE, "readonly");
      return request(tx.objectStore(STORE).getAll() as IDBRequest<StoredLut[]>);
    },
    async put(entry) {
      const tx = (await open()).transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      await done(tx);
    },
    async delete(id) {
      const tx = (await open()).transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      await done(tx);
    },
  };
}

/** A store in memory, for tests and for a window without IndexedDB. */
export function memoryStore(initial: StoredLut[] = []): LutStore {
  const records = new Map(initial.map((e) => [e.id, e]));
  return {
    all: async () => [...records.values()],
    put: async (entry) => void records.set(entry.id, entry),
    delete: async (id) => void records.delete(id),
  };
}
