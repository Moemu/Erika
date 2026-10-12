/** Icon source resolution: preset asset -> GitHub avatar -> builtin.
 * Every source is decoded and pixel-checked BEFORE it counts as available, so
 * corrupt bytes or oversized images fall through to the next source (design
 * doc 10.1: byte cap, decode pixel cap, timeout). Shared by the API and the
 * CLI (render-live) so both produce the same default artwork. */

import { readFileSync } from "node:fs";
import { loadImage } from "@napi-rs/canvas";
import { LIMITS } from "@erika/shared";
import type { Preset } from "./types.js";

export function presetIconPaths(preset: Preset | null | undefined, theme?: string): string[] {
  return [...new Set([
    theme === "light" ? preset?.icon?.pathLight : undefined,
    theme ? preset?.icon?.pathTransparent : undefined,
    preset?.icon?.path,
  ].filter((path): path is string => Boolean(path)))];
}

/** Decode and pixel-cap an image; throws on corrupt bytes or oversized input. */
export async function validateIconImage(buf: Buffer): Promise<Buffer> {
  const img = await loadImage(buf);
  if (img.width > LIMITS.iconMaxPixels || img.height > LIMITS.iconMaxPixels) {
    throw new Error(`icon exceeds pixel cap: ${img.width}x${img.height} > ${LIMITS.iconMaxPixels}`);
  }
  return buf;
}

export interface ImageFetcher {
  (url: string): Promise<Buffer>;
}

/** Byte/pixel-capped fetcher for GitHub-hosted images: avatars and the subject
 * repo's own icon (raw.githubusercontent.com). Both live on GitHub-controlled
 * hosts, so the SSRF surface stays fixed and no user-supplied host is fetched. */
export function createImageFetcher(options: {
  maxBytes?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheMaxBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}): ImageFetcher {
  const maxBytes = options.maxBytes ?? LIMITS.iconMaxBytes;
  const timeoutMs = options.timeoutMs ?? LIMITS.iconTimeoutMs;
  const cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60_000;
  const cacheMaxBytes = options.cacheMaxBytes ?? LIMITS.avatarCacheMB * 1024 * 1024;
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const cache = new Map<string, { buf: Buffer; at: number }>();
  let cachedBytes = 0;

  return async function fetchImage(url: string): Promise<Buffer> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < cacheTtlMs) return hit.buf;
    if (hit) {
      cache.delete(url);
      cachedBytes -= hit.buf.length;
    }

    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("image url must be https");
    const host = u.hostname;
    if (!host.endsWith(".githubusercontent.com") && host !== "githubusercontent.com") {
      throw new Error(`image host not allowed: ${host}`);
    }
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error(`image exceeds byte cap (${declared})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`image exceeds byte cap (${buf.length})`);

    if (cachedBytes + buf.length > cacheMaxBytes) {
      // evict oldest entries until it fits
      for (const [k, v] of cache) {
        cache.delete(k);
        cachedBytes -= v.buf.length;
        if (cachedBytes + buf.length <= cacheMaxBytes) break;
      }
    }
    cache.set(url, { buf, at: Date.now() });
    cachedBytes += buf.length;
    log(`image cached: ${url} (${buf.length} bytes)`);
    return buf;
  };
}

/** Conventional locations of a project's own Grokbot icon inside its repo. */
export const REPO_ICON_PATHS = [
  "assets/grokbot-icon.webp",
  "assets/grokbot-icon.png",
  "assets/grokbot-icon.jpg",
];

/** Repo-relative path guard: a preset may only name a path INSIDE the subject
 * repo. Absolute filesystem paths (POSIX `/…`, Windows `C:\…`, UNC `\\…`) and
 * parent traversal must never reach the raw base -- an absolute path used to be
 * concatenated and 404'd silently in the container. */
export function isRepoRelativePath(p: string): boolean {
  const path = p.trim();
  if (path === "") return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/u).includes("..");
}

/** Explicit paths are tried in order (including theme-variant fallbacks).
 * Without valid explicit paths, probe the conventional repository locations. */
export function repoIconUrlsFor(s: {
  owner: string;
  repo: string;
  branch?: string;
  explicit?: string | readonly string[];
}): string[] {
  const base = `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.branch ?? "HEAD"}`;
  const paths = typeof s.explicit === "string" ? [s.explicit] : s.explicit ?? [];
  const valid = [...new Set(paths.filter(isRepoRelativePath).map((path) => path.trim()))];
  if (valid.length > 0) return valid.map((path) => `${base}/${path}`);
  return REPO_ICON_PATHS.map((p) => `${base}/${p}`);
}

export interface ResolvedIcon {
  kind: "repo" | "avatar" | "builtin";
  buffer?: Buffer;
}

/** Try the requested source, then the rest of the chain; a source is
 * "unavailable" when the repo lacks it or fetching fails. */
export async function resolveIconChain(order: string[], source: {
  /** subject-repo icon URLs (raw.githubusercontent.com), tried in order */
  repoIconUrls?: string[];
  avatarUrl?: string;
  builtinPath: string;
  imageFetcher?: ImageFetcher;
  log?: (msg: string) => void;
}): Promise<ResolvedIcon | null> {
  for (const kind of [...new Set(order)]) {
    try {
      if (kind === "repo" && source.repoIconUrls?.length && source.imageFetcher) {
        for (const url of source.repoIconUrls) {
          try {
            const buffer = await source.imageFetcher(url);
            return { kind: "repo", buffer: await validateIconImage(buffer) };
          } catch (err) {
            source.log?.(`repo icon candidate failed (${url}): ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      if (kind === "avatar" && source.avatarUrl && source.imageFetcher) {
        return { kind: "avatar", buffer: await validateIconImage(await source.imageFetcher(source.avatarUrl)) };
      }
      if (kind === "builtin") {
        return { kind: "builtin", buffer: await validateIconImage(readFileSync(source.builtinPath)) };
      }
    } catch (err) {
      source.log?.(`icon source "${kind}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

// ---- background colour capture (the PSD technique, automated) ----
// Grokbot-style icons are full-bleed artworks whose top-right corner stays
// blank; the original PSDs simply painted the canvas with that backdrop colour.
// Sampling that corner region (rather than the whole border) is what makes the
// shipped artworks work: their left edge carries the character, so a
// border-wide sampler always fails on them (measured on the shipped sources).
// Transparent corners identify artwork that can composite onto a theme.
// Non-uniform opaque corners use the contained card layout.

import { createCanvas } from "@napi-rs/canvas";

export interface CaptureResult {
  color: string | null; // "#RRGGBB" when the sampled region is uniform, else null
  transparent: boolean; // any sampled pixel is (near) transparent
}

const SAMPLE_REGION = 64; // max window edge (canvas units)
const SAMPLE_INSET = 2; // skip the outermost pixels (antialiasing)
const UNIFORM_SPREAD = 24; // allowed per-channel range inside the window

export function captureBackgroundColor(img: Awaited<ReturnType<typeof loadImage>>): CaptureResult {
  const w = img.width;
  const h = img.height;
  // clamp to what the bitmap can actually give us: tiny icons (1x1 fixtures,
  // small avatars) must not produce an out-of-bounds read
  const fits = Math.max(1, Math.min(w - SAMPLE_INSET * 2, h - SAMPLE_INSET * 2));
  const region = Math.max(1, Math.min(SAMPLE_REGION, Math.floor(Math.min(w, h) / 4), fits));
  const x0 = Math.min(Math.max(0, w - SAMPLE_INSET - region), w - region);
  const y0 = Math.min(SAMPLE_INSET, h - region);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img as unknown as Parameters<typeof ctx.drawImage>[0], 0, 0);
  const data = ctx.getImageData(x0, y0, region, region).data;

  const min = [255, 255, 255];
  const max = [0, 0, 0];
  const sum = [0, 0, 0];
  let pixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) return { color: null, transparent: true };
    for (let ch = 0; ch < 3; ch++) {
      const v = data[i + ch];
      if (v < min[ch]) min[ch] = v;
      if (v > max[ch]) max[ch] = v;
      sum[ch] += v;
    }
    pixels++;
  }
  if (pixels === 0) return { color: null, transparent: false };
  const spread = Math.max(...[0, 1, 2].map((ch) => max[ch] - min[ch]));
  if (spread > UNIFORM_SPREAD) return { color: null, transparent: false };
  const avg = sum.map((s) => Math.round(s / pixels));
  return { color: `#${avg.map((v) => v.toString(16).padStart(2, "0")).join("")}`, transparent: false };
}
