// The stages on the real renderer. Run via `npm run test:gpu` (run.cjs copies
// this file into a SafeLight checkout and runs it under its headless
// Chromium + SwiftShader rig). What the CPU suite cannot check:
//  • core's stage contract accepts both stages without a warning;
//  • the GLSL compiles with the host's namespacing and reads the atlas, and
//    a photo without a LUT, or with one the atlas lacks, is drawn exactly as
//    without the stage;
//  • in float32 the shader lands on its CPU twin (model.ts) and on the
//    double-precision reference, for identity tables of every size, looks
//    in 3D, 1D and shaper + 3D, wide domains, other encodings, strength,
//    and colours above white and below black;
//  • the bake stage's grid survives the real pipeline: a look exported from
//    an edit and applied to the unedited photo matches the edit;
//  • keys near 2^16, past 2^24 and near 2^31 each draw their own LUT, from
//    whichever atlas page the photo names, never a neighbour's;
//  • a photo without a LUT leaves the stage out and uploads nothing, and
//    switching photos, LUTs or strength uploads no texture once each page in
//    use is on the GPU;
//  • what a full-size frame costs with a 65-node LUT on.

import { describe, expect, it } from "vitest";
import { bakeLook, planBake, type FrameRenderer } from "@lut/bake";
import { decode } from "@lut/encoding";
import { cubeFrom, identityCube, type Lut, type Table, type Vec3 } from "@lut/lut";
import { applyLook, applyLookFromAtlas, type AtlasLook } from "@lut/model";
import { ATLAS_WIDTH, PAGE_COUNT, buildAtlas, packLut, pageName, pageOf, type Atlas, type PackedLut } from "@lut/pack";
import { DEFAULT_SETTINGS, EXT_ID, LOOK_STAGE_ID, PAGE_KEY, applyPatch, idToUniform, type LookSettings } from "@lut/params";
import { ATLAS_KEY, bakeStage, lookStage } from "@lut/stage";
import { CURRENT_PROCESS_VERSION } from "@/catalog/process-version";
import type { DevelopParams } from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import { checkStageContract } from "@/extensions/stage-validation";
import { variantTextureKey } from "@/rendering/webgl/stage-texture-variant";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import {
  OPEN_PROBE,
  builtinStages,
  deriveWithoutSettings,
  floatImage,
  glHarness,
  identityParams,
  type FloatImage,
} from "@/rendering/webgl/webgl.test-support";

const AS_DRAWN = { encoding: "perceptual", primaries: "rec709" } as const;
const V2 = { processVersion: CURRENT_PROCESS_VERSION };

const look = (r: number, g: number, b: number): Vec3 => [
  0.03 + 0.94 * Math.pow(Math.max(r, 0), 0.85) + 0.05 * g,
  0.02 + 0.9 * g + 0.04 * Math.sin(3 * b),
  0.08 + 0.75 * b + 0.1 * r * g,
];

function shaperOf(size: number, fn: (x: number) => number): Table {
  const data = new Float64Array(3 * size);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    data.set([fn(x), fn(x) * 0.9, Math.min(1, fn(x) * 1.1)], 3 * i);
  }
  return { size, lo: [0, 0, 0], hi: [1, 1, 1], data };
}

const LUTS: [string, Lut][] = [
  ["identity 2", { title: "", shaper: null, cube: identityCube(2) }],
  ["identity 17", { title: "", shaper: null, cube: identityCube(17) }],
  ["identity 33", { title: "", shaper: null, cube: identityCube(33) }],
  ["identity 65", { title: "", shaper: null, cube: identityCube(65) }],
  ["look 33", { title: "", shaper: null, cube: cubeFrom(33, look) }],
  ["look 65", { title: "", shaper: null, cube: cubeFrom(65, look) }],
  ["look 9, wide domain", { title: "", shaper: null, cube: cubeFrom(9, look, [-0.1, 0, 0], [1.3, 1.1, 1]) }],
  ["1D 4096", { title: "", shaper: shaperOf(4096, (x) => Math.sqrt(x)), cube: null }],
  ["shaper 64 + 3D 11", { title: "", shaper: shaperOf(64, (x) => Math.pow(x, 0.6)), cube: cubeFrom(11, look) }],
];

const PACKED: PackedLut[] = LUTS.map(([, lut], i) => packLut(lut, 101 + 7919 * i));
const ATLAS = buildAtlas(PACKED);
const atlasTexture = (atlas: Atlas, version = 1): StageTextureData => ({
  data: atlas.data,
  width: atlas.width,
  height: atlas.height,
  format: "rgba8",
  version,
});
/** Where the renderer finds atlas page `page`: as api.setStageTexture files it. */
function pageKey(page: number): string {
  const key = variantTextureKey(`${LOOK_STAGE_ID}.${ATLAS_KEY}`, pageName(page));
  if (!key) throw new Error(`no variant key for page ${page}`);
  return key;
}

/** The stage textures of these LUTs, each page as the library supplies it. */
function pagesOf(luts: readonly PackedLut[], version = 1): Record<string, StageTextureData> {
  const out: Record<string, StageTextureData> = {};
  for (let page = 0; page < PAGE_COUNT; page++) {
    const on = luts.filter((l) => pageOf(l.key) === page);
    if (on.length > 0) out[pageKey(page)] = atlasTexture(buildAtlas(on), version);
  }
  return out;
}

const TEXTURES = pagesOf(PACKED);

// Greys, primaries, a sweep, near-black, above white and below black.
const W = 32;
const H = 24;
const PIXELS: Vec3[] = Array.from({ length: W * H }, (_, k) => {
  const x = k % W;
  const y = Math.floor(k / W);
  if (y === 0) return [x / (W - 1), x / (W - 1), x / (W - 1)];
  if (y === 1) return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]][x % 6] as Vec3;
  // All three channels at or above RAW clip recovery's threshold, which
  // otherwise rebuilds a channel above it from its neighbours.
  if (y === 2) return [1 + x * 0.05, 0.98 + x * 0.02, 0.99 + 0.01 * x] as Vec3;
  if (y === 3) return [-0.02 * (x % 4), 0.3, 0.6 + 0.01 * x] as Vec3;
  if (y === 4) return [x * 1e-4, x * 2e-4, x * 3e-4] as Vec3;
  const f = (n: number) => ((k * n) % 997) / 997;
  return [f(31), f(57), f(83)];
});
const SCENE = floatImage(W, H, (x, y) => PIXELS[y * W + x]);

const stages = (): ProcessingStageContribution[] => [...builtinStages(), lookStage(), bakeStage()];

function render(
  image: FloatImage,
  bags: Record<string, Record<string, unknown>>,
  opts: { withStages?: boolean; pipeline?: ResolvedPipeline; params?: DevelopParams; textures?: Record<string, StageTextureData> } = {},
): Record<string, Float32Array> {
  const frames: Record<string, Float32Array> = {};
  const renderer = new WebGLRenderer(glHarness().canvas, {
    derive: deriveWithoutSettings,
    stages: opts.withStages === false ? builtinStages() : stages(),
    pipeline: opts.pipeline ?? OPEN_PROBE,
  });
  try {
    renderer.setImage(image);
    renderer.setStageTextures(opts.textures ?? TEXTURES);
    renderer.setParams(opts.params ?? identityParams(V2));
    for (const [name, bag] of Object.entries(bags)) {
      renderer.setContributedParams(bag);
      const frame = renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
      if (!frame) throw new Error(`no frame for ${name}`);
      frames[name] = frame.data;
    }
  } finally {
    renderer.dispose();
  }
  return frames;
}

const lookOf = (p: PackedLut, settings: LookSettings = DEFAULT_SETTINGS): AtlasLook => ({ key: p.key, sig: p.sig, layout: p.layout, settings });
const bagOf = (p: PackedLut, settings: LookSettings = DEFAULT_SETTINGS) => applyPatch(p.key, p.sig, p.layout, "test", settings);
const pixel = (f: Float32Array, k: number): Vec3 => [f[4 * k], f[4 * k + 1], f[4 * k + 2]];

/** The largest |GPU − CPU| over the frame, relative to each value's scale
 *  above 1. The idle frame is drawn by a program without the stage (it is
 *  dormant there), whose arithmetic upstream may round a channel that should
 *  be 0 to 1e-10 or back: the gamma curves' slope is unbounded at 0, so a
 *  channel that small is also tried at 0, and the closer answer counts. */
function worst(idle: Float32Array, frame: Float32Array, cpu: (c: Vec3) => Vec3): { err: number; at: Vec3 | null } {
  let err = 0;
  let at: Vec3 | null = null;
  for (let k = 0; k < W * H; k++) {
    const input = pixel(idle, k);
    const flushed = input.map((v) => (Math.abs(v) < 1e-6 ? 0 : v)) as Vec3;
    const wants = [cpu(input), cpu(flushed)];
    const got = pixel(frame, k);
    for (let ch = 0; ch < 3; ch++) {
      const e = Math.min(...wants.map((want) => Math.abs(got[ch] - want[ch]) / Math.max(1, Math.abs(want[ch]))));
      if (e > err) {
        err = e;
        at = input;
      }
    }
  }
  return { err, at };
}

describe("LUT Tools on the GPU", () => {
  it("passes core's stage contract without a warning", () => {
    expect(checkStageContract(lookStage(), EXT_ID)).toMatchObject({ error: null, warnings: [] });
    expect(checkStageContract(bakeStage(), EXT_ID)).toMatchObject({ error: null, warnings: [] });
  });

  const SETTINGS: [string, LookSettings][] = [
    ["sRGB", DEFAULT_SETTINGS],
    ["half strength", { ...DEFAULT_SETTINGS, strength: 0.5 }],
    ["Rec.709 in and out", { strength: 1, inEnc: 1, outEnc: 1 }],
    ["linear in, sRGB out", { strength: 1, inEnc: 3, outEnc: 0 }],
    ["gamma 2.2 in, linear out", { strength: 1, inEnc: 2, outEnc: 3 }],
  ];

  const bags: Record<string, Record<string, unknown>> = { idle: {} };
  PACKED.forEach((p, i) => {
    for (const [s, settings] of SETTINGS) bags[`${LUTS[i][0]} / ${s}`] = bagOf(p, settings);
  });
  bags.missing = { ...bagOf(PACKED[4]), [`${LOOK_STAGE_ID}.lut`]: idToUniform(999) };
  bags["wrong signature"] = { ...bagOf(PACKED[4]), [`${LOOK_STAGE_ID}.sig`]: idToUniform(PACKED[4].sig ^ 1) };
  bags["page without it"] = { ...bagOf(PACKED[4]), [PAGE_KEY]: pageName(3) };
  bags["zero strength"] = bagOf(PACKED[4], { ...DEFAULT_SETTINGS, strength: 0 });
  const frames = render(SCENE, bags);

  it("leaves the frame exactly as it was with no LUT, a missing one, a stale one, or at 0%", () => {
    const without = render(SCENE, { idle: {} }, { withStages: false }).idle;
    for (const name of ["idle", "missing", "wrong signature", "page without it", "zero strength"]) {
      expect(Array.from(frames[name]), name).toEqual(Array.from(without));
    }
  });

  it("draws only finite values", () => {
    for (const [name, frame] of Object.entries(frames)) expect(frame.every(Number.isFinite), name).toBe(true);
  });

  it.each(LUTS.map(([name], i) => [name, i] as const))("lands on its CPU twin and on the reference: %s", (name, i) => {
    for (const [s, settings] of SETTINGS) {
      const frame = frames[`${name} / ${s}`];
      const twin = worst(frames.idle, frame, (c) => applyLookFromAtlas(c, ATLAS, lookOf(PACKED[i], settings)));
      const reference = worst(frames.idle, frame, (c) => applyLook(c, LUTS[i][1], settings));
      console.log(`[lut-gpu] ${name} / ${s}: twin ${twin.err.toExponential(2)} reference ${reference.err.toExponential(2)} at ${JSON.stringify(twin.at)}`);
      expect(twin.err, `${name} / ${s}`).toBeLessThan(2e-5);
      expect(reference.err, `${name} / ${s}`).toBeLessThan(1e-4);
    }
  });

  it("leaves every colour, above white and below black too, where it was through an identity table", () => {
    for (const name of ["identity 2", "identity 17", "identity 33", "identity 65"]) {
      const frame = frames[`${name} / sRGB`];
      for (let k = 0; k < W * H; k++) {
        const want = pixel(frames.idle, k);
        pixel(frame, k).forEach((v, ch) => expect(Math.abs(v - want[ch]), `${name} pixel ${k}`).toBeLessThan(2e-5 * Math.max(1, Math.abs(want[ch]))));
      }
    }
  });

  it("keeps a highlight's excess as light above the LUT's white", () => {
    const frame = frames["look 33 / sRGB"];
    for (let x = 1; x < W; x++) {
      const k = 2 * W + x;
      const input = pixel(frames.idle, k);
      expect(input[0]).toBeGreaterThan(1);
      const edge = applyLook([1, Math.min(input[1], 1), Math.min(input[2], 1)], LUTS[4][1], DEFAULT_SETTINGS);
      expect(decode(pixel(frame, k)[0], 0) - decode(edge[0], 0)).toBeCloseTo(decode(input[0], 0) - 1, 4);
    }
  });

  it("takes a new atlas without a recompile and finds the same LUT at its new place", () => {
    const moved = buildAtlas([packLut({ title: "", shaper: null, cube: identityCube(5) }, 77), PACKED[5]]);
    const out = render(SCENE, { look: bagOf(PACKED[5]) }, { textures: { [pageKey(0)]: atlasTexture(moved, 2) } });
    expect(Array.from(out.look)).toEqual(Array.from(frames["look 65 / sRGB"]));
  });

  it("costs a full-size frame no more than a few times the idle one", () => {
    const big = floatImage(1536, 1024, (x, y) => PIXELS[(y * 1536 + x) % PIXELS.length]);
    const timed: Record<string, number> = {};
    const renderer = new WebGLRenderer(glHarness().canvas, { derive: deriveWithoutSettings, stages: stages(), pipeline: OPEN_PROBE });
    try {
      renderer.setImage(big);
      renderer.setStageTextures(TEXTURES);
      renderer.setParams(identityParams(V2));
      const time = (name: string, bag: Record<string, unknown>) => {
        renderer.setContributedParams(bag);
        renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
        const t0 = performance.now();
        renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
        timed[name] = performance.now() - t0;
      };
      time("idle", {});
      time("65-node look", bagOf(PACKED[5]));
      time("shaper + 3D", bagOf(PACKED[8]));
    } finally {
      renderer.dispose();
    }
    console.log(`[lut-gpu] 1536×1024 frame, ms: ${JSON.stringify(timed)}`);
    for (const name of ["65-node look", "shaper + 3D"]) expect(timed[name]).toBeLessThan(Math.max(10 * timed.idle, 5000));
  });
});

describe("keys and pages on the GPU", () => {
  // Neighbours in each range a 16-bit int or a 32-bit float would merge: a
  // 16-bit int keeps 2^15, a float 2^24 exactly. Each LUT paints its own
  // colour over the whole frame, so a pixel shows which LUT the key found.
  const KEYS = [
    0xffff, 0x10000, 0x10001,
    2 ** 24 + 1, 2 ** 24 + 2, 2 ** 24 + 3,
    2 ** 29 + 1, 2 ** 30 + 1,
    2 ** 31 - 3, 2 ** 31 - 2, 2 ** 31 - 1,
  ];
  const colour = (i: number): Vec3 => [0.05 + 0.08 * i, 0.5 + 0.03 * (i % 3), 0.9 - 0.07 * i];
  const FLAT = KEYS.map((key, i) => packLut({ title: "", shaper: null, cube: cubeFrom(2, () => colour(i)) }, key));
  const PLAIN = floatImage(16, 12, (x, y) => [0.1 + 0.04 * x, 0.2 + 0.03 * y, 0.5]);

  it("spreads the keys over every page", () => {
    expect(new Set(KEYS.map(pageOf))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("draws each key's own LUT, never a neighbour's", () => {
    const bags = Object.fromEntries(FLAT.map((p, i) => [String(i), bagOf(p)]));
    const frames = render(PLAIN, bags, { textures: pagesOf(FLAT) });
    FLAT.forEach((_, i) => {
      const frame = frames[String(i)];
      for (let k = 0; k < 16 * 12; k++) {
        const got = pixel(frame, k);
        const off = (j: number) => Math.max(...colour(j).map((v, ch) => Math.abs(got[ch] - v)));
        expect(off(i), `key ${KEYS[i]} pixel ${k}`).toBeLessThan(2e-3);
        for (let j = 0; j < KEYS.length; j++) if (j !== i) expect(off(j)).toBeGreaterThan(0.02);
      }
    });
  });

  /** Counts the atlas pages the renderer uploads while `run` draws. */
  function countUploads(run: () => void): number {
    const gl = glHarness().gl;
    const original = gl.texImage2D;
    let uploads = 0;
    gl.texImage2D = ((...args: unknown[]) => {
      if (args[3] === ATLAS_WIDTH) uploads++;
      return Reflect.apply(original, gl, args);
    }) as typeof gl.texImage2D;
    try {
      run();
    } finally {
      gl.texImage2D = original;
    }
    return uploads;
  }

  it("leaves the stage out and uploads nothing without a LUT; switching photos, LUTs or strength uploads nothing more", () => {
    const [a, a2] = FLAT.filter((p) => pageOf(p.key) === 0);
    const b = FLAT.find((p) => pageOf(p.key) === 3);
    if (!a || !a2 || !b) throw new Error("the keys don't cover pages 0 and 3");
    const renderer = new WebGLRenderer(glHarness().canvas, {
      derive: deriveWithoutSettings,
      stages: stages(),
      pipeline: OPEN_PROBE,
      skipDormantStages: true,
    });
    const steps: Record<string, number> = {};
    const drawn: Record<string, Float32Array> = {};
    let dormantWithout: readonly string[] = [];
    try {
      renderer.setImage(PLAIN);
      renderer.setStageTextures(pagesOf(FLAT));
      renderer.setParams(identityParams(V2));
      const draw = (name: string, bag: Record<string, unknown>) => {
        steps[name] = countUploads(() => {
          renderer.setContributedParams(bag);
          const f = renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
          if (!f) throw new Error(`no frame for ${name}`);
          drawn[name] = f.data;
        });
      };
      draw("no LUT", {});
      dormantWithout = [...renderer.dormantStages];
      draw("photo A", bagOf(a));
      draw("photo B, another page", bagOf(b));
      draw("photo A again", bagOf(a));
      draw("photo B again", bagOf(b));
      draw("another LUT on A's page", bagOf(a2));
      for (const strength of [0.2, 0.55, 0.9]) draw(`strength ${strength}`, bagOf(a2, { ...DEFAULT_SETTINGS, strength }));
      draw("no LUT again", {});
    } finally {
      renderer.dispose();
    }
    console.log(`[lut-gpu] atlas uploads: ${JSON.stringify(steps)}`);
    expect(dormantWithout).toContain(LOOK_STAGE_ID);
    expect(steps).toEqual({
      "no LUT": 0,
      "photo A": 1,
      "photo B, another page": 1,
      "photo A again": 0,
      "photo B again": 0,
      "another LUT on A's page": 0,
      "strength 0.2": 0,
      "strength 0.55": 0,
      "strength 0.9": 0,
      "no LUT again": 0,
    });
    expect(Array.from(drawn["photo A again"])).toEqual(Array.from(drawn["photo A"]));
    expect(Array.from(drawn["photo A"])).not.toEqual(Array.from(drawn["photo B, another page"]));
    expect(Array.from(drawn["no LUT again"])).toEqual(Array.from(drawn["no LUT"]));
  });
});

describe("a look exported and applied again on the GPU", () => {
  // A photo-like scene in linear light, through the shipping display
  // transform and Basic's tools, so the unedited rendering carries the RAW
  // baseline and the core shoulder that the bake has to undo.
  const SW = 48;
  const SH = 32;
  const photo = floatImage(SW, SH, (x, y) => {
    const u = x / (SW - 1);
    const v = y / (SH - 1);
    return [0.02 + 0.6 * u * (1 - 0.4 * v), 0.03 + 0.5 * v * v + 0.1 * u, 0.04 + 0.45 * (1 - u) * v + 0.05];
  });
  const edit = identityParams({
    ...V2,
    exposure: 0.35,
    contrast: 30,
    whites: 12,
    blacks: -10,
    vibrance: 25,
    saturation: 10,
    tint: 8,
  });

  async function roundTrip(size: number) {
    const renderer = new WebGLRenderer(glHarness().canvas, { derive: deriveWithoutSettings, stages: stages(), pipeline: BUILTIN_RESOLVED });
    try {
      renderer.setStageTextures({});
      const frameOf = (params: DevelopParams, bag: Record<string, unknown>) => {
        renderer.setParams(params);
        renderer.setContributedParams(bag);
        const f = renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
        if (!f) throw new Error("no frame");
        return { ...f, space: AS_DRAWN, point: "pre-output" as const };
      };
      renderer.setImage(photo);
      const edited = frameOf(edit, {}).data;
      const plainFrame = frameOf(identityParams(V2), {}).data;

      renderer.setImage(floatImage(3 * 96, 3 * 64, () => [0.5, 0.5, 0.5]));
      const render: FrameRenderer = async (params, bag) => frameOf(params, bag);
      const plan = planBake(
        { params: edit, bag: {}, stages: [], asShotTemperature: edit.temperature },
        {
          normalizeParams: (p) => identityParams({ ...p, temperature: edit.temperature }),
          summarize: () => [],
          isOfficial: () => true,
        },
      );
      const baked = await bakeLook(plan, size, render, () => {});

      const packed = packLut({ title: "", shaper: null, cube: baked.table }, 5);
      renderer.setStageTextures(pagesOf([packed]));
      renderer.setImage(photo);
      const applied = frameOf(identityParams(V2), applyPatch(packed.key, packed.sig, packed.layout, "baked", DEFAULT_SETTINGS)).data;
      return { edited, applied, plain: plainFrame };
    } finally {
      renderer.dispose();
    }
  }

  /** |applied − edited| over the frame: all of it, and the pixels the edit
   *  doesn't push against [0, 1], where a clip makes a crease no lattice of
   *  this size can follow. */
  function errors(r: Awaited<ReturnType<typeof roundTrip>>) {
    const all: number[] = [];
    const smooth: number[] = [];
    let moved = 0;
    for (let k = 0; k < SW * SH; k++) {
      const edited = [0, 1, 2].map((ch) => r.edited[4 * k + ch]);
      const clipped = edited.some((v) => v >= 0.999 || v <= 0.001);
      for (let ch = 0; ch < 3; ch++) {
        const e = Math.abs(r.applied[4 * k + ch] - edited[ch]);
        all.push(e);
        if (!clipped) smooth.push(e);
        moved = Math.max(moved, Math.abs(edited[ch] - r.plain[4 * k + ch]));
      }
    }
    const stats = (list: number[]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p99: sorted[Math.floor(sorted.length * 0.99)],
        max: sorted[sorted.length - 1],
      };
    };
    return { all: stats(all), smooth: stats(smooth), smoothShare: smooth.length / all.length, moved };
  }

  // The error is the lattice's own interpolation of a strongly curved edit:
  // it halves from 33 nodes to 65.
  it.each([
    [33, 8e-3, 1.5e-2],
    [65, 4e-3, 8e-3],
  ])("matches the edit closely at %i nodes", async (size, p99, max) => {
    const e = errors(await roundTrip(size));
    const fmt = (s: { mean: number; p99: number; max: number }) => `mean ${s.mean.toExponential(2)} p99 ${s.p99.toExponential(2)} max ${s.max.toExponential(2)}`;
    console.log(`[lut-gpu] round trip at ${size}: edit moved up to ${e.moved.toFixed(3)}; all ${fmt(e.all)}; unclipped (${(100 * e.smoothShare).toFixed(0)}%) ${fmt(e.smooth)}`);
    expect(e.moved).toBeGreaterThan(0.05);
    expect(e.smoothShare).toBeGreaterThan(0.8);
    expect(e.all.mean).toBeLessThan(1.5e-3);
    expect(e.smooth.p99).toBeLessThan(p99);
    expect(e.smooth.max).toBeLessThan(max);
  });
});
