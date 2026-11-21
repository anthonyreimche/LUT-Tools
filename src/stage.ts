// The two GPU stages.
//
// The look stage applies a photo's LUT where a display-referred look belongs:
// in display-adjust, after the display transform and the core display tools,
// on the photo sRGB-encoded with its sign and range kept (`perceptual`). It
// reads the LUT from the atlas page the photo names (pack.ts) with texelFetch
// only: the directory probe, one fetch a channel for a 1D table and two a
// node for the four nodes of a tetrahedron, 18 at most. Input outside the LUT's domain is read
// at the domain's edge, and what lay beyond it is added back as light, so
// highlights a display LUT can't represent keep their detail and the result
// stays continuous at the edge.
//
// The bake stage is what exporting a look renders: while it is on, every
// pixel's colour, from the decode phase on, is a node of an identity grid
// picked by the pixel's place in the frame, so the rest of the pipeline
// turns the grid into the look's table (bake.ts).
//
// A fragment shader's ints are mediump unless declared otherwise, which some
// GPUs keep in 16 bits. So every integer that can pass 2^15 is a highp local
// or parameter, and a uniform that can is a float, exact in a highp float to
// 2^24: the key and the signature as two 16-bit halves (params.ts), the 1D
// table's node count, the bake grid's first node.

import { ATLAS_WIDTH, PROBES } from "./pack";
import { ATLAS_KEY, BAKE_STAGE_ID, DEFAULT_SETTINGS, LOOK_STAGE_ID, type LookKey } from "./params";
import type { ProcessingStageContribution, UniformDeclaration } from "./safelight";

export { ATLAS_KEY };

const LOOK_UNIFORMS: (UniformDeclaration & { key: LookKey })[] = [
  { key: "active", glslType: "int", default: 0 },
  { key: "lut", glslType: "vec2", default: [0, 0] },
  { key: "sig", glslType: "vec2", default: [0, 0] },
  { key: "strength", glslType: "float", default: DEFAULT_SETTINGS.strength, range: { min: 0, max: 1 }, label: "Strength" },
  { key: "inEnc", glslType: "int", default: DEFAULT_SETTINGS.inEnc },
  { key: "outEnc", glslType: "int", default: DEFAULT_SETTINGS.outEnc },
  { key: "kind", glslType: "int", default: 0 },
  { key: "n3", glslType: "int", default: 2 },
  { key: "n1", glslType: "float", default: 2 },
  { key: "lo3", glslType: "vec3", default: [0, 0, 0] },
  { key: "hi3", glslType: "vec3", default: [1, 1, 1] },
  { key: "lo1", glslType: "vec3", default: [0, 0, 0] },
  { key: "hi1", glslType: "vec3", default: [1, 1, 1] },
  { key: "range3", glslType: "vec2", default: [0, 1] },
  { key: "range1", glslType: "vec2", default: [0, 1] },
];

const W = `${ATLAS_WIDTH}`;

export const LOOK_HELPERS = /* glsl */ `
highp ivec2 ltTexel(highp int i) { return ivec2(i % ${W}, i / ${W}); }

highp uint ltWord(highp int i) {
  highp uvec4 b = uvec4(texelFetch(${ATLAS_KEY}, ltTexel(i), 0) * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}

highp uint ltId(highp vec2 halves) {
  highp uint hi = uint(halves.x);
  highp uint lo = uint(halves.y);
  return (hi << 16u) | lo;
}

highp int ltFind(highp vec2 key, highp vec2 sig) {
  highp uint want = ltId(key);
  if (textureSize(${ATLAS_KEY}, 0).x != ${W} || want == 0u) return -1;
  highp uint slots = ltWord(0);
  if (slots < 8u) return -1;
  highp uint mask = slots - 1u;
  for (int p = 0; p < ${PROBES}; p++) {
    highp int s = int((want + uint(p)) & mask);
    highp uint id = ltWord(1 + 3 * s);
    if (id == want) return ltWord(3 + 3 * s) == ltId(sig) ? int(ltWord(2 + 3 * s)) : -1;
    if (id == 0u) return -1;
  }
  return -1;
}

float ltShaper(highp int base, highp int m, int ch, float x, vec2 range) {
  float p = clamp(x, 0.0, 1.0) * float(m - 1);
  highp int i = min(int(p), m - 2);
  float f = p - float(i);
  vec4 t = floor(texelFetch(${ATLAS_KEY}, ltTexel(base + ch * (m - 1) + i), 0) * 255.0 + 0.5);
  return range.x + mix(t.r * 256.0 + t.g, t.b * 256.0 + t.a, f) * ((range.y - range.x) / 65535.0);
}

vec3 ltNode(highp int base, highp int n, highp ivec3 i, vec2 range) {
  highp int t = base + 2 * (i.x + n * (i.y + n * i.z));
  vec3 hi = floor(texelFetch(${ATLAS_KEY}, ltTexel(t), 0).rgb * 255.0 + 0.5);
  vec3 lo = floor(texelFetch(${ATLAS_KEY}, ltTexel(t + 1), 0).rgb * 255.0 + 0.5);
  return range.x + (hi * 256.0 + lo) * ((range.y - range.x) / 65535.0);
}

vec3 ltCube(highp int base, highp int n, vec3 u, vec2 range) {
  vec3 p = clamp(u, 0.0, 1.0) * float(n - 1);
  highp ivec3 i = min(ivec3(p), ivec3(n - 2));
  vec3 f = p - vec3(i);
  ivec3 o1;
  ivec3 o2;
  vec3 w;
  if (f.x >= f.y) {
    if (f.y >= f.z) { o1 = ivec3(1, 0, 0); o2 = ivec3(1, 1, 0); w = f.xyz; }
    else if (f.x >= f.z) { o1 = ivec3(1, 0, 0); o2 = ivec3(1, 0, 1); w = f.xzy; }
    else { o1 = ivec3(0, 0, 1); o2 = ivec3(1, 0, 1); w = f.zxy; }
  } else {
    if (f.z >= f.y) { o1 = ivec3(0, 0, 1); o2 = ivec3(0, 1, 1); w = f.zyx; }
    else if (f.z >= f.x) { o1 = ivec3(0, 1, 0); o2 = ivec3(0, 1, 1); w = f.yzx; }
    else { o1 = ivec3(0, 1, 0); o2 = ivec3(1, 1, 0); w = f.yxz; }
  }
  vec3 c0 = ltNode(base, n, i, range);
  vec3 c1 = ltNode(base, n, i + o1, range);
  vec3 c2 = ltNode(base, n, i + o2, range);
  vec3 c3 = ltNode(base, n, i + ivec3(1), range);
  return c0 + w.x * (c1 - c0) + w.y * (c2 - c1) + w.z * (c3 - c2);
}

vec3 ltDecode(vec3 v, int enc) {
  vec3 a = abs(v);
  vec3 l = a;
  if (enc == 0) l = mix(pow((a + 0.055) / 1.055, vec3(2.4)), a / 12.92, vec3(lessThanEqual(a, vec3(0.04045))));
  else if (enc == 1) l = pow(max(a, vec3(1e-30)), vec3(2.4));
  else if (enc == 2) l = pow(max(a, vec3(1e-30)), vec3(2.2));
  return sign(v) * l;
}

vec3 ltEncode(vec3 v, int enc) {
  vec3 a = abs(v);
  vec3 e = a;
  if (enc == 0) e = mix(1.055 * pow(max(a, vec3(1e-30)), vec3(1.0 / 2.4)) - 0.055, a * 12.92, vec3(lessThanEqual(a, vec3(0.0031308))));
  else if (enc == 1) e = pow(max(a, vec3(1e-30)), vec3(1.0 / 2.4));
  else if (enc == 2) e = pow(max(a, vec3(1e-30)), vec3(1.0 / 2.2));
  return sign(v) * e;
}
`;

export const LOOK_GLSL = /* glsl */ `
if (active != 0 && strength > 0.0) {
  highp int base = ltFind(lut, sig);
  if (base >= 0) {
    highp int m1 = int(n1);
    vec3 light = ltDecode(c, 0);
    vec3 e = inEnc == 0 ? c : ltEncode(light, inEnc);
    bool shaped = (kind & 1) != 0;
    vec3 ec = shaped ? clamp(e, lo1, hi1) : clamp(e, lo3, hi3);
    vec3 v = ec;
    if (shaped) {
      vec3 x = (ec - lo1) / (hi1 - lo1);
      v = vec3(ltShaper(base, m1, 0, x.x, range1), ltShaper(base, m1, 1, x.y, range1), ltShaper(base, m1, 2, x.z, range1));
    }
    if ((kind & 2) != 0) {
      highp int base3 = base + (shaped ? 3 * (m1 - 1) : 0);
      v = ltCube(base3, n3, (clamp(v, lo3, hi3) - lo3) / (hi3 - lo3), range3);
    }
    vec3 graded = v;
    if (outEnc != 0 || any(notEqual(e, ec))) graded = ltEncode(ltDecode(v, outEnc) + (light - ltDecode(ec, inEnc)), 0);
    c = mix(c, graded, strength);
  }
}
`;

export function lookStage(): ProcessingStageContribution {
  return {
    id: LOOK_STAGE_ID,
    name: "LUT",
    phase: "display-adjust",
    priority: 900,
    space: { encoding: "perceptual" },
    uniforms: LOOK_UNIFORMS.map((u) => ({ ...u })),
    textures: [{ key: ATLAS_KEY, kind: "lut", format: "rgba8" }],
    helpers: LOOK_HELPERS,
    glsl: LOOK_GLSL,
    dormantWhen: { active: 0 },
  };
}

export const BAKE_KEYS = ["bake", "gridSize", "gridCells", "gridStart", "gridTop"] as const;
export type BakeKey = (typeof BAKE_KEYS)[number];
export const bakeKey = (key: BakeKey): string => `${BAKE_STAGE_ID}.${key}`;

export const BAKE_HELPERS = /* glsl */ `
vec3 ltGridLight(vec3 g) {
  return mix(pow((g + 0.055) / 1.055, vec3(2.4)), g / 12.92, vec3(lessThanEqual(g, vec3(0.04045))));
}
`;

export const BAKE_GLSL = /* glsl */ `
if (bake != 0) {
  highp ivec2 cells = gridCells;
  highp ivec2 cell = clamp(ivec2(vUv * vec2(cells)), ivec2(0), cells - 1);
  highp int k = int(gridStart) + cell.y * cells.x + cell.x;
  highp int n = gridSize;
  vec3 g = vec3(0.0);
  if (k < n * n * n) g = vec3(float(k % n), float((k / n) % n), float(k / (n * n))) * (gridTop / float(n - 1));
  lin = ltGridLight(g);
}
`;

export function bakeStage(): ProcessingStageContribution {
  return {
    id: BAKE_STAGE_ID,
    name: "LUT export grid",
    phase: "decode",
    priority: 0,
    uniforms: [
      { key: "bake", glslType: "int", default: 0 },
      { key: "gridSize", glslType: "int", default: 2 },
      { key: "gridCells", glslType: "ivec2", default: [1, 1] },
      { key: "gridStart", glslType: "float", default: 0 },
      { key: "gridTop", glslType: "float", default: 1 },
    ],
    helpers: BAKE_HELPERS,
    glsl: BAKE_GLSL,
    dormantWhen: { bake: 0 },
    presetScope: "per-image",
  };
}
