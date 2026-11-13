// The param-bag contract. A photo's LUT is stored in its edit as the LUT's
// key and layout plus the settings the panel shows, under the look stage's
// qualified keys, so copy and paste and presets carry a LUT like any other
// adjustment. The table itself stays in the library: an edit takes a few
// dozen numbers rather than the hundreds of kilobytes a table does, and a
// photo whose LUT has left the library draws without it and says so.
// `active` is 0 without a LUT or at 0% strength, which lets the renderer
// leave the stage out of the program.
//
// The LUT's key and its layout's signature are 31-bit numbers, which an
// `int` uniform can't carry: a fragment shader's ints are mediump unless
// declared otherwise, 16 bits on some GPUs. The edit holds each as two 16-bit
// halves in a vec2, exact in a highp float (idToUniform). The atlas page that
// holds the LUT follows from its key and is named under the texture's key,
// which picks the page's texture for the photo.

import { SRGB, isEncoding, type EncodingId } from "./encoding";
import { pageName, pageOf, type LutLayout } from "./pack";

export const EXT_ID = "lut-tools";
export const LOOK_STAGE_ID = `${EXT_ID}.look`;
export const BAKE_STAGE_ID = `${EXT_ID}.bake`;

export const LOOK_KEYS = [
  "active",
  "lut",
  "sig",
  "strength",
  "inEnc",
  "outEnc",
  "kind",
  "n3",
  "n1",
  "lo3",
  "hi3",
  "lo1",
  "hi1",
  "range3",
  "range1",
] as const;
export type LookKey = (typeof LOOK_KEYS)[number];

export const qualified = (key: LookKey): string => `${LOOK_STAGE_ID}.${key}`;

/** Not a uniform: the LUT's name, so a photo whose LUT is missing can say which. */
export const NAME_KEY = `${LOOK_STAGE_ID}.name`;

/** The look stage's texture: the atlas page that holds the photo's LUT. */
export const ATLAS_KEY = "atlas";
/** Not a uniform: the name of the atlas page the photo's LUT is in. */
export const PAGE_KEY = `${LOOK_STAGE_ID}.${ATLAS_KEY}`;

/** A key or signature (an integer from 0 to 2³¹ − 1) as the vec2 uniform
 *  that carries it: its high and low 16 bits. */
export function idToUniform(id: number): [number, number] {
  return [Math.floor(id / 65536), id % 65536];
}

const isHalf = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff;

/** The key or signature a vec2 uniform carries; 0 for anything else. */
export function idFromUniform(v: unknown): number {
  if (!Array.isArray(v) || v.length !== 2 || !isHalf(v[0]) || !isHalf(v[1]) || v[0] > 0x7fff) return 0;
  return v[0] * 65536 + v[1];
}

export interface LookSettings {
  strength: number;
  inEnc: EncodingId;
  outEnc: EncodingId;
}

export const DEFAULT_SETTINGS: LookSettings = { strength: 1, inEnc: SRGB, outEnc: SRGB };

/** The patch that puts a LUT on a photo, with these settings. */
export function applyPatch(key: number, sig: number, layout: LutLayout, name: string, s: LookSettings): Record<string, unknown> {
  return {
    [qualified("active")]: s.strength > 0 ? 1 : 0,
    [qualified("lut")]: idToUniform(key),
    [qualified("sig")]: idToUniform(sig),
    [qualified("strength")]: s.strength,
    [qualified("inEnc")]: s.inEnc,
    [qualified("outEnc")]: s.outEnc,
    [qualified("kind")]: layout.kind,
    [qualified("n3")]: layout.n3,
    [qualified("n1")]: layout.n1,
    [qualified("lo3")]: [...layout.lo3],
    [qualified("hi3")]: [...layout.hi3],
    [qualified("lo1")]: [...layout.lo1],
    [qualified("hi1")]: [...layout.hi1],
    [qualified("range3")]: [...layout.range3],
    [qualified("range1")]: [...layout.range1],
    [NAME_KEY]: name,
    [PAGE_KEY]: pageName(pageOf(key)),
  };
}

/** The patch that takes the LUT off: every key cleared, back to defaults. */
export function removePatch(): Record<string, undefined> {
  const patch: Record<string, undefined> = { [NAME_KEY]: undefined, [PAGE_KEY]: undefined };
  for (const key of LOOK_KEYS) patch[qualified(key)] = undefined;
  return patch;
}

/** The patch for new settings on the photo's LUT. */
export function settingsPatch(key: number, s: LookSettings): Record<string, unknown> {
  return {
    [qualified("strength")]: s.strength,
    [qualified("inEnc")]: s.inEnc,
    [qualified("outEnc")]: s.outEnc,
    [qualified("active")]: key !== 0 && s.strength > 0 ? 1 : 0,
  };
}

export interface PhotoLook {
  /** 0 for none. */
  key: number;
  sig: number;
  name: string | null;
  settings: LookSettings;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** What a photo's bag says about its LUT, each value read as the GPU binds it. */
export function readLook(get: (qualifiedKey: string) => unknown): PhotoLook {
  const inEnc = get(qualified("inEnc"));
  const outEnc = get(qualified("outEnc"));
  const name = get(NAME_KEY);
  return {
    key: idFromUniform(get(qualified("lut"))),
    sig: idFromUniform(get(qualified("sig"))),
    name: typeof name === "string" ? name : null,
    settings: {
      strength: Math.min(1, Math.max(0, num(get(qualified("strength")), 1))),
      inEnc: isEncoding(inEnc) ? inEnc : SRGB,
      outEnc: isEncoding(outEnc) ? outEnc : SRGB,
    },
  };
}
