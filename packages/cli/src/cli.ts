#!/usr/bin/env node
/** erika CLI.
 * - render:      render from a data snapshot (M1 flow, offline)
 * - render-live: fetch live data from GitHub then render (GitHub Actions route)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderBanner } from "@erika/core";

// pick up the repo-root .env when present (shell env still wins)
try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // no .env -- rely on the process environment
}
import {
  DEFAULT_PRESETS_PATH,
  DEFAULT_TEMPLATES_DIR,
  REPO_ROOT,
  loadPresetRegistry,
  loadTemplate,
  builtinIconPathFor,
} from "@erika/core";
import { createGitHubProvider } from "@erika/providers";
import { createImageFetcher, isRepoRelativePath, presetIconPaths, repoIconUrlsFor, resolveIconChain } from "@erika/core";
import type { BannerData, Preset, Template } from "@erika/core";

type Deps = { templatesDir: string; presetsPath: string };

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      template: { type: "string" },
      data: { type: "string" },
      preset: { type: "string" },
      owner: { type: "string" },
      repo: { type: "string" },
      theme: { type: "string" },
      accent: { type: "string" },
      scale: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      meta: { type: "string" },
      icon: { type: "string" },
      out: { type: "string", short: "o" },
      font: { type: "string" },
      "fonts-dir": { type: "string", multiple: true },
      format: { type: "string" },
      "presets-path": { type: "string" },
      "templates-dir": { type: "string" },
      token: { type: "string" },
    },
  });

  const command = positionals[0] ?? "render";
  const deps: Deps = {
    templatesDir: values["templates-dir"] ?? DEFAULT_TEMPLATES_DIR,
    presetsPath: values["presets-path"] ?? DEFAULT_PRESETS_PATH,
  };

  switch (command) {
    case "render":
      return renderCommand(values, deps);
    case "render-live":
      return renderLiveCommand(values, deps);
    default:
      throw new Error(`unknown command "${command}" (supports "render", "render-live")`);
  }
}

function loadPreset(values: { preset?: string; "presets-path"?: string }): Preset | null {
  if (!values.preset) return null;
  const isRegistryKey = !existsSync(values.preset) && /^[^/\\]+\/[^/\\]+$/.test(values.preset);
  if (isRegistryKey) {
    const registry = loadPresetRegistry(values["presets-path"] ?? DEFAULT_PRESETS_PATH);
    const preset = registry.get(values.preset);
    if (!preset) throw new Error(`no preset for "${values.preset}" in registry`);
    return preset;
  }
  return JSON.parse(readFileSync(resolve(values.preset), "utf-8")) as Preset;
}

async function renderCommand(
  values: {
    template?: string; data?: string; theme?: string; accent?: string; scale?: string; title?: string;
    description?: string; meta?: string; icon?: string; out?: string; font?: string;
    "fonts-dir"?: string[]; format?: string; "templates-dir"?: string; preset?: string;
    "presets-path"?: string;
  },
  deps: Deps,
): Promise<number> {
  if (!values.template) throw new Error("--template is required (id or path)");
  if (!values.data) throw new Error("--data is required (path to data snapshot JSON)");

  const template = loadTemplate(values.template, deps.templatesDir);
  const data = JSON.parse(readFileSync(resolve(values.data), "utf-8")) as BannerData;
  if (data.private) {
    throw new Error("refusing to render: data snapshot is marked private");
  }
  const preset = loadPreset(values);
  const format = (values.format ?? extname(values.out ?? ".webp").slice(1)) as "png" | "webp";
  const fontDirs = values["fonts-dir"] ?? [join(deps.templatesDir, "fonts")];

  // offline icon pinning: --icon <file> replaces whatever the preset points at
  const iconBuffer = values.icon ? readFileSync(resolve(values.icon)) : null;
  const result = await renderBanner({
    template,
    data,
    preset,
    params: {
      theme: values.theme,
      accent: values.accent,
      scale: values.scale ? Number(values.scale) : undefined,
      title: values.title,
      description: values.description,
      meta: values.meta !== undefined ? values.meta.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
    },
    iconOverride: iconBuffer ? { buffer: iconBuffer, kind: "repo" } : undefined,
    fontDirs,
    fontOverride: values.font,
    format: format === "png" ? "png" : "webp",
  });

  const out = values.out ?? `out/${template.id}.${format}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.buffer);

  console.log(
    `rendered ${out}  ${result.width}x${result.height}  ${result.buffer.length} bytes  ` +
      `template=${template.id} font=${result.fontUsed} theme=${values.theme ?? preset?.theme ?? template.defaults.theme} accent=${result.accent}`,
  );
  return 0;
}

/** Fetch live repo data via the same Provider as the API (ETag/quiet failure
 * semantics apply), then render. Powers the GitHub Actions route: a scheduled
 * workflow regenerates committed banner files without any hosted service. */
export async function renderLiveCommand(
  values: {
    owner?: string; repo?: string; template?: string; theme?: string; accent?: string; scale?: string;
    title?: string; description?: string; meta?: string; icon?: string; out?: string; font?: string;
    "fonts-dir"?: string[]; format?: string; "presets-path"?: string; token?: string;
    "templates-dir"?: string;
  },
  deps: Deps,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<number> {
  if (!values.owner || !values.repo) throw new Error("--owner and --repo are required");
  const token = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    console.warn("[erika] GITHUB_TOKEN is not set: unauthenticated quota is 60 req/h");
  }
  const provider = createGitHubProvider({
    token,
    fetchImpl: options.fetchImpl,
    log: (msg) => console.error(`[provider] ${msg}`),
  });
  const snapshot = await provider.getRepo(values.owner, values.repo);
  const data = snapshot.data;

  const registry = loadPresetRegistry(deps.presetsPath);
  const preset = registry.get(`${values.owner}/${values.repo}`);
  const template = loadTemplate(values.template ?? preset?.template ?? "grokbot", deps.templatesDir);
  // same public interface as the API: the project icon lives in the subject
  // repo (or --icon pins a local file for offline runs)
  const iconBuffer = values.icon ? readFileSync(resolve(values.icon)) : null;
  const repoIconPaths = presetIconPaths(preset, values.theme);
  for (const path of repoIconPaths.filter((path) => !isRepoRelativePath(path))) {
    console.error(`[icons] preset icon path "${path}" is not repo-relative; ignoring it`);
  }
  const repoIconUrls = repoIconUrlsFor({
    owner: values.owner,
    repo: values.repo,
    branch: data.defaultBranch,
    explicit: repoIconPaths,
  });
  const icon = iconBuffer
    ? { kind: "repo" as const, buffer: iconBuffer }
    : await resolveIconChain(["repo", "builtin"], {
        repoIconUrls,
        builtinPath: builtinIconPathFor(deps.templatesDir, values.theme),
        imageFetcher: createImageFetcher({ fetchImpl: options.fetchImpl }),
        log: (msg) => console.error(`[icons] ${msg}`),
      });
  const format = (values.format ?? extname(values.out ?? ".webp").slice(1)) as "png" | "webp";
  const fontDirs = values["fonts-dir"] ?? [join(deps.templatesDir, "fonts")];

  const result = await renderBanner({
    template,
    data,
    preset,
    params: {
      theme: values.theme,
      accent: values.accent,
      scale: values.scale ? Number(values.scale) : undefined,
      title: values.title,
      description: values.description,
      meta: values.meta !== undefined ? values.meta.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
    },
    iconOverride: icon ? { buffer: icon.buffer, kind: icon.kind } : undefined,
    fontDirs,
    fontOverride: values.font,
    format: format === "png" ? "png" : "webp",
  });

  const out = values.out ?? `out/${data.name}.${format}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.buffer);

  console.log(
    `render-live ${out}  ${result.width}x${result.height}  ${result.buffer.length} bytes  ` +
      `stars=${data.stargazersCount ?? "?"} freshness=${snapshot.freshness} font=${result.fontUsed} accent=${result.accent}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("erika failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
