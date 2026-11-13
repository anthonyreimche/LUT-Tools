// The LUT library: every LUT added, kept across sessions and projects, and
// the atlas pages the look stage reads them from. Adding, renaming and
// removing write the store, rebuild the pages whose LUTs changed and tell the
// other windows, which read the store again. A page is supplied only once it
// holds a LUT, and again only when its LUTs change, once for a whole batch.

import { SRGB, type EncodingId } from "./encoding";
import { MAX_ATLAS_TEXELS, PAGE_COUNT, buildAtlas, directorySlots, pageOf, type PackedLut } from "./pack";
import type { Preparer } from "./prepare";
import type { LutStore, StoredLut } from "./store";
import type { StageTextureData } from "./safelight";

export interface IncomingFile {
  /** The file's name, with its folder path when it came with one ("Pack/Sub/a.cube"). */
  path: string;
  bytes: () => Promise<Uint8Array>;
}

export interface AddReport {
  added: StoredLut[];
  /** Files left out, each with why. */
  refused: { name: string; reason: string }[];
  /** Notes on files added, such as a table that was resampled. */
  notes: { name: string; note: string }[];
}

export interface Library {
  /** The entries, by folder then name. */
  entries(): readonly StoredLut[];
  get(id: string): StoredLut | undefined;
  byKey(key: number): StoredLut | undefined;
  /** Add files, telling `onProgress` how many of them are done. */
  add(files: readonly IncomingFile[], onProgress?: (done: number, total: number) => void): Promise<AddReport>;
  rename(id: string, name: string): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  setEncodings(id: string, inEnc: EncodingId, outEnc: EncodingId): Promise<void>;
  /** How full the library is, 0 to 1: its fullest page's share of its room.
   *  A file whose page is full is refused. */
  usage(): number;
  /** Changes with every change, for useSyncExternalStore. */
  revision(): number;
  subscribe(listener: () => void): () => void;
  /** Read the store again (another window changed it). */
  reload(): Promise<void>;
  dispose(): void;
}

export interface LibraryDeps {
  store: LutStore;
  /** Supplies atlas page `page`, or takes it away (null). */
  setPage(page: number, tex: StageTextureData | null): void;
  prepare: Preparer;
  /** Tells the other windows the store changed; returns the unsubscribe. */
  channel?: { post(): void; listen(onChange: () => void): () => void };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sorted(list: Iterable<StoredLut>): StoredLut[] {
  return [...list].sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name));
}

function folderOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(0, -1).join("/");
}

const asPacked = (e: StoredLut): PackedLut => ({ key: e.key, sig: e.sig, layout: e.layout, texels: e.texels });

export const LIBRARY_FULL =
  "The LUT library is full. Remove LUTs you no longer use from the library, then add this file again.";

/** What a page holds, for checking a new LUT's room against it. */
class PageRoom {
  readonly keys: number[] = [];
  blockTexels = 0;

  take(key: number, texels: number): void {
    this.keys.push(key);
    this.blockTexels += texels;
  }

  /** The texels the page takes with these extra LUTs. */
  texelsWith(key?: number, texels = 0): number {
    const keys = key === undefined ? this.keys : [...this.keys, key];
    return keys.length === 0 ? 0 : 1 + 3 * directorySlots(keys) + this.blockTexels + texels;
  }
}

function roomsOf(entries: Iterable<StoredLut>): PageRoom[] {
  const pages = Array.from({ length: PAGE_COUNT }, () => new PageRoom());
  for (const e of entries) pages[pageOf(e.key)].take(e.key, e.texels.length / 4);
  return pages;
}

export function createLibrary(deps: LibraryDeps): Library {
  let byId = new Map<string, StoredLut>();
  let list: StoredLut[] = [];
  let rev = 0;
  let used = 0;
  /** Each page's LUTs as last supplied, by id, and its texture's version. */
  const supplied = Array.from({ length: PAGE_COUNT }, () => ({ ids: "", version: 0 }));
  const listeners = new Set<() => void>();

  function notify(): void {
    rev++;
    for (const l of listeners) l();
  }

  function publish(): void {
    list = sorted(byId.values());
    const pages = Array.from({ length: PAGE_COUNT }, (): StoredLut[] => []);
    for (const e of list) pages[pageOf(e.key)].push(e);
    const rooms = roomsOf(list);
    used = Math.max(...rooms.map((r) => r.texelsWith() / MAX_ATLAS_TEXELS));
    pages.forEach((entries, page) => {
      const ids = entries
        .map((e) => e.id)
        .sort()
        .join(",");
      const state = supplied[page];
      if (ids === state.ids) return;
      state.ids = ids;
      if (entries.length === 0) {
        deps.setPage(page, null);
        return;
      }
      const atlas = buildAtlas(entries.map(asPacked));
      deps.setPage(page, { data: atlas.data, width: atlas.width, height: atlas.height, format: "rgba8", version: ++state.version });
    });
    notify();
  }

  async function reload(): Promise<void> {
    const records = await deps.store.all();
    byId = new Map(records.map((r) => [r.id, r]));
    publish();
  }

  const unlisten = deps.channel?.listen(() => void reload());

  function changed(): void {
    publish();
    deps.channel?.post();
  }

  return {
    entries: () => list,
    get: (id) => byId.get(id),
    byKey: (key) => list.find((e) => e.key === key),
    async add(files, onProgress) {
      const report: AddReport = { added: [], refused: [], notes: [] };
      const byKey = new Map([...byId.values()].map((e) => [e.key, e]));
      const rooms = roomsOf(byId.values());
      for (const [index, file] of files.entries()) {
        onProgress?.(index, files.length);
        const name = file.path.split(/[\\/]/).pop() ?? file.path;
        let bytes: Uint8Array;
        try {
          bytes = await file.bytes();
        } catch {
          report.refused.push({ name, reason: "The file can't be read." });
          continue;
        }
        const read = await deps.prepare(name, bytes);
        if (!read.ok) {
          report.refused.push({ name, reason: read.error });
          continue;
        }
        const same = byId.get(read.hash) ?? report.added.find((e) => e.id === read.hash);
        if (same) {
          report.refused.push({ name, reason: `It is already in the library as ${same.name}.` });
          continue;
        }
        const clash = byKey.get(read.key);
        if (clash) {
          report.refused.push({ name, reason: `Its key matches ${clash.name}'s; this file can't be told apart from it.` });
          continue;
        }
        const room = rooms[pageOf(read.key)];
        if (room.texelsWith(read.key, read.texels.length / 4) > MAX_ATLAS_TEXELS) {
          report.refused.push({ name, reason: LIBRARY_FULL });
          continue;
        }
        const entry: StoredLut = {
          id: read.hash,
          key: read.key,
          sig: read.sig,
          name: read.title,
          folder: folderOf(file.path),
          format: read.format,
          layout: read.layout,
          texels: read.texels,
          inEnc: SRGB,
          outEnc: SRGB,
          addedAt: Date.now(),
        };
        await deps.store.put(entry);
        byKey.set(entry.key, entry);
        room.take(entry.key, entry.texels.length / 4);
        report.added.push(entry);
        for (const note of read.notes) report.notes.push({ name, note });
      }
      onProgress?.(files.length, files.length);
      if (report.added.length > 0) {
        for (const e of report.added) byId.set(e.id, e);
        changed();
      }
      return report;
    },
    async rename(id, name) {
      const entry = byId.get(id);
      const trimmed = name.trim();
      if (!entry || trimmed === "" || trimmed === entry.name) return;
      const next = { ...entry, name: trimmed };
      await deps.store.put(next);
      byId.set(id, next);
      changed();
    },
    async remove(ids) {
      const gone = ids.filter((id) => byId.has(id));
      if (gone.length === 0) return;
      for (const id of gone) {
        await deps.store.delete(id);
        byId.delete(id);
      }
      changed();
    },
    async setEncodings(id, inEnc, outEnc) {
      const entry = byId.get(id);
      if (!entry || (entry.inEnc === inEnc && entry.outEnc === outEnc)) return;
      const next = { ...entry, inEnc, outEnc };
      await deps.store.put(next);
      byId.set(id, next);
      list = sorted(byId.values());
      notify();
      deps.channel?.post();
    },
    usage: () => used,
    revision: () => rev,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reload,
    dispose() {
      unlisten?.();
      listeners.clear();
    },
  };
}

/** Tells this app's other windows the library changed. */
export function broadcastChannel(name: string): LibraryDeps["channel"] {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(name);
  return {
    post: () => channel.postMessage("changed"),
    listen(onChange) {
      const handler = () => onChange();
      channel.addEventListener("message", handler);
      return () => {
        channel.removeEventListener("message", handler);
        channel.close();
      };
    },
  };
}
