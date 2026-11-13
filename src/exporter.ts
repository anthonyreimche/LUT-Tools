// Exporting the open photo's look: plan, render the grid through the photo,
// write the file.

import { bakeLook, planBake, type FrameRenderer } from "./bake";
import { lookFile, type ExportFormat } from "./export-file";
import { baseName } from "./read-file";
import type { CatalogPhoto, ProcessingStageContribution, SafelightAPI } from "./safelight";

const isOfficialExtension = (id: string): boolean =>
  id === "core" || id.startsWith("core.") || id === "safelight" || id.startsWith("safelight.");

export interface ExportedLook {
  blob: Blob;
  fileName: string;
  leftOut: string[];
}

export async function exportLook(
  api: SafelightAPI,
  photo: CatalogPhoto,
  stages: readonly (ProcessingStageContribution & { extensionId: string })[],
  format: ExportFormat,
  onProgress: (fraction: number) => void,
): Promise<ExportedLook> {
  const dev = api.stores.useDevelopStore.getState();
  if (dev.photoId !== photo.id) throw new Error("the photo isn't open in Develop");
  const plan = planBake(
    { params: dev.params, bag: dev.paramBag, stages, asShotTemperature: photo.exif.colorTemperature },
    {
      normalizeParams: (p) => api.develop.normalizeParams(p),
      summarize: (p) => api.presets.summarize(p),
      isOfficial: isOfficialExtension,
    },
  );
  const render: FrameRenderer = (params, bag) =>
    api.develop.renderPhotoFloatFrame(photo.id, params, {
      paramBag: bag,
      point: "pre-output",
      space: { encoding: "perceptual", primaries: "rec709" },
    });
  const baked = await bakeLook(plan, format.size, render, onProgress);
  const title = `${baseName(photo.filename)} look`;
  const file = await lookFile(baked.table, format, title, baked.leftOut);
  return { ...file, leftOut: baked.leftOut };
}
