/** Parameter panel: rendered from /v1/meta so new server capabilities show up
 * without a playground release.
 *
 * Layout: the everyday fields stay visible; icon path / display overrides /
 * placeholder language / API base live behind 高级选项 so the form reads as a
 * short list instead of a wall of controls. */

import { useI18n, type MessageKey } from "../lib/i18n.js";
import { useState } from "react";
import { Field, Select, TextInput, Button } from "./ui.js";
import type { Meta, ParamState } from "../lib/api.js";

const META_LABELS: Partial<Record<string, MessageKey>> = {
  stars: "stars",
  forks: "forks",
  issues: "issues",
  release: "release",
  full_name: "fullName",
  license: "license",
  language: "language",
  last_updated: "lastUpdated",
};

export function ParamPanel({
  meta,
  state,
  patch,
  onRefreshMeta,
  metaError,
}: {
  meta: Meta | null;
  state: ParamState;
  patch: (p: Partial<ParamState>) => void;
  onRefreshMeta: () => void;
  metaError: string | null;
}) {
  const { t } = useI18n();
  // the server picks grokbot/avatar from the icon source when no template is
  // pinned; mirror that here so the panel shows the effective template
  const autoId = state.icon === "avatar" ? "avatar" : "grokbot";
  const template =
    meta?.templates.find((t) => t.id === (state.template ?? autoId)) ?? meta?.templates[0] ?? null;
  const limits = meta?.limits;
  const scaleMin = limits?.scaleMin ?? 0.1;
  const declaredMeta = template?.metaFields ?? [];
  const effectiveMeta =
    state.meta === null ? (template?.defaultMetaFields ?? declaredMeta) : state.meta.split(",").map((f) => f.trim()).filter(Boolean);
  const toggleMeta = (field: string, on: boolean) => {
    const next = on ? [...effectiveMeta, field] : effectiveMeta.filter((f) => f !== field);
    patch({ meta: next.join(",") });
  };
  // shared links that carry advanced overrides should show them without a click
  const advancedActive =
    state.iconPath !== "" ||
    state.iconFit !== null ||
    state.iconRound !== null ||
    state.lang !== null ||
    state.apiBase !== "";
  const scale = state.scale ?? 0.5;
  const [advOpen, setAdvOpen] = useState(advancedActive);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Owner">
          <TextInput
            value={state.owner}
            onChange={(e) => patch({ owner: e.target.value })}
            placeholder="Moemu"
            spellCheck={false}
          />
        </Field>
        <Field label="Repo">
          <TextInput
            value={state.repo}
            onChange={(e) => patch({ repo: e.target.value })}
            placeholder="Erika"
            spellCheck={false}
          />
        </Field>
      </div>

      {metaError && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 p-2 text-xs text-red-300">
          {t("metaFailed")}: {metaError}
          <Button className="ml-2" onClick={onRefreshMeta}>{t("retry")}</Button>
        </p>
      )}

      {meta && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("template")}>
              <Select
                value={state.template ?? ""}
                onChange={(e) => patch({ template: e.target.value || null })}
                options={[
                  { value: "", label: t("autoTemplate") },
                  ...meta.templates.map((t) => ({ value: t.id, label: t.id })),
                ]}
              />
            </Field>
            <Field label={t("theme")}>
              <Select
                value={state.theme ?? ""}
                onChange={(e) => patch({ theme: e.target.value || null })}
                options={[
                  { value: "", label: t("presetDefault") },
                  ...(template?.themes ?? ["dark", "light"]).map((theme) => ({
                    value: theme,
                    label: theme === "dark" ? t("dark") : theme === "light" ? t("light") : theme,
                  })),
                ]}
              />
            </Field>
          </div>

          <Field label={t("accent")} hint={t("accentHint")}>
            <div className="flex items-center gap-2">
              <Select
                value={state.accent === "auto" ? "auto" : state.accent ? "custom" : ""}
                onChange={(e) => patch({ accent: e.target.value === "custom" ? "#8B65B5" : e.target.value || null })}
                options={[
                  { value: "", label: t("presetDefault") },
                  { value: "auto", label: t("accentAuto") },
                  { value: "custom", label: t("accentCustom") },
                ]}
              />
              {state.accent && state.accent !== "auto" && (
                <input type="color" aria-label={t("accentCustom")} value={/^#[0-9a-f]{6}$/i.test(state.accent) ? state.accent : "#8B65B5"}
                  onInput={(e) => patch({ accent: e.currentTarget.value })} className="h-8 w-12 shrink-0 cursor-pointer" />
              )}
            </div>
          </Field>

          <Field label={t("titleOverride")} hint={t("titleHint", { limit: limits?.title ?? 25 })}>
            <TextInput
              value={state.title}
              maxLength={limits?.title ?? 25}
              onChange={(e) => patch({ title: e.target.value })}
              spellCheck={false}
            />
          </Field>

          <Field label={t("descriptionOverride")} hint={t("descriptionHint", { limit: limits?.description ?? 180 })}>
            <textarea
              value={state.description}
              maxLength={limits?.description ?? 180}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
              className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-600 transition-colors focus:border-brand-500/70 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </Field>

          <Field
            label={`${t("scale")} ${scale.toFixed(2)}`}
            hint={
              template
                ? `${Math.round(template.canvas.width * scale)}×${Math.round(template.canvas.height * scale)}`
                : undefined
            }
          >
            <input
              type="range"
              min={scaleMin}
              max={limits?.scaleMax ?? 1}
              step={0.05}
              value={scale}
              onChange={(e) => patch({ scale: Number(e.target.value) })}
              className="w-full accent-brand-500"
            />
          </Field>

          <Field label={t("iconSource")} hint={t("avatarHint")}>
            <Select
              value={state.icon ?? ""}
              onChange={(e) => patch(e.target.value ? { icon: e.target.value, iconPath: "" } : { icon: null })}
              options={[
                { value: "", label: t("autoIcon") },
                { value: "builtin", label: t("defaultIcon") },
                { value: "avatar", label: t("avatar") },
              ]}
            />
          </Field>

          <section aria-labelledby="icon-guide-heading" className="space-y-2 rounded-lg border border-brand-300/50 bg-brand-200/30 p-2.5 text-xs leading-relaxed text-ink-300">
            <h2 id="icon-guide-heading" className="font-medium text-ink-100">{t("guideTitle")}</h2>
            <a
              href={t("studioUrl")}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded text-brand-600 underline underline-offset-4 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              {t("studioLink")}
            </a>
            <details>
              <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">{t("guideSummary")}</summary>
              <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                <li>{t("guideGenerate")}</li>
                <li>{t("guideSave")} <code>assets/grokbot-icon.png</code>{t("period")} {t("guideTransparent")}</li>
                <li>{t("guideUse")}</li>
              </ol>
              <p className="mt-2">
                {t("guideCredit")}{" "}
                <a href="https://x.com/Multi_Serio_Ai/status/2100800237619347535" target="_blank" rel="noopener noreferrer" className="rounded text-brand-600 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">@Multi_Serio_Ai</a>{t("period")}
              </p>
            </details>
          </section>

          <Field label={t("metadata")}>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-0.5">
              {(template?.metaFields ?? []).map((field) => (
                <label key={field} className="flex items-center gap-1.5 text-xs text-ink-300">
                  <input
                    type="checkbox"
                    checked={effectiveMeta.includes(field)}
                    onChange={(e) => toggleMeta(field, e.target.checked)}
                    className="accent-brand-500"
                  />
                  {META_LABELS[field] ? t(META_LABELS[field]) : field}
                </label>
              ))}
              {(template?.metaFields ?? []).length === 0 && (
                <span className="text-xs text-ink-600">{t("noMetadata")}</span>
              )}
            </div>
          </Field>

          <details
            open={advOpen}
            onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)}
            className="group rounded-lg border border-ink-700 bg-ink-900"
          >
            <summary className="cursor-pointer select-none rounded-md px-2.5 py-2 text-xs text-ink-300 transition-colors hover:text-ink-100">
              {t("advanced")}
            </summary>
            <div className="space-y-3 border-t border-ink-700 p-2.5">
              {/* the API only honors iconPath for icon=auto (default); the field
                  is hidden for avatar/builtin instead of silently ignored */}
              {!state.icon && (
                <Field label={t("iconPath")} hint={t("relativePath")}>
                  <TextInput
                    value={state.iconPath}
                    onChange={(e) => patch({ iconPath: e.target.value })}
                    placeholder="assets/grokbot-icon.webp"
                    spellCheck={false}
                  />
                </Field>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Field label={t("iconDisplay")}>
                  <Select
                    value={state.iconFit ?? ""}
                    onChange={(e) => patch({ iconFit: e.target.value || null })}
                    options={[
                      { value: "", label: t("templateDefault") },
                      { value: "contain", label: t("contain") },
                      { value: "cover", label: t("cover") },
                    ]}
                  />
                </Field>
                <Field label={t("roundCrop")}>
                  <Select
                    value={state.iconRound ?? ""}
                    onChange={(e) => patch({ iconRound: e.target.value || null })}
                    options={[
                      { value: "", label: t("templateDefault") },
                      { value: "1", label: t("circle") },
                      { value: "0", label: t("square") },
                    ]}
                  />
                </Field>
              </div>

              <Field label={t("placeholderLanguage")}>
                <Select
                  value={state.lang ?? ""}
                  onChange={(e) => patch({ lang: e.target.value || null })}
                  options={[
                    { value: "", label: t("followInterface") },
                    { value: "zh", label: t("chinese") },
                    { value: "en", label: "English" },
                  ]}
                />
              </Field>

              <Field label={t("apiBase")} hint={t("sameOrigin")}>
                <TextInput
                  value={state.apiBase}
                  onChange={(e) => patch({ apiBase: e.target.value })}
                  placeholder={window.location.origin}
                  spellCheck={false}
                />
              </Field>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
