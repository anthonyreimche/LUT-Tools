// Exporting a photo's look as a LUT.
//
// A LUT can only hold what happens to a colour wherever it is in the frame,
// so the edit is rendered with its spatial tools neutral: sharpening, noise
// reduction, texture, clarity, dehaze, Highlights and Shadows (local on
// current photos, and coupled to a detail band on older ones), masks,
// healing, vignette, grain, geometry, and every extension stage that looks
// at neighbouring pixels or at the pixel's place. What was left out is
// reported.
//
// The bake stage replaces each pixel's colour, right after the photo is
// decoded, with a node of an identity grid chosen by where the pixel sits,
// so one small render turns thousands of grid colours into what the edit
// makes of them. The grid is rendered twice: through the edit (E) and
// through the photo as it opens unedited (U). The LUT is applied after the
// display transform to a photo's unedited rendering, so it must map U's
// output to E's: node p of the LUT is E(U⁻¹(p)), U inverted numerically on
// its own lattice. On a JPEG U is close to the identity; on a RAW it holds
// the camera baseline and the core shoulder, which the photo already has.
//
// The grid stops at 0.99 rather than 1: RAW highlight reconstruction treats
// linear values at 0.98 and above as clipped and would mix the photo's own
// pixels into them. The last sliver to 1 is continued along the lattice's
// edge, as the stage itself continues past a domain.

import { sampleLattice, type Table, type Vec3 } from "./lut";
import { BAKE_STAGE_ID, EXT_ID } from "./params";
import { bakeKey } from "./stage";
import type { DevelopParams, FloatFrame, ProcessingStageContribution } from "./safelight";

export const GRID_TOP = 0.99;
/** A grid cell is this many frame pixels a side, so the one read from its
 *  middle is the cell's own colour however the frame was resampled. */
export const CELL_PIXELS = 3;

type Bag = Record<string, unknown>;

/** The core params a LUT can't hold. */
const SPATIAL_FIELDS = [
  "highlights",
  "shadows",
  "highlightDetail",
  "shadowDetail",
  "texture",
  "clarity",
  "dehaze",
  "sharpening",
  "luminanceNR",
  "colorNR",
] as const satisfies readonly (keyof DevelopParams)[];

const STRUCTURED_FIELDS = [
  "vignette",
  "grain",
  "masks",
  "retouch",
  "crop",
  "straighten",
  "transform",
  "uprightMode",
  "guidedLines",
] as const satisfies readonly (keyof DevelopParams)[];

const SPATIAL_GLSL = /\b(srcUv|sensorUv|vUv|gl_FragCoord|uImage|readSource|stageResult|uImageAspect|rawLuma|lumaLod|uViewport)\b/;

/** Reads of the image in a pass: anywhere, and on the first pass the
 *  previous draw, which is the stage's input there. */
const PASS_IMAGE_READS = /\b(readSource|fetchInput)\b/;
const FIRST_PASS_READS = /\b(readPrev|readPrev4|fetchPrev4)\b/;

const passText = (p: { glsl: string; helpers?: string }): string => `${p.glsl}\n${p.helpers ?? ""}`;

/** A stage whose result depends on more than the pixel's own colour. A
 *  stage whose passes only build a table from its settings, never reading
 *  the image, isn't. */
export function isSpatialStage(stage: ProcessingStageContribution): boolean {
  if (stage.phase === "geometry") return true;
  const passes = stage.passes ?? [];
  if (passes.some((p) => PASS_IMAGE_READS.test(passText(p)))) return true;
  if (passes.length > 0 && FIRST_PASS_READS.test(passText(passes[0]))) return true;
  if ((stage.textures ?? []).some((t) => t.kind === "coverage" || t.kind === "paint" || t.kind === "atlas")) return true;
  return SPATIAL_GLSL.test(stage.glsl) || SPATIAL_GLSL.test(stage.helpers ?? "");
}

export interface BakeInputs {
  params: DevelopParams;
  bag: Bag;
  /** Every registered stage, with its owner. */
  stages: readonly (ProcessingStageContribution & { extensionId: string })[];
  asShotTemperature: number | undefined;
}

export interface BakeHelpers {
  normalizeParams(p: Partial<DevelopParams>): DevelopParams;
  /** Core's names for the params in `p` that differ from the defaults. */
  summarize(p: Partial<DevelopParams>): { label: string }[];
  /** Whether the stage's values are the photo's params (Safelight's own
   *  stages), not bag entries. */
  isOfficial(extensionId: string): boolean;
}

export interface BakePlan {
  edit: { params: DevelopParams; bag: Bag };
  plain: { params: DevelopParams; bag: Bag };
  /** What the LUT leaves out, in the names the app shows them by. */
  leftOut: string[];
}

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** The params with every tool a LUT can't hold switched off. */
function neutralFields(defaults: DevelopParams): Partial<DevelopParams> {
  const neutral: Partial<DevelopParams> = {};
  for (const key of SPATIAL_FIELDS) neutral[key] = 0;
  for (const key of STRUCTURED_FIELDS) Object.assign(neutral, { [key]: defaults[key] });
  neutral.vignette = { ...defaults.vignette, amount: 0 };
  neutral.grain = { ...defaults.grain, amount: 0 };
  return neutral;
}

export function planBake(inputs: BakeInputs, helpers: BakeHelpers): BakePlan {
  const defaults = helpers.normalizeParams({ processVersion: inputs.params.processVersion });
  const neutral = neutralFields(defaults);
  const leftOut: string[] = [];
  for (const key of Object.keys(neutral) as (keyof DevelopParams)[]) {
    if (!differs(inputs.params[key], neutral[key])) continue;
    // Core names a field only where it differs from its default; one left
    // at a default that isn't neutral (Sharpening's) is named by its neutral.
    const named = helpers.summarize({ [key]: inputs.params[key] });
    const label = (named.length > 0 ? named : helpers.summarize({ [key]: neutral[key] }))[0]?.label;
    if (label && !leftOut.includes(label)) leftOut.push(label);
  }

  const bag: Bag = { ...inputs.bag };
  for (const stage of inputs.stages) {
    if (stage.id === BAKE_STAGE_ID || stage.extensionId === EXT_ID) continue;
    if (helpers.isOfficial(stage.extensionId) || !isSpatialStage(stage)) continue;
    let touched = false;
    for (const u of [...stage.uniforms, ...(stage.passes ?? []).flatMap((p) => p.uniforms ?? [])]) {
      const key = `${stage.id}.${u.key}`;
      if (key in bag && differs(bag[key], u.default)) touched = true;
      bag[key] = u.default;
    }
    for (const t of stage.textures ?? []) {
      if (t.kind === "coverage" || t.kind === "paint") {
        const key = `${stage.id}.${t.key}`;
        if (Array.isArray(bag[key]) && (bag[key] as unknown[]).length > 0) touched = true;
        delete bag[key];
      }
    }
    if (touched && !leftOut.includes(stage.name)) leftOut.push(stage.name);
  }

  const plain = helpers.normalizeParams({ temperature: inputs.asShotTemperature, processVersion: inputs.params.processVersion });
  return {
    edit: { params: { ...inputs.params, ...neutral }, bag },
    plain: { params: { ...plain, ...neutral }, bag: {} },
    leftOut,
  };
}

export interface GridLayout {
  cellsX: number;
  cellsY: number;
}

export function gridLayout(width: number, height: number): GridLayout {
  return { cellsX: Math.max(1, Math.floor(width / CELL_PIXELS)), cellsY: Math.max(1, Math.floor(height / CELL_PIXELS)) };
}

/** The bag entries that turn the grid on for one render. */
export function gridPatch(size: number, layout: GridLayout, start: number): Bag {
  return {
    [bakeKey("bake")]: 1,
    [bakeKey("gridSize")]: size,
    [bakeKey("gridCells")]: [layout.cellsX, layout.cellsY],
    [bakeKey("gridStart")]: start,
    [bakeKey("gridTop")]: GRID_TOP,
  };
}

/** The grid colour of node k, as the bake stage computes it. */
export function gridColour(k: number, size: number): Vec3 {
  const s = GRID_TOP / (size - 1);
  return [(k % size) * s, (Math.floor(k / size) % size) * s, Math.floor(k / (size * size)) * s];
}

/** The colour at the middle of each cell, cell by cell, rows of cells from
 *  vUv's y = 0, which is the frame's first row unless `flipped`. */
export function readCells(frame: FloatFrame, layout: GridLayout, flipped: boolean): Float64Array {
  const out = new Float64Array(3 * layout.cellsX * layout.cellsY);
  for (let cy = 0; cy < layout.cellsY; cy++) {
    const y0 = Math.floor(((cy + 0.5) * frame.height) / layout.cellsY);
    const y = flipped ? frame.height - 1 - y0 : y0;
    for (let cx = 0; cx < layout.cellsX; cx++) {
      const x = Math.floor(((cx + 0.5) * frame.width) / layout.cellsX);
      const at = 4 * (y * frame.width + x);
      const k = 3 * (cy * layout.cellsX + cx);
      out[k] = frame.data[at];
      out[k + 1] = frame.data[at + 1];
      out[k + 2] = frame.data[at + 2];
    }
  }
  return out;
}

function solve3(a: number[], b: Vec3): Vec3 | null {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const det = a0 * (a4 * a8 - a5 * a7) - a1 * (a3 * a8 - a5 * a6) + a2 * (a3 * a7 - a4 * a6);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const inv = 1 / det;
  return [
    (b[0] * (a4 * a8 - a5 * a7) - a1 * (b[1] * a8 - a5 * b[2]) + a2 * (b[1] * a7 - a4 * b[2])) * inv,
    (a0 * (b[1] * a8 - a5 * b[2]) - b[0] * (a3 * a8 - a5 * a6) + a2 * (a3 * b[2] - b[1] * a6)) * inv,
    (a0 * (a4 * b[2] - b[1] * a7) - a1 * (a3 * b[2] - b[1] * a6) + b[0] * (a3 * a7 - a4 * a6)) * inv,
  ];
}

const sq = (r: Vec3): number => r[0] * r[0] + r[1] * r[1] + r[2] * r[2];

/** The lattice position whose value is `target`: damped Gauss-Newton on the
 *  piecewise-linear lattice, continued past its edges. The closest found
 *  when no position reaches it. */
export function invertLattice(data: ArrayLike<number>, size: number, target: Vec3, start: Vec3): { t: Vec3; residual: number } {
  let t: Vec3 = [...start];
  let s = sampleLattice(data, size, t);
  let r: Vec3 = [s.value[0] - target[0], s.value[1] - target[1], s.value[2] - target[2]];
  let err = sq(r);
  let lambda = 1e-9;
  for (let iter = 0; iter < 60 && err > 1e-16; iter++) {
    const j = s.jac;
    // JᵀJ and Jᵀr, J's column a at j[3a..3a+2].
    const jtj = new Array<number>(9);
    const jtr: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) jtj[3 * a + b] = j[3 * a] * j[3 * b] + j[3 * a + 1] * j[3 * b + 1] + j[3 * a + 2] * j[3 * b + 2];
      jtr[a] = -(j[3 * a] * r[0] + j[3 * a + 1] * r[1] + j[3 * a + 2] * r[2]);
    }
    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const damped = jtj.map((v, i) => (i % 4 === 0 ? v + lambda * (v + 1e-12) : v));
      const step = solve3(damped, jtr);
      if (step) {
        const next: Vec3 = [0, 1, 2].map((a) => Math.min(1.5, Math.max(-0.5, t[a] + step[a]))) as Vec3;
        const ns = sampleLattice(data, size, next);
        const nr: Vec3 = [ns.value[0] - target[0], ns.value[1] - target[1], ns.value[2] - target[2]];
        const nerr = sq(nr);
        if (nerr < err) {
          t = next;
          s = ns;
          r = nr;
          err = nerr;
          lambda = Math.max(lambda * 0.1, 1e-12);
          improved = true;
          continue;
        }
      }
      lambda = Math.max(lambda * 10, 1e-6);
    }
    if (!improved) break;
  }
  return { t, residual: Math.sqrt(err) };
}

export interface ComposeResult {
  table: Table;
  /** The largest |U(x) − p| left at a node: where the unedited rendering
   *  never reaches p (above its white, say), how far off the match is. */
  worstResidual: number;
}

/** The LUT E ∘ U⁻¹ at `size` nodes over [0, 1], U and E sampled on the grid. */
export async function composeLook(
  plain: Float64Array,
  edited: Float64Array,
  size: number,
  onProgress?: (done: number) => void,
): Promise<ComposeResult> {
  const data = new Float64Array(3 * size ** 3);
  let worst = 0;
  const scale = 1 / GRID_TOP;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const p: Vec3 = [r / (size - 1), g / (size - 1), b / (size - 1)];
        const { t, residual } = invertLattice(plain, size, p, [p[0] * scale, p[1] * scale, p[2] * scale]);
        const v = sampleLattice(edited, size, t).value;
        const k = 3 * (r + size * (g + size * b));
        data[k] = v[0];
        data[k + 1] = v[1];
        data[k + 2] = v[2];
        if (residual > worst) worst = residual;
      }
    onProgress?.((b + 1) / size);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { table: { size, lo: [0, 0, 0], hi: [1, 1, 1], data }, worstResidual: worst };
}

/** Renders the photo with `params` and `bag`: pre-output, sRGB-encoded, signed. */
export type FrameRenderer = (params: DevelopParams, bag: Bag) => Promise<FloatFrame | null>;

export interface BakeResult {
  table: Table;
  leftOut: string[];
  worstResidual: number;
}

/** The grid's colours through one set of params, tile by tile. */
async function renderGrid(
  render: FrameRenderer,
  params: DevelopParams,
  bag: Bag,
  size: number,
  layout: GridLayout,
  flipped: boolean,
  onTile: () => void,
): Promise<Float64Array> {
  const nodes = size ** 3;
  const perTile = layout.cellsX * layout.cellsY;
  const out = new Float64Array(3 * nodes);
  for (let start = 0; start < nodes; start += perTile) {
    const frame = await render(params, { ...bag, ...gridPatch(size, layout, start) });
    if (!frame) throw new Error("the photo couldn't be rendered");
    const cells = readCells(frame, layout, flipped);
    out.set(cells.subarray(0, 3 * Math.min(perTile, nodes - start)), 3 * start);
    onTile();
  }
  return out;
}

/** Which way up the frame holds the grid: the unedited rendering of the
 *  first tile lies closer to the grid's own colours one way than the other. */
function isFlipped(frame: FloatFrame, layout: GridLayout, size: number): boolean {
  const misfit = (flipped: boolean): number => {
    const cells = readCells(frame, layout, flipped);
    let e = 0;
    const count = Math.min(layout.cellsX * layout.cellsY, size ** 3);
    for (let k = 0; k < count; k++) {
      const want = gridColour(k, size);
      for (let ch = 0; ch < 3; ch++) e += (cells[3 * k + ch] - want[ch]) ** 2;
    }
    return e;
  };
  return misfit(true) < misfit(false);
}

export async function bakeLook(
  plan: BakePlan,
  size: number,
  render: FrameRenderer,
  onProgress: (fraction: number) => void,
): Promise<BakeResult> {
  const probe = await render(plan.plain.params, { ...plan.plain.bag, ...gridPatch(size, { cellsX: 1, cellsY: 1 }, 0) });
  if (!probe) throw new Error("the photo couldn't be rendered");
  const layout = gridLayout(probe.width, probe.height);
  const first = await render(plan.plain.params, { ...plan.plain.bag, ...gridPatch(size, layout, 0) });
  if (!first) throw new Error("the photo couldn't be rendered");
  const flipped = isFlipped(first, layout, size);
  const tiles = Math.ceil(size ** 3 / (layout.cellsX * layout.cellsY));
  let done = 0;
  const tick = () => onProgress((0.6 * ++done) / (2 * tiles));
  const plain = await renderGrid(render, plan.plain.params, plan.plain.bag, size, layout, flipped, tick);
  const edited = await renderGrid(render, plan.edit.params, plan.edit.bag, size, layout, flipped, tick);
  const composed = await composeLook(plain, edited, size, (f) => onProgress(0.6 + 0.4 * f));
  return { table: composed.table, leftOut: plan.leftOut, worstResidual: composed.worstResidual };
}
