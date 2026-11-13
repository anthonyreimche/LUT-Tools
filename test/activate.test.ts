// What activate() registers: the two stages, the panel and its stylesheet,
// all named under the manifest's id, and the library's (empty) atlas;
// deactivate() takes the stages back out.

import { describe, expect, it } from "vitest";
import manifest from "../safelight.json";
import pkg from "../package.json";
import { PANEL_ID, STYLESHEET_ID, activate, activeLibrary, deactivate } from "../src/index";
import { BAKE_STAGE_ID, EXT_ID, LOOK_STAGE_ID, NAME_KEY, qualified } from "../src/params";
import { writeCube } from "../src/cube";
import { cubeFrom } from "../src/lut";
import { pageName, pageOf } from "../src/pack";
import { ATLAS_KEY } from "../src/stage";
import { fakeApi } from "./support/fake-api";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("activate", () => {
  it("registers the look and the export grid stages", () => {
    const rig = fakeApi();
    activate(rig.api);
    expect(rig.stages.map((s) => s.id)).toEqual([LOOK_STAGE_ID, BAKE_STAGE_ID]);
    deactivate();
  });

  it("registers the panel in Develop and its stylesheet", () => {
    const rig = fakeApi();
    activate(rig.api);
    expect(rig.panels).toHaveLength(1);
    expect(rig.panels[0]).toMatchObject({ id: PANEL_ID, title: "LUT", defaultDock: { module: "develop", direction: "right" } });
    expect(rig.stylesheets.map((s) => s.id)).toEqual([STYLESHEET_ID]);
    deactivate();
  });

  it("reads the library, and supplies no atlas page while it is empty", async () => {
    const rig = fakeApi();
    activate(rig.api);
    await settle();
    expect(activeLibrary()?.entries()).toEqual([]);
    expect([...rig.textures.keys()]).toEqual([]);
    deactivate();
  });

  it("supplies each atlas page as a variant of the look stage's texture", async () => {
    const rig = fakeApi();
    activate(rig.api);
    await settle();
    const library = activeLibrary();
    if (!library) throw new Error("no library");
    const cube = writeCube({ title: "Warm", shaper: null, cube: cubeFrom(3, (r, g, b) => [r, g * 0.9, b * 0.8]) });
    const { added } = await library.add([{ path: "Warm.cube", bytes: async () => new TextEncoder().encode(cube) }]);
    expect([...rig.textures.keys()]).toEqual([`${LOOK_STAGE_ID}.${ATLAS_KEY}#${pageName(pageOf(added[0].key))}`]);
    expect([...rig.textures.values()][0]).toMatchObject({ width: 4096, height: 1, format: "rgba8", version: 1 });
    deactivate();
  });

  it("names its contributions under the manifest's id, at one version", () => {
    expect(EXT_ID).toBe(manifest.id);
    for (const id of [PANEL_ID, STYLESHEET_ID, LOOK_STAGE_ID, BAKE_STAGE_ID]) expect(id.startsWith(`${manifest.id}.`)).toBe(true);
    expect(pkg.version).toBe(manifest.version);
  });

  it("takes the photo's LUT off from the panel header's reset, as one undo step", () => {
    const rig = fakeApi({ [qualified("active")]: 1, [qualified("lut")]: 5, [NAME_KEY]: "Teal" });
    activate(rig.api);
    rig.panels[0].onReset?.();
    const bag = rig.params();
    expect(bag[qualified("active")]).toBeUndefined();
    expect(bag[qualified("lut")]).toBeUndefined();
    expect(bag[NAME_KEY]).toBeUndefined();
    expect(rig.commits).toEqual(["LUT reset"]);
    deactivate();
  });

  it("unregisters both stages on deactivate, once, and drops any preview", () => {
    const rig = fakeApi();
    activate(rig.api);
    deactivate();
    deactivate();
    expect(rig.unregistered).toEqual([LOOK_STAGE_ID, BAKE_STAGE_ID]);
    expect(rig.viewValues).toEqual([null]);
  });
});
