/** API integration tests: the M2 key acceptance is the "same README URL
 * updates after repo data changes + degrades per policy on GitHub failure". */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TEMPLATES_DIR } from "@erika/core";
import { LIMITS } from "@erika/shared";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createApp } from "../src/app.js";
import type { GitHubProvider, RepoSnapshot } from "@erika/providers";
import { NotFoundError, UpstreamError } from "@erika/providers";

/** Scriptable fake provider: snapshots queue + error injection. */
function fakeProvider() {
  const queue: Array<RepoSnapshot | Error> = [];
  const calls = 0;
  const provider: GitHubProvider = {
    async getRepo() {
      const next = queue.shift();
      if (!next) throw new Error("fake provider queue empty");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { provider, queue };
}

function snapshot(stars: number, versionSuffix = ""): RepoSnapshot {
  return {
    freshness: "fresh",
    version: `v${stars}${versionSuffix}`,
    data: {
      fullName: "Moemu/Erika",
      name: "Erika",
      description: "A URL-driven banner service\nfor GitHub repositories,\nrendering portrait banners.",
      stargazersCount: stars,
      forksCount: 1,
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      private: false,
    },
  };
}

function buildApp(queue: Array<RepoSnapshot | Error>) {
  return createApp({
    provider: {
      getRepo: async () => {
        const next = queue.shift();
        if (!next) throw new Error("queue empty");
        if (next instanceof Error) throw next;
        return next;
      },
    },
    // the icon chain would hit raw.githubusercontent.com; tests serve the local
    // fixture instead, so the repo-icon path is exercised without network
    imageFetcher: async (url: string) => {
      if (url.includes("avatars.githubusercontent.com")) throw new Error("no avatars in these tests");
      return readFileSync(join(DEFAULT_TEMPLATES_DIR, "assets", "erika.webp"));
    },
    cacheMaxBytes: 64 * 1024 * 1024,
  });
}

describe("GET /v1/banner", () => {
  let queue: Array<RepoSnapshot | Error>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    queue = [];
    app = buildApp(queue);
  });

  it("validates accent colors before fetching upstream", async () => {
    for (const accent of ["red", "#fff", "#GG0000", "auto!"]) {
      const res = await app.request(`/v1/banner/A/B.webp?accent=${encodeURIComponent(accent)}`);
      expect(res.status).toBe(400);
    }
    expect(queue).toHaveLength(0);
  });

  it("keeps accent colors distinct in cache and exposes them on cache hits and 304", async () => {
    const url = "/v1/banner/Moemu/Erika.webp?scale=0.1&theme=light";
    const fetch = async (accent?: string, etag?: string) => {
      queue.push(snapshot(42));
      return app.request(url + (accent ? `&accent=${encodeURIComponent(accent)}` : ""),
        etag ? { headers: { "If-None-Match": etag } } : undefined);
    };
    const defaults = await fetch();
    const custom = await fetch("#FFFFFF");
    expect(custom.headers.get("X-Banner-Accent")).toBe("#FFFFFF");
    expect(custom.headers.get("etag")).not.toBe(defaults.headers.get("etag"));
    const cached = await fetch("#ffffff", custom.headers.get("etag")!);
    expect(cached.status).toBe(304);
    expect(cached.headers.get("X-Banner-Accent")).toBe("#FFFFFF");
    const auto = await fetch("auto");
    expect(auto.headers.get("X-Banner-Accent")).toMatch(/^#[0-9A-F]{6}$/);
    expect(auto.headers.get("access-control-expose-headers")).toContain("X-Banner-Accent");
  });

  it("uses requested accent on placeholders and separates their cache entries", async () => {
    const request = async (accent: string) => {
      queue.push(new NotFoundError("missing"));
      return app.request(`/v1/banner/No/Such.webp?scale=0.1&accent=${encodeURIComponent(accent)}`);
    };
    const first = await request("#123456");
    const second = await request("#654321");
    const cached = await request("#123456");
    expect(first.headers.get("X-Banner-Accent")).toBe("#123456");
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(cached.headers.get("X-Banner-Accent")).toBe("#123456");
    expect(cached.headers.get("etag")).toBe(first.headers.get("etag"));
  });

  it("renders a webp with ETag + cache headers", async () => {
    queue.push(snapshot(9));
    const res = await app.request("/v1/banner/Moemu/Erika.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Banner-Error");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10_000);
  });

  it("revalidates with ETag: identical payload -> 304", async () => {
    const snap = snapshot(9);
    queue.push(snap, snap);
    const res1 = await app.request("/v1/banner/Moemu/Erika.webp");
    const etag = res1.headers.get("etag")!;
    const res2 = await app.request("/v1/banner/Moemu/Erika.webp", {
      headers: { "If-None-Match": etag },
    });
    expect(res2.status).toBe(304);
  });

  it("KEY ACCEPTANCE: same URL updates after data change (new ETag, new bytes)", async () => {
    // stars are VISIBLE by default (the template declares the footer row)
    queue.push(snapshot(9), snapshot(42, "-b"), snapshot(42, "-b"));
    const url = "/v1/banner/Moemu/Erika.webp";
    const res1 = await app.request(url);
    const etag1 = res1.headers.get("etag")!;
    const bytes1 = await res1.arrayBuffer();

    const res2 = await app.request(url);
    const etag2 = res2.headers.get("etag")!;
    const bytes2 = await res2.arrayBuffer();

    expect(etag2).not.toBe(etag1);
    expect(Buffer.compare(Buffer.from(bytes1), Buffer.from(bytes2))).not.toBe(0);

    // a conditional request against the OLD etag now re-downloads (200)
    const res3 = await app.request(url, { headers: { "If-None-Match": etag1 } });
    expect(res3.status).toBe(200);
  });

  it("invariant: with metadata off (?meta=) a stars-only change keeps the bytes", async () => {
    queue.push(snapshot(9), snapshot(42, "-b"));
    const url = "/v1/banner/Moemu/Erika.webp?meta=";
    const res1 = await app.request(url);
    const res2 = await app.request(url);
    // ETag is the image-bytes hash: with no metadata row the render is identical
    // bytes, so the ETag stays equal even though the data version changed.
    expect(res2.headers.get("etag")).toBe(res1.headers.get("etag"));
    expect(Buffer.compare(Buffer.from(await res1.arrayBuffer()), Buffer.from(await res2.arrayBuffer()))).toBe(0);
  });

  it("metadata rows are opt-out: ?meta= renders a different image", async () => {
    queue.push(snapshot(9), snapshot(9));
    const withRows = await app.request("/v1/banner/Moemu/Erika.webp");
    const without = await app.request("/v1/banner/Moemu/Erika.webp?meta=");
    expect(without.status).toBe(200);
    expect(without.headers.get("etag")).not.toBe(withRows.headers.get("etag"));
  });

  it("description accent markers survive the query path and change the bytes only by colour", async () => {
    queue.push(snapshot(9), snapshot(9));
    const plain = await app.request(
      "/v1/banner/Moemu/Erika.webp?description=A%20Nonebot%202%20plugin",
    );
    const marked = await app.request(
      "/v1/banner/Moemu/Erika.webp?description=A%20**Nonebot%202**%20plugin",
    );
    expect(marked.status).toBe(200);
    expect(marked.headers.get("etag")).not.toBe(plain.headers.get("etag"));
  });

  it("not-found repo -> placeholder image with X-Banner-Error + normal cache", async () => {
    queue.push(new NotFoundError("No/Such"));
    const res = await app.request("/v1/banner/No/Such.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-error")).toBe("not-found");
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(res.headers.get("content-type")).toBe("image/webp");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it.each([
    ["grokbot", "light", "en", "png"],
    ["grokbot", "dark", "zh", "webp"],
    ["avatar", "light", "zh", "webp"],
    ["avatar", "dark", "en", "png"],
  ])("not-found uses Erika artwork with %s, %s, %s and %s", async (template, theme, lang, format) => {
    queue.push(new NotFoundError("No/Such"), new NotFoundError("No/Such"));
    const url = `/v1/banner/No/Such/${template}.${format}?theme=${theme}&lang=${lang}&scale=0.2&icon=avatar`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-icon")).toBe("builtin");
    expect(res.headers.get("x-banner-template")).toBe(template);
    expect(res.headers.get("x-banner-preset")).toBe("0");
    expect(res.headers.get("x-banner-error")).toBe("not-found");
    const image = await loadImage(Buffer.from(await res.arrayBuffer()));
    expect([image.width, image.height]).toEqual([600, 360]);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width / 2, image.height).data;
    let sweatPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 2] > pixels[i] + 40 && pixels[i + 1] > pixels[i] + 20) sweatPixels++;
    }
    expect(sweatPixels).toBeGreaterThan(10);
    const cached = await app.request(url, { headers: { "If-None-Match": res.headers.get("etag")! } });
    expect(cached.status).toBe(304);
  });

  it("rate limited without stale -> transient placeholder with short cache", async () => {
    queue.push(new UpstreamError("rate-limited", "limited", 120));
    const res = await app.request("/v1/banner/Moemu/Erika.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-error")).toBe("upstream-rate-limited");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
  });

  it("serves stale data when the provider says so (degradation path)", async () => {
    const stale = { ...snapshot(9), freshness: "stale" as const };
    queue.push(stale);
    const res = await app.request("/v1/banner/Moemu/Erika.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-error")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
  });

  it("fresh=1 switches the response to revalidate-always", async () => {
    queue.push(snapshot(9));
    const res = await app.request("/v1/banner/Moemu/Erika.webp?fresh=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("validates params: bad scale / long title / unknown template / unknown theme / iconPath+icon / fresh", async () => {
    queue.push(snapshot(9));
    const badScale = await app.request("/v1/banner/Moemu/Erika.webp?scale=2");
    expect(badScale.status).toBe(400);
    const longTitle = await app.request(
      `/v1/banner/Moemu/Erika.webp?title=${"x".repeat(LIMITS.titleChars + 1)}`,
    );
    expect(longTitle.status).toBe(400);
    const longDesc = await app.request(
      `/v1/banner/Moemu/Erika.webp?description=${"x".repeat(LIMITS.descriptionChars + 1)}`,
    );
    expect(longDesc.status).toBe(400);
    const badTemplate = await app.request("/v1/banner/Moemu/Erika/nope.webp");
    expect(badTemplate.status).toBe(400);
    const badTheme = await app.request("/v1/banner/Moemu/Erika.webp?theme=sepia");
    expect(badTheme.status).toBe(400);
    const badExt = await app.request("/v1/banner/Moemu/Erika.gif");
    expect(badExt.status).toBe(400);
    const iconPathWithBuiltin = await app.request(
      "/v1/banner/Moemu/Erika.webp?icon=builtin&iconPath=assets/mine.webp",
    );
    expect(iconPathWithBuiltin.status).toBe(400);
    const badFresh = await app.request("/v1/banner/Moemu/Erika.webp?fresh=0");
    expect(badFresh.status).toBe(400);
  });

  it("zh placeholder message for not-found with lang=zh", async () => {
    queue.push(new NotFoundError("No/Such"));
    const res = await app.request("/v1/banner/No/Such.webp?lang=zh");
    expect(res.headers.get("x-banner-error")).toBe("not-found");
    expect(res.status).toBe(200);
  });

  it("repo names with dots survive extension parsing", async () => {
    queue.push({ ...snapshot(5), data: { ...snapshot(5).data, name: "next.js", fullName: "vercel/next.js" }, version: "nextjs" });
    const res = await app.request("/v1/banner/vercel/next.js.webp");
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/meta", () => {
  it("lists templates with their declared metadata fields", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      templates: Array<{ id: string; metaFields: string[]; defaultMetaFields: string[] }>;
      metaFields: string[];
    };
    const ids = meta.templates.map((t) => t.id);
    expect(ids).toContain("grokbot");
    expect(ids).toContain("avatar");
    const grokbot = meta.templates.find((t) => t.id === "grokbot")!;
    expect(grokbot.metaFields).toEqual(["full_name", "stars", "forks", "issues", "release", "license", "language", "last_updated"]);
    expect(grokbot.defaultMetaFields).toEqual(["full_name", "stars", "forks", "issues", "release"]);
    expect(meta.metaFields).toContain("release");
  });
});

describe("review regressions", () => {
  it("accepts new fields on both templates, preserves defaults and refreshes their image ETags", async () => {
    const original = snapshot(9, "metadata");
    original.data = { ...original.data, licenseSpdxId: "MIT", language: "TypeScript", pushedAt: "2026-09-30T00:00:00Z" };
    const queue = [original, snapshot(9), original, original];
    const app = buildApp(queue);
    const defaults = await app.request("/v1/banner/Moemu/Erika.png?scale=0.2");
    const noExtras = await app.request("/v1/banner/Moemu/Erika.png?scale=0.2");
    expect(defaults.headers.get("etag")).toBe(noExtras.headers.get("etag"));
    const url = "/v1/banner/Moemu/Erika.png?scale=0.2&meta=license,language,last_updated";
    const selected = await app.request(url);
    expect(selected.status).toBe(200);
    expect(selected.headers.get("etag")).not.toBe(defaults.headers.get("etag"));
    const avatar = await app.request("/v1/banner/Moemu/Erika/avatar.png?scale=0.2&icon=builtin&meta=license,language,last_updated");
    expect(avatar.status).toBe(200);
    for (const change of [{ licenseSpdxId: "Apache-2.0" }, { language: "Python" }, { pushedAt: "2026-10-01T00:00:00Z" }]) {
      queue.push({ ...original, version: JSON.stringify(change), data: { ...original.data, ...change } });
      const updated = await app.request(url);
      expect(updated.status).toBe(200);
      expect(updated.headers.get("etag")).not.toBe(selected.headers.get("etag"));
    }
  });
  let queue: Array<RepoSnapshot | Error>;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    queue = [];
    app = buildApp(queue);
  });

  it("placeholder cache does not mix format or theme", async () => {
    queue.push(new NotFoundError("No/Such"), new NotFoundError("No/Such"));
    const dark = await app.request("/v1/banner/No/Such.webp?theme=dark");
    const light = await app.request("/v1/banner/No/Such.png?theme=light");
    expect(dark.headers.get("content-type")).toBe("image/webp");
    expect(light.headers.get("content-type")).toBe("image/png");
    const dk = Buffer.from(await dark.arrayBuffer());
    const lt = Buffer.from(await light.arrayBuffer());
    expect(Buffer.compare(dk, lt)).not.toBe(0);
  });

  it("unknown meta field -> 400 (service and template agree on the field set)", async () => {
    queue.push(snapshot(9));
    const res = await app.request("/v1/banner/Moemu/Erika.webp?meta=bogus");
    expect(res.status).toBe(400);
  });

  it("a meta subset renders a different image than the declared default", async () => {
    queue.push(snapshot(9), snapshot(9));
    const subset = await app.request("/v1/banner/Moemu/Erika.webp?meta=stars");
    const all = await app.request("/v1/banner/Moemu/Erika.webp");
    expect(subset.status).toBe(200);
    expect(subset.headers.get("etag")).not.toBe(all.headers.get("etag"));
  });

  it("explicit light theme survives preset theme overrides (Erika dark != light)", async () => {
    // the Erika preset overrides the accent; a light request must not inherit the dark palette
    queue.push(snapshot(9), snapshot(9));
    const dark = await app.request("/v1/banner/Moemu/Erika.webp?theme=dark");
    const light = await app.request("/v1/banner/Moemu/Erika.webp?theme=light");
    expect(dark.status).toBe(200);
    expect(light.status).toBe(200);
    const dk = Buffer.from(await dark.arrayBuffer());
    const lt = Buffer.from(await light.arrayBuffer());
    expect(Buffer.compare(dk, lt)).not.toBe(0);
  });

  it("corrupt avatar bytes fall through to the builtin icon (no 500)", async () => {
    const app2 = createApp({
      provider: {
        getRepo: async () => ({
          freshness: "fresh" as const,
          version: "stranger",
          data: {
            fullName: "Some/One",
            name: "One",
            description: "a stranger repo",
            stargazersCount: 3,
            avatarUrl: "https://avatars.githubusercontent.com/u/99?v=4",
            private: false,
          },
        }),
      },
      imageFetcher: async () => Buffer.from("this is not an image"),
      cacheMaxBytes: 64 * 1024 * 1024,
    });
    // icon=avatar with corrupt bytes: the chain falls back to the default
    // Grokbot icon and the banner still renders (never a broken image)
    const res = await app2.request("/v1/banner/Some/One.webp?icon=avatar");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });
});
