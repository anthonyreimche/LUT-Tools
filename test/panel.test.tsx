// The panel against the fake API: putting a LUT on, previewing on hover,
// strength and encodings, a missing LUT, and the library's own actions.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { writeCube } from "../src/cube";
import { cubeFrom } from "../src/lut";
import { createLibrary, type Library } from "../src/library";
import { LutPanel, NEARLY_FULL, previewValues } from "../src/Panel";
import { pageName, pageOf } from "../src/pack";
import { NAME_KEY, PAGE_KEY, applyPatch, idToUniform, qualified } from "../src/params";
import { inlinePreparer } from "../src/prepare";
import { initRuntime } from "../src/rt";
import { memoryStore } from "../src/store";
import { fakeApi, type Rig } from "./support/fake-api";

afterEach(cleanup);

const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, gain: number) => ({
  path,
  bytes: async () => text(writeCube({ title: path.replace(/^.*\//, "").replace(".cube", ""), shaper: null, cube: cubeFrom(3, (r, g, b) => [r * gain, g, b]) })),
});

async function setup(bag: Record<string, unknown> = {}): Promise<{ rig: Rig; library: Library }> {
  const rig = fakeApi(bag);
  initRuntime(rig.api);
  rig.api.registerProcessingStage((await import("../src/stage")).lookStage());
  const library = createLibrary({ store: memoryStore(), setPage: () => {}, prepare: inlinePreparer(() => Promise.reject(new Error("no"))) });
  await library.reload();
  await library.add([file("Warm.cube", 1.1), file("Film/Portra.cube", 0.9), file("Film/Velvia.cube", 0.8)]);
  return { rig, library };
}

const entry = (library: Library, name: string) => {
  const e = library.entries().find((x) => x.name === name);
  if (!e) throw new Error(`no ${name}`);
  return e;
};

describe("the LUT panel", () => {
  it("says when the photo has no LUT and lists the library by folder", async () => {
    const { library } = await setup();
    render(<LutPanel library={library} />);
    expect(screen.getByText(/No LUT on this photo/)).toBeTruthy();
    expect(screen.getByText("Warm")).toBeTruthy();
    expect(screen.getByText("Film")).toBeTruthy();
    expect(screen.getByText("Portra")).toBeTruthy();
    expect(screen.getByText(/3 LUTs, library 1% full/)).toBeTruthy();
    expect(screen.queryByText(/nearly full|is full/)).toBeNull();
  });

  it("says plainly what to do when the library is nearly full, and when it is full", async () => {
    const { library } = await setup();
    const { rerender } = render(<LutPanel library={{ ...library, usage: () => NEARLY_FULL }} />);
    expect(screen.getByText(/library 90% full/)).toBeTruthy();
    expect(screen.getByText(/The library is nearly full\. Remove LUTs you no longer use/)).toBeTruthy();
    rerender(<LutPanel library={{ ...library, usage: () => 1 }} />);
    expect(screen.getByText(/The library is full\. Remove LUTs you no longer use/)).toBeTruthy();
  });

  it("previews a LUT while it is hovered and stops when the pointer leaves the list", async () => {
    const { rig, library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.mouseEnter(screen.getByText("Portra").parentElement as HTMLElement);
    expect(rig.viewValues.at(-1)).toEqual(previewValues(entry(library, "Portra"), 1));
    expect(rig.viewValues.at(-1)).not.toHaveProperty(NAME_KEY);
    expect(rig.viewValues.at(-1)?.[PAGE_KEY]).toBe(pageName(pageOf(entry(library, "Portra").key)));
    fireEvent.mouseLeave(screen.getByText("Portra").closest(".lut-tools-sections") as HTMLElement);
    expect(rig.viewValues.at(-1)).toBeNull();
  });

  // SafeLight #278: with the pointer resting on a LUT, the next photo opened
  // (arrow keys, the filmstrip) was drawn with the preview, which isn't its edit.
  it("stops previewing when another photo opens", async () => {
    const { rig, library } = await setup();
    const photo = (id: string) => ({ id, filename: `${id}.raf` }) as unknown as Parameters<Rig["setPhoto"]>[0];
    rig.setPhoto(photo("A"));
    render(<LutPanel library={library} />);
    fireEvent.mouseEnter(screen.getByText("Portra").parentElement as HTMLElement);
    expect(rig.viewValues.at(-1)).not.toBeNull();
    act(() => rig.setPhoto(photo("B")));
    expect(rig.viewValues.at(-1)).toBeNull();
  });

  it("puts a LUT on the photo as one undo step, with the encodings last used with it", async () => {
    const { rig, library } = await setup();
    await library.setEncodings(entry(library, "Velvia").id, 1, 1);
    render(<LutPanel library={library} />);
    fireEvent.click(screen.getByText("Velvia"));
    const v = entry(library, "Velvia");
    expect(rig.params()).toEqual(applyPatch(v.key, v.sig, v.layout, "Velvia", { strength: 1, inEnc: 1, outEnc: 1 }));
    expect(rig.commits).toEqual(["LUT"]);
    expect(rig.viewValues.at(-1)).toBeNull();
  });

  it("shows the applied LUT with its strength, and keeps the strength when another is picked", async () => {
    const { rig, library } = await setup();
    const w = entry(library, "Warm");
    const { container } = render(<LutPanel library={library} />);
    fireEvent.click(screen.getByText("Warm"));
    const slider = rig.sliders(container)[0];
    expect(slider).toMatchObject({ label: "Strength", value: 100, min: 0, max: 100 });
    act(() => slider.onChange(40));
    expect(rig.params()[qualified("strength")]).toBe(0.4);
    act(() => slider.onCommit?.());
    expect(rig.commits).toEqual(["LUT", "LUT strength"]);
    fireEvent.click(screen.getByText("Portra"));
    expect(rig.params()[qualified("strength")]).toBe(0.4);
    expect(rig.params()[qualified("lut")]).toEqual(idToUniform(entry(library, "Portra").key));
    act(() => rig.sliders(container)[0].onChange(0));
    expect(rig.params()[qualified("active")]).toBe(0);
    void w;
  });

  it("changes the encodings on the photo and remembers them for the LUT", async () => {
    const { rig, library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.click(screen.getByText("Warm"));
    fireEvent.change(screen.getByLabelText("LUT input encoding"), { target: { value: "3" } });
    expect(rig.params()[qualified("inEnc")]).toBe(3);
    expect(rig.commits.at(-1)).toBe("LUT encoding");
    await waitFor(() => expect(entry(library, "Warm").inEnc).toBe(3));
  });

  it("says which LUT is missing when the photo's isn't in the library", async () => {
    const { library } = await setup({ [qualified("active")]: 1, [qualified("lut")]: idToUniform(777), [NAME_KEY]: "Kodak 2383" });
    render(<LutPanel library={library} />);
    expect(screen.getByRole("status").textContent).toMatch(/“Kodak 2383” isn't in the LUT library/);
  });

  it("takes the LUT off", async () => {
    const { rig, library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.click(screen.getByText("Warm"));
    fireEvent.click(screen.getByText("Remove"));
    expect(rig.params()).toEqual({});
    expect(rig.commits).toEqual(["LUT", "Remove LUT"]);
  });

  it("searches names and folders", async () => {
    const { library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.change(screen.getByLabelText("Search LUTs"), { target: { value: "film" } });
    expect(screen.queryByText("Warm")).toBeNull();
    expect(screen.getByText("Velvia")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search LUTs"), { target: { value: "zzz" } });
    expect(screen.getByText("No LUT matches.")).toBeTruthy();
  });

  it("renames from the context menu", async () => {
    const { rig, library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.contextMenu(screen.getByText("Warm").parentElement as HTMLElement);
    const menu = rig.menu();
    const rename = menu?.items.find((i) => i !== "separator" && i.label === "Rename…");
    if (!rename || rename === "separator") throw new Error("no Rename item");
    act(() => rename.onClick());
    const input = screen.getByLabelText("LUT name");
    fireEvent.change(input, { target: { value: "Golden" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Golden")).toBeTruthy());
  });

  it("asks before removing a LUT from the library, and keeps it on No", async () => {
    const { rig, library } = await setup();
    render(<LutPanel library={library} />);
    rig.confirm.answer = false;
    fireEvent.click(screen.getByLabelText("Remove Warm"));
    await waitFor(() => expect(rig.confirm.asked).toEqual(["Remove “Warm” from the library?"]));
    expect(library.entries()).toHaveLength(3);
    rig.confirm.answer = true;
    fireEvent.click(screen.getByLabelText("Remove Warm"));
    await waitFor(() => expect(library.entries()).toHaveLength(2));
  });

  it("collapses a folder", async () => {
    const { library } = await setup();
    render(<LutPanel library={library} />);
    fireEvent.click(screen.getByText("Film"));
    expect(screen.queryByText("Portra")).toBeNull();
  });

  it("adds the files picked, keeps the LUT ones, and says what it couldn't add", async () => {
    const { rig, library } = await setup();
    const { container } = render(<LutPanel library={library} />);
    const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    const good = new File([writeCube({ title: "New", shaper: null, cube: cubeFrom(3, (r, g, b) => [b, g, r]) })], "New.cube");
    const bad = new File(["LUT_3D_SIZE 2\n"], "Bad.cube");
    const other = new File(["hello"], "notes.txt");
    Object.defineProperty(input, "files", { value: [good, bad, other], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(library.entries().map((e) => e.name)).toContain("New"));
    await waitFor(() => expect(rig.alerts).toHaveLength(1));
    expect(rig.alerts[0].title).toBe("LUTs added");
    expect(rig.alerts[0].message).toMatch(/Added 1 LUT\./);
    expect(rig.alerts[0].message).toMatch(/Bad\.cube: The table has 0 entries/);
    expect(rig.alerts[0].message).not.toMatch(/notes/);
  });
});
