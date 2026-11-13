// HaldCLUT images: a 3D table stored as the pixels of a square image. At
// level L the table has L² nodes an axis and the image is L³ pixels a side;
// pixel k (rows from the top, left to right) is node k, red changing fastest,
// then green, then blue. The identity image of a level is the table that
// changes nothing; a look applied to it gives the look's table.

import { MAX_CUBE_SIZE, cubeFrom, sampleLattice, type Lut, type Table } from "./lut";
import type { RgbImage } from "./png";

export const MIN_HALD_LEVEL = 2;
export const MAX_HALD_LEVEL = 16;

/** The level of a HaldCLUT image `width` × `height` pixels, or null. */
export function haldLevel(width: number, height: number): number | null {
  if (width !== height) return null;
  for (let level = MIN_HALD_LEVEL; level <= MAX_HALD_LEVEL; level++) if (level ** 3 === width) return level;
  return null;
}

/** How closely some channel of a look must follow some axis of the grid
 *  (or its inverse) for the image to be taken for a HaldCLUT rather than a
 *  picture of the same size. Channel swaps, negatives and black-and-white
 *  looks follow an axis closely; noise follows none. */
const MIN_GRID_CORRELATION = 0.3;

/** The largest |correlation| between an output channel and a grid axis. */
function gridCorrelation(image: RgbImage, size: number): number {
  const n = image.width * image.height;
  const axis = (k: number, a: number): number => Math.floor(k / size ** a) % size;
  let best = 0;
  for (let a = 0; a < 3; a++) {
    for (let ch = 0; ch < 3; ch++) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let k = 0; k < n; k++) {
        const x = axis(k, a);
        const y = image.data[3 * k + ch];
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
      const vx = sxx - (sx * sx) / n;
      const vy = syy - (sy * sy) / n;
      if (vx > 0 && vy > 0) best = Math.max(best, Math.abs((sxy - (sx * sy) / n) / Math.sqrt(vx * vy)));
    }
  }
  return best;
}

/** The image's table, resampled to MAX_CUBE_SIZE when it has more nodes. */
export function haldToLut(image: RgbImage, title: string): { ok: true; lut: Lut; level: number } | { ok: false; error: string } {
  const level = haldLevel(image.width, image.height);
  if (level === null) {
    return {
      ok: false,
      error: `A ${image.width} × ${image.height} image isn't a HaldCLUT: it must be square, ${MIN_HALD_LEVEL ** 3} to ${MAX_HALD_LEVEL ** 3} pixels a side, a whole number cubed`,
    };
  }
  const size = level * level;
  for (let i = 0; i < image.data.length; i++) {
    if (!Number.isFinite(image.data[i])) return { ok: false, error: "The image has pixels that aren't numbers" };
  }
  if (gridCorrelation(image, size) < MIN_GRID_CORRELATION) {
    return { ok: false, error: "The image is the size of a HaldCLUT, but its pixels don't follow a HaldCLUT's colour grid" };
  }
  let cube: Table;
  if (size <= MAX_CUBE_SIZE) {
    const data = new Float64Array(image.data.length);
    for (let i = 0; i < data.length; i++) data[i] = image.data[i] / image.scale;
    cube = { size, lo: [0, 0, 0], hi: [1, 1, 1], data };
  } else {
    cube = cubeFrom(MAX_CUBE_SIZE, (r, g, b) => sampleLattice(image.data, size, [r, g, b], image.scale).value);
  }
  return { ok: true, lut: { title, shaper: null, cube }, level };
}

/** The table, which must have level² nodes an axis over [0, 1], as a HaldCLUT
 *  image's 16-bit samples, clipped to [0, 1]. */
export function haldPixels(cube: Table, level: number): Uint16Array {
  if (cube.size !== level * level) throw new Error(`a level ${level} HaldCLUT needs ${level * level} nodes an axis`);
  const out = new Uint16Array(cube.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(Math.max(cube.data[i], 0), 1) * 65535);
  return out;
}
