// LUT Tools, a Safelight extension (GPL-3.0-or-later).
//
// 3D and 1D LUTs (.cube) and HaldCLUT film simulations: a library kept across
// sessions and projects, a Develop panel that puts one on the photo with its
// strength and encodings, the stage that draws it (stage.ts), and exporting
// a photo's look as a .cube or a HaldCLUT.

import { broadcastChannel, createLibrary, type Library } from "./library";
import { pageName } from "./pack";
import { LutPanel } from "./Panel";
import { ATLAS_KEY, BAKE_STAGE_ID, EXT_ID, LOOK_STAGE_ID, removePatch } from "./params";
import { inlinePreparer, workerPreparer } from "./prepare";
import PrepareWorker from "./prepare-worker?worker&inline";
import { browserJpegDecoder } from "./read-file";
import { React, api, initRuntime } from "./rt";
import type { SafelightAPI } from "./safelight";
import { bakeStage, lookStage } from "./stage";
import { indexedDbStore, memoryStore } from "./store";
import { lutCss } from "./styles";

export const PANEL_ID = `${EXT_ID}.panel`;
export const STYLESHEET_ID = `${EXT_ID}.styles`;

let library: Library | null = null;
let stopImports: (() => void) | null = null;

/** The library while the extension is active. */
export const activeLibrary = (): Library | null => library;

function reset(): void {
  const dev = api.stores.useDevelopStore.getState();
  dev.setDynParams(removePatch());
  void dev.commitEdit("LUT reset");
}

export function activate(host: SafelightAPI): void {
  initRuntime(host);
  library?.dispose();
  stopImports?.();
  host.registerProcessingStage(lookStage());
  host.registerProcessingStage(bakeStage());
  host.registerStylesheet({ id: STYLESHEET_ID, css: lutCss(host.ui.tokens) });
  const prepare = workerPreparer(() => new PrepareWorker({ name: "LUT import" }), inlinePreparer(browserJpegDecoder));
  stopImports = prepare.dispose;
  const active = createLibrary({
    // A window without IndexedDB keeps the library for the session only.
    store: typeof indexedDB === "undefined" ? memoryStore() : indexedDbStore(),
    setPage: (page, tex) => host.setStageTexture(LOOK_STAGE_ID, ATLAS_KEY, tex, pageName(page)),
    prepare,
    channel: broadcastChannel(`${EXT_ID}.library`),
  });
  library = active;
  active.reload().catch((err: unknown) => console.error("[lut-tools] the LUT library couldn't be read:", err));
  host.registerPanel({
    id: PANEL_ID,
    title: "LUT",
    component: () => <LutPanel library={active} />,
    defaultDock: { module: "develop", direction: "right" },
    modules: ["develop"],
    onReset: reset,
  });
}

export function deactivate(): void {
  if (!library) return;
  library.dispose();
  library = null;
  stopImports?.();
  stopImports = null;
  api.develop.setViewValues(null);
  api.unregisterProcessingStage(LOOK_STAGE_ID);
  api.unregisterProcessingStage(BAKE_STAGE_ID);
}
