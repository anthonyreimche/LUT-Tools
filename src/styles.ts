// The library list takes the Presets panel's look (its toolbar buttons,
// folder headers and rows), as plain CSS: the app's Tailwind build never
// scans an extension. `:where()` keeps every rule at zero specificity so a
// theme's stylesheet still wins, and the `html.sl-larger-text` and
// `html.sl-title-headings` rules repeat core's Accessibility ones.

import type { UITokens } from "./safelight";

const P = "lut-tools";

export const cls = {
  toolbar: `${P}-toolbar`,
  tool: `${P}-tool`,
  search: `${P}-search`,
  empty: `${P}-empty`,
  note: `${P}-note`,
  warning: `${P}-warning`,
  sections: `${P}-sections`,
  rows: `${P}-rows`,
  groupHeader: `${P}-group-header`,
  caret: `${P}-caret`,
  groupName: `${P}-group-name`,
  count: `${P}-count`,
  row: `${P}-row`,
  current: `${P}-current`,
  apply: `${P}-apply`,
  delete: `${P}-delete`,
  rename: `${P}-rename`,
} as const;

const TRUNCATE = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
const TEXT_10 = [cls.tool, cls.empty, cls.note, cls.warning, cls.groupHeader];
const TEXT_11 = [cls.row, cls.search, cls.rename];
const any = (classes: readonly string[]) => classes.map((c) => `html.sl-larger-text .${c}`).join(", ");

export function lutCss(t: UITokens): string {
  return `
:where(.${cls.toolbar}) { margin-bottom: 0.5rem; display: flex; gap: 0.25rem; }
:where(.${cls.tool}) { flex: 1; border-radius: 0.25rem; background-color: ${t.surface2}; padding: 0.25rem 0.5rem; font-size: 10px; color: ${t.textSecondary}; }
:where(.${cls.search}), :where(.${cls.rename}) { width: 100%; border-radius: 0.25rem; background-color: ${t.surface2}; padding: 0.25rem 0.5rem; font-size: 11px; color: ${t.textPrimary}; }
:where(.${cls.search}) { margin-bottom: 0.5rem; }
:where(.${cls.search}:focus), :where(.${cls.rename}:focus) { outline-style: none; }
:where(.${cls.empty}) { font-size: 10px; color: ${t.textMuted}; }
:where(.${cls.note}) { font-size: 10px; line-height: 1.375; color: ${t.textMuted}; }
:where(.${cls.warning}) { border-radius: 0.25rem; background-color: ${t.surface2}; padding: 0.375rem 0.5rem; font-size: 10px; line-height: 1.375; color: ${t.textSecondary}; }
:where(.${cls.sections} > :not(:last-child)) { margin-block: 0 0.25rem; }
:where(.${cls.rows} > :not(:last-child)) { margin-block: 0 0.125rem; }
:where(.${cls.groupHeader}) { display: flex; width: 100%; align-items: center; gap: 0.25rem; padding: 0.125rem 0.25rem; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.025em; color: ${t.textMuted}; }
:where(.${cls.caret}) { display: inline-block; width: 0.75rem; }
:where(.${cls.groupName}) { ${TRUNCATE} }
:where(.${cls.count}) { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.6; }
:where(.${cls.row}) { position: relative; display: flex; align-items: center; justify-content: space-between; border-radius: 0.25rem; padding: 0.25rem 0.5rem; font-size: 11px; color: ${t.textSecondary}; }
:where(.${cls.current}) { background-color: ${t.surface3}; color: ${t.textPrimary}; }
:where(.${cls.apply}) { min-width: 0; flex: 1; ${TRUNCATE} text-align: left; }
:where(.${cls.delete}) { margin-left: 0.25rem; color: ${t.textMuted}; opacity: 0; }

@media (hover: hover) {
  :where(.${cls.tool}:hover) { background-color: ${t.surface3}; color: ${t.textPrimary}; }
  :where(.${cls.groupHeader}:hover) { color: ${t.textSecondary}; }
  :where(.${cls.row}:hover) { background-color: ${t.surface2}; }
  :where(.${cls.apply}:hover) { color: ${t.textPrimary}; }
  :where(.${cls.delete}:hover) { color: ${t.labelRed}; }
  :where(.${cls.row}:hover .${cls.delete}) { opacity: 1; }
}

${any(TEXT_10)} { font-size: 12px !important; }
${any(TEXT_11)} { font-size: 13px !important; line-height: 1.45 !important; }
html.sl-larger-text .${cls.groupHeader} { text-transform: none !important; }
html.sl-title-headings .${cls.groupHeader} { text-transform: capitalize !important; }
`;
}
