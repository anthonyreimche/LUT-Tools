// How the LUTs reach the GPU: every library LUT in an RGBA8 texture (an atlas
// page), each value as 16 bits over its table's own range, found by its key
// through a small hash directory at the start of its page.
//
// The library spreads over PAGE_COUNT pages, each a variant of the look
// stage's one texture, and a LUT's page follows from its key, so it never
// has to be stored: the photo's edit names the page with the key (params.ts),
// the renderer binds that page alone and uploads it the first time a photo
// needs it, and adding the same file again, anywhere, puts it back where the
// edits look for it. A page is as tall as its LUTs need, so the library costs
// what it holds. Where a LUT sits within its page is never stored either: the
// shader looks the key up, and a key that isn't there draws the photo
// unchanged.
//
// Texels, RGBA bytes, row-major, ATLAS_WIDTH wide:
//   0                header: the directory's slot count T (a power of two)
//   1 + 3s ..        slot s: key, data offset, layout signature (u32, LE)
//   1 + 3T ..        each LUT's block: the shader's 1D texels, then its 3D ones
// A 1D table of M nodes takes M − 1 texels a channel, texel i holding nodes i
// and i + 1 (hi, lo, hi, lo), so a lookup is one fetch a channel. A 3D node
// takes two texels, the high bytes of r, g, b and then the low ones.

import { type Lut, type Table, type Vec3 } from "./lut";

export const ATLAS_WIDTH = 4096;
export const MAX_ATLAS_HEIGHT = 4096;
/** A page's room: 64 MB, the most one stage texture may take. */
export const MAX_ATLAS_TEXELS = ATLAS_WIDTH * MAX_ATLAS_HEIGHT;
/** Four full pages are the 256 MB of stage textures one extension may hold. */
export const PAGE_COUNT = 4;
/** How far past its home slot the shader looks for a key. */
export const PROBES = 4;

export const KIND_SHAPER = 1;
export const KIND_CUBE = 2;

/** What a photo's edit records of its LUT: enough to read it in the atlas. */
export interface LutLayout {
  kind: number;
  n3: number;
  n1: number;
  lo3: Vec3;
  hi3: Vec3;
  lo1: Vec3;
  hi1: Vec3;
  range3: [number, number];
  range1: [number, number];
}

export interface PackedLut {
  key: number;
  layout: LutLayout;
  sig: number;
  /** The LUT's block, in RGBA bytes. */
  texels: Uint8Array;
}

/** The 31-bit key a LUT is known by, from its file's SHA-256: never 0, which
 *  means "no LUT". */
export function keyFromHash(hex: string): number {
  return (parseInt(hex.slice(0, 8), 16) & 0x7fffffff) || 1;
}

/** The page a key's LUT lives in: the key's top two bits, which the
 *  directory's slot (the key's low bits) doesn't depend on. */
export const pageOf = (key: number): number => Math.floor(key / 2 ** 29) % PAGE_COUNT;

/** The texture variant a page is supplied as. */
export const pageName = (page: number): string => `p${page}`;

function fnv1a(words: number[]): number {
  const bytes = new Uint8Array(new Float32Array(words).buffer);
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
  return h >>> 0;
}

/** A layout's signature: the shader draws a LUT only when the edit's layout
 *  is the one the atlas holds. */
export function layoutSignature(l: LutLayout): number {
  return (
    fnv1a([l.kind, l.n3, l.n1, ...l.lo3, ...l.hi3, ...l.lo1, ...l.hi1, ...l.range3, ...l.range1]) & 0x7fffffff
  );
}

function valueRange(t: Table): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of t.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 1e-9 ? [lo, hi] : [lo, lo + 1];
}

const quantize = (v: number, r: [number, number]): number =>
  Math.min(65535, Math.max(0, Math.round(((v - r[0]) / (r[1] - r[0])) * 65535)));

export const shaperTexels = (l: LutLayout): number => (l.kind & KIND_SHAPER ? 3 * (l.n1 - 1) : 0);
export const cubeTexels = (l: LutLayout): number => (l.kind & KIND_CUBE ? 2 * l.n3 ** 3 : 0);

export function packLut(lut: Lut, key: number): PackedLut {
  const none: [number, number] = [0, 1];
  const layout: LutLayout = {
    kind: (lut.shaper ? KIND_SHAPER : 0) | (lut.cube ? KIND_CUBE : 0),
    n3: lut.cube?.size ?? 2,
    n1: lut.shaper?.size ?? 2,
    lo3: lut.cube ? [...lut.cube.lo] : [0, 0, 0],
    hi3: lut.cube ? [...lut.cube.hi] : [1, 1, 1],
    lo1: lut.shaper ? [...lut.shaper.lo] : [0, 0, 0],
    hi1: lut.shaper ? [...lut.shaper.hi] : [1, 1, 1],
    range3: lut.cube ? valueRange(lut.cube) : none,
    range1: lut.shaper ? valueRange(lut.shaper) : none,
  };
  const texels = new Uint8Array(4 * (shaperTexels(layout) + cubeTexels(layout)));
  let at = 0;
  if (lut.shaper) {
    const m = layout.n1;
    const d = lut.shaper.data;
    for (let ch = 0; ch < 3; ch++)
      for (let i = 0; i < m - 1; i++) {
        const a = quantize(d[3 * i + ch], layout.range1);
        const b = quantize(d[3 * (i + 1) + ch], layout.range1);
        texels[at] = a >> 8;
        texels[at + 1] = a & 0xff;
        texels[at + 2] = b >> 8;
        texels[at + 3] = b & 0xff;
        at += 4;
      }
  }
  if (lut.cube) {
    const d = lut.cube.data;
    for (let p = 0; p < d.length; p += 3) {
      for (let ch = 0; ch < 3; ch++) {
        const q = quantize(d[p + ch], layout.range3);
        texels[at + ch] = q >> 8;
        texels[at + 4 + ch] = q & 0xff;
      }
      at += 8;
    }
  }
  return { key, layout, sig: layoutSignature(layout), texels };
}

export interface Atlas {
  width: number;
  height: number;
  data: Uint8Array;
  /** Where each key's block starts, in texels. */
  offsets: Map<number, number>;
  slots: number;
}

/** The directory's slot count for these keys: the smallest power of two, at
 *  least twice their number, at which every key sits within PROBES slots of
 *  its home. */
export function directorySlots(keys: readonly number[]): number {
  for (let slots = Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, 2 * keys.length)))); ; slots *= 2) {
    const used = new Uint8Array(slots);
    let placed = true;
    for (const key of [...keys].sort((a, b) => a - b)) {
      let probe = 0;
      while (probe < PROBES && used[(key + probe) & (slots - 1)]) probe++;
      if (probe === PROBES) {
        placed = false;
        break;
      }
      used[(key + probe) & (slots - 1)] = 1;
    }
    if (placed) return slots;
  }
}

/** The texels an atlas of these LUTs takes. */
export function atlasTexels(luts: readonly PackedLut[]): number {
  return 1 + 3 * directorySlots(luts.map((l) => l.key)) + luts.reduce((n, l) => n + l.texels.length / 4, 0);
}

export function buildAtlas(luts: readonly PackedLut[]): Atlas {
  const keys = luts.map((l) => l.key);
  if (new Set(keys).size !== keys.length) throw new Error("two LUTs with one key");
  const slots = directorySlots(keys);
  const total = atlasTexels(luts);
  if (total > MAX_ATLAS_TEXELS) throw new Error("the LUTs don't fit in one atlas");
  const height = Math.max(1, Math.ceil(total / ATLAS_WIDTH));
  const data = new Uint8Array(ATLAS_WIDTH * height * 4);
  const view = new DataView(data.buffer);
  const word = (texel: number, v: number) => view.setUint32(4 * texel, v >>> 0, true);
  word(0, slots);
  const offsets = new Map<number, number>();
  let at = 1 + 3 * slots;
  const sorted = [...luts].sort((a, b) => a.key - b.key);
  for (const lut of sorted) {
    let slot = lut.key & (slots - 1);
    while (view.getUint32(4 * (1 + 3 * slot), true) !== 0) slot = (slot + 1) & (slots - 1);
    word(1 + 3 * slot, lut.key);
    word(2 + 3 * slot, at);
    word(3 + 3 * slot, lut.sig);
    data.set(lut.texels, 4 * at);
    offsets.set(lut.key, at);
    at += lut.texels.length / 4;
  }
  return { width: ATLAS_WIDTH, height, data, offsets, slots };
}
