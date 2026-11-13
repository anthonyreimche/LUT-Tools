// The stages as registered, and their GLSL read as text: where they run,
// what keeps them dormant, and the texture fetches a draw can make.

import { describe, expect, it } from "vitest";
import { ATLAS_WIDTH, PROBES, packLut, pageName, pageOf } from "../src/pack";
import {
  BAKE_STAGE_ID,
  DEFAULT_SETTINGS,
  LOOK_KEYS,
  LOOK_STAGE_ID,
  NAME_KEY,
  PAGE_KEY,
  applyPatch,
  idFromUniform,
  idToUniform,
  qualified,
  readLook,
  removePatch,
  settingsPatch,
} from "../src/params";
import { ATLAS_KEY, BAKE_GLSL, BAKE_HELPERS, LOOK_GLSL, LOOK_HELPERS, bakeStage, lookStage } from "../src/stage";
import { identityCube } from "../src/lut";

const code = (glsl: string): string => glsl.replace(/\/\/.*$/gm, "");
const count = (glsl: string, re: RegExp): number => (code(glsl).match(re) ?? []).length;

/** Every integer variable or parameter `glsl` declares without `highp`: what
 *  a 16-bit mediump int would hold. */
function mediumpInts(glsl: string): string[] {
  const out: string[] = [];
  for (const m of code(glsl).matchAll(/(\bhighp\s+)?\b(u?int|[iu]vec[234])\s+(\w+)\s*(?=[=;,)])/g)) if (!m[1]) out.push(m[3]);
  return out;
}

/** The body of a GLSL function in `src`. */
function body(src: string, name: string): string {
  const start = src.indexOf(`${name}(`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`no ${name}`);
}

describe("the look stage", () => {
  const stage = lookStage();

  it("runs after the display tools, on unclipped sRGB-encoded values, late in display-adjust", () => {
    expect(stage).toMatchObject({ id: LOOK_STAGE_ID, phase: "display-adjust", priority: 900, space: { encoding: "perceptual" } });
  });

  it("declares a uniform for every key the edit holds, and is dormant until a LUT is on", () => {
    expect(stage.uniforms.map((u) => u.key)).toEqual([...LOOK_KEYS]);
    expect(stage.dormantWhen).toEqual({ active: 0 });
    expect(stage.uniforms.find((u) => u.key === "active")?.default).toBe(0);
  });

  it("reads one RGBA8 texture, the atlas", () => {
    expect(stage.textures).toEqual([{ key: ATLAS_KEY, kind: "lut", format: "rgba8" }]);
    expect(LOOK_HELPERS).toContain(`${ATLAS_WIDTH}`);
  });

  it("reads the atlas with texelFetch only, no filtered or derivative reads", () => {
    const all = LOOK_HELPERS + LOOK_GLSL;
    expect(count(all, /\btexture\s*\(/g)).toBe(0);
    expect(count(all, /\btextureLod\s*\(/g)).toBe(0);
    expect(code(all)).not.toMatch(/\bconst\s+\w+\s+\w+\s*\[/);
    expect(code(all)).not.toMatch(/#\s*(if|define)/);
  });

  // The worst a pixel can fetch: the header, a probe per slot looked at, the
  // matched slot's offset and signature, a texel a channel for a 1D table and
  // two a node for a tetrahedron's four nodes.
  it("fetches at most 18 texels a pixel", () => {
    expect(count(body(LOOK_HELPERS, "uint ltWord"), /\btexelFetch\s*\(/g)).toBe(1);
    const find = body(LOOK_HELPERS, "int ltFind");
    expect(count(find, /\bltWord\s*\(/g)).toBe(4);
    expect(find).toContain(`p < ${PROBES}`);
    expect(count(body(LOOK_HELPERS, "float ltShaper"), /\btexelFetch\s*\(/g)).toBe(1);
    expect(count(body(LOOK_HELPERS, "vec3 ltNode"), /\btexelFetch\s*\(/g)).toBe(2);
    expect(count(body(LOOK_HELPERS, "vec3 ltCube"), /\bltNode\s*\(/g)).toBe(4);
    expect(count(LOOK_GLSL, /\bltShaper\s*\(/g)).toBe(3);
    expect(count(LOOK_GLSL, /\bltCube\s*\(/g)).toBe(1);
    expect(count(LOOK_GLSL, /\bltFind\s*\(/g)).toBe(1);
    const worst = 1 + PROBES + 2 + 3 * 1 + 4 * 2;
    expect(worst).toBe(18);
    expect(worst).toBeLessThanOrEqual(25);
  });

  it("writes every float literal with a decimal point", () => {
    expect(code(LOOK_HELPERS + LOOK_GLSL)).not.toMatch(/\bconst\s+float\s+\w+\s*=\s*-?\d+\s*;/);
  });

  // A fragment shader's ints are mediump, 16 bits on some GPUs, unless
  // declared highp; uniforms can't be declared highp, so any that can pass
  // 2^15 is a float, exact to 2^24.
  it("carries the key and signature as 16-bit halves, and the 1D table's size as a float", () => {
    const type = (key: string) => stage.uniforms.find((u) => u.key === key)?.glslType;
    expect([type("lut"), type("sig"), type("n1")]).toEqual(["vec2", "vec2", "float"]);
    expect(stage.uniforms.filter((u) => u.glslType === "int").map((u) => u.key)).toEqual(["active", "inEnc", "outEnc", "kind", "n3"]);
  });

  it("keeps every integer that indexes the atlas highp", () => {
    expect(mediumpInts(LOOK_HELPERS + LOOK_GLSL).sort()).toEqual(["ch", "enc", "enc", "o1", "o2", "p"]);
  });
});

describe("the bake stage", () => {
  const stage = bakeStage();

  it("runs first in decode, dormant unless a bake asks for it, and never in presets", () => {
    expect(stage).toMatchObject({ id: BAKE_STAGE_ID, phase: "decode", priority: 0, dormantWhen: { bake: 0 }, presetScope: "per-image" });
  });

  it("reads no texture at all", () => {
    expect(count(BAKE_HELPERS + BAKE_GLSL, /\btexel?Fetch|\btexture\w*\s*\(/g)).toBe(0);
  });

  it("counts grid nodes past 2^15 exactly: the first node is a float, the counting highp", () => {
    expect(stage.uniforms.find((u) => u.key === "gridStart")?.glslType).toBe("float");
    expect(mediumpInts(BAKE_HELPERS + BAKE_GLSL)).toEqual([]);
  });
});

describe("a key's uniform form", () => {
  const near = [1, 0x7fff, 0xffff, 0x10000, 0x10001, 2 ** 24 - 1, 2 ** 24, 2 ** 24 + 1, 2 ** 31 - 2, 2 ** 31 - 1];

  it("is two 16-bit halves that give the key back", () => {
    for (const id of near) {
      const [hi, lo] = idToUniform(id);
      expect([Number.isInteger(hi), Number.isInteger(lo), hi <= 0x7fff, lo <= 0xffff]).toEqual([true, true, true, true]);
      expect(idFromUniform([hi, lo])).toBe(id);
    }
    expect(idToUniform(0x12345678)).toEqual([0x1234, 0x5678]);
  });

  it("is exact in a 32-bit float, where a key past 2^24 isn't", () => {
    for (const id of near) expect(Array.from(Float32Array.from(idToUniform(id)))).toEqual(idToUniform(id));
    expect(Math.fround(2 ** 24 + 1)).not.toBe(2 ** 24 + 1);
  });

  it("reads anything else as no key", () => {
    for (const v of [undefined, 5, "5", [1], [1, 2, 3], [-1, 0], [0, 65536], [0x8000, 0], [0.5, 1], [NaN, 0]]) expect(idFromUniform(v)).toBe(0);
  });
});

describe("the param bag", () => {
  const packed = packLut({ title: "", shaper: null, cube: identityCube(9) }, 4242);

  it("round-trips a LUT and its settings through the bag", () => {
    const bag = applyPatch(packed.key, packed.sig, packed.layout, "Nine", { strength: 0.4, inEnc: 1, outEnc: 2 });
    const look = readLook((k) => bag[k]);
    expect(look).toEqual({ key: 4242, sig: packed.sig, name: "Nine", settings: { strength: 0.4, inEnc: 1, outEnc: 2 } });
    expect(bag[qualified("active")]).toBe(1);
    expect(bag[qualified("lut")]).toEqual(idToUniform(4242));
    expect(bag[qualified("sig")]).toEqual(idToUniform(packed.sig));
  });

  it("names the atlas page the LUT is in under the texture's key", () => {
    expect(PAGE_KEY).toBe(`${LOOK_STAGE_ID}.${ATLAS_KEY}`);
    for (const key of [4242, 2 ** 29 + 7, 2 ** 30 + 7, 2 ** 31 - 1]) {
      expect(applyPatch(key, 1, packed.layout, "x", DEFAULT_SETTINGS)[PAGE_KEY]).toBe(pageName(pageOf(key)));
    }
  });

  it("is inactive at 0% so the stage can sleep, and clears every key on removal", () => {
    expect(applyPatch(packed.key, packed.sig, packed.layout, "x", { ...DEFAULT_SETTINGS, strength: 0 })[qualified("active")]).toBe(0);
    expect(settingsPatch(packed.key, { ...DEFAULT_SETTINGS, strength: 0 })[qualified("active")]).toBe(0);
    expect(settingsPatch(0, DEFAULT_SETTINGS)[qualified("active")]).toBe(0);
    expect(Object.values(removePatch()).every((v) => v === undefined)).toBe(true);
    expect(Object.keys(removePatch()).sort()).toEqual([...LOOK_KEYS.map(qualified), NAME_KEY, PAGE_KEY].sort());
  });

  it("reads a damaged bag as no LUT at the defaults", () => {
    const look = readLook((k) => ({ [qualified("lut")]: "x", [qualified("strength")]: 7, [qualified("inEnc")]: 9 })[k]);
    expect(look).toEqual({ key: 0, sig: 0, name: null, settings: { strength: 1, inEnc: 0, outEnc: 0 } });
  });
});
