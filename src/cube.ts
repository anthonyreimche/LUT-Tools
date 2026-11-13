// .cube files: the Adobe Cube LUT Specification 1.0 (a 1D or a 3D table,
// DOMAIN_MIN / DOMAIN_MAX) plus the common extension that puts a 1D shaper
// in front of a 3D table, with LUT_1D_INPUT_RANGE / LUT_3D_INPUT_RANGE.
//
// Keywords come before the data, the 1D table's lines before the 3D table's,
// and 3D lines run red fastest, then green, then blue. A few writers emit
// blue fastest; such a file is recognized by its outputs following the
// wrong axes and read the other way round. A file that doesn't follow the
// format is refused with the line that broke it, never read as a guess.

import { MAX_SHAPER_SIZE, type Lut, type Table, type Vec3 } from "./lut";

export type Parsed = { ok: true; lut: Lut; axisOrder: "red-fastest" | "blue-fastest" } | { ok: false; error: string };

const MAX_3D_SIZE = 256;

const fail = (error: string): Parsed => ({ ok: false, error });

function triple(tokens: string[], line: number, what: string): Vec3 | string {
  if (tokens.length !== 3) return `${what} on line ${line} needs three numbers`;
  const v = tokens.map(Number);
  if (!v.every(Number.isFinite)) return `${what} on line ${line} isn't three numbers`;
  return [v[0], v[1], v[2]];
}

function range(tokens: string[], line: number, what: string): [number, number] | string {
  if (tokens.length !== 2) return `${what} on line ${line} needs two numbers`;
  const v = tokens.map(Number);
  if (!v.every(Number.isFinite)) return `${what} on line ${line} isn't two numbers`;
  if (!(v[0] < v[1])) return `${what} on line ${line} must run from a lower to a higher value`;
  return [v[0], v[1]];
}

function size(tokens: string[], line: number, what: string, max: number): number | string {
  const n = tokens.length === 1 ? Number(tokens[0]) : NaN;
  if (!Number.isInteger(n) || n < 2 || n > max) return `${what} on line ${line} must be a whole number from 2 to ${max}`;
  return n;
}

function pearson(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Whether a red-fastest reading of `data` has its red and blue outputs
 *  following the blue and red axes instead: a blue-fastest file. */
export function looksBlueFastest(data: Float64Array, n: number): boolean {
  if (n < 3) return false;
  const count = n * n * n;
  const fast = new Float64Array(count);
  const slow = new Float64Array(count);
  const outR = new Float64Array(count);
  const outB = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    fast[k] = k % n;
    slow[k] = Math.floor(k / (n * n));
    outR[k] = data[3 * k];
    outB[k] = data[3 * k + 2];
  }
  const asWritten = pearson(outR, fast) + pearson(outB, slow);
  const swapped = pearson(outR, slow) + pearson(outB, fast);
  return swapped > asWritten + 0.5;
}

/** The same table read with red and blue indices exchanged. */
export function swapRedBlueAxes(data: Float64Array, n: number): Float64Array {
  const out = new Float64Array(data.length);
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const from = 3 * (b + n * (g + n * r));
        const to = 3 * (r + n * (g + n * b));
        out[to] = data[from];
        out[to + 1] = data[from + 1];
        out[to + 2] = data[from + 2];
      }
  return out;
}

export function parseCube(text: string, fallbackTitle: string): Parsed {
  let title: string | null = null;
  let size1: number | null = null;
  let size3: number | null = null;
  let domainMin: Vec3 | null = null;
  let domainMax: Vec3 | null = null;
  let range1: [number, number] | null = null;
  let range3: [number, number] | null = null;
  const seen = new Set<string>();
  let values = new Float64Array(0);
  let count = 0;
  let dataStarted = false;

  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i].trim();
    if (line.startsWith("TITLE")) {
      if (dataStarted) return fail(`TITLE on line ${lineNo} comes after the table data`);
      if (seen.has("TITLE")) return fail(`TITLE is given twice (line ${lineNo})`);
      seen.add("TITLE");
      const rest = line.slice(5).trim();
      const quoted = /^"([^"]*)"/.exec(rest);
      title = (quoted ? quoted[1] : rest.split("#")[0]).trim();
      continue;
    }
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash).trim();
    if (line === "") continue;
    const tokens = line.split(/\s+/);
    const head = tokens[0];

    if (/^[-+.\d]/.test(head)) {
      if (!dataStarted) {
        dataStarted = true;
        if (size1 === null && size3 === null) return fail(`Table data starts on line ${lineNo} before LUT_1D_SIZE or LUT_3D_SIZE`);
        values = new Float64Array(3 * ((size1 ?? 0) + (size3 ?? 0) ** 3));
      }
      const v = triple(tokens, lineNo, "The table entry");
      if (typeof v === "string") return fail(v);
      if (count + 3 > values.length) return fail(`The table has more entries than its size calls for (line ${lineNo})`);
      values[count++] = v[0];
      values[count++] = v[1];
      values[count++] = v[2];
      continue;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(head)) return fail(`Line ${lineNo} isn't a keyword or a table entry: "${line.slice(0, 40)}"`);
    if (dataStarted) return fail(`${head} on line ${lineNo} comes after the table data`);
    if (seen.has(head)) return fail(`${head} is given twice (line ${lineNo})`);
    seen.add(head);
    const args = tokens.slice(1);
    switch (head) {
      case "LUT_1D_SIZE": {
        const n = size(args, lineNo, head, MAX_SHAPER_SIZE);
        if (typeof n === "string") return fail(n);
        size1 = n;
        break;
      }
      case "LUT_3D_SIZE": {
        const n = size(args, lineNo, head, MAX_3D_SIZE);
        if (typeof n === "string") return fail(n);
        size3 = n;
        break;
      }
      case "DOMAIN_MIN":
      case "DOMAIN_MAX": {
        const v = triple(args, lineNo, head);
        if (typeof v === "string") return fail(v);
        if (head === "DOMAIN_MIN") domainMin = v;
        else domainMax = v;
        break;
      }
      case "LUT_1D_INPUT_RANGE":
      case "LUT_3D_INPUT_RANGE": {
        const r = range(args, lineNo, head);
        if (typeof r === "string") return fail(r);
        if (head === "LUT_1D_INPUT_RANGE") range1 = r;
        else range3 = r;
        break;
      }
      case "LUT_IN_VIDEO_RANGE":
      case "LUT_OUT_VIDEO_RANGE":
        return fail(`${head} (line ${lineNo}): video-range LUTs aren't supported`);
      default:
        // The specification lets readers skip keywords they don't know.
        break;
    }
  }

  if (size1 === null && size3 === null) return fail("The file names no LUT_1D_SIZE or LUT_3D_SIZE");
  if (range1 && size1 === null) return fail("LUT_1D_INPUT_RANGE is given without a 1D table");
  if (range3 && size3 === null) return fail("LUT_3D_INPUT_RANGE is given without a 3D table");
  const lo: Vec3 = domainMin ?? [0, 0, 0];
  const hi: Vec3 = domainMax ?? [1, 1, 1];
  for (let a = 0; a < 3; a++) {
    if (!(lo[a] < hi[a])) return fail("DOMAIN_MIN must be below DOMAIN_MAX in every channel");
  }
  const expected = (size1 ?? 0) + (size3 ?? 0) ** 3;
  const found = count / 3;
  if (found !== expected) {
    return fail(`The table has ${found} entries where its size${size1 && size3 ? "s call" : " calls"} for ${expected}`);
  }

  const table = (n: number, from: number, entries: number, r: [number, number] | null): Table => ({
    size: n,
    lo: r ? [r[0], r[0], r[0]] : [...lo],
    hi: r ? [r[1], r[1], r[1]] : [...hi],
    data: values.slice(3 * from, 3 * (from + entries)),
  });
  const shaper = size1 !== null ? table(size1, 0, size1, range1) : null;
  let cube = size3 !== null ? table(size3, size1 ?? 0, size3 ** 3, range3) : null;
  let axisOrder: "red-fastest" | "blue-fastest" = "red-fastest";
  if (cube && looksBlueFastest(cube.data, cube.size)) {
    cube = { ...cube, data: swapRedBlueAxes(cube.data, cube.size) };
    axisOrder = "blue-fastest";
  }
  return { ok: true, lut: { title: title || fallbackTitle, shaper, cube }, axisOrder };
}

const num = (v: number): string => {
  const s = (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
  return s === "-0.000000" ? "0.000000" : s;
};

/** A one-table LUT as .cube text, red fastest. */
export function writeCube(lut: Lut, comments: readonly string[] = []): string {
  if (lut.shaper && lut.cube) throw new Error("writeCube writes one table");
  const t = lut.cube ?? lut.shaper;
  if (!t) throw new Error("a LUT without a table");
  const out: string[] = comments.map((c) => `# ${c}`);
  out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  out.push(lut.cube ? `LUT_3D_SIZE ${t.size}` : `LUT_1D_SIZE ${t.size}`);
  out.push(`DOMAIN_MIN ${t.lo.map(num).join(" ")}`);
  out.push(`DOMAIN_MAX ${t.hi.map(num).join(" ")}`);
  for (let i = 0; i < t.data.length; i += 3) out.push(`${num(t.data[i])} ${num(t.data[i + 1])} ${num(t.data[i + 2])}`);
  return `${out.join("\n")}\n`;
}
