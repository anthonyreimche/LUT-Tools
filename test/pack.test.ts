// The atlas and the stage's CPU twins: the reference from the parsed table,
// and the shader's own steps over the atlas bytes.

import { describe, expect, it } from "vitest";
import { decode, encode, type EncodingId } from "../src/encoding";
import { cubeFrom, identityCube, type Lut, type Table, type Vec3 } from "../src/lut";
import { applyLook, applyLookFromAtlas, findInAtlas, type AtlasLook } from "../src/model";
import {
  ATLAS_WIDTH,
  PAGE_COUNT,
  PROBES,
  atlasTexels,
  buildAtlas,
  directorySlots,
  keyFromHash,
  layoutSignature,
  packLut,
  pageName,
  pageOf,
  type PackedLut,
} from "../src/pack";
import { DEFAULT_SETTINGS, type LookSettings } from "../src/params";

const look = (r: number, g: number, b: number): Vec3 => [
  0.03 + 0.94 * Math.pow(Math.max(r, 0), 0.85) + 0.05 * g,
  0.02 + 0.9 * g + 0.04 * Math.sin(3 * b),
  0.08 + 0.75 * b + 0.1 * r * g,
];

function shaperOf(size: number, fn: (x: number) => number, lo = 0, hi = 1): Table {
  const data = new Float64Array(3 * size);
  for (let i = 0; i < size; i++) {
    const x = lo + ((hi - lo) * i) / (size - 1);
    data[3 * i] = fn(x);
    data[3 * i + 1] = fn(x) * 0.9;
    data[3 * i + 2] = Math.min(1, fn(x) * 1.1);
  }
  return { size, lo: [lo, lo, lo], hi: [hi, hi, hi], data };
}

const LUTS: Record<string, Lut> = {
  "identity 2": { title: "", shaper: null, cube: identityCube(2) },
  "identity 33": { title: "", shaper: null, cube: identityCube(33) },
  "look 17": { title: "", shaper: null, cube: cubeFrom(17, look) },
  "look 65": { title: "", shaper: null, cube: cubeFrom(65, look) },
  "look 9 over a wide domain": { title: "", shaper: null, cube: cubeFrom(9, look, [-0.1, 0, 0], [1.2, 1.1, 1]) },
  "1D 1024": { title: "", shaper: shaperOf(1024, (x) => Math.sqrt(x)), cube: null },
  "1D 5 over [0, 2]": { title: "", shaper: shaperOf(5, (x) => x * x * 0.25, 0, 2), cube: null },
  "shaper + 3D": { title: "", shaper: shaperOf(64, (x) => Math.pow(x, 0.6)), cube: cubeFrom(11, look) },
};

const packed: PackedLut[] = Object.values(LUTS).map((lut, i) => packLut(lut, 1000 + 7919 * i));
const atlas = buildAtlas(packed);

const lookOf = (p: PackedLut, settings: LookSettings = DEFAULT_SETTINGS): AtlasLook => ({
  key: p.key,
  sig: p.sig,
  layout: p.layout,
  settings,
});

function grid(): Vec3[] {
  const out: Vec3[] = [];
  const steps = [0, 0.013, 0.2, 0.37, 0.5, 0.61, 0.8, 0.97, 1];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push([r, g, b]);
  return out;
}

const maxDiff = (a: Vec3, b: Vec3): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe("keys and signatures", () => {
  it("takes 31 bits of the hash, never 0", () => {
    expect(keyFromHash("ffffffff00")).toBe(0x7fffffff);
    expect(keyFromHash("80000000aa")).toBe(1);
    expect(keyFromHash("0000002a")).toBe(42);
  });

  it("puts a key on the page its top two bits name, whatever its low bits", () => {
    expect(PAGE_COUNT).toBe(4);
    expect([1, 2 ** 29 - 1, 2 ** 29, 2 ** 30, 2 ** 30 + 2 ** 29, 2 ** 31 - 1].map(pageOf)).toEqual([0, 0, 1, 2, 3, 3]);
    expect(pageOf(keyFromHash("deadbeef"))).toBe(pageOf(keyFromHash("deadbeef")));
    expect([0, 1, 2, 3].map(pageName)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("spreads hashed keys over every page", () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) counts[pageOf(keyFromHash(((i * 2654435761) >>> 0).toString(16).padStart(8, "0")))]++;
    for (const n of counts) expect(n).toBeGreaterThan(800);
  });

  it("gives a different signature to a different layout", () => {
    const a = packLut(LUTS["look 17"], 5).layout;
    expect(layoutSignature(a)).toBe(layoutSignature({ ...a }));
    expect(layoutSignature({ ...a, n3: 18 })).not.toBe(layoutSignature(a));
    expect(layoutSignature({ ...a, range3: [a.range3[0], a.range3[1] + 1e-3] })).not.toBe(layoutSignature(a));
  });
});

describe("the atlas", () => {
  it("is ATLAS_WIDTH wide and as tall as its texels need", () => {
    expect(atlas.width).toBe(ATLAS_WIDTH);
    expect(atlas.height).toBe(Math.ceil(atlasTexels(packed) / ATLAS_WIDTH));
    expect(atlas.data.length).toBe(4 * atlas.width * atlas.height);
  });

  it("finds every LUT by its key and signature, and nothing else", () => {
    for (const p of packed) expect(findInAtlas(atlas, p.key, p.sig)).toBe(atlas.offsets.get(p.key));
    expect(findInAtlas(atlas, packed[0].key, packed[0].sig + 1)).toBe(-1);
    expect(findInAtlas(atlas, 424242, 1)).toBe(-1);
    expect(findInAtlas(atlas, 0, 0)).toBe(-1);
    const empty = buildAtlas([]);
    expect(empty.height).toBe(1);
    expect(findInAtlas(empty, packed[0].key, packed[0].sig)).toBe(-1);
  });

  it("keeps every key within the probes, however the keys collide", () => {
    const keys = Array.from({ length: 50 }, (_, i) => 1 + 64 * i);
    const slots = directorySlots(keys);
    expect(slots).toBeGreaterThanOrEqual(128);
    const luts = keys.map((k) => packLut(LUTS["identity 2"], k));
    const crowded = buildAtlas(luts);
    for (const l of luts) expect(findInAtlas(crowded, l.key, l.sig)).toBeGreaterThan(0);
    expect(PROBES).toBe(4);
  });

  it("refuses two LUTs with one key", () => {
    expect(() => buildAtlas([packed[0], packed[0]])).toThrow(/one key/);
  });

  it("stores 16 bits a value: a 65-node table takes 2·65³ texels", () => {
    expect(packLut(LUTS["look 65"], 1).texels.length).toBe(4 * 2 * 65 ** 3);
    expect(packLut(LUTS["1D 1024"], 1).texels.length).toBe(4 * 3 * 1023);
  });
});

describe("the stage on the CPU", () => {
  it.each(Object.keys(LUTS))("reads %s from the atlas as the parsed table, to 16 bits", (name) => {
    const p = packed[Object.keys(LUTS).indexOf(name)];
    const lut = LUTS[name];
    const step = Math.max(p.layout.range3[1] - p.layout.range3[0], p.layout.range1[1] - p.layout.range1[0]) / 65535;
    let worst = 0;
    for (const c of grid()) worst = Math.max(worst, maxDiff(applyLookFromAtlas(c, atlas, lookOf(p)), applyLook(c, lut, DEFAULT_SETTINGS)));
    expect(worst).toBeLessThanOrEqual(1.5 * step + 1e-12);
  });

  it.each([2, 17, 33, 65])("leaves every colour where it was through an identity table of %i nodes", (n) => {
    const p = packLut({ title: "", shaper: null, cube: identityCube(n) }, 77);
    const single = buildAtlas([p]);
    for (const c of grid()) expect(maxDiff(applyLookFromAtlas(c, single, lookOf(p)), c)).toBeLessThanOrEqual(1e-5);
  });

  it("keeps what lies outside the domain: highlights above 1 and negative channels", () => {
    const p = packed[1];
    for (const c of [[1.4, 0.5, 0.2], [-0.05, 0.3, 1.2], [2.5, 2.5, 2.5]] as Vec3[]) {
      expect(maxDiff(applyLookFromAtlas(c, atlas, lookOf(p)), c)).toBeLessThanOrEqual(1e-5);
    }
  });

  it("adds a highlight's excess back as light, continuously at the domain's edge", () => {
    const lut = LUTS["look 17"];
    const edge = applyLook([1, 0.5, 0.5], lut, DEFAULT_SETTINGS);
    const past = applyLook([1 + 1e-6, 0.5, 0.5], lut, DEFAULT_SETTINGS);
    expect(maxDiff(edge, past)).toBeLessThan(1e-5);
    const far = applyLook([1.5, 0.5, 0.5], lut, DEFAULT_SETTINGS);
    expect(far[0]).toBeGreaterThan(edge[0]);
    expect(decode(far[0], 0) - decode(edge[0], 0)).toBeCloseTo(decode(1.5, 0) - 1, 9);
  });

  it.each([1, 2, 3] as EncodingId[])("leaves colours unchanged through an identity table in encoding %i on both sides", (enc) => {
    const p = packLut({ title: "", shaper: null, cube: identityCube(33) }, 99);
    const single = buildAtlas([p]);
    const s = { strength: 1, inEnc: enc, outEnc: enc };
    for (const c of grid()) expect(maxDiff(applyLookFromAtlas(c, single, lookOf(p, s)), c)).toBeLessThan(2e-5);
  });

  it.each([
    [3, 0],
    [0, 1],
    [2, 3],
  ] as [EncodingId, EncodingId][])("converts input encoding %i to output encoding %i as the reference does", (inEnc, outEnc) => {
    // A table that is an identity between the two encodings: what remains is
    // the table's own interpolation, the same in both.
    const lut: Lut = { title: "", shaper: null, cube: cubeFrom(33, (r, g, b) => [r, g, b].map((x) => encode(decode(x, inEnc), outEnc)) as Vec3) };
    const p = packLut(lut, 99);
    const single = buildAtlas([p]);
    const s = { strength: 1, inEnc, outEnc };
    for (const c of grid()) expect(maxDiff(applyLookFromAtlas(c, single, lookOf(p, s)), applyLook(c, lut, s))).toBeLessThan(1e-4);
    expect(maxDiff(applyLook([0.5, 0.7, 0.2], lut, s), [0.5, 0.7, 0.2])).toBeLessThan(2e-3);
  });

  it("blends by strength and does nothing at 0", () => {
    const p = packed[2];
    const c: Vec3 = [0.3, 0.6, 0.2];
    const full = applyLookFromAtlas(c, atlas, lookOf(p));
    const half = applyLookFromAtlas(c, atlas, lookOf(p, { ...DEFAULT_SETTINGS, strength: 0.5 }));
    half.forEach((v, i) => expect(v).toBeCloseTo((c[i] + full[i]) / 2, 12));
    expect(applyLookFromAtlas(c, atlas, lookOf(p, { ...DEFAULT_SETTINGS, strength: 0 }))).toEqual(c);
  });

  it("draws the photo unchanged when its LUT isn't in the atlas", () => {
    const c: Vec3 = [0.3, 0.6, 0.2];
    expect(applyLookFromAtlas(c, atlas, { ...lookOf(packed[2]), key: 31337 })).toEqual(c);
  });
});
