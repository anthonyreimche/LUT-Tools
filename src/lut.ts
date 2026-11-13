// A look-up table as the parsers hand it over and the writers take it: a 1D
// table, a 3D table, or a 1D shaper followed by a 3D table, each over its own
// input domain. Values are the file's own numbers, in double precision.
//
// The reference evaluation here is what the GPU stage is checked against:
// the input is clamped to the domain, a 1D table interpolates linearly per
// channel, a 3D table tetrahedrally. Tetrahedral interpolation reproduces any
// function that is linear over a cell exactly, so an identity table is exact
// at every size and grey stays grey.

export type Vec3 = [number, number, number];

/** A table over [lo, hi] per channel, `size` nodes an axis. 1D: node i of
 *  channel c at data[3i + c]. 3D: node (r, g, b) at data[3(r + N(g + N·b)) + c],
 *  red changing fastest. */
export interface Table {
  size: number;
  lo: Vec3;
  hi: Vec3;
  data: Float64Array;
}

export interface Lut {
  title: string;
  /** A 1D table, alone or as the shaper in front of `cube`. */
  shaper: Table | null;
  cube: Table | null;
}

/** The largest 3D table kept: bigger ones are resampled to it on import. */
export const MAX_CUBE_SIZE = 65;
/** The most nodes a 1D table may have (the .cube limit). */
export const MAX_SHAPER_SIZE = 65536;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** A 1D table at `e`, already inside its domain, channel by channel. */
export function evalShaper(t: Table, e: Vec3): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const x = ((e[ch] - t.lo[ch]) / (t.hi[ch] - t.lo[ch])) * (t.size - 1);
    const i = Math.max(0, Math.min(Math.floor(x), t.size - 2));
    const f = x - i;
    out[ch] = t.data[3 * i + ch] * (1 - f) + t.data[3 * (i + 1) + ch] * f;
  }
  return out;
}

/** The axes in descending order of `f`, ties to the lower axis: the
 *  tetrahedron of the cube cell that holds the point. */
export function tetraOrder(f: Vec3): [number, number, number] {
  const [r, g, b] = f;
  if (r >= g) {
    if (g >= b) return [0, 1, 2];
    if (r >= b) return [0, 2, 1];
    return [2, 0, 1];
  }
  if (b >= g) return [2, 1, 0];
  if (b >= r) return [1, 2, 0];
  return [1, 0, 2];
}

export interface CubeSample {
  value: Vec3;
  /** d value / d position, the position in [0, 1] across the lattice,
   *  column-major (jac[3 * axis + channel]). Constant over a tetrahedron. */
  jac: number[];
}

/** A lattice of `size`³ nodes over [0, 1]³ at `t`: tetrahedral inside, and
 *  outside continued along the boundary tetrahedron's plane. The nodes are
 *  `data` divided by `scale` (an image's 255 or 65535). */
export function sampleLattice(data: ArrayLike<number>, size: number, t: Vec3, scale = 1): CubeSample {
  const n1 = size - 1;
  const idx: Vec3 = [0, 0, 0];
  const f: Vec3 = [0, 0, 0];
  const tc: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    tc[a] = clamp(t[a], 0, 1);
    const p = tc[a] * n1;
    idx[a] = Math.min(Math.floor(p), size - 2);
    f[a] = p - idx[a];
  }
  const order = tetraOrder(f);
  const corner: Vec3 = [idx[0], idx[1], idx[2]];
  const node = (c: Vec3): number => 3 * (c[0] + size * (c[1] + size * c[2]));
  let at = node(corner);
  const value: Vec3 = [data[at], data[at + 1], data[at + 2]];
  const jac = new Array<number>(9).fill(0);
  for (const axis of order) {
    corner[axis] += 1;
    const next = node(corner);
    for (let ch = 0; ch < 3; ch++) {
      const step = data[next + ch] - data[at + ch];
      value[ch] += f[axis] * step;
      jac[3 * axis + ch] = step * n1;
    }
    at = next;
  }
  for (let a = 0; a < 3; a++) {
    const beyond = t[a] - tc[a];
    if (beyond !== 0) for (let ch = 0; ch < 3; ch++) value[ch] += jac[3 * a + ch] * beyond;
  }
  if (scale !== 1) {
    for (let ch = 0; ch < 3; ch++) value[ch] /= scale;
    for (let i = 0; i < 9; i++) jac[i] /= scale;
  }
  return { value, jac };
}

/** A 3D table at `s`, already inside its domain. */
export function evalCube(t: Table, s: Vec3): Vec3 {
  const u: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) u[a] = (s[a] - t.lo[a]) / (t.hi[a] - t.lo[a]);
  return sampleLattice(t.data, t.size, u).value;
}

/** The table at encoded input `e`: `clamped` is `e` held to the input
 *  domain, the point the table was read at. */
export function evalLut(lut: Lut, e: Vec3): { value: Vec3; clamped: Vec3 } {
  const first = lut.shaper ?? lut.cube;
  if (!first) throw new Error("a LUT without a table");
  const clamped: Vec3 = [0, 1, 2].map((a) => clamp(e[a], first.lo[a], first.hi[a])) as Vec3;
  let value = clamped;
  if (lut.shaper) value = evalShaper(lut.shaper, value);
  if (lut.cube) {
    const cube = lut.cube;
    value = evalCube(cube, [0, 1, 2].map((a) => clamp(value[a], cube.lo[a], cube.hi[a])) as Vec3);
  }
  return { value, clamped };
}

/** An identity 3D table of `size` nodes over [lo, hi]. */
export function identityCube(size: number, lo: Vec3 = [0, 0, 0], hi: Vec3 = [1, 1, 1]): Table {
  return cubeFrom(size, (r, g, b) => [r, g, b], lo, hi);
}

/** A 3D table whose node at domain point (r, g, b) is fn(r, g, b). */
export function cubeFrom(
  size: number,
  fn: (r: number, g: number, b: number) => Vec3,
  lo: Vec3 = [0, 0, 0],
  hi: Vec3 = [1, 1, 1],
): Table {
  const data = new Float64Array(size * size * size * 3);
  const at = (a: number, i: number) => lo[a] + ((hi[a] - lo[a]) * i) / (size - 1);
  let k = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const v = fn(at(0, r), at(1, g), at(2, b));
        data[k++] = v[0];
        data[k++] = v[1];
        data[k++] = v[2];
      }
  return { size, lo: [...lo], hi: [...hi], data };
}

/** `t` read at `size` nodes an axis over the same domain. */
export function resampleCube(t: Table, size: number): Table {
  if (t.size === size) return t;
  return cubeFrom(size, (r, g, b) => evalCube(t, [r, g, b]), t.lo, t.hi);
}

/** Whether every node of `t` is within `tolerance` of its own position. */
export function isIdentityCube(t: Table, tolerance: number): boolean {
  const id = identityCube(t.size, t.lo, t.hi);
  return t.data.every((v, i) => Math.abs(v - id.data[i]) <= tolerance);
}
