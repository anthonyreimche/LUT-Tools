// PNG, read and written here rather than by the browser: its decode drops
// 16-bit samples to 8 and may colour-manage them, and a HaldCLUT's pixels
// are data that must arrive exactly as written.

import { crc32, deflate, inflate } from "./zlib";

/** Three channels a pixel, rows from the top; a sample is data[i] / scale. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array | Float32Array;
  scale: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const u32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the per-row filters in place; returns the rows without filter bytes. */
function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      switch (filter) {
        case 0:
          out[row + x] = v;
          break;
        case 1:
          out[row + x] = v + a;
          break;
        case 2:
          out[row + x] = v + b;
          break;
        case 3:
          out[row + x] = v + ((a + b) >> 1);
          break;
        case 4:
          out[row + x] = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`row ${y + 1} has an unknown filter (${filter})`);
      }
    }
  }
  return out;
}

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((v, i) => bytes[i] === v);
}

/** A colour PNG's pixels. Throws an Error that says what's wrong. */
export async function decodePng(bytes: Uint8Array): Promise<RgbImage> {
  if (!isPng(bytes)) throw new Error("it isn't a PNG file");
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at + 12 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const start = at + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error(`the ${type} chunk is cut short`);
    if (crc32(bytes, at + 4, end) !== u32(bytes, end)) throw new Error(`the ${type} chunk is damaged (checksum)`);
    const body = bytes.subarray(start, end);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      depth = body[8];
      colourType = body[9];
      if (body[10] !== 0 || body[11] !== 0) throw new Error("it uses an unknown compression or filter method");
      if (body[12] !== 0) throw new Error("interlaced PNGs aren't supported; save it without interlacing");
    } else if (type === "PLTE") palette = body.slice();
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      ended = true;
      break;
    } else if (type.charCodeAt(0) < 97) throw new Error(`it has a chunk this reader doesn't know (${type})`);
    at = end + 4;
  }
  if (!ended) throw new Error("the file is cut short");
  if (width === 0 || height === 0) throw new Error("it has no image header");
  const channels = CHANNELS[colourType];
  if (channels === undefined) throw new Error(`it has an unknown colour type (${colourType})`);
  if (colourType === 0 || colourType === 4) throw new Error("it is greyscale: a HaldCLUT needs colour");
  if (colourType === 3 ? depth !== 8 : depth !== 8 && depth !== 16) {
    throw new Error(`${depth}-bit samples of this colour type aren't supported`);
  }
  if (colourType === 3 && !palette) throw new Error("its palette is missing");

  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(joined);
  } catch {
    throw new Error("its image data is damaged");
  }
  const bytesPerSample = depth / 8;
  const bpp = channels * bytesPerSample;
  const rowBytes = width * bpp;
  if (raw.length < height * (rowBytes + 1)) throw new Error("its image data is cut short");
  const rows = unfilter(raw, height, rowBytes, bpp);

  const count = width * height;
  if (depth === 16) {
    const data = new Uint16Array(count * 3);
    for (let p = 0; p < count; p++) {
      const s = p * bpp;
      for (let ch = 0; ch < 3; ch++) data[3 * p + ch] = (rows[s + 2 * ch] << 8) | rows[s + 2 * ch + 1];
    }
    return { width, height, data, scale: 65535 };
  }
  const data = new Uint8Array(count * 3);
  for (let p = 0; p < count; p++) {
    if (palette) {
      const i = rows[p] * 3;
      if (i + 3 > palette.length) throw new Error("a pixel names a colour the palette doesn't have");
      data.set(palette.subarray(i, i + 3), 3 * p);
    } else {
      const s = p * bpp;
      data[3 * p] = rows[s];
      data[3 * p + 1] = rows[s + 1];
      data[3 * p + 2] = rows[s + 2];
    }
  }
  return { width, height, data, scale: 255 };
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

/** A 16-bit RGB PNG of `rgb` (three samples a pixel, rows from the top). */
export async function encodePng16(width: number, height: number, rgb: Uint16Array): Promise<Uint8Array> {
  const rowBytes = width * 6;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1);
    for (let i = 0; i < width * 3; i++) {
      const v = rgb[y * width * 3 + i];
      raw[row + 1 + 2 * i] = v >> 8;
      raw[row + 2 + 2 * i] = v & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 16;
  header[9] = 2;
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
