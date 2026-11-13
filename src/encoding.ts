// The encodings a LUT can expect on input and produce on output. The stage
// receives the photo sRGB-encoded (signed, so out-of-gamut and above-white
// values survive), turns it into display light and encodes it as the LUT
// wants; the LUT's output is decoded from its encoding back to light and
// returned sRGB-encoded. Each curve keeps the sign, like the stage's space.
// The GLSL in stage.ts is a line-for-line copy of these.

export const ENCODINGS = [
  { id: 0, label: "sRGB" },
  { id: 1, label: "Rec.709 (gamma 2.4)" },
  { id: 2, label: "Gamma 2.2" },
  { id: 3, label: "Linear" },
] as const;

export type EncodingId = (typeof ENCODINGS)[number]["id"];

export const SRGB: EncodingId = 0;

export function isEncoding(x: unknown): x is EncodingId {
  return ENCODINGS.some((e) => e.id === x);
}

function decodeMagnitude(a: number, enc: EncodingId): number {
  switch (enc) {
    case 0:
      return a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
    case 1:
      return Math.pow(a, 2.4);
    case 2:
      return Math.pow(a, 2.2);
    case 3:
      return a;
  }
}

function encodeMagnitude(a: number, enc: EncodingId): number {
  switch (enc) {
    case 0:
      return a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
    case 1:
      return Math.pow(a, 1 / 2.4);
    case 2:
      return Math.pow(a, 1 / 2.2);
    case 3:
      return a;
  }
}

/** Encoded value to light, sign kept. */
export const decode = (v: number, enc: EncodingId): number => Math.sign(v) * decodeMagnitude(Math.abs(v), enc);

/** Light to encoded value, sign kept. */
export const encode = (v: number, enc: EncodingId): number => Math.sign(v) * encodeMagnitude(Math.abs(v), enc);
