// Baseline TIFF, enough for a HaldCLUT: the first image, RGB, chunky,
// stripped, 8 or 16-bit unsigned or 32-bit float samples, uncompressed,
// LZW, Deflate or PackBits, with or without horizontal differencing.

import type { RgbImage } from "./png";
import { inflate } from "./zlib";

const TAG = {
  width: 256,
  height: 257,
  bits: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samples: 277,
  rowsPerStrip: 278,
  stripBytes: 279,
  planar: 284,
  predictor: 317,
  tileWidth: 322,
  sampleFormat: 339,
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function isTiff(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42)
  );
}

/** TIFF's LZW: MSB-first codes from 9 to 12 bits, the width growing one
 *  code early. */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
    first[i] = i;
  }
  let out = new Uint8Array(Math.max(expected, 1));
  let pos = 0;
  let bit = 0;
  let width = 9;
  let next = 258;
  let old = -1;
  const totalBits = input.length * 8;
  const read = (): number => {
    if (bit + width > totalBits) return 257;
    let code = 0;
    for (let i = 0; i < width; i++) {
      const b = bit + i;
      code = (code << 1) | ((input[b >> 3] >> (7 - (b & 7))) & 1);
    }
    bit += width;
    return code;
  };
  const emit = (code: number) => {
    const n = length[code];
    if (pos + n > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, pos + n));
      grown.set(out);
      out = grown;
    }
    let c = code;
    for (let i = n - 1; i >= 0; i--) {
      out[pos + i] = suffix[c];
      c = prefix[c];
    }
    pos += n;
  };
  const add = (from: number, ch: number) => {
    if (next >= 4096) return;
    prefix[next] = from;
    suffix[next] = ch;
    length[next] = length[from] + 1;
    first[next] = first[from];
    next++;
    if (next === (1 << width) - 1 && width < 12) width++;
  };
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      old = -1;
      continue;
    }
    if (old === -1) {
      if (code > 255) throw new Error("its LZW data is damaged");
      emit(code);
    } else if (code < next) {
      emit(code);
      add(old, first[code]);
    } else if (code === next) {
      add(old, first[old]);
      emit(code);
    } else throw new Error("its LZW data is damaged");
    old = code;
  }
  return out.subarray(0, pos);
}

export function packBitsDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let pos = 0;
  let i = 0;
  while (i < input.length && pos < expected) {
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && pos < expected; k++) out[pos++] = input[i++];
    } else if (n !== -128) {
      const v = input[i++];
      for (let k = 0; k < 1 - n && pos < expected; k++) out[pos++] = v;
    }
  }
  return out;
}

/** The first image's pixels. Throws an Error that says what's wrong. */
export async function decodeTiff(bytes: Uint8Array): Promise<RgbImage> {
  if (!isTiff(bytes)) throw new Error("it isn't a TIFF file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) throw new Error("the file is cut short");
  const count = u16(ifd);
  const tags = new Map<number, number[]>();
  for (let e = 0; e < count; e++) {
    const at = ifd + 2 + 12 * e;
    if (at + 12 > bytes.length) throw new Error("the file is cut short");
    const tag = u16(at);
    const type = u16(at + 2);
    const n = u32(at + 4);
    const size = TYPE_SIZE[type] ?? 0;
    if (type !== 3 && type !== 4) continue;
    const base = size * n <= 4 ? at + 8 : u32(at + 8);
    if (base + size * n > bytes.length) throw new Error("the file is cut short");
    const values: number[] = [];
    for (let k = 0; k < n; k++) values.push(type === 3 ? u16(base + 2 * k) : u32(base + 4 * k));
    tags.set(tag, values);
  }
  const one = (tag: number, fallback?: number): number => {
    const v = tags.get(tag)?.[0] ?? fallback;
    if (v === undefined) throw new Error(`it lacks a required field (tag ${tag})`);
    return v;
  };
  const width = one(TAG.width);
  const height = one(TAG.height);
  const samples = one(TAG.samples, 1);
  const bitsAll = tags.get(TAG.bits) ?? [1];
  const bits = bitsAll[0];
  const compression = one(TAG.compression, 1);
  const predictor = one(TAG.predictor, 1);
  const format = one(TAG.sampleFormat, 1);
  if (tags.has(TAG.tileWidth)) throw new Error("tiled TIFFs aren't supported; save it in strips");
  if (one(TAG.planar, 1) !== 1) throw new Error("TIFFs with separate colour planes aren't supported");
  if (one(TAG.photometric, 2) !== 2 || samples < 3) throw new Error("it isn't an RGB image");
  if (bitsAll.some((b) => b !== bits)) throw new Error("its channels have different bit depths");
  const kind = format === 3 && bits === 32 ? "float" : format === 1 && (bits === 8 || bits === 16) ? "uint" : null;
  if (!kind) throw new Error(`${bits}-bit ${format === 3 ? "floating-point" : "integer"} samples aren't supported`);
  if (predictor !== 1 && !(predictor === 2 && kind === "uint")) throw new Error("its predictor isn't supported");

  const offsets = tags.get(TAG.stripOffsets);
  const counts = tags.get(TAG.stripBytes);
  if (!offsets || !counts || offsets.length !== counts.length) throw new Error("its strips are missing");
  const rowsPerStrip = Math.min(one(TAG.rowsPerStrip, height), height);
  const bytesPerSample = bits / 8;
  const rowBytes = width * samples * bytesPerSample;
  const raw = new Uint8Array(rowBytes * height);
  for (let s = 0; s < offsets.length; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    if (rows <= 0) break;
    const want = rows * rowBytes;
    if (offsets[s] + counts[s] > bytes.length) throw new Error("a strip runs past the end of the file");
    const src = bytes.subarray(offsets[s], offsets[s] + counts[s]);
    let strip: Uint8Array;
    if (compression === 1) strip = src;
    else if (compression === 5) strip = lzwDecode(src, want);
    else if (compression === 8 || compression === 32946) {
      try {
        strip = await inflate(src);
      } catch {
        throw new Error("its Deflate data is damaged");
      }
    } else if (compression === 32773) strip = packBitsDecode(src, want);
    else throw new Error(`its compression (${compression}) isn't supported`);
    if (strip.length < want) throw new Error("a strip is cut short");
    raw.set(strip.subarray(0, want), s * rowsPerStrip * rowBytes);
  }

  const pixels = width * height;
  const rv = new DataView(raw.buffer);
  if (kind === "float") {
    const data = new Float32Array(pixels * 3);
    for (let p = 0; p < pixels; p++)
      for (let ch = 0; ch < 3; ch++) data[3 * p + ch] = rv.getFloat32((p * samples + ch) * 4, little);
    return { width, height, data, scale: 1 };
  }
  const all = bits === 16 ? new Uint16Array(pixels * samples) : raw;
  if (bits === 16) for (let i = 0; i < all.length; i++) all[i] = rv.getUint16(2 * i, little);
  if (predictor === 2) {
    const mask = bits === 16 ? 0xffff : 0xff;
    for (let y = 0; y < height; y++)
      for (let x = 1; x < width; x++)
        for (let ch = 0; ch < samples; ch++) {
          const i = (y * width + x) * samples + ch;
          all[i] = (all[i] + all[i - samples]) & mask;
        }
  }
  const data = bits === 16 ? new Uint16Array(pixels * 3) : new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p++) for (let ch = 0; ch < 3; ch++) data[3 * p + ch] = all[p * samples + ch];
  return { width, height, data, scale: bits === 16 ? 65535 : 255 };
}
