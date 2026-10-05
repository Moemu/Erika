/** URL-as-state: every playground parameter lives in the query string so any
 * panel configuration is shareable by link. */

import { bannerQueryParams, type ParamState } from "./api.js";
import type { Locale } from "./locale.js";

const KEYS = [
  "owner", "repo", "template", "theme", "accent", "title", "description",
  "scale", "icon", "iconPath", "iconFit", "iconRound", "meta", "lang", "scheme", "apiBase",
] as const;

export function readStateFromUrl(): Partial<ParamState> {
  const params = new URLSearchParams(window.location.search);
  const state: Partial<ParamState> = {};
  for (const key of KEYS) {
    const raw = params.get(key);
    if (raw == null) continue;
    const v = raw;
    // `meta=` (empty) is meaningful: it means "show no metadata"
    if (v === "" && key !== "meta") continue;
    if (key === "scale") {
      const n = Number(v);
      if (Number.isFinite(n)) state.scale = n;
    } else if (key === "scheme") {
      if (v === "light" || v === "dark") state.scheme = v;
    } else {
      (state as Record<string, unknown>)[key] = v;
    }
  }
  return state;
}

export function writeStateToUrl(state: ParamState, locale: Locale): void {
  const params = new URLSearchParams();
  params.set("uiLang", locale);
  if (state.owner) params.set("owner", state.owner);
  if (state.repo) params.set("repo", state.repo);
  if (state.template) params.set("template", state.template);
  bannerQueryParams(state).forEach((value, key) => params.set(key, value));
  if (state.scheme !== "dark") params.set("scheme", state.scheme);
  if (state.apiBase) params.set("apiBase", state.apiBase);
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  window.history.replaceState(null, "", url);
}
