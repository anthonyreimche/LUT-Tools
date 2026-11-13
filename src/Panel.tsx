// The Develop panel: the open photo's LUT with its strength and encodings,
// the library to pick from (hovering a LUT previews it on the photo), and
// exporting the photo's look as a LUT.

import { ENCODINGS, isEncoding, type EncodingId } from "./encoding";
import { EXPORT_FORMATS, download, formatById, type ExportFormatId } from "./export-file";
import { exportLook } from "./exporter";
import type { Library } from "./library";
import { NAME_KEY, applyPatch, readLook, removePatch, settingsPatch, type LookSettings, type PhotoLook } from "./params";
import { hasLutExtension } from "./read-file";
import { React, api } from "./rt";
import type { StoredLut } from "./store";
import { cls } from "./styles";

export function useLibrary(library: Library): number {
  return React.useSyncExternalStore(library.subscribe, library.revision);
}

/** What the photo's LUT is: none, one in the library, or one that has left it. */
export type LookState = { kind: "none" } | { kind: "applied"; entry: StoredLut } | { kind: "missing"; name: string | null };

export function lookState(look: PhotoLook, library: Library): LookState {
  if (look.key === 0) return { kind: "none" };
  const entry = library.byKey(look.key);
  return entry && entry.sig === look.sig ? { kind: "applied", entry } : { kind: "missing", name: look.name };
}

/** The values that draw `entry` on the photo, for the hover preview: the
 *  stage's uniforms only. */
export function previewValues(entry: StoredLut, strength: number): Record<string, unknown> {
  const values = applyPatch(entry.key, entry.sig, entry.layout, entry.name, { strength, inEnc: entry.inEnc, outEnc: entry.outEnc });
  delete values[NAME_KEY];
  return values;
}

const ENCODING_OPTIONS = ENCODINGS.map((e) => ({ value: String(e.id), label: e.label }));

function groupsOf(entries: readonly StoredLut[], query: string): { folder: string; items: StoredLut[] }[] {
  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.folder.toLowerCase().includes(q)) : entries;
  const groups = new Map<string, StoredLut[]>();
  for (const e of shown) {
    const list = groups.get(e.folder);
    if (list) list.push(e);
    else groups.set(e.folder, [e]);
  }
  return [...groups].map(([folder, items]) => ({ folder, items }));
}

async function reportAdded(report: Awaited<ReturnType<Library["add"]>>): Promise<void> {
  if (report.refused.length === 0 && report.notes.length === 0) return;
  const lines: string[] = [];
  if (report.added.length > 0) lines.push(`Added ${report.added.length} LUT${report.added.length === 1 ? "" : "s"}.`);
  for (const n of report.notes) lines.push(`${n.name}: ${n.note}`);
  if (report.refused.length > 0) {
    lines.push(`${report.refused.length === 1 ? "One file wasn't" : `${report.refused.length} files weren't`} added:`);
    for (const r of report.refused.slice(0, 12)) lines.push(`${r.name}: ${r.reason}`);
    if (report.refused.length > 12) lines.push(`…and ${report.refused.length - 12} more.`);
  }
  await api.ui.alertDialog({ title: report.added.length > 0 ? "LUTs added" : "No LUTs added", message: lines.join("\n") });
}

function CurrentLook({ library, look, state }: { library: Library; look: PhotoLook; state: LookState }) {
  const { Select, Button, Field, Stack, Row } = api.ui;
  const { Slider } = api.components;
  const scope = api.develop.useParamScope();
  const set = (s: LookSettings, commit: string | null) => {
    scope.setParams(settingsPatch(look.key, s));
    if (commit) scope.commit(commit);
  };
  const setEncoding = (which: "inEnc" | "outEnc", value: string) => {
    const id = Number(value);
    if (!isEncoding(id)) return;
    const next = { ...look.settings, [which]: id as EncodingId };
    set(next, "LUT encoding");
    if (state.kind === "applied") void library.setEncodings(state.entry.id, next.inEnc, next.outEnc);
  };
  const remove = () => {
    scope.setParams(removePatch());
    scope.commit("Remove LUT");
  };

  if (state.kind === "none") return <p className={cls.note}>No LUT on this photo. Pick one from the library below.</p>;
  return (
    <Stack gap={6}>
      {state.kind === "missing" ? (
        <div className={cls.warning} role="status">
          {state.name ? `“${state.name}”` : "This photo's LUT"} isn't in the LUT library, so the photo is drawn without it. Add
          its file again to bring it back.
        </div>
      ) : null}
      <Row gap={6} justify="space-between">
        <span style={{ fontSize: 11, color: api.ui.tokens.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state.kind === "applied" ? state.entry.name : (state.name ?? "Missing LUT")}
        </span>
        <Button size="sm" variant="ghost" onClick={remove}>
          Remove
        </Button>
      </Row>
      <Slider
        label="Strength"
        value={Math.round(look.settings.strength * 100)}
        min={0}
        max={100}
        step={1}
        defaultValue={100}
        onChange={(v) => set({ ...look.settings, strength: v / 100 }, null)}
        onCommit={() => scope.commit("LUT strength")}
      />
      <Field label="Input" hint="The encoding the LUT expects. Most looks and film simulations expect sRGB.">
        <Select ariaLabel="LUT input encoding" value={String(look.settings.inEnc)} options={ENCODING_OPTIONS} onChange={(v) => setEncoding("inEnc", v)} />
      </Field>
      <Field label="Output" hint="The encoding the LUT produces.">
        <Select ariaLabel="LUT output encoding" value={String(look.settings.outEnc)} options={ENCODING_OPTIONS} onChange={(v) => setEncoding("outEnc", v)} />
      </Field>
    </Stack>
  );
}

function LibraryList({ library, look, current }: { library: Library; look: PhotoLook; current: StoredLut | null }) {
  useLibrary(library);
  const { ContextMenu } = api.components;
  const scope = api.develop.useParamScope();
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; entry?: StoredLut; folder?: string } | null>(null);
  const [adding, setAdding] = React.useState<string | null>(null);
  const filesRef = React.useRef<HTMLInputElement>(null);
  const folderRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    return () => api.develop.setViewValues(null);
  }, []);

  const strength = look.key !== 0 ? look.settings.strength : 1;
  const preview = (entry: StoredLut | null) => api.develop.setViewValues(entry ? previewValues(entry, strength) : null);

  const apply = (entry: StoredLut) => {
    preview(null);
    scope.setParams(applyPatch(entry.key, entry.sig, entry.layout, entry.name, { strength: look.key !== 0 ? look.settings.strength || 1 : 1, inEnc: entry.inEnc, outEnc: entry.outEnc }));
    scope.commit("LUT");
  };

  const addFrom = async (input: HTMLInputElement | null) => {
    const files = [...(input?.files ?? [])].filter((f) => hasLutExtension(f.name));
    if (input) input.value = "";
    if (files.length === 0) return;
    try {
      const report = await library.add(
        files.map((f) => ({ path: f.webkitRelativePath || f.name, bytes: async () => new Uint8Array(await f.arrayBuffer()) })),
        (done, total) => setAdding(done < total ? `Adding ${done + 1} of ${total}…` : null),
      );
      await reportAdded(report);
    } finally {
      setAdding(null);
    }
  };

  const removeEntries = async (entries: readonly StoredLut[], what: string) => {
    const sure = await api.ui.confirmDialog({
      title: `Remove ${what} from the library?`,
      message: "Photos that use it keep their settings but are drawn without it, and say so, until you add the file again.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (sure) await library.remove(entries.map((e) => e.id));
  };

  const commitRename = () => {
    if (renaming) void library.rename(renaming.id, renaming.name);
    setRenaming(null);
  };

  const groups = groupsOf(library.entries(), query);
  const renderEntry = (entry: StoredLut) => (
    <div
      key={entry.id}
      className={`${cls.row}${current?.id === entry.id ? ` ${cls.current}` : ""}`}
      onMouseEnter={() => preview(entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        preview(null);
        setMenu({ x: e.clientX, y: e.clientY, entry });
      }}
    >
      {renaming?.id === entry.id ? (
        <input
          className={cls.rename}
          aria-label="LUT name"
          autoFocus
          value={renaming.name}
          onChange={(e) => setRenaming({ id: entry.id, name: e.target.value })}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(null);
          }}
        />
      ) : (
        <button className={cls.apply} title={entry.folder ? `${entry.folder}/${entry.name}` : entry.name} onClick={() => apply(entry)}>
          {entry.name}
        </button>
      )}
      <button className={cls.delete} title="Remove from library" aria-label={`Remove ${entry.name}`} onClick={() => void removeEntries([entry], `“${entry.name}”`)}>
        ✕
      </button>
    </div>
  );

  return (
    <div>
      <div className={cls.toolbar}>
        <button className={cls.tool} disabled={adding !== null} onClick={() => filesRef.current?.click()}>
          Add files…
        </button>
        <button className={cls.tool} disabled={adding !== null} onClick={() => folderRef.current?.click()}>
          Add folder…
        </button>
      </div>
      {adding ? (
        <p className={cls.note} role="status">
          {adding}
        </p>
      ) : null}
      <input ref={filesRef} type="file" multiple accept=".cube,.png,.tif,.tiff,.jpg,.jpeg" style={{ display: "none" }} onChange={(e) => void addFrom(e.currentTarget)} />
      <input ref={folderRef} type="file" style={{ display: "none" }} onChange={(e) => void addFrom(e.currentTarget)} />
      {library.entries().length === 0 ? (
        <p className={cls.empty}>The library is empty. Add .cube files or HaldCLUT images.</p>
      ) : (
        <>
          <input className={cls.search} type="search" placeholder="Search LUTs" aria-label="Search LUTs" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className={cls.sections} onMouseLeave={() => preview(null)}>
            {groups.length === 0 ? <p className={cls.empty}>No LUT matches.</p> : null}
            {groups.map(({ folder, items }) =>
              folder === "" ? (
                <div key="" className={cls.rows}>
                  {items.map(renderEntry)}
                </div>
              ) : (
                <div key={folder}>
                  <button
                    className={cls.groupHeader}
                    onClick={() =>
                      setCollapsed((s) => {
                        const next = new Set(s);
                        if (next.has(folder)) next.delete(folder);
                        else next.add(folder);
                        return next;
                      })
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, folder });
                    }}
                  >
                    <span className={cls.caret}>{collapsed.has(folder) && !query ? "▸" : "▾"}</span>
                    <span className={cls.groupName}>{folder}</span>
                    <span className={cls.count}>{items.length}</span>
                  </button>
                  {collapsed.has(folder) && !query ? null : <div className={cls.rows}>{items.map(renderEntry)}</div>}
                </div>
              ),
            )}
          </div>
          <LibraryRoom count={library.entries().length} usage={library.usage()} />
        </>
      )}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.entry
              ? [
                  { label: "Rename…", onClick: () => menu.entry && setRenaming({ id: menu.entry.id, name: menu.entry.name }) },
                  "separator",
                  { label: "Remove from library", danger: true, onClick: () => menu.entry && void removeEntries([menu.entry], `“${menu.entry.name}”`) },
                ]
              : [
                  {
                    label: "Remove folder from library",
                    danger: true,
                    onClick: () => {
                      const items = library.entries().filter((e) => e.folder === menu.folder);
                      void removeEntries(items, `${items.length} LUT${items.length === 1 ? "" : "s"} in “${menu.folder}”`);
                    },
                  },
                ]
          }
        />
      ) : null}
    </div>
  );
}

/** From here the panel says the library is nearly full, and what to do. */
export const NEARLY_FULL = 0.9;

function LibraryRoom({ count, usage }: { count: number; usage: number }) {
  const { ProgressBar, Stack } = api.ui;
  const percent = Math.min(100, Math.ceil(usage * 100));
  return (
    <Stack gap={4}>
      <p className={cls.note} style={{ marginTop: 6 }}>
        {count} LUT{count === 1 ? "" : "s"}, library {percent}% full
      </p>
      <ProgressBar value={Math.min(1, usage)} />
      {usage >= NEARLY_FULL ? (
        <p className={cls.warning} role="status">
          {usage >= 1 ? "The library is full." : "The library is nearly full."} Remove LUTs you no longer use to make room for
          more. A 33-point LUT takes about an eighth of the room of a 65-point one.
        </p>
      ) : null}
    </Stack>
  );
}

function ExportLook() {
  const { Select, Button, Stack, ProgressBar } = api.ui;
  const photo = api.catalog.useActivePhoto();
  const stages = api.registry.use((s) => s.processingStages);
  const [format, setFormat] = React.useState<ExportFormatId>("cube-33");
  const [progress, setProgress] = React.useState<number | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const run = async () => {
    if (!photo) return;
    setResult(null);
    setProgress(0);
    try {
      const out = await exportLook(api, photo, Object.values(stages), formatById(format), setProgress);
      download(out.blob, out.fileName);
      setResult(
        out.leftOut.length > 0
          ? `Saved ${out.fileName}. A LUT can only hold colour and tone, so it leaves out: ${out.leftOut.join(", ")}.`
          : `Saved ${out.fileName}.`,
      );
    } catch (err) {
      setResult(`The look couldn't be exported: ${err instanceof Error ? err.message : String(err)}.`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Stack gap={6}>
      <Select ariaLabel="LUT format" value={format} options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))} onChange={(v) => setFormat(formatById(v).id)} />
      <Button size="sm" variant="secondary" full disabled={!photo || progress !== null} onClick={() => void run()}>
        Export look as LUT…
      </Button>
      {progress !== null ? <ProgressBar value={progress} /> : null}
      {result ? (
        <p className={cls.note} role="status">
          {result}
        </p>
      ) : (
        <p className={cls.note}>Saves this photo's colour and tone as a LUT, sRGB in and out.</p>
      )}
    </Stack>
  );
}

export function LutPanel({ library }: { library: Library }) {
  useLibrary(library);
  const { Section, Stack } = api.ui;
  const scope = api.develop.useParamScope();
  const look = readLook((k) => scope.getParam(k));
  const state = lookState(look, library);
  return (
    <div style={{ padding: 8 }}>
      <Stack gap={10}>
        <CurrentLook library={library} look={look} state={state} />
        <Section title="Library">
          <LibraryList library={library} look={look} current={state.kind === "applied" ? state.entry : null} />
        </Section>
        <Section title="Export">
          <ExportLook />
        </Section>
      </Stack>
    </div>
  );
}
