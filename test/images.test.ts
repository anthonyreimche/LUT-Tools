// HaldCLUT images: the PNG and TIFF readers on hand-built files, the Hald
// layout, and readLutFile's choice of reader and its refusals.

import { describe, expect, it } from "vitest";
import { haldLevel, haldPixels, haldToLut } from "../src/hald";
import { cubeFrom, evalCube, identityCube, isIdentityCube, type Vec3 } from "../src/lut";
import { decodePng, encodePng16, type RgbImage } from "../src/png";
import { readLutFile, type JpegDecoder } from "../src/read-file";
import { decodeTiff, lzwDecode } from "../src/tiff";
import { identityHald, lzwEncode, makePng, makeTiff } from "./support/files";

const noJpeg: JpegDecoder = () => Promise.reject(new Error("no JPEG decoder in this test"));

const rgbOf = (img: RgbImage): number[] => Array.from(img.data);

describe("decodePng", () => {
  it("reads 8-bit RGB through every row filter", async () => {
    const samples = identityHald(2, 255);
    const img = await decodePng(await makePng(8, 8, samples));
    expect(img).toMatchObject({ width: 8, height: 8, scale: 255 });
    expect(rgbOf(img)).toEqual(samples);
  });

  it("reads 16-bit RGB", async () => {
    const samples = identityHald(2, 65535);
    const img = await decodePng(await makePng(8, 8, samples, { depth: 16 }));
    expect(img.scale).toBe(65535);
    expect(rgbOf(img)).toEqual(samples);
  });

  it("drops the alpha of RGBA", async () => {
    const rgb = identityHald(2, 255);
    const rgba: number[] = [];
    for (let p = 0; p < 64; p++) rgba.push(rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2], 200);
    expect(rgbOf(await decodePng(await makePng(8, 8, rgba, { colourType: 6 })))).toEqual(rgb);
  });

  it("reads a palette image", async () => {
    const palette = [10, 20, 30, 40, 50, 60];
    const img = await decodePng(await makePng(2, 1, [1, 0], { colourType: 3, palette }));
    expect(rgbOf(img)).toEqual([40, 50, 60, 10, 20, 30]);
  });

  it("writes 16-bit RGB that it reads back exactly", async () => {
    const samples = Uint16Array.from(identityHald(2, 65535));
    const img = await decodePng(await encodePng16(8, 8, samples));
    expect(rgbOf(img)).toEqual(Array.from(samples));
  });

  it.each([
    ["not a PNG", async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), /isn't a PNG/],
    ["greyscale", async () => makePng(2, 1, [0, 255], { colourType: 0 }), /greyscale/],
    ["interlaced", async () => makePng(8, 8, identityHald(2, 255), { interlace: 1 }), /interlaced/],
    [
      "a damaged chunk",
      async () => {
        const bytes = await makePng(8, 8, identityHald(2, 255));
        bytes[40] ^= 0xff;
        return bytes;
      },
      /damaged/,
    ],
    ["cut short", async () => (await makePng(8, 8, identityHald(2, 255))).subarray(0, 60), /cut short/],
  ])("refuses %s", async (_name, make, message) => {
    await expect(decodePng(await make())).rejects.toThrow(message);
  });
});

describe("decodeTiff", () => {
  const rgb8 = identityHald(2, 255);
  const rgb16 = identityHald(2, 65535);

  it.each([
    ["uncompressed, little-endian", { little: true }],
    ["uncompressed, big-endian", { little: false }],
    ["LZW", { compression: 5 as const }],
    ["Deflate", { compression: 8 as const }],
    ["PackBits", { compression: 32773 as const }],
    ["LZW with horizontal differencing", { compression: 5 as const, predictor: 2 as const }],
    ["several strips", { rowsPerStrip: 3 }],
  ])("reads 8-bit RGB, %s", async (_name, opts) => {
    expect(rgbOf(await decodeTiff(await makeTiff(8, 8, rgb8, opts)))).toEqual(rgb8);
  });

  it.each([
    ["little-endian", { little: true }],
    ["big-endian", { little: false }],
    ["Deflate with differencing", { compression: 8 as const, predictor: 2 as const }],
  ])("reads 16-bit RGB, %s", async (_name, opts) => {
    const img = await decodeTiff(await makeTiff(8, 8, rgb16, { bits: 16, ...opts }));
    expect(img.scale).toBe(65535);
    expect(rgbOf(img)).toEqual(rgb16);
  });

  it("reads 32-bit float RGB", async () => {
    const values = identityHald(2, 1000).map((v) => v / 1000);
    const img = await decodeTiff(await makeTiff(8, 8, values, { bits: 32, float: true, compression: 5 }));
    expect(img.scale).toBe(1);
    rgbOf(img).forEach((v, i) => expect(v).toBeCloseTo(values[i], 6));
  });

  it("drops a fourth channel", async () => {
    const rgba: number[] = [];
    for (let p = 0; p < 64; p++) rgba.push(rgb8[3 * p], rgb8[3 * p + 1], rgb8[3 * p + 2], 9);
    expect(rgbOf(await decodeTiff(await makeTiff(8, 8, rgba, { samples: 4 })))).toEqual(rgb8);
  });

  it("decodes LZW past the code-width steps", () => {
    const input = Uint8Array.from({ length: 20000 }, (_, i) => (i * 7 + (i >> 5)) & 0xff);
    expect(Array.from(lzwDecode(lzwEncode(input), input.length))).toEqual(Array.from(input));
  });

  it.each([
    ["tiles", { tiled: true }, /tiled/],
    ["separate planes", { planar: 2 }, /separate colour planes/],
  ])("refuses %s", async (_name, opts, message) => {
    await expect(decodeTiff(await makeTiff(8, 8, rgb8, opts))).rejects.toThrow(message);
  });

  it("refuses a file that isn't a TIFF", async () => {
    await expect(decodeTiff(new Uint8Array(16))).rejects.toThrow(/isn't a TIFF/);
  });
});

describe("HaldCLUT layout", () => {
  it("knows the levels from 2 to 16 by their sizes", () => {
    expect(haldLevel(8, 8)).toBe(2);
    expect(haldLevel(512, 512)).toBe(8);
    expect(haldLevel(4096, 4096)).toBe(16);
    expect(haldLevel(512, 511)).toBeNull();
    expect(haldLevel(100, 100)).toBeNull();
    expect(haldLevel(1, 1)).toBeNull();
  });

  it.each([2, 3, 4, 8])("reads the level %i identity image as an identity table", (level) => {
    const side = level ** 3;
    const img: RgbImage = { width: side, height: side, data: Uint16Array.from(identityHald(level, 65535)), scale: 65535 };
    const hald = haldToLut(img, "id");
    if (!hald.ok) throw new Error(hald.error);
    expect(hald.lut.cube?.size).toBe(level * level);
    expect(isIdentityCube(hald.lut.cube!, 1 / 65535)).toBe(true);
  });

  it("resamples a level 9 image to 65 nodes, keeping its look", () => {
    const look = (r: number, g: number, b: number): Vec3 => [r * r, 0.5 * g + 0.25, 1 - b];
    const table = cubeFrom(81, look);
    const img: RgbImage = { width: 729, height: 729, data: Float32Array.from(table.data), scale: 1 };
    const hald = haldToLut(img, "big");
    if (!hald.ok) throw new Error(hald.error);
    expect(hald.lut.cube?.size).toBe(65);
    for (const c of [[0.3, 0.6, 0.9], [0.01, 0.99, 0.5]] as Vec3[]) {
      const got = evalCube(hald.lut.cube!, c);
      const want = look(...c);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 3));
    }
  });

  it("takes looks that follow the grid, a negative and black and white included, and refuses noise of a HaldCLUT's size", () => {
    const id = identityHald(2, 255);
    const of = (data: number[]): RgbImage => ({ width: 8, height: 8, data: Uint8Array.from(data), scale: 255 });
    const negative = id.map((v) => 255 - v);
    const bw = id.map((_, i) => {
      const p = i - (i % 3);
      return Math.round(0.3 * id[p] + 0.6 * id[p + 1] + 0.1 * id[p + 2]);
    });
    let seed = 7;
    const noise = id.map(() => (seed = (seed * 48271) % 2147483647) % 256);
    expect(haldToLut(of(negative), "n").ok).toBe(true);
    expect(haldToLut(of(bw), "bw").ok).toBe(true);
    const refused = haldToLut(of(noise), "photo");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/don't follow a HaldCLUT's colour grid/);
  });

  it("refuses an image that isn't a HaldCLUT", () => {
    const hald = haldToLut({ width: 10, height: 10, data: new Uint8Array(300), scale: 255 }, "x");
    expect(hald.ok).toBe(false);
    if (!hald.ok) expect(hald.error).toMatch(/isn't a HaldCLUT/);
  });

  it("lays a table out as its image, clipped to [0, 1]", () => {
    const table = cubeFrom(4, (r, g, b) => [r * 1.5, g, b - 0.5]);
    const px = haldPixels(table, 2);
    expect(px.length).toBe(64 * 3);
    expect(px[3 * 63]).toBe(65535);
    expect(px[2]).toBe(0);
    expect(() => haldPixels(identityCube(5), 2)).toThrow(/4 nodes/);
  });
});

describe("readLutFile", () => {
  const cube = new TextEncoder().encode(
    "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
  );

  it("reads a .cube by its extension, names it after the file and hashes the bytes", async () => {
    const r = await readLutFile("Looks/Teal.cube", cube, noJpeg);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("cube");
    expect(r.lut.title).toBe("Teal");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await readLutFile("other.cube", cube, noJpeg);
    expect(again.ok && again.hash).toBe(r.hash);
  });

  it("reads PNG and TIFF HaldCLUTs by their contents", async () => {
    const png = await readLutFile("film.png", await makePng(8, 8, identityHald(2, 255)), noJpeg);
    const tif = await readLutFile("film.tif", await makeTiff(8, 8, identityHald(2, 255)), noJpeg);
    for (const r of [png, tif]) {
      if (!r.ok) throw new Error(r.error);
      expect(r.format).toBe("hald");
      expect(r.lut.cube?.size).toBe(4);
    }
  });

  it("hands a JPEG to the JPEG decoder", async () => {
    const decode: JpegDecoder = async () => ({ width: 8, height: 8, data: Uint8Array.from(identityHald(2, 255)), scale: 255 });
    const r = await readLutFile("film.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), decode);
    expect(r.ok && r.lut.cube?.size).toBe(4);
  });

  it("notes a table it resampled", async () => {
    const big = new TextEncoder().encode(
      ["LUT_3D_SIZE 70", ...Array.from(identityCube(70).data).reduce<string[]>((rows, _v, i, d) => {
        if (i % 3 === 0) rows.push(`${d[i]} ${d[i + 1]} ${d[i + 2]}`);
        return rows;
      }, [])].join("\n"),
    );
    const r = await readLutFile("big.cube", big, noJpeg);
    if (!r.ok) throw new Error(r.error);
    expect(r.lut.cube?.size).toBe(65);
    expect(r.notes.join(" ")).toMatch(/resampled to 65/);
    expect(isIdentityCube(r.lut.cube!, 1e-9)).toBe(true);
  });

  it.each([
    ["binary bytes named .cube", "x.cube", Uint8Array.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), /isn't text/],
    ["a photo that isn't a Hald", "photo.png", null, /isn't a HaldCLUT/],
    ["an unknown format", "x.tif", Uint8Array.from([1, 2, 3, 4]), /isn't a .cube LUT or a PNG/],
    ["a broken image", "x.png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), /can't be read/],
  ])("refuses %s", async (_name, fileName, bytes, message) => {
    const data = bytes ?? (await makePng(10, 10, new Array(300).fill(128)));
    const r = await readLutFile(fileName, data, noJpeg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});
