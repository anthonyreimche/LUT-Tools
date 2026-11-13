// One file to what the library stores of it: read, keyed and packed for the
// atlas. A batch runs each file through a worker (prepare-worker.ts), so the
// parsing never holds up the window; where no worker starts, it runs here,
// giving the window a turn between files.

import { keyFromHash, packLut, type LutLayout } from "./pack";
import { readLutFile, type JpegDecoder } from "./read-file";

export type Prepared =
  | {
      ok: true;
      /** SHA-256 of the file, hex. */
      hash: string;
      key: number;
      sig: number;
      title: string;
      format: "cube" | "hald";
      layout: LutLayout;
      texels: Uint8Array;
      notes: string[];
    }
  | { ok: false; error: string };

/** Prepares one file, its name for its format and its bytes. */
export type Preparer = (name: string, bytes: Uint8Array) => Promise<Prepared>;

export async function prepareLutFile(name: string, bytes: Uint8Array, decodeJpeg: JpegDecoder): Promise<Prepared> {
  const read = await readLutFile(name, bytes, decodeJpeg);
  if (!read.ok) return read;
  const packed = packLut(read.lut, keyFromHash(read.hash));
  return {
    ok: true,
    hash: read.hash,
    key: packed.key,
    sig: packed.sig,
    title: read.lut.title,
    format: read.format,
    layout: packed.layout,
    texels: packed.texels,
    notes: read.notes,
  };
}

/** How long the window's thread may parse before it gives the window a turn. */
const SLICE_MS = 12;

const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/** Prepares files on the window's own thread, yielding to it between files
 *  once a slice's time is up. */
export function inlinePreparer(decodeJpeg: JpegDecoder): Preparer {
  let sliceStart = performance.now();
  return async (name, bytes) => {
    if (performance.now() - sliceStart > SLICE_MS) {
      await nextTask();
      sliceStart = performance.now();
    }
    return prepareLutFile(name, bytes, decodeJpeg);
  };
}

export interface PrepareRequest {
  id: number;
  name: string;
  bytes: Uint8Array;
}

export interface PrepareResponse {
  id: number;
  result: Prepared;
}

/** The minimum of a dedicated worker that workerPreparer uses. */
export interface WorkerLike {
  postMessage(message: PrepareRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<PrepareResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** Prepares files in a worker, started on the first file. If it can't be
 *  started, or fails, this file and every later one is prepared by
 *  `fallback` instead. `dispose` ends the worker. */
export function workerPreparer(start: () => WorkerLike, fallback: Preparer): Preparer & { dispose(): void } {
  let worker: WorkerLike | null = null;
  let broken = false;
  let nextId = 0;
  const waiting = new Map<
    number,
    { name: string; bytes: Uint8Array; resolve: (p: Prepared) => void; reject: (err: unknown) => void }
  >();

  function fail(): void {
    broken = true;
    worker?.terminate();
    worker = null;
    for (const w of waiting.values()) fallback(w.name, w.bytes).then(w.resolve, w.reject);
    waiting.clear();
  }

  function started(): WorkerLike | null {
    if (worker || broken) return worker;
    try {
      worker = start();
    } catch {
      broken = true;
      return null;
    }
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      w.resolve(e.data.result);
    };
    worker.onerror = fail;
    return worker;
  }

  const prepare: Preparer = (name, bytes) => {
    const w = started();
    if (!w) return fallback(name, bytes);
    const id = nextId++;
    // The worker gets its own copy, so the caller's bytes stay usable for the
    // fallback should the worker fail.
    const copy = bytes.slice();
    return new Promise<Prepared>((resolve, reject) => {
      waiting.set(id, { name, bytes, resolve, reject });
      w.postMessage({ id, name, bytes: copy }, [copy.buffer]);
    });
  };
  return Object.assign(prepare, { dispose: fail });
}
