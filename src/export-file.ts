// The files a baked look is saved as.

import { writeCube } from "./cube";
import { haldPixels } from "./hald";
import type { Table } from "./lut";
import { encodePng16 } from "./png";

export const EXPORT_FORMATS = [
  { id: "cube-17", label: ".cube, 17 points", size: 17, hald: 0 },
  { id: "cube-33", label: ".cube, 33 points", size: 33, hald: 0 },
  { id: "cube-65", label: ".cube, 65 points", size: 65, hald: 0 },
  { id: "hald-8", label: "HaldCLUT PNG, level 8", size: 64, hald: 8 },
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportFormatId = ExportFormat["id"];

export const formatById = (id: string): ExportFormat => EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[1];

/** A name safe on every file system. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? "Look" : cleaned.slice(0, 120);
}

export async function lookFile(
  table: Table,
  format: ExportFormat,
  title: string,
  leftOut: readonly string[],
): Promise<{ blob: Blob; fileName: string }> {
  const base = safeFileName(title);
  if (format.hald) {
    const png = await encodePng16(format.hald ** 3, format.hald ** 3, haldPixels(table, format.hald));
    return { blob: new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }), fileName: `${base}.png` };
  }
  const comments = ["Made with LUT Tools for Safelight.", "Input and output: sRGB."];
  if (leftOut.length > 0) comments.push(`Left out (not colour operations): ${leftOut.join(", ")}.`);
  const text = writeCube({ title, shaper: null, cube: table }, comments);
  return { blob: new Blob([text], { type: "text/plain" }), fileName: `${base}.cube` };
}

/** Hand a file to the browser's download, as core's own exports do. */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
