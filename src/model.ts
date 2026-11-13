// What the look stage does to one pixel, on the CPU. `applyLook` works from
// the parsed LUT in double precision: the reference. `applyLookFromAtlas`
// follows the shader step by step, reading the atlas bytes the GPU reads,
// and finds what the shader finds or nothing.

import { decode, encode, type EncodingId } from "./encoding";
import { clamp, evalLut, tetraOrder, type Lut, type Vec3 } from "./lut";
import { ATLAS_WIDTH, KIND_CUBE, KIND_SHAPER, PROBES, type Atlas, type LutLayout } from "./pack";
import type { LookSettings } from "./params";

const map3 = (v: Vec3, f: (x: number, i: number) => number): Vec3 => [f(v[0], 0), f(v[1], 1), f(v[2], 2)];

/** The pixel `c` (sRGB-encoded, signed) after the stage, given what the
 *  table makes of an encoded input and the input domain's clamp. */
function grade(
  c: Vec3,
  s: LookSettings,
  table: (e: Vec3) => { value: Vec3; clamped: Vec3 },
): Vec3 {
  if (!(s.strength > 0)) return c;
  const light = map3(c, (x) => decode(x, 0));
  const e = s.inEnc === 0 ? c : map3(light, (x) => encode(x, s.inEnc));
  const { value, clamped } = table(e);
  const inside = clamped.every((x, i) => x === e[i]);
  const graded =
    s.outEnc === 0 && inside
      ? value
      : map3(value, (v, i) => encode(decode(v, s.outEnc) + light[i] - decode(clamped[i], s.inEnc as EncodingId), 0));
  return map3(c, (x, i) => x + (graded[i] - x) * s.strength);
}

export function applyLook(c: Vec3, lut: Lut, s: LookSettings): Vec3 {
  return grade(c, s, (e) => evalLut(lut, e));
}

function word(atlas: Atlas, texel: number): number {
  const at = 4 * texel;
  const d = atlas.data;
  return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
}

/** The block of `key` in the atlas when its signature is `sig`, else -1. */
export function findInAtlas(atlas: Atlas, key: number, sig: number): number {
  if (atlas.width !== ATLAS_WIDTH || key <= 0) return -1;
  const slots = word(atlas, 0);
  if (slots < 8) return -1;
  for (let p = 0; p < PROBES; p++) {
    const s = (key + p) & (slots - 1);
    const id = word(atlas, 1 + 3 * s);
    if (id === key) return word(atlas, 3 + 3 * s) === sig ? word(atlas, 2 + 3 * s) : -1;
    if (id === 0) return -1;
  }
  return -1;
}

export interface AtlasLook {
  key: number;
  sig: number;
  layout: LutLayout;
  settings: LookSettings;
}

export function applyLookFromAtlas(c: Vec3, atlas: Atlas, look: AtlasLook): Vec3 {
  const base = findInAtlas(atlas, look.key, look.sig);
  if (base < 0) return c;
  const l = look.layout;
  const d = atlas.data;
  const unit3 = (l.range3[1] - l.range3[0]) / 65535;
  const unit1 = (l.range1[1] - l.range1[0]) / 65535;
  const shaped = (l.kind & KIND_SHAPER) !== 0;
  const node = (b: number, i: Vec3): Vec3 => {
    const t = 4 * (b + 2 * (i[0] + l.n3 * (i[1] + l.n3 * i[2])));
    return [0, 1, 2].map((ch) => l.range3[0] + (d[t + ch] * 256 + d[t + 4 + ch]) * unit3) as Vec3;
  };
  const cube = (b: number, u: Vec3): Vec3 => {
    const p = map3(u, (x) => clamp(x, 0, 1) * (l.n3 - 1));
    const i = map3(p, (x) => Math.min(Math.trunc(x), l.n3 - 2));
    const f = map3(p, (x, a) => x - i[a]);
    const corner: Vec3 = [...i];
    let prev = node(b, corner);
    const out: Vec3 = [...prev];
    for (const axis of tetraOrder(f)) {
      corner[axis] += 1;
      const next = node(b, corner);
      for (let ch = 0; ch < 3; ch++) out[ch] += f[axis] * (next[ch] - prev[ch]);
      prev = next;
    }
    return out;
  };
  const shaper = (ch: number, x: number): number => {
    const m = l.n1;
    const p = clamp(x, 0, 1) * (m - 1);
    const i = Math.min(Math.trunc(p), m - 2);
    const f = p - i;
    const t = 4 * (base + ch * (m - 1) + i);
    const a = d[t] * 256 + d[t + 1];
    const b = d[t + 2] * 256 + d[t + 3];
    return l.range1[0] + (a + (b - a) * f) * unit1;
  };
  return grade(c, look.settings, (e) => {
    const clamped = shaped ? map3(e, (x, a) => clamp(x, l.lo1[a], l.hi1[a])) : map3(e, (x, a) => clamp(x, l.lo3[a], l.hi3[a]));
    let v = clamped;
    if (shaped) v = map3(clamped, (x, a) => shaper(a, (x - l.lo1[a]) / (l.hi1[a] - l.lo1[a])));
    if (l.kind & KIND_CUBE) {
      const base3 = base + (shaped ? 3 * (l.n1 - 1) : 0);
      v = cube(base3, map3(v, (x, a) => (clamp(x, l.lo3[a], l.hi3[a]) - l.lo3[a]) / (l.hi3[a] - l.lo3[a])));
    }
    return { value: v, clamped };
  });
}
