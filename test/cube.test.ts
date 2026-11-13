// The .cube reader and writer, on hand-written files.

import { describe, expect, it } from "vitest";
import { parseCube, writeCube } from "../src/cube";
import { cubeFrom, evalLut, identityCube, type Lut, type Vec3 } from "../src/lut";

const IDENTITY_2 = `# a hand-made identity
TITLE "Two nodes"
LUT_3D_SIZE 2

0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

function ok(text: string, title = "file") {
  const parsed = parseCube(text, title);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

function err(text: string): string {
  const parsed = parseCube(text, "file");
  if (parsed.ok) throw new Error("parsed a malformed file");
  return parsed.error;
}

const look = (r: number, g: number, b: number): Vec3 => [0.05 + 0.9 * r ** 0.8, g * 0.95 + 0.02 * r, 0.1 + 0.8 * b];

describe("parseCube", () => {
  it("reads a hand-made 2-node identity, its title and its domain", () => {
    const { lut, axisOrder } = ok(IDENTITY_2);
    expect(lut.title).toBe("Two nodes");
    expect(lut.shaper).toBeNull();
    expect(lut.cube?.size).toBe(2);
    expect(lut.cube?.lo).toEqual([0, 0, 0]);
    expect(lut.cube?.hi).toEqual([1, 1, 1]);
    expect(Array.from(lut.cube?.data ?? [])).toEqual(Array.from(identityCube(2).data));
    expect(axisOrder).toBe("red-fastest");
  });

  it("leaves any colour where it was through an identity table, inside the domain", () => {
    const { lut } = ok(IDENTITY_2);
    for (const c of [[0.1, 0.5, 0.9], [0, 0, 0], [1, 1, 1], [0.33, 0.66, 0.2]] as Vec3[]) {
      const { value } = evalLut(lut, c);
      value.forEach((v, i) => expect(v).toBeCloseTo(c[i], 12));
    }
  });

  it("takes CRLF and CR line ends, a BOM, blank lines, tabs and trailing comments", () => {
    const text = "﻿TITLE \"x\"\r\nLUT_3D_SIZE\t2 # two\r" + identityCube(2).data.reduce<string[]>((rows, _v, i, d) => {
      if (i % 3 === 0) rows.push(`${d[i]}\t${d[i + 1]}  ${d[i + 2]} # node`);
      return rows;
    }, []).join("\r\n");
    expect(ok(text).lut.cube?.size).toBe(2);
  });

  it("uses the file name when there is no TITLE", () => {
    expect(ok(IDENTITY_2.replace('TITLE "Two nodes"\n', ""), "From the name").lut.title).toBe("From the name");
  });

  it("reads DOMAIN_MIN and DOMAIN_MAX", () => {
    const lut: Lut = { title: "d", shaper: null, cube: identityCube(3, [-0.5, 0, 0], [1.5, 2, 4]) };
    const back = ok(writeCube(lut)).lut.cube;
    expect(back?.lo).toEqual([-0.5, 0, 0]);
    expect(back?.hi).toEqual([1.5, 2, 4]);
  });

  it("reads a 1D table", () => {
    const text = `LUT_1D_SIZE 3
DOMAIN_MIN 0 0 0
DOMAIN_MAX 2 2 2
0 0 0
0.25 0.5 1
1 1 1
`;
    const { lut } = ok(text);
    expect(lut.cube).toBeNull();
    expect(lut.shaper?.size).toBe(3);
    expect(evalLut(lut, [0.5, 1, 1.5]).value).toEqual([0.125, 0.5, 1]);
  });

  it("reads a 1D shaper ahead of a 3D table, each with its input range", () => {
    const shaper = Array.from({ length: 4 }, (_, i) => `${(i / 3) ** 0.5} ${(i / 3) ** 0.5} ${(i / 3) ** 0.5}`);
    const cube = cubeFrom(2, (r, g, b) => [r, g, b]);
    const rows = [];
    for (let i = 0; i < cube.data.length; i += 3) rows.push(`${cube.data[i]} ${cube.data[i + 1]} ${cube.data[i + 2]}`);
    const text = ["LUT_1D_SIZE 4", "LUT_3D_SIZE 2", "LUT_1D_INPUT_RANGE 0 4", "LUT_3D_INPUT_RANGE 0 1", ...shaper, ...rows].join("\n");
    const { lut } = ok(text);
    expect(lut.shaper?.hi).toEqual([4, 4, 4]);
    expect(lut.cube?.hi).toEqual([1, 1, 1]);
    const v = evalLut(lut, [4 / 3, 4 / 3, 4 / 3]).value;
    v.forEach((x) => expect(x).toBeCloseTo(Math.sqrt(1 / 3), 12));
  });

  it("skips keywords it doesn't know", () => {
    expect(ok(IDENTITY_2.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_SOMETHING_NEW 5 a")).lut.cube?.size).toBe(2);
  });

  it("reads a blue-fastest file the right way round", () => {
    const want = cubeFrom(5, look);
    const rows: string[] = ["LUT_3D_SIZE 5"];
    for (let r = 0; r < 5; r++)
      for (let g = 0; g < 5; g++)
        for (let b = 0; b < 5; b++) {
          const v = look(r / 4, g / 4, b / 4);
          rows.push(v.join(" "));
        }
    const parsed = ok(rows.join("\n"));
    expect(parsed.axisOrder).toBe("blue-fastest");
    parsed.lut.cube?.data.forEach((v, i) => expect(v).toBeCloseTo(want.data[i], 12));
  });

  it("keeps the specification's order for a table that can't tell (black and white)", () => {
    const grey = cubeFrom(5, (r, g, b) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [y, y, y];
    });
    expect(ok(writeCube({ title: "bw", shaper: null, cube: grey })).axisOrder).toBe("red-fastest");
  });
});

describe("parseCube refuses malformed files", () => {
  const body = identityCube(2).data.reduce<string[]>((rows, _v, i, d) => {
    if (i % 3 === 0) rows.push(`${d[i]} ${d[i + 1]} ${d[i + 2]}`);
    return rows;
  }, []);
  const file = (head: string[], rows = body) => [...head, ...rows].join("\n");

  it.each([
    ["no size", file([]), /LUT_1D_SIZE or LUT_3D_SIZE/],
    ["too few entries", file(["LUT_3D_SIZE 2"], body.slice(0, 7)), /7 entries where its size calls for 8/],
    ["too many entries", file(["LUT_3D_SIZE 2"], [...body, "0 0 0"]), /more entries than its size calls for/],
    ["a bad number", file(["LUT_3D_SIZE 2"], [...body.slice(0, 7), "1 one 1"]), /line 9 isn't three numbers/],
    ["two numbers on a line", file(["LUT_3D_SIZE 2"], [...body.slice(0, 7), "1 1"]), /line 9 needs three numbers/],
    ["a NaN", file(["LUT_3D_SIZE 2"], [...body.slice(0, 7), "1 NaN 1"]), /line 9 isn't three numbers/],
    ["a keyword after the data", `${file(["LUT_3D_SIZE 2"])}\nDOMAIN_MIN 0 0 0`, /comes after the table data/],
    ["a size given twice", file(["LUT_3D_SIZE 2", "LUT_3D_SIZE 2"]), /given twice/],
    ["a size of 1", file(["LUT_3D_SIZE 1"]), /from 2 to 256/],
    ["a size of 300", file(["LUT_3D_SIZE 300"]), /from 2 to 256/],
    ["a fractional size", file(["LUT_3D_SIZE 2.5"]), /whole number/],
    ["an empty domain", file(["LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 1", "DOMAIN_MAX 1 1 1"]), /DOMAIN_MIN must be below DOMAIN_MAX/],
    ["a two-number domain", file(["LUT_3D_SIZE 2", "DOMAIN_MIN 0 0"]), /needs three numbers/],
    ["a backwards input range", file(["LUT_3D_SIZE 2", "LUT_3D_INPUT_RANGE 1 0"]), /lower to a higher/],
    ["an input range for a missing table", file(["LUT_3D_SIZE 2", "LUT_1D_INPUT_RANGE 0 1"]), /without a 1D table/],
    ["video range", file(["LUT_3D_SIZE 2", "LUT_IN_VIDEO_RANGE"]), /video-range LUTs aren't supported/],
    ["prose", "Hello, this is not a LUT", /isn't a keyword or a table entry/],
    ["data before the size", file([], [...body, "LUT_3D_SIZE 2"]), /starts on line 1 before LUT_1D_SIZE/],
  ])("%s", (_name, text, message) => {
    expect(err(text)).toMatch(message);
  });
});

describe("writeCube", () => {
  it("writes what parseCube reads back to six decimals", () => {
    const lut: Lut = { title: 'My "look"', shaper: null, cube: cubeFrom(7, look) };
    const back = ok(writeCube(lut, ["Made with LUT Tools"])).lut;
    expect(back.title).toBe("My 'look'");
    back.cube?.data.forEach((v, i) => expect(Math.abs(v - (lut.cube?.data[i] ?? 0))).toBeLessThanOrEqual(5e-7));
  });

  it("starts with the comments and the header lines", () => {
    const text = writeCube({ title: "t", shaper: null, cube: identityCube(2) }, ["one"]);
    expect(text.split("\n").slice(0, 5)).toEqual([
      "# one",
      'TITLE "t"',
      "LUT_3D_SIZE 2",
      "DOMAIN_MIN 0.000000 0.000000 0.000000",
      "DOMAIN_MAX 1.000000 1.000000 1.000000",
    ]);
  });

  it("writes an identity table that reads back as an exact identity", () => {
    const back = ok(writeCube({ title: "id", shaper: null, cube: identityCube(17) })).lut.cube;
    back?.data.forEach((v, i) => expect(Math.abs(v - identityCube(17).data[i])).toBeLessThanOrEqual(5e-7));
  });
});
