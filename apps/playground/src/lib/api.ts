/** /v1/meta + banner preview fetching (preview = production: the playground
 * loads the real API, never a mock renderer). */

export interface TemplateInfo {
  id: string;
  version: number;
  themes: string[];
  canvas: { width: number; height: number };
  /** metadata fields the template declares */
  metaFields: string[];
  defaultMetaFields?: string[];
}

export interface Meta {
  schemaVersion: number;
  templates: TemplateInfo[];
  metaFields: string[];
  formats: string[];
  limits: {
    title: number;
    description: number;
    scaleMin: number;
    scaleMax: number;
    urlLength: number;
    iconMaxBytes: number;
  };
}

export async function fetchMeta(apiBase: string, signal: AbortSignal): Promise<Meta> {
  const res = await fetch(`${apiBase}/v1/meta`, { signal });
  if (!res.ok) throw new Error(`/v1/meta ${res.status}`);
  return (await res.json()) as Meta;
}

export interface PreviewImage {
  path: string;
  blobUrl: string;
  sizeBytes: number;
  /** X-Banner-Error header, surfaced for badges (null on normal images) */
  bannerError: string | null;
  /** X-Banner-Icon / X-Banner-Preset / X-Banner-Template: what served this image */
  iconKind: string | null;
  presetUsed: boolean;
  template: string | null;
  accent: string | null;
}

/** Fetch the banner as a blob so X-Banner-Error is readable (plain <img> can't). */
export async function fetchBanner(
  apiBase: string,
  path: string,
  signal: AbortSignal,
): Promise<PreviewImage> {
  const res = await fetch(`${apiBase}${path}`, { signal });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* not json */
    }
    throw new Error(`API ${detail}`);
  }
  const blob = await res.blob();
  return {
    path,
    blobUrl: URL.createObjectURL(blob),
    sizeBytes: blob.size,
    bannerError: res.headers.get("X-Banner-Error"),
    iconKind: res.headers.get("X-Banner-Icon"),
    presetUsed: res.headers.get("X-Banner-Preset") === "1",
    template: res.headers.get("X-Banner-Template"),
    accent: res.headers.get("X-Banner-Accent"),
  };
}

export type ParamState = {
  owner: string;
  repo: string;
  template: string | null; // null = preset default / classic
  accent: string | null;
  theme: string | null; // null = preset default
  title: string;
  description: string;
  scale: number | null;
  icon: string | null;
  /** repo-relative override for the project icon ("" = conventional path) */
  iconPath: string;
  /** null = template/preset default; else explicit display mode */
  iconFit: string | null;
  iconRound: string | null;
  /** csv of metadata fields; null = template default; "" = show none */
  meta: string | null;
  lang: string | null;
  /** preview-only: simulate GitHub light or dark background */
  scheme: "light" | "dark";
  apiBase: string;
};

/** Banner query params shared by the banner URL and the shareable page URL
 * (one source of truth: adding a param here updates both). */
export function bannerQueryParams(state: ParamState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.theme) params.set("theme", state.theme);
  if (state.accent) params.set("accent", state.accent);
  if (state.title) params.set("title", state.title);
  if (state.description) params.set("description", state.description);
  if (state.scale != null) params.set("scale", String(state.scale));
  if (state.icon) params.set("icon", state.icon);
  if (state.iconPath) params.set("iconPath", state.iconPath);
  if (state.iconFit) params.set("iconFit", state.iconFit);
  if (state.iconRound) params.set("iconRound", state.iconRound);
  if (state.meta !== null) params.set("meta", state.meta);
  if (state.lang) params.set("lang", state.lang);
  return params;
}

export function bannerPath(state: ParamState): string | null {
  const { owner, repo } = state;
  if (!owner.trim() || !repo.trim()) return null;
  const qs = bannerQueryParams(state).toString();
  const query = qs ? `?${qs}` : "";
  // the format extension always terminates the path (API contract)
  const base = `/v1/banner/${encodeURIComponent(owner.trim())}/${encodeURIComponent(repo.trim())}`;
  if (state.template) {
    return `${base}/${encodeURIComponent(state.template)}.webp${query}`;
  }
  return `${base}.webp${query}`;
}

export function absoluteUrl(apiBase: string, path: string): string {
  const base = apiBase.trim() || window.location.origin;
  return `${base.replace(/\/$/, "")}${path}`;
}
