// Hand-built image files for the decoders: PNGs with every row filter, and
// TIFFs in each byte order and compression the reader takes.

import { crc32, deflate } from "../../src/zlib";

/** An identity HaldCLUT's samples at `level`, scaled to `max`. */
export function identityHald(level: number, max: number): number[] {
  const n = level * level;
  const out: number[] = [];
  for (let k = 0; k < n ** 3; k++) {
    const r = k % n;
    const g = Math.floor(k / n) % n;
    const b = Math.floor(k / (n * n));
    out.push(Math.round((r / (n - 1)) * max), Math.round((g / (n - 1)) * max), Math.round((b / (n - 1)) * max));
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface PngOptions {
  colourType?: number;
  depth?: number;
  interlace?: number;
  /** Bytes of each pixel, in the colour type's layout. */
  palette?: number[];
}

/** A PNG of `samples` (in the colour type's channel layout), each row with
 *  the next of the five filters. */
export async function makePng(width: number, height: number, samples: number[], opts: PngOptions = {}): Promise<Uint8Array> {
  const colourType = opts.colourType ?? 2;
  const depth = opts.depth ?? 8;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType] ?? 3;
  const bps = depth / 8;
  const bpp = channels * bps;
  const rowBytes = width * bpp;
  const plain = new Uint8Array(height * rowBytes);
  samples.forEach((v, i) => {
    if (bps === 2) {
      plain[2 * i] = v >> 8;
      plain[2 * i + 1] = v & 0xff;
    } else plain[i] = v;
  });
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const v = plain[y * rowBytes + x];
      const a = x >= bpp ? plain[y * rowBytes + x - bpp] : 0;
      const b = y > 0 ? plain[(y - 1) * rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? plain[(y - 1) * rowBytes + x - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      raw[y * (rowBytes + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = depth;
  header[9] = colourType;
  header[12] = opts.interlace ?? 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (opts.palette) parts.push(chunk("PLTE", Uint8Array.from(opts.palette)));
  const z = await deflate(raw);
  parts.push(chunk("IDAT", z.subarray(0, z.length >> 1)), chunk("IDAT", z.subarray(z.length >> 1)), chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

/** TIFF's LZW, for the reader's tests: 9 to 12-bit codes, early change. */
export function lzwEncode(input: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  let width = 9;
  const put = (code: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) {
      bytes.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258;
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    next = 258;
    width = 9;
  };
  put(256);
  reset();
  let w = "";
  for (const byte of input) {
    const ch = String.fromCharCode(byte);
    if (dict.has(w + ch)) {
      w += ch;
      continue;
    }
    put(dict.get(w) as number);
    dict.set(w + ch, next++);
    // The encoder runs one entry ahead of the decoder, which widens its codes
    // as its own table reaches 2^width − 1 entries.
    if (next === 1 << width && width < 12) width++;
    if (next >= 4093) {
      put(256);
      reset();
    }
    w = ch;
  }
  if (w) put(dict.get(w) as number);
  put(257);
  if (bits > 0) bytes.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(bytes);
}

export function packBitsEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    let run = 1;
    while (i + run < input.length && run < 128 && input[i + run] === input[i]) run++;
    if (run > 1) {
      out.push((1 - run) & 0xff, input[i]);
      i += run;
    } else {
      const start = i;
      while (i < input.length && i - start < 128 && !(i + 1 < input.length && input[i + 1] === input[i])) i++;
      if (i === start) i++;
      out.push(i - start - 1, ...input.subarray(start, i));
    }
  }
  return Uint8Array.from(out);
}

export interface TiffOptions {
  little?: boolean;
  bits?: 8 | 16 | 32;
  float?: boolean;
  samples?: number;
  compression?: 1 | 5 | 8 | 32773;
  predictor?: 1 | 2;
  rowsPerStrip?: number;
  tiled?: boolean;
  planar?: number;
}

/** A one-image TIFF of `samples` (interleaved, `samples` channels). */
export async function makeTiff(width: number, height: number, values: number[], opts: TiffOptions = {}): Promise<Uint8Array> {
  const little = opts.little ?? true;
  const bits = opts.bits ?? 8;
  const spp = opts.samples ?? 3;
  const compression = opts.compression ?? 1;
  const rowsPerStrip = opts.rowsPerStrip ?? height;
  const bps = bits / 8;
  const rowValues = width * spp;
  const plainRow = (y: number): Uint8Array => {
    const row = values.slice(y * rowValues, (y + 1) * rowValues);
    if (opts.predictor === 2) {
      const mask = bits === 16 ? 0xffff : 0xff;
      for (let x = width - 1; x >= 1; x--) for (let ch = 0; ch < spp; ch++) row[x * spp + ch] = (row[x * spp + ch] - row[(x - 1) * spp + ch]) & mask;
    }
    const out = new Uint8Array(rowValues * bps);
    const v = new DataView(out.buffer);
    row.forEach((s, i) => {
      if (bits === 8) out[i] = s;
      else if (bits === 16) v.setUint16(2 * i, s, little);
      else v.setFloat32(4 * i, s, little);
    });
    return out;
  };
  const strips: Uint8Array[] = [];
  for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
    const rows: Uint8Array[] = [];
    for (let y = y0; y < Math.min(height, y0 + rowsPerStrip); y++) rows.push(plainRow(y));
    const plain = concat(rows);
    strips.push(
      compression === 1 ? plain : compression === 5 ? lzwEncode(plain) : compression === 8 ? await deflate(plain) : packBitsEncode(plain),
    );
  }
  const entries: [number, number, number[]][] = [
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, Array(spp).fill(bits)],
    [259, 3, [compression]],
    [262, 3, [2]],
    [273, 4, strips.map(() => 0)],
    [277, 3, [spp]],
    [278, 4, [rowsPerStrip]],
    [279, 4, strips.map((s) => s.length)],
    [284, 3, [opts.planar ?? 1]],
    [317, 3, [opts.predictor ?? 1]],
    [339, 3, Array(spp).fill(opts.float ? 3 : 1)],
  ];
  if (opts.tiled) entries.push([322, 3, [16]]);
  entries.sort((a, b) => a[0] - b[0]);
  const ifdSize = 2 + 12 * entries.length + 4;
  const extra: Uint8Array[] = [];
  let extraAt = 8 + ifdSize;
  const extraOffsets = new Map<number, number>();
  for (const [tag, type, vals] of entries) {
    const size = (type === 3 ? 2 : 4) * vals.length;
    if (size > 4) {
      extraOffsets.set(tag, extraAt);
      extra.push(new Uint8Array(size));
      extraAt += size;
    }
  }
  let dataAt = extraAt;
  const stripOffsets = strips.map((s) => {
    const at = dataAt;
    dataAt += s.length;
    return at;
  });
  entries.find((e) => e[0] === 273)![2] = stripOffsets;
  const out = new Uint8Array(dataAt);
  const v = new DataView(out.buffer);
  out.set(little ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]);
  v.setUint32(4, 8, little);
  v.setUint16(8, entries.length, little);
  entries.forEach(([tag, type, vals], i) => {
    const at = 10 + 12 * i;
    v.setUint16(at, tag, little);
    v.setUint16(at + 2, type, little);
    v.setUint32(at + 4, vals.length, little);
    const where = extraOffsets.get(tag) ?? at + 8;
    if (where !== at + 8) v.setUint32(at + 8, where, little);
    vals.forEach((val, k) => (type === 3 ? v.setUint16(where + 2 * k, val, little) : v.setUint32(where + 4 * k, val, little)));
  });
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  return out;
}
