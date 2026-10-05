/** Erika Playground — URL is state, preview is production. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchBanner, fetchMeta, bannerPath, type Meta, type PreviewImage } from "./lib/api.js";
import { readStateFromUrl, writeStateToUrl } from "./lib/url-state.js";
import { ParamPanel } from "./components/param-panel.js";
import { PreviewStage } from "./components/preview-stage.js";
import { Snippets } from "./components/snippets.js";
import { useI18n } from "./lib/i18n.js";
import { Button, CopyButton, Select } from "./components/ui.js";
import { Sun, Moon, Maximize2, Minimize2, RotateCcw } from "lucide-react";

const DEFAULT_STATE = {
  owner: "Moemu",
  repo: "Erika",
  template: null,
  theme: null,
  // default to artwork detection: visitors don't know a preset may tune the
  // accent, and the preset color is one click away ("跟随预设")
  accent: "auto" as string | null,
  title: "",
  description: "",
  scale: null,
  icon: null,
  iconPath: "",
  iconFit: null,
  iconRound: null,
  meta: null,
  lang: null,
  scheme: "dark" as const,
  apiBase: "",
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const [state, setState] = useState(() => ({ ...DEFAULT_STATE, ...readStateFromUrl() }));
  const patch = useCallback((p: Partial<typeof state>) => {
    setState((old) => ({ ...old, ...p }));
  }, []);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaTick, setMetaTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setMetaError(null);
    fetchMeta(state.apiBase || "", ctrl.signal)
      .then(setMeta)
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setMetaError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [state.apiBase, metaTick]);

  useEffect(() => {
    writeStateToUrl(state, locale);
  }, [state, locale]);

  const bannerState = useMemo(() => ({ ...state, lang: state.lang ?? (locale === "zh-CN" ? "zh" : "en") }), [state, locale]);
  const path = useMemo(() => bannerPath(bannerState), [bannerState]);
  const debouncedPath = useDebounced(path, 300);
  const [image, setImage] = useState<PreviewImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!debouncedPath) {
      setImage(null);
      return;
    }
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    setPreviewError(null);
    fetchBanner(state.apiBase || "", debouncedPath, ctrl.signal)
      .then((r) => {
        setImage((old) => {
          if (old) URL.revokeObjectURL(old.blobUrl);
          return r;
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setPreviewError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPath, state.apiBase]);

  const autoTemplate = state.icon === "avatar" ? "avatar" : "grokbot";
  const template = meta?.templates.find((t) => t.id === (state.template ?? autoTemplate)) ?? null;

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-4 p-4 lg:flex-row">
      {/* main column */}
      <main className="min-w-0 flex-1 space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold">
            <img
              src={`${import.meta.env.BASE_URL}icon-192.png`}
              alt=""
              aria-hidden="true"
              className="h-9 w-9 rounded-xl ring-1 ring-brand-500/20"
            />
            <span className="text-brand-600">Erika</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("interfaceLanguage")}
              className="w-auto max-w-32"
              value={locale}
              onChange={(e) => setLocale(e.target.value === "zh-CN" ? "zh-CN" : "en")}
              options={[{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]}
            />
            <Button onClick={() => patch({ scheme: state.scheme === "dark" ? "light" : "dark" })}>
              {state.scheme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              {state.scheme === "dark" ? t("lightPreview") : t("darkPreview")}
            </Button>
            <Button onClick={() => patch({ scale: state.scale == null ? 1 : null })} title={t("originalSizeHint")}>
              {state.scale == null ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
              {state.scale == null ? t("originalSize") : t("readmeSize")}
            </Button>
          </div>
        </header>

        <PreviewStage
          image={image}
          loading={loading}
          error={previewError}
          scheme={state.scheme}
          raw={state.scale === 1}
          scale={state.scale ?? 0.5}
          canvas={template?.canvas ?? null}
        />

        {path && <Snippets state={bannerState} path={path} />}

        <p className="text-xs text-ink-600">{t("previewHint")}</p>
      </main>

      {/* side panel */}
      <aside className="panel w-full shrink-0 space-y-4 p-4 lg:w-80">
        <ParamPanel
          meta={meta}
          metaError={metaError}
          state={state}
          patch={patch}
          onRefreshMeta={() => setMetaTick((t) => t + 1)}
        />

        <div className="flex gap-2 border-t border-ink-700 pt-3">
          <CopyButton
            text={path ? `${(state.apiBase || window.location.origin).replace(/\/$/, "")}${path}` : ""}
            label={t("copyUrl")}
          />
          <Button onClick={() => setState({ ...DEFAULT_STATE })} title={t("resetHint")}>
              <RotateCcw size={14} /> {t("reset")}
            </Button>
        </div>
      </aside>
    </div>
  );
}
