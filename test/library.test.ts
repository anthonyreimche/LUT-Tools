// The library: adding files and folders, refusing what can't be read or has
// no room, the atlas pages it supplies (only those that hold LUTs, once a
// batch, only when their LUTs change), renaming, removing, and other
// windows' changes.

import { describe, expect, it } from "vitest";
import { writeCube } from "../src/cube";
import { cubeFrom, identityCube, type Vec3 } from "../src/lut";
import { LIBRARY_FULL, createLibrary, type IncomingFile, type LibraryDeps } from "../src/library";
import { findInAtlas } from "../src/model";
import { ATLAS_WIDTH, MAX_ATLAS_TEXELS, PAGE_COUNT, pageOf, type Atlas } from "../src/pack";
import { inlinePreparer, prepareLutFile, type Preparer } from "../src/prepare";
import { memoryStore, type StoredLut } from "../src/store";
import type { StageTextureData } from "../src/safelight";
import { identityHald, makePng } from "./support/files";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const noJpeg = () => Promise.reject(new Error("no JPEG here"));
const cubeFile = (path: string, fn: (r: number, g: number, b: number) => Vec3, size = 5): IncomingFile => ({
  path,
  bytes: async () => text(writeCube({ title: path.split("/").pop()?.replace(".cube", "") ?? path, shaper: null, cube: cubeFrom(size, fn) })),
});

async function keyOf(file: IncomingFile): Promise<number> {
  const p = await prepareLutFile(file.path, await file.bytes(), noJpeg);
  if (!p.ok) throw new Error(p.error);
  return p.key;
}

/** Files of 5-node LUTs, each on a page of its own, in page order. */
async function onePerPage(): Promise<IncomingFile[]> {
  const found: (IncomingFile | undefined)[] = Array.from({ length: PAGE_COUNT }, () => undefined);
  for (let i = 1; found.some((f) => !f); i++) {
    const file = cubeFile(`Gain ${i}.cube`, (x, y, z) => [x * (1 - i / 1000), y, z]);
    found[pageOf(await keyOf(file))] ??= file;
  }
  return found as IncomingFile[];
}

function rig(initial: StoredLut[] = [], prepare: Preparer = inlinePreparer(noJpeg)) {
  const supplied: { page: number; tex: StageTextureData | null }[] = [];
  let other: (() => void) | null = null;
  const posted: number[] = [];
  const store = memoryStore(initial);
  const deps: LibraryDeps = {
    store,
    setPage: (page, tex) => void supplied.push({ page, tex }),
    prepare,
    channel: {
      post: () => void posted.push(1),
      listen: (onChange) => {
        other = onChange;
        return () => (other = null);
      },
    },
  };
  const library = createLibrary(deps);
  /** The page as last supplied. */
  const page = (n: number): Atlas | null => {
    const t = supplied.filter((s) => s.page === n).at(-1)?.tex;
    return t ? { width: t.width, height: t.height, data: t.data as Uint8Array, offsets: new Map(), slots: 0 } : null;
  };
  const found = (e: StoredLut): number => {
    const p = page(pageOf(e.key));
    return p ? findInAtlas(p, e.key, e.sig) : -1;
  };
  const bytes = (): number => {
    let total = 0;
    for (let n = 0; n < PAGE_COUNT; n++) total += page(n)?.data.byteLength ?? 0;
    return total;
  };
  return { library, store, supplied, page, found, bytes, posted, otherWindow: () => other?.() };
}

describe("the library", () => {
  it("supplies no atlas page at all while it is empty", async () => {
    const r = rig();
    await r.library.reload();
    expect(r.library.entries()).toEqual([]);
    expect(r.supplied).toEqual([]);
    expect(r.library.usage()).toBe(0);
  });

  it("adds .cube files and HaldCLUTs, grouped by folder, each on its key's page", async () => {
    const r = rig();
    await r.library.reload();
    const png = await makePng(8, 8, identityHald(2, 255));
    const report = await r.library.add([
      cubeFile("Warm.cube", (x, y, z) => [x, y * 0.95, z * 0.9]),
      cubeFile("Pack/Film/Cool.cube", (x, y, z) => [x * 0.9, y, z]),
      { path: "Pack/Film/Neutral.png", bytes: async () => png },
    ]);
    expect(report.refused).toEqual([]);
    expect(r.library.entries().map((e) => [e.folder, e.name, e.format])).toEqual([
      ["", "Warm", "cube"],
      ["Pack/Film", "Cool", "cube"],
      ["Pack/Film", "Neutral", "hald"],
    ]);
    for (const e of r.library.entries()) expect(r.found(e)).toBeGreaterThan(0);
    expect(r.posted).toHaveLength(1);
    expect((await r.store.all()).length).toBe(3);
  });

  it("supplies each page a batch touches once, with the batch's LUTs, and leaves the rest alone", async () => {
    const r = rig();
    await r.library.reload();
    const files = await onePerPage();
    await r.library.add([files[0], files[2]]);
    expect(r.supplied.map((s) => [s.page, s.tex?.version])).toEqual([
      [0, 1],
      [2, 1],
    ]);
    const batch = [...Array(6).keys()].map((i) => cubeFile(`More ${i}.cube`, (x, y, z) => [x, y, z * (1 - i / 50)]));
    const before = r.supplied.length;
    await r.library.add(batch);
    const pages = r.supplied.slice(before).map((s) => s.page);
    expect(new Set(pages).size).toBe(pages.length);
    for (const e of r.library.entries()) expect(r.found(e)).toBeGreaterThan(0);
  });

  it("costs what it holds: a page is as tall as its LUTs need", async () => {
    const r = rig();
    await r.library.reload();
    await r.library.add([0, 1, 2].map((i) => cubeFile(`Look ${i}.cube`, (x, y, z) => [x, y * (1 - i / 10), z], 33)));
    const block = 2 * 33 ** 3;
    expect(r.bytes()).toBeLessThan(4 * (3 * block + 3 * ATLAS_WIDTH));
    expect(r.bytes()).toBeLessThan(1.5 * 1024 * 1024);
    for (let n = 0; n < PAGE_COUNT; n++) {
      const p = r.page(n);
      if (p) expect(p.width).toBe(ATLAS_WIDTH);
    }
  });

  it("refuses a file already in the library, a malformed one and an unreadable one, saying why", async () => {
    const r = rig();
    await r.library.reload();
    const original = cubeFile("A.cube", (x, y, z) => [x, y, z]);
    await r.library.add([original]);
    const supplied = r.supplied.length;
    const report = await r.library.add([
      { path: "Again.cube", bytes: original.bytes },
      { path: "Broken.cube", bytes: async () => text("LUT_3D_SIZE 2\n0 0 0\n") },
      { path: "Gone.cube", bytes: () => Promise.reject(new Error("gone")) },
    ]);
    expect(report.added).toEqual([]);
    expect(report.refused.map((x) => x.name)).toEqual(["Again.cube", "Broken.cube", "Gone.cube"]);
    expect(report.refused[0].reason).toMatch(/already in the library as A/);
    expect(report.refused[1].reason).toMatch(/1 entries where its size calls for 8/);
    expect(report.refused[2].reason).toMatch(/can't be read/);
    expect(r.supplied).toHaveLength(supplied);
  });

  it("refuses a LUT whose page is full, saying what to do, and still adds one whose page has room", async () => {
    const [first, second] = await onePerPage();
    const huge: StoredLut = {
      id: "f".repeat(64),
      key: 99,
      sig: 1,
      name: "Huge",
      folder: "",
      format: "cube",
      layout: { kind: 2, n3: 2, n1: 2, lo3: [0, 0, 0], hi3: [1, 1, 1], lo1: [0, 0, 0], hi1: [1, 1, 1], range3: [0, 1], range1: [0, 1] },
      texels: new Uint8Array(4 * (MAX_ATLAS_TEXELS - 200)),
      inEnc: 0,
      outEnc: 0,
      addedAt: 0,
    };
    expect(pageOf(huge.key)).toBe(0);
    const r = rig([huge]);
    await r.library.reload();
    expect(r.library.usage()).toBeGreaterThan(0.99);
    const report = await r.library.add([first, second]);
    expect(report.refused).toEqual([{ name: first.path, reason: LIBRARY_FULL }]);
    expect(LIBRARY_FULL).toMatch(/full\. Remove LUTs you no longer use/);
    expect(report.added.map((e) => e.name)).toEqual([second.path.replace(".cube", "")]);
  });

  it("renames, keeping the LUT's key, and supplies no page for it", async () => {
    const r = rig();
    await r.library.reload();
    const [entry] = (await r.library.add([cubeFile("Old.cube", (x, y, z) => [x, y, z])])).added;
    const supplied = r.supplied.length;
    await r.library.rename(entry.id, "  New name ");
    expect(r.library.get(entry.id)).toMatchObject({ name: "New name", key: entry.key });
    expect((await r.store.all())[0].name).toBe("New name");
    await r.library.rename(entry.id, "   ");
    expect(r.library.get(entry.id)?.name).toBe("New name");
    expect(r.supplied).toHaveLength(supplied);
  });

  it("removes LUTs from the store and their page, and takes an emptied page away", async () => {
    const r = rig();
    await r.library.reload();
    const files = await onePerPage();
    const { added } = await r.library.add([files[1], files[3], cubeFile("B.cube", (x, y, z) => [y, x, z])]);
    const [one, three] = added;
    const supplied = r.supplied.length;
    await r.library.remove([one.id]);
    expect(r.library.entries().map((e) => e.id)).not.toContain(one.id);
    expect(r.supplied.slice(supplied)).toEqual([{ page: 1, tex: null }]);
    expect(r.found(three)).toBeGreaterThan(0);
  });

  it("remembers the encodings last chosen with a LUT, without supplying a page", async () => {
    const r = rig();
    await r.library.reload();
    const [entry] = (await r.library.add([cubeFile("V.cube", (x, y, z) => [x, y, z])])).added;
    const supplied = r.supplied.length;
    await r.library.setEncodings(entry.id, 1, 1);
    expect(r.library.get(entry.id)).toMatchObject({ inEnc: 1, outEnc: 1 });
    expect((await r.store.all())[0]).toMatchObject({ inEnc: 1, outEnc: 1 });
    expect(r.supplied).toHaveLength(supplied);
  });

  it("reads the store again when another window changes it, supplying only the pages that changed", async () => {
    const r = rig();
    await r.library.reload();
    const entry = await addedEntry();
    await r.store.put(entry);
    r.otherWindow();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.library.entries()).toHaveLength(1);
    expect(r.supplied.map((s) => s.page)).toEqual([pageOf(entry.key)]);
    r.otherWindow();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.supplied).toHaveLength(1);
  });

  it("keeps a removal made while a batch is being added", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const inline = inlinePreparer(noJpeg);
    const r = rig([], async (name, bytes) => {
      if (name === "Slow.cube") await gate;
      return inline(name, bytes);
    });
    await r.library.reload();
    const [early] = (await r.library.add([cubeFile("Early.cube", (x, y, z) => [x, y, z])])).added;
    const adding = r.library.add([cubeFile("Slow.cube", (x, y, z) => [z, y, x])]);
    await r.library.remove([early.id]);
    release();
    await adding;
    expect(r.library.entries().map((e) => e.name)).toEqual(["Slow"]);
  });

  it("finds a LUT by its key, and nothing for a key it lacks", async () => {
    const r = rig();
    await r.library.reload();
    const [entry] = (await r.library.add([cubeFile("K.cube", (x, y, z) => [x, y, z])])).added;
    expect(r.library.byKey(entry.key)?.id).toBe(entry.id);
    expect(r.library.byKey(12345)).toBeUndefined();
  });
});

async function addedEntry(): Promise<StoredLut> {
  const r = rig();
  await r.library.reload();
  const report = await r.library.add([
    { path: "Id.cube", bytes: async () => text(writeCube({ title: "Id", shaper: null, cube: identityCube(3) })) },
  ]);
  return report.added[0];
}
