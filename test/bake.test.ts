// Exporting a look: what is left out, how the grid is laid out and read, and
// the composed table, on a pipeline simulated on the CPU.

import { describe, expect, it } from "vitest";
import {
  CELL_PIXELS,
  GRID_TOP,
  bakeLook,
  gridColour,
  gridLayout,
  invertLattice,
  isSpatialStage,
  planBake,
  readCells,
  type BakeHelpers,
  type FrameRenderer,
} from "../src/bake";
import { cubeFrom, evalCube, sampleLattice, type Vec3 } from "../src/lut";
import { EXT_ID } from "../src/params";
import { bakeKey, bakeStage, lookStage } from "../src/stage";
import type { DevelopParams, FloatFrame, ProcessingStageContribution } from "../src/safelight";

const DEFAULTS = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  highlightDetail: 0,
  shadowDetail: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpening: 40,
  luminanceNR: 0,
  colorNR: 25,
  temperature: 6500,
  vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0 },
  grain: { amount: 0, size: 25, roughness: 50, color: 0 },
  masks: [],
  retouch: [],
  crop: { x: 0, y: 0, w: 1, h: 1, angle: 0 },
  straighten: 0,
  transform: { vertical: 0 },
  uprightMode: "off",
  guidedLines: [],
  processVersion: 2,
} as unknown as DevelopParams;

const helpers: BakeHelpers = {
  normalizeParams: (p) => ({ ...DEFAULTS, ...p }) as DevelopParams,
  // As core's: only what differs from the defaults is named.
  summarize: (p) =>
    Object.entries(p)
      .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k as keyof DevelopParams]))
      .map(([k]) => ({ label: `core:${k}` })),
  isOfficial: (id) => id.startsWith("safelight."),
};

const stage = (over: Partial<ProcessingStageContribution> & { id: string }, extensionId = "other"): ProcessingStageContribution & { extensionId: string } => ({
  name: over.id,
  phase: "display-adjust",
  glsl: "c *= k;",
  uniforms: [{ key: "k", glslType: "float", default: 1 }],
  ...over,
  extensionId,
});

describe("isSpatialStage", () => {
  it.each([
    ["a pure colour stage", stage({ id: "a" }), false],
    ["a stage whose passes read its input", stage({ id: "b", passes: [{ glsl: "c = readPrev(vec2(0.5));" }] }), true],
    ["a stage whose passes read the source", stage({ id: "b2", passes: [{ glsl: "c = vec3(1.0);" }, { glsl: "c = readSource(vec2(0.5));" }] }), true],
    [
      "a stage whose passes build a table from its settings",
      stage({ id: "b3", passes: [{ glsl: "c = vec3(k);" }, { glsl: "c = readPrev(vec2(0.5)) * 2.0;" }] }),
      false,
    ],
    ["a geometry stage", stage({ id: "c", phase: "geometry", glsl: "srcUv += 0.0;" }), true],
    ["a stage reading its position", stage({ id: "d", glsl: "c *= vUv.x;" }), true],
    ["a stage reading the source", stage({ id: "e", helpers: "vec3 f() { return texture(uImage, srcUv).rgb; }" }), true],
    ["a painted stage", stage({ id: "f", textures: [{ key: "m", kind: "coverage" }] }), true],
    ["a LUT stage", stage({ id: "g", textures: [{ key: "lut", kind: "lut" }] }), false],
  ])("%s: %s", (_name, s, spatial) => {
    expect(isSpatialStage(s)).toBe(spatial);
  });

  it("calls this extension's look stage global", () => {
    expect(isSpatialStage(lookStage())).toBe(false);
  });
});

describe("planBake", () => {
  const params = {
    ...DEFAULTS,
    exposure: 0.7,
    clarity: 30,
    sharpening: 40,
    masks: [{ id: "m" }],
    grain: { ...DEFAULTS.grain, amount: 20 },
  } as unknown as DevelopParams;
  const stages = [
    stage({ id: "glow", passes: [{ glsl: "c = readPrev(vec2(0.5));", uniforms: [{ key: "radius", glslType: "float", default: 3 }] }] }),
    stage({ id: "tint" }),
    stage({ id: "warp", phase: "geometry", glsl: "srcUv *= k;" }),
    stage({ id: "safelight.basic.tone", glsl: "lin *= srcUv.x;" }, "safelight.basic"),
    { ...bakeStage(), extensionId: EXT_ID },
    { ...lookStage(), extensionId: EXT_ID },
  ];
  const bag = { "glow.k": 2, "glow.radius": 9, "tint.k": 1.2, "lut-tools.look.active": 1 };
  const plan = planBake({ params, bag, stages, asShotTemperature: 5200 }, helpers);

  it("renders the edit with its spatial core tools at their defaults, keeping the rest", () => {
    expect(plan.edit.params.exposure).toBe(0.7);
    expect(plan.edit.params.clarity).toBe(0);
    expect(plan.edit.params.masks).toEqual([]);
    expect(plan.edit.params.grain.amount).toBe(0);
    expect(plan.edit.params.sharpening).toBe(0);
    expect(plan.edit.params.colorNR).toBe(0);
  });

  it("names what it left out, the core's way, defaults that aren't neutral included, then the extension stages", () => {
    expect(plan.leftOut).toEqual(["core:clarity", "core:sharpening", "core:colorNR", "core:grain", "core:masks", "glow"]);
  });

  it("puts spatial extension stages back to their defaults, passes included, and keeps the others", () => {
    expect(plan.edit.bag).toMatchObject({ "glow.k": 1, "glow.radius": 3, "tint.k": 1.2, "warp.k": 1, "lut-tools.look.active": 1 });
    expect(plan.edit.bag).not.toHaveProperty("safelight.basic.tone.k");
  });

  it("takes the unedited photo as it opens: defaults, its as-shot white balance, its process version, spatial tools off", () => {
    expect(plan.plain.params).toMatchObject({ exposure: 0, temperature: 5200, processVersion: 2, sharpening: 0, colorNR: 0 });
    expect(plan.plain.bag).toEqual({});
  });
});

describe("the grid", () => {
  it("lays out cells of CELL_PIXELS a side", () => {
    expect(gridLayout(640, 427)).toEqual({ cellsX: 213, cellsY: 142 });
    expect(gridLayout(2, 2)).toEqual({ cellsX: 1, cellsY: 1 });
    expect(CELL_PIXELS).toBe(3);
  });

  it("numbers its nodes red fastest, up to GRID_TOP", () => {
    expect(gridColour(0, 3)).toEqual([0, 0, 0]);
    expect(gridColour(1, 3)).toEqual([GRID_TOP / 2, 0, 0]);
    expect(gridColour(3, 3)).toEqual([0, GRID_TOP / 2, 0]);
    expect(gridColour(26, 3)).toEqual([GRID_TOP, GRID_TOP, GRID_TOP]);
  });

  it("reads each cell's middle pixel, either way up", () => {
    const layout = { cellsX: 4, cellsY: 2 };
    const frame = fakeFrame(13, 7, layout, (k) => [k, 0, 0], false);
    expect(Array.from(readCells(frame, layout, false)).filter((_, i) => i % 3 === 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const upside = fakeFrame(13, 7, layout, (k) => [k, 0, 0], true);
    expect(Array.from(readCells(upside, layout, true)).filter((_, i) => i % 3 === 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("invertLattice", () => {
  it("finds the position of a value on a curved, monotone lattice", () => {
    const u = cubeFrom(9, (r, g, b) => [Math.pow(r, 0.8) * 0.9, 0.1 + 0.8 * g * g, b * 0.95 + 0.02 * r]);
    for (const p of [[0.3, 0.5, 0.4], [0.05, 0.12, 0.9], [0.85, 0.85, 0.2]] as Vec3[]) {
      const { t, residual } = invertLattice(u.data, 9, p, p);
      expect(residual).toBeLessThan(1e-9);
      const back = sampleLattice(u.data, 9, t).value;
      back.forEach((v, i) => expect(v).toBeCloseTo(p[i], 9));
    }
  });

  it("goes past the lattice's edge along its last slope", () => {
    const u = cubeFrom(5, (r, g, b) => [r * 0.9, g * 0.9, b * 0.9]);
    const { t, residual } = invertLattice(u.data, 5, [1, 0.45, 0.45], [1, 0.5, 0.5]);
    expect(residual).toBeLessThan(1e-9);
    expect(t[0]).toBeCloseTo(1 / 0.9, 9);
  });
});

/** A frame with node k's colour fn(k) over its whole cell. */
function fakeFrame(width: number, height: number, layout: { cellsX: number; cellsY: number }, fn: (k: number) => Vec3, flipped: boolean): FloatFrame {
  const data = new Float32Array(4 * width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const vy = (flipped ? height - 1 - y : y) + 0.5;
      const cx = Math.min(layout.cellsX - 1, Math.floor(((x + 0.5) / width) * layout.cellsX));
      const cy = Math.min(layout.cellsY - 1, Math.floor((vy / height) * layout.cellsY));
      const v = fn(cy * layout.cellsX + cx);
      data.set([v[0], v[1], v[2], 1], 4 * (y * width + x));
    }
  return { data, width, height, space: { encoding: "perceptual", primaries: "rec709" }, point: "pre-output" };
}

describe("bakeLook on a simulated pipeline", () => {
  // The unedited rendering: a shoulder above 0.8, like a RAW's; the edit a
  // warm, contrasty grade on top of it.
  const shoulder = (x: number): number => (x < 0.8 ? x : 0.8 + 0.2 * Math.tanh((x - 0.8) / 0.2));
  const plainFn = (g: Vec3): Vec3 => g.map(shoulder) as Vec3;
  const editFn = (g: Vec3): Vec3 => {
    const u = plainFn(g);
    return [Math.min(1.1, u[0] * 1.08 + 0.02), u[1] * u[1] * 0.3 + u[1] * 0.7, u[2] * 0.85];
  };

  function renderer(flipped: boolean, frames: { count: number }): FrameRenderer {
    return async (params, bag) => {
      frames.count++;
      const size = bag[bakeKey("gridSize")] as number;
      const [cellsX, cellsY] = bag[bakeKey("gridCells")] as [number, number];
      const start = bag[bakeKey("gridStart")] as number;
      const fn = params.exposure === 0 ? plainFn : editFn;
      return fakeFrame(97, 64, { cellsX, cellsY }, (k) => (start + k < size ** 3 ? fn(gridColour(start + k, size)) : [0, 0, 0]), flipped);
    };
  }

  const plan = planBake(
    { params: { ...DEFAULTS, exposure: 1 }, bag: {}, stages: [], asShotTemperature: undefined },
    helpers,
  );

  it.each([false, true])("maps the unedited rendering to the edited one (frame flipped: %s)", async (flipped) => {
    const frames = { count: 0 };
    const progress: number[] = [];
    const result = await bakeLook(plan, 17, renderer(flipped, frames), (f) => progress.push(f));
    expect(frames.count).toBe(2 + 2 * Math.ceil(17 ** 3 / (32 * 21)));
    expect(progress.at(-1)).toBeCloseTo(1, 9);
    let worst = 0;
    for (const x of [[0.1, 0.4, 0.7], [0.5, 0.5, 0.5], [0.9, 0.2, 0.6], [0.02, 0.98, 0.33], [0.75, 0.6, 0.05]] as Vec3[]) {
      const got = evalCube(result.table, plainFn(x));
      const want = editFn(x);
      worst = Math.max(worst, ...got.map((v, i) => Math.abs(v - want[i])));
    }
    expect(worst).toBeLessThan(2e-3);
  });
});
