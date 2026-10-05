/** Template & preset loading shared by the CLI and the API server. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IconBox, IconSlot, Preset, RatioIconBox, Template } from "./types.js";
import { declaredMetaFields, defaultMetaFields } from "./metadata.js";

/** Repo root, derived from this module's compiled location (dist/ -> package -> packages -> root). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_TEMPLATES_DIR = join(REPO_ROOT, "packages", "templates");
export const DEFAULT_PRESETS_PATH = join(REPO_ROOT, "apps", "api", "presets", "presets.json");

export function builtinIconPathFor(templatesDir: string, theme?: string): string {
  return join(templatesDir, "assets", theme ? "erika-transparent.png" : "erika.webp");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Expand a ratio layout into absolute slot geometry.
 * Templates in the tree only carry percentages; pixel values live here. */
function resolveLayout(tpl: Template): Template {
  const layout = tpl.layout;
  if (!layout) return tpl;
  const W = tpl.canvas.width;
  const H = tpl.canvas.height;
  const box = (b: RatioIconBox, like: IconSlot): IconBox => {
    const size = Math.round(b.size * W);
    return {
      x: Math.round(b.x * W),
      y: Math.round(b.centerY * H - size / 2),
      size,
      fit: b.fit ?? like.fit,
      padding: b.padding ?? like.padding,
      radius: b.radius ?? like.radius,
      position: like.position,
    };
  };
  const slots = { ...tpl.slots };
  const title = { ...slots.title };
  const description = { ...slots.description };
  if (layout.iconCard) slots.icon = { ...slots.icon, ...box(layout.iconCard, slots.icon) };
  if (layout.iconBlend) slots.iconBlend = box(layout.iconBlend, slots.icon);
  if (layout.title) {
    title.x = Math.round(layout.title.x * W);
    title.inkTop = Math.round(layout.title.inkTop * H);
  }
  if (layout.description) {
    description.x = Math.round(layout.description.x * W);
    description.top = Math.round(layout.description.top * H);
    if (layout.description.bottom != null) {
      description.bandBottom = Math.round(layout.description.bottom * H);
    }
  }
  if (layout.text) {
    if (layout.title) title.maxWidth = Math.round((layout.text.rightEdge - layout.title.x) * W);
    if (layout.description) {
      description.maxWidth = Math.round((layout.text.rightEdge - layout.description.x) * W);
    }
  }
  return { ...tpl, slots: { ...slots, title, description } };
}

/** Load a template by id (resolved against templatesDir) or explicit path,
 * resolving one level of `extends` inheritance. */
export function loadTemplate(idOrPath: string, templatesDir = DEFAULT_TEMPLATES_DIR): Template {
  const path = existsSync(idOrPath) ? idOrPath : join(templatesDir, `${idOrPath}.json`);
  const tpl = readJson(path) as Template;
  if (!tpl.extends) return resolveLayout(tpl);
  const basePath = existsSync(tpl.extends) ? tpl.extends : join(templatesDir, `${tpl.extends}.json`);
  const base = readJson(basePath) as Template;
  return resolveLayout({
    ...base,
    ...tpl,
    defaults: { ...base.defaults, ...tpl.defaults },
    slots: { ...base.slots, ...tpl.slots },
    themes: { ...base.themes, ...tpl.themes },
  } as Template);
}

export interface TemplateInfo {
  id: string;
  version: number;
  themes: string[];
  canvas: { width: number; height: number };
  /** metadata fields the template declares (topline + footer) */
  metaFields: string[];
  defaultMetaFields: string[];
}

/** Enumerate renderable templates in a directory (schemaVersion + id required). */
export function listTemplates(templatesDir = DEFAULT_TEMPLATES_DIR): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  for (const entry of readdirSync(templatesDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(templatesDir, entry), "utf-8")) as Template;
      if (typeof raw?.id === "string" && typeof raw?.schemaVersion === "number") {
        const tpl = loadTemplate(raw.id, templatesDir);
        out.push({
          id: tpl.id,
          version: tpl.version,
          themes: Object.keys(tpl.themes ?? {}),
          canvas: { ...(tpl.canvas ?? { width: 0, height: 0 }) },
          metaFields: declaredMetaFields(tpl.slots.meta),
          defaultMetaFields: defaultMetaFields(tpl.slots.meta),
        });
      }
    } catch {
      // not a template file (e.g. package.json) -- skip silently
    }
  }
  return out;
}

export interface PresetRegistry {
  /** repo key "owner/repo" -> preset */
  get(key: string): (Preset & { key: string }) | null;
  path: string;
}

/** Icon paths belong to the subject's GitHub repository. Local CLI files are
 * resolved separately by --icon and must not change these public paths. */
export function loadPresetRegistry(path = DEFAULT_PRESETS_PATH): PresetRegistry {
  const raw = readJson(path) as Record<string, Preset>;
  const map = new Map<string, Preset & { key: string }>();
  for (const [key, entry] of Object.entries(raw)) {
    if (key.startsWith("$")) continue; // $comment etc.
    const preset: Preset & { key: string } = { ...entry, key };
    map.set(key.toLowerCase(), preset);
  }
  return { get: (key) => map.get(key.toLowerCase()) ?? null, path };
}
