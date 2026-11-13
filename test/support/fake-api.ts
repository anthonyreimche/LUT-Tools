// A stand-in Safelight API for unit tests, over real React and zustand. It has
// only what this extension uses: reading any other member throws, naming it,
// so a test shows what to add here when the extension starts using more.
//
// The photo's edit is a param bag in a zustand store, so a panel re-renders
// when it changes. Reads fall back to the defaults of the registered stages'
// uniforms, as Safelight's do. Core's Slider and the UI kit are plain
// elements that keep their props, so a test can drive them.

import * as React from "react";
import { create } from "zustand";
import type {
  CatalogPhoto,
  ContextMenuProps,
  PanelContribution,
  ParamScope,
  ProcessingStageContribution,
  SafelightAPI,
  SliderProps,
  StageTextureData,
  StylesheetContribution,
} from "../../src/safelight";
import { EXT_ID } from "../../src/params";

type Props = Record<string, unknown> & { children?: React.ReactNode };

export interface Rig {
  api: SafelightAPI;
  panels: PanelContribution[];
  stages: ProcessingStageContribution[];
  unregistered: string[];
  stylesheets: StylesheetContribution[];
  /** The last texture each stage texture key was given, a variant's under
   *  "{stageId}.{key}#{variant}". */
  textures: Map<string, StageTextureData>;
  /** The photo's param bag, by qualified key, without defaults. */
  params(): Readonly<Record<string, unknown>>;
  /** The labels of the undo steps the extension made, in order. */
  commits: string[];
  /** Each setViewValues call, in order. */
  viewValues: (Record<string, unknown> | null)[];
  alerts: { title: string; message: string }[];
  /** What confirmDialog answers, and the titles it was asked with. */
  confirm: { answer: boolean; asked: string[] };
  /** The latest props of each slider drawn in `root`, in document order. */
  sliders(root: ParentNode): SliderProps[];
  /** The open context menu's props, if any. */
  menu(): ContextMenuProps | null;
  setPhoto(photo: CatalogPhoto | undefined): void;
}

export function fakeApi(initial: Record<string, unknown> = {}): Rig {
  const panels: PanelContribution[] = [];
  const stages: ProcessingStageContribution[] = [];
  const unregistered: string[] = [];
  const stylesheets: StylesheetContribution[] = [];
  const textures = new Map<string, StageTextureData>();
  const commits: string[] = [];
  const viewValues: (Record<string, unknown> | null)[] = [];
  const alerts: { title: string; message: string }[] = [];
  const confirm = { answer: true, asked: [] as string[] };
  const defaults = new Map<string, unknown>();
  const photo = create<{ params: Record<string, unknown>; active: CatalogPhoto | undefined }>()(() => ({
    params: { ...initial },
    active: undefined,
  }));
  const sliderProps = new Map<number, SliderProps>();
  let menuProps: ContextMenuProps | null = null;
  let nextSlider = 0;

  function useParamScope(): ParamScope {
    const params = photo((s) => s.params);
    return {
      maskId: null,
      getParam: (key) => (key in params ? params[key] : defaults.get(key)),
      getParams: () => params,
      setParams: (patch) =>
        photo.setState((s) => {
          const next = { ...s.params, ...patch };
          for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
          return { params: next };
        }),
      commit: (label) => void commits.push(label),
    };
  }

  function Slider(props: SliderProps) {
    const id = React.useRef(nextSlider++).current;
    sliderProps.set(id, props);
    return React.createElement("div", { "data-slider": id }, `${props.label} ${props.value}`);
  }

  function ContextMenu(props: ContextMenuProps) {
    menuProps = props;
    React.useEffect(
      () => () => {
        menuProps = null;
      },
      [],
    );
    return React.createElement("div", { "data-menu": true });
  }

  const plain =
    (tag: string) =>
    ({ children, title, label }: Props) =>
      React.createElement(tag, null, title as React.ReactNode, label as React.ReactNode, children);
  const Button = ({ children, onClick, disabled }: Props) =>
    React.createElement("button", { onClick: onClick as () => void, disabled: disabled as boolean }, children);
  const Select = ({ value, onChange, options, ariaLabel }: Props) =>
    React.createElement(
      "select",
      {
        "aria-label": ariaLabel as string,
        value: value as string,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => (onChange as (v: string) => void)(e.target.value),
      },
      (options as { value: string; label: string }[]).map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label)),
    );
  const ProgressBar = ({ value }: Props) => React.createElement("progress", { value: value as number });

  const tokens = new Proxy({}, { get: (_t, key) => `var(--${String(key)})` });

  const members = {
    version: 1,
    extensionId: EXT_ID,
    react: React,
    registerPanel: (c: PanelContribution) => void panels.push(c),
    registerProcessingStage: (c: ProcessingStageContribution) => {
      stages.push(c);
      for (const u of c.uniforms) defaults.set(`${c.id}.${u.key}`, u.default);
    },
    unregisterProcessingStage: (id: string) => void unregistered.push(id),
    registerStylesheet: (c: StylesheetContribution) => void stylesheets.push(c),
    setStageTexture: (stageId: string, key: string, tex: StageTextureData | null, variant?: string) => {
      const filed = variant === undefined ? `${stageId}.${key}` : `${stageId}.${key}#${variant}`;
      if (tex) textures.set(filed, tex);
      else textures.delete(filed);
    },
    components: { Slider, ContextMenu },
    ui: {
      Button,
      Select,
      ProgressBar,
      Field: plain("div"),
      Section: plain("section"),
      Stack: plain("div"),
      Row: plain("div"),
      tokens,
      alertDialog: async (o: { title: string; message: string }) => void alerts.push(o),
      confirmDialog: async (o: { title: string }) => {
        confirm.asked.push(o.title);
        return confirm.answer;
      },
    },
    develop: {
      useParamScope,
      setViewValues: (v: Record<string, unknown> | null) => void viewValues.push(v),
    },
    catalog: { useActivePhoto: () => photo((s) => s.active) },
    stores: {
      useDevelopStore: {
        getState: () => ({
          setDynParams: (patch: Record<string, unknown>) => photo.setState((s) => ({ params: { ...s.params, ...patch } })),
          commitEdit: async (label: string) => void commits.push(label),
        }),
      },
    },
    registry: { use: <T,>(select: (s: { processingStages: Record<string, unknown> }) => T): T => select({ processingStages: {} }) },
  };

  return {
    api: strict(members, "api") as unknown as SafelightAPI,
    panels,
    stages,
    unregistered,
    stylesheets,
    textures,
    params: () => photo.getState().params,
    commits,
    viewValues,
    alerts,
    confirm,
    sliders: (root) =>
      [...root.querySelectorAll("[data-slider]")].map((el) => {
        const props = sliderProps.get(Number(el.getAttribute("data-slider")));
        if (!props) throw new Error("a slider without props");
        return props;
      }),
    menu: () => menuProps,
    setPhoto: (active) => photo.setState({ active }),
  };
}

/** Wraps a plain object so reading a member it lacks throws, naming the member. */
function strict<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key === "toJSON") return Reflect.get(obj, key, receiver);
      if (!(key in obj)) throw new Error(`The fake API has no ${path}.${key}. Add it to test/support/fake-api.ts.`);
      const value: unknown = Reflect.get(obj, key, receiver);
      const isPlainObject = typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
      return isPlainObject && key !== "react" && key !== "tokens" ? strict(value, `${path}.${key}`) : value;
    },
  });
}
