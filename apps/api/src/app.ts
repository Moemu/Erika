/** Banner API routes, placeholder responses, and cache headers. */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  DEFAULT_TEMPLATES_DIR,
  loadPresetRegistry,
  loadTemplate,
  listTemplates,
  type PresetRegistry,
} from "@erika/core";
import { renderBanner } from "@erika/core";
import {
  NotFoundError,
  UpstreamError,
  type GitHubProvider,
  type RepoSnapshot,
} from "@erika/providers";
import {
  LIMITS,
  META_FIELDS,
  bannerQuerySchema,
  normalizeQuery,
  type IconSource,
  type ImageFormat,
  type MetaField,
} from "@erika/shared";
import { RenderCache, RenderQueue, QueueOverflowError, SingleFlight, etagOf, sha256hex } from "./render-cache.js";
import {
  createImageFetcher,
  builtinIconPathFor,
  declaredMetaFields,
  defaultMetaFields,
  isRepoRelativePath,
  presetIconPaths,
  repoIconUrlsFor,
  resolveIconChain,
  validateIconImage,
  type ImageFetcher,
  type ResolvedIcon,
} from "@erika/core";

const FORMATS: ImageFormat[] = ["webp", "png"];

export interface ApiDeps {
  provider: GitHubProvider;
  templatesDir?: string;
  presetsPath?: string;
  fontsDir?: string;
  builtinIconPath?: string;
  imageFetcher?: ImageFetcher;
  cacheMaxBytes?: number;
  renderConcurrency?: number;
  renderQueueMax?: number;
  /** playground dist directory (same-origin hosting, route B); when set, the
   * built Playground is served from this app and the built-in landing page is
   * replaced by the real frontend */
  staticRoot?: string;
  /** injectable clock for tests */
  now?: () => number;
  log?: (msg: string) => void;
}

type ErrorKind = "not-found" | "upstream-rate-limited" | "upstream-timeout";

const PLACEHOLDER_MESSAGES: Record<ErrorKind, Record<"en" | "zh", string>> = {
  "not-found": {
    en: "Repository not found, or set to private.",
    zh: "仓库不存在，或已转为私有。",
  },
  "upstream-rate-limited": {
    en: "Temporarily unavailable (GitHub rate limited) — please retry later.",
    zh: "暂时不可用（GitHub 配额受限），请稍后再试。",
  },
  "upstream-timeout": {
    en: "Temporarily unavailable — please retry later.",
    zh: "服务暂时不可用，请稍后再试。",
  },
};

const CACHE_NORMAL = "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400";
const CACHE_REVALIDATE = "no-cache";
const CACHE_TRANSIENT = "public, max-age=60, s-maxage=60";

export function createApp(deps: ApiDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const templatesDir = deps.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const presetsPath = deps.presetsPath ?? join(templatesDir, "..", "..", "apps", "api", "presets", "presets.json");
  const fontsDir = deps.fontsDir ?? join(templatesDir, "fonts");
  const builtinIconPath = deps.builtinIconPath ?? builtinIconPathFor(templatesDir);
  const themedBuiltinIconPath = deps.builtinIconPath ?? builtinIconPathFor(templatesDir, "light");
  const notFoundIconPath = join(templatesDir, "assets", "erika-not-found.png");
  const notFoundIcon = existsSync(notFoundIconPath) ? readFileSync(notFoundIconPath) : undefined;
  const notFoundFingerprint = notFoundIcon ? sha256hex(notFoundIcon.toString("base64")).slice(0, 12) : "missing";
  if (!notFoundIcon) log(`not-found illustration missing: ${notFoundIconPath}; using text placeholder`);
  // the default icon's *content* is part of the render cache key: replacing the
  // asset must invalidate cached renders (a constant "builtin" fingerprint would
  // keep serving the old artwork until the LRU evicted it)
  const builtinFingerprints = new Map([...new Set([builtinIconPath, themedBuiltinIconPath])].map((path) => [
    path, existsSync(path) ? sha256hex(readFileSync(path).toString("base64")).slice(0, 12) : "missing",
  ]));
  const registry: PresetRegistry = loadPresetRegistry(presetsPath);
  const imageFetcher = deps.imageFetcher ?? createImageFetcher({ log });
  const cache = new RenderCache(deps.cacheMaxBytes ?? LIMITS.renderCacheMB * 1024 * 1024);
  const renderQueue = new RenderQueue(deps.renderConcurrency ?? 4, deps.renderQueueMax ?? 64);
  const inflight = new SingleFlight<{ bytes: Buffer; contentType: string; accent?: string }>();

  const app = new Hono();

  // Allow Playground clients to read cache and rendering headers.
  app.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Expose-Headers", "ETag, X-Banner-Error, X-Banner-Icon, X-Banner-Preset, X-Banner-Template, X-Banner-Accent");
  });

  app.get("/healthz", (c) =>
    c.json({ ok: true, cache: { count: cache.count, bytes: cache.sizeBytes }, renderQueue: renderQueue.depth }),
  );

  function tooBusy(c: Context): Response {
    c.header("Retry-After", "5");
    c.header("Cache-Control", CACHE_TRANSIENT);
    return c.json({ error: "server busy, retry later" }, 503);
  }

  app.get("/v1/meta", (c) => {
    return c.json({
      schemaVersion: 1,
      templates: listTemplates(templatesDir),
      metaFields: [...META_FIELDS],
      formats: FORMATS,
      limits: {
        title: LIMITS.titleChars,
        description: LIMITS.descriptionChars,
        scaleMin: LIMITS.scaleMin,
        scaleMax: LIMITS.scaleMax,
        urlLength: LIMITS.urlLength,
        iconMaxBytes: LIMITS.iconMaxBytes,
      },
    });
  });

  app.get("/v1/banner/:owner/:repo", (c) => bannerHandler(c, {}));
  app.get("/v1/banner/:owner/:repo/:template", (c) => bannerHandler(c, { viaTemplateParam: true }));

  async function bannerHandler(
    c: Context,
    opts: { viaTemplateParam?: boolean },
  ): Promise<Response> {
    if (c.req.url.length > LIMITS.urlLength) {
      return c.json({ error: `url too long (max ${LIMITS.urlLength} chars)` }, 414);
    }

    const owner = c.req.param("owner") ?? "";
    // format lives on the extension of the LAST path segment; repo names may contain dots
    const EXT_RE = /^(.+)\.(webp|png)$/i;
    const repoRaw = c.req.param("repo") ?? "";
    const templateParam = c.req.param("template");
    let repo = "";
    let format: ImageFormat | null = null;
    let templateId: string | null = null;
    if (templateParam !== undefined) {
      const tm = EXT_RE.exec(templateParam);
      if (!tm) return c.json({ error: "unsupported format extension; use .webp or .png" }, 400);
      templateId = tm[1];
      format = tm[2].toLowerCase() as ImageFormat;
      repo = repoRaw; // no extension on the 4-segment route
    } else {
      const rm = EXT_RE.exec(repoRaw);
      if (!rm) return c.json({ error: "unsupported format extension; use .webp or .png" }, 400);
      repo = rm[1];
      format = rm[2].toLowerCase() as ImageFormat;
    }

    const parsed = bannerQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid query", details: parsed.error.flatten().fieldErrors }, 400);
    }
    const q = normalizeQuery(parsed.data);

    const repoKey = `${owner}/${repo}`;
    const preset = registry.get(repoKey);

    // template precedence: explicit path > explicit avatar request > preset >
    // grokbot. An explicit avatar always takes the avatar path (its preset
    // template choice was written for the project's own icon).
    const iconSource: IconSource = q.icon ?? "auto";
    // iconPath names a location inside the subject repo: it is meaningless (and
    // previously silently ignored) for the avatar/builtin sources
    if (q.iconPath && iconSource !== "auto") {
      return c.json({ error: "iconPath only applies when icon is auto (default)" }, 400);
    }
    const requestedId =
      templateId ?? (iconSource === "avatar" ? "avatar" : preset?.template ?? "grokbot");
    let template;
    try {
      template = loadTemplate(requestedId, templatesDir);
    } catch {
      return c.json({ error: `unknown template "${requestedId}"` }, 400);
    }
    // An explicit theme locks the palette; artwork placement is independent.
    if (q.theme && !template.themes[q.theme]) {
      return c.json({ error: `unknown theme "${q.theme}"; available: ${Object.keys(template.themes).join(", ")}` }, 400);
    }

    const lang = q.lang ?? "en";

    // metadata fields: template default when omitted, [] when emptied, 400 for
    // fields the service does not know or the template does not declare
    const declaredFields = declaredMetaFields(template.slots.meta);
    let metaFields: MetaField[];
    if (q.meta === undefined) {
      metaFields = defaultMetaFields(template.slots.meta);
    } else {
      const unknown = q.meta.filter((f) => !(META_FIELDS as readonly string[]).includes(f));
      if (unknown.length > 0) {
        return c.json(
          { error: `unsupported meta field(s): ${unknown.join(", ")}; supported: ${META_FIELDS.join(", ")}` },
          400,
        );
      }
      const undeclared = q.meta.filter((f) => !declaredFields.includes(f as MetaField));
      if (undeclared.length > 0) {
        return c.json(
          { error: `template "${template.id}" does not declare meta field(s): ${undeclared.join(", ")}; declares: ${declaredFields.join(", ") || "none"}` },
          400,
        );
      }
      metaFields = q.meta as MetaField[];
    }

    // data with the failure taxonomy; provider serves stale when it can
    let snapshot: RepoSnapshot | null = null;
    let errorKind: ErrorKind | null = null;
    try {
      snapshot = await deps.provider.getRepo(owner, repo);
    } catch (err) {
      if (err instanceof NotFoundError) {
        errorKind = "not-found";
      } else if (err instanceof UpstreamError) {
        errorKind = err.kind === "rate-limited" ? "upstream-rate-limited" : "upstream-timeout";
      } else {
        throw err;
      }
    }

    // ---- placeholder path (never a broken image) ----
    if (errorKind) {
      const placeholderIcon = errorKind === "not-found" ? notFoundIcon : undefined;
      const phKey = `ph:${errorKind}:${lang}:${q.scale}:${repoKey}:${template.id}:${template.version}:${q.theme ?? ""}:${format}:${placeholderIcon ? notFoundFingerprint : ""}:${q.accent ?? ""}`;
      let ph: { bytes: Buffer; contentType: string; accent?: string };
      try {
        ph = await renderQueue.run(() =>
          inflight.run(phKey, async () => {
            const cached = cache.get(phKey);
            if (cached) return { bytes: cached.bytes, contentType: `image/${format}`, accent: cached.accent };
            const msg = PLACEHOLDER_MESSAGES[errorKind!][lang];
            const res = await renderBanner({
              template,
              data: { fullName: repoKey, name: repo, description: msg, private: false },
              preset: {
                title: repoKey,
                description: msg,
                theme: q.theme,
              },
              params: { scale: q.scale, theme: q.theme, accent: q.accent, meta: [] },
              fontDirs: [fontsDir],
              iconOverride: placeholderIcon ? { buffer: placeholderIcon, kind: "builtin" } : undefined,
              format,
            });
            const stored = cache.set(phKey, res.buffer, res.accent);
            return { bytes: stored.bytes, contentType: `image/${format}`, accent: stored.accent };
          }),
        );
      } catch (err) {
        if (err instanceof QueueOverflowError) return tooBusy(c);
        throw err;
      }
      const etag = etagOf(ph.bytes);
      if (ph.accent) c.header("X-Banner-Accent", ph.accent);
      c.header("X-Banner-Error", errorKind);
      c.header("X-Banner-Icon", placeholderIcon ? "builtin" : "none");
      c.header("X-Banner-Template", template.id);
      c.header("X-Banner-Preset", "0");
      c.header("Cache-Control", q.fresh ? CACHE_REVALIDATE : errorKind === "not-found" ? CACHE_NORMAL : CACHE_TRANSIENT);
      c.header("ETag", etag);
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
      return c.body(new Uint8Array(ph.bytes), 200, { "Content-Type": ph.contentType });
    }

    // ---- normal render path ----
    const data = snapshot!.data;
    const title = q.title ?? preset?.title ?? data.name;
    const description =
      q.description !== undefined ? q.description : preset?.description != null ? preset.description : data.description ?? "";

    // icon resolution: the subject repo's own icon (public interface: a
    // conventional path in that repo, overridable) then the default Grokbot icon
    const repoIconPaths = presetIconPaths(preset, q.theme);
    for (const path of repoIconPaths.filter((path) => !isRepoRelativePath(path))) {
      log(`preset icon path "${path}" is not repo-relative; ignoring it`);
    }
    const repoIconUrls = repoIconUrlsFor({
      owner,
      repo,
      branch: data.defaultBranch,
      explicit: q.iconPath ?? repoIconPaths,
    });
    const iconOrder =
      iconSource === "avatar" ? ["avatar"] : iconSource === "builtin" ? ["builtin"] : ["repo", "builtin"];
    const selectedBuiltinPath = q.theme ? themedBuiltinIconPath : builtinIconPath;
    let icon: ResolvedIcon | null;
    if (q.iconPath) {
      try {
        icon = { kind: "repo", buffer: await validateIconImage(await imageFetcher(repoIconUrls[0])) };
      } catch (err) {
        const details = err instanceof Error ? err.message : "Image load failed";
        log(`explicit iconPath failed (${q.iconPath}): ${details}`);
        c.header("Cache-Control", "no-store");
        c.header("X-Banner-Error", "icon-load-failed");
        return c.json({ error: `Cannot load iconPath "${q.iconPath}"`, details }, 400);
      }
    } else {
      icon = await resolveIconChain(iconOrder, {
        repoIconUrls,
        avatarUrl: data.avatarUrl,
        builtinPath: selectedBuiltinPath,
        imageFetcher,
        log,
      });
    }

    // the release tag is an extra upstream call: fetch it only when the
    // resolved field set displays it
    if (metaFields.includes("release") && data.releaseTag === undefined) {
      data.releaseTag = await deps.provider.getLatestRelease?.(owner, repo) ?? null;
    }

    // render cache key: template + data content version + icon source + resolved params
    const iconFingerprint = icon
      ? icon.kind === "builtin"
        ? `builtin:${builtinFingerprints.get(selectedBuiltinPath)}`
        : `${icon.kind}:${sha256hex(icon.buffer!.toString("base64")).slice(0, 16)}`
      : "none";
    const cacheKey = sha256hex(JSON.stringify({
      templateId: template.id,
      templateVersion: template.version,
      dataVersion: snapshot!.version,
      releaseTag: data.releaseTag ?? null,
      icon: iconFingerprint,
      title,
      description,
      theme: q.theme ?? null,
      accent: q.accent ?? null,
      scale: q.scale,
      iconFit: q.iconFit ?? null,
      iconRound: q.iconRound ?? null,
      meta: metaFields,
      format,
    }));

    let rendered: { bytes: Buffer; contentType: string; accent?: string };
    try {
      rendered = await renderQueue.run(() =>
        inflight.run(cacheKey, async () => {
          const cached = cache.get(cacheKey);
          if (cached) return { bytes: cached.bytes, contentType: `image/${format}`, accent: cached.accent };
          const res = await renderBanner({
            template,
            data,
            preset: preset ?? null,
            params: {
              theme: q.theme,
              accent: q.accent,
              scale: q.scale,
              title: q.title,
              description: q.description,
              meta: metaFields,
              iconFit: q.iconFit,
              iconRound: q.iconRound === undefined ? undefined : q.iconRound === "1",
            },
            iconOverride: icon ? { buffer: icon.buffer, kind: icon.kind } : undefined,
            fontDirs: [fontsDir],
            format,
          });
          const stored = cache.set(cacheKey, res.buffer, res.accent);
          return { bytes: stored.bytes, contentType: `image/${format}`, accent: stored.accent };
        }),
      );
    } catch (err) {
      if (err instanceof QueueOverflowError) return tooBusy(c);
      throw err;
    }

    const etag = etagOf(rendered.bytes);
    c.header("Cache-Control", q.fresh ? CACHE_REVALIDATE : CACHE_NORMAL);
    c.header("ETag", etag);
    // discoverability: which template, icon source & preset served this image
    c.header("X-Banner-Template", template.id);
    c.header("X-Banner-Icon", icon?.kind ?? "none");
    c.header("X-Banner-Preset", preset ? "1" : "0");
    if (rendered.accent) c.header("X-Banner-Accent", rendered.accent);
    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    return c.body(new Uint8Array(rendered.bytes), 200, { "Content-Type": rendered.contentType });
  }

  if (!deps.staticRoot) {
    // built-in landing page: only when NOT serving the Playground statically
    app.get("/", (c) => {
      return c.html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Erika — Banner API</title>
<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:48px auto;padding:0 24px;background:#171412;color:#eee}
code{background:#2a2523;padding:2px 6px;border-radius:4px}a{color:#d9a08a}</style></head>
<body><h1>Erika（絵里香）</h1>
<p>为你的仓库绘制肖像的画师少女 / A banner girl who paints portraits for your repos.</p>
<h2>用法</h2>
<pre><code>GET /v1/banner/:owner/:repo.webp
GET /v1/banner/:owner/:repo/:template.webp</code></pre>
<p>示例：<a href="/v1/banner/Moemu/Erika.webp">/v1/banner/Moemu/Erika.webp</a></p>
<p>参数：theme / accent / title / description / meta / icon / scale / lang / fresh（见 <a href="/v1/meta">/v1/meta</a> 与 <a href="/doc">/doc</a>）</p>
</body></html>`);
    });
  }

  // minimal static OpenAPI description (full zod-openapi integration deferred)
  app.get("/doc", (c) => {
    return c.json({
      openapi: "3.1.0",
      info: { title: "Erika Banner API", version: "0.1.0" },
      paths: {
        "/v1/banner/{owner}/{repo}{format}": {
          get: {
            summary: "Render a repo banner",
            parameters: [
              { name: "owner", in: "path", required: true, schema: { type: "string" } },
              { name: "repo", in: "path", required: true, schema: { type: "string" } },
              { name: "format", in: "path", required: true, schema: { enum: [".webp", ".png"] } },
              { name: "theme", in: "query", schema: { type: "string" } },
              { name: "accent", in: "query", schema: { type: "string", pattern: "^(auto|#[0-9a-fA-F]{6})$", example: "auto" } },
              { name: "title", in: "query", schema: { type: "string", maxLength: LIMITS.titleChars } },
              { name: "description", in: "query", schema: { type: "string", maxLength: LIMITS.descriptionChars } },
              { name: "meta", in: "query", description: `Comma-separated fields: ${META_FIELDS.join(", ")}. Empty string hides all metadata. Omit to use template defaults. last_updated is the UTC code push date.`, schema: { type: "string", example: "license,language,last_updated" } },
              { name: "icon", in: "query", schema: { enum: ["auto", "avatar", "builtin"] } },
              { name: "iconPath", in: "query", description: "Repository image path. Fetch, decode, or size failures return JSON 400 without fallback.", schema: { type: "string", example: "assets/grokbot-icon.webp" } },
              { name: "iconFit", in: "query", schema: { enum: ["contain", "cover"] } },
              { name: "iconRound", in: "query", schema: { enum: ["0", "1"] } },
              { name: "scale", in: "query", schema: { type: "number", minimum: LIMITS.scaleMin, maximum: LIMITS.scaleMax } },
              { name: "lang", in: "query", schema: { enum: ["en", "zh"] } },
              { name: "fresh", in: "query", schema: { enum: ["1"], example: "1" } },
            ],
            responses: {
              "200": { description: "Banner image", content: { "image/webp": {}, "image/png": {} } },
              "304": { description: "Not modified (ETag)" },
              "400": { description: "Invalid params or unavailable explicit iconPath image" },
            },
          },
        },
        "/v1/meta": { get: { summary: "Template & capability manifest", responses: { "200": { description: "OK" } } } },
      },
    });
  });

  // route B same-origin static hosting: the built Playground is served from
  // this app. Registered LAST so the API routes above keep priority;
  // extension-less unknown paths fall back to the SPA entry.
  if (deps.staticRoot) {
    const spaIndex = readFileSync(join(deps.staticRoot, "index.html"), "utf-8");
    app.all("/v1", (c) => c.json({ error: "not found" }, 404));
    app.all("/v1/*", (c) => c.json({ error: "not found" }, 404));
    app.use("*", serveStatic({ root: deps.staticRoot }));
    app.get("*", (c) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.includes(".")) return c.text("not found", 404);
      return c.html(spaIndex);
    });
  }

  return app;
}
