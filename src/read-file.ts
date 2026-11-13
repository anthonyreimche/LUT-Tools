// One file to one LUT: a .cube by its text, a HaldCLUT by its image. Every
// refusal comes back as a sentence for the person who picked the file.

import { parseCube } from "./cube";
import { haldToLut } from "./hald";
import { MAX_CUBE_SIZE, resampleCube, type Lut, type Table } from "./lut";
import { decodePng, isPng, type RgbImage } from "./png";
import { decodeTiff, isTiff } from "./tiff";

export type ReadResult =
  | { ok: true; lut: Lut; format: "cube" | "hald"; hash: string; notes: string[] }
  | { ok: false; error: string };

/** Decodes a JPEG's 8-bit samples without colour management. */
export type JpegDecoder = (bytes: Uint8Array) => Promise<RgbImage>;

export const LUT_FILE_EXTENSIONS = [".cube", ".png", ".tif", ".tiff", ".jpg", ".jpeg"] as const;

export function hasLutExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return LUT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function baseName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function finite(t: Table | null): boolean {
  return t === null || t.data.every(Number.isFinite);
}

export async function readLutFile(fileName: string, bytes: Uint8Array, decodeJpeg: JpegDecoder): Promise<ReadResult> {
  const title = baseName(fileName);
  const notes: string[] = [];
  let lut: Lut;
  let format: "cube" | "hald";
  if (fileName.toLowerCase().endsWith(".cube")) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: "The file isn't text, so it can't be a .cube LUT" };
    }
    const parsed = parseCube(text, title);
    if (!parsed.ok) return parsed;
    lut = parsed.lut;
    format = "cube";
    if (parsed.axisOrder === "blue-fastest") notes.push("Its entries run blue fastest; read in that order.");
  } else {
    let image: RgbImage;
    try {
      if (isPng(bytes)) image = await decodePng(bytes);
      else if (isTiff(bytes)) image = await decodeTiff(bytes);
      else if (isJpeg(bytes)) image = await decodeJpeg(bytes);
      else return { ok: false, error: "The file isn't a .cube LUT or a PNG, TIFF or JPEG HaldCLUT" };
    } catch (err) {
      return { ok: false, error: `The image can't be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    const hald = haldToLut(image, title);
    if (!hald.ok) return hald;
    lut = hald.lut;
    format = "hald";
    if (hald.level * hald.level > MAX_CUBE_SIZE) notes.push(`Level ${hald.level} is resampled to ${MAX_CUBE_SIZE} nodes an axis.`);
  }
  if (!finite(lut.shaper) || !finite(lut.cube)) return { ok: false, error: "The table holds values that aren't numbers" };
  if (lut.cube && lut.cube.size > MAX_CUBE_SIZE) {
    notes.push(`Its ${lut.cube.size}-node table is resampled to ${MAX_CUBE_SIZE} nodes an axis.`);
    lut = { ...lut, cube: resampleCube(lut.cube, MAX_CUBE_SIZE) };
  }
  return { ok: true, lut, format, hash: await sha256Hex(bytes), notes };
}

/** A JPEG's samples through the browser's decoder, colour management off. */
export const browserJpegDecoder: JpegDecoder = async (bytes) => {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas to decode it on");
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const data = new Uint8Array(bitmap.width * bitmap.height * 3);
  for (let p = 0; p < data.length / 3; p++) {
    data[3 * p] = rgba[4 * p];
    data[3 * p + 1] = rgba[4 * p + 1];
    data[3 * p + 2] = rgba[4 * p + 2];
  }
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data, scale: 255 };
};
