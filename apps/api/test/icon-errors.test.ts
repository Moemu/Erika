import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createImageFetcher, type ImageFetcher } from "@erika/core";
import { LIMITS } from "@erika/shared";
import { createApp } from "../src/app.js";

const metadataPng = readFileSync(new URL("../../../tests/fixtures/png-svg-metadata.png", import.meta.url));
const explicitUrl = "/v1/banner/Some/Project.png?iconPath=logo.png&scale=0.1";

function makeApp(imageFetcher: ImageFetcher) {
  const getLatestRelease = vi.fn(async () => null);
  const app = createApp({
    provider: {
      getRepo: async () => ({
        freshness: "fresh",
        version: "v1",
        data: { fullName: "Some/Project", name: "Project", defaultBranch: "main", private: false },
      }),
      getLatestRelease,
    },
    imageFetcher,
  });
  return { app, getLatestRelease };
}

describe("explicit iconPath errors", () => {
  it.each([
    ["missing image", "image fetch failed: 404"],
    ["timeout", "image request timed out"],
  ])("returns JSON 400 for %s without fallback", async (_name, reason) => {
    const fetcher = vi.fn(async () => { throw new Error(reason); });
    const { app, getLatestRelease } = makeApp(fetcher);
    const res = await app.request(explicitUrl);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: 'Cannot load iconPath "logo.png"', details: reason });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-banner-error")).toBe("icon-load-failed");
    expect(res.headers.get("etag")).toBeNull();
    expect(fetcher.mock.calls).toEqual([["https://raw.githubusercontent.com/Some/Project/main/logo.png"]]);
    expect(getLatestRelease).not.toHaveBeenCalled();
  });

  it.each([
    ["corrupt image", async () => Buffer.from("invalid image"), /image/i],
    ["pixel limit", async () => createCanvas(LIMITS.iconMaxPixels + 1, 1).encode("png"), /pixel cap/],
  ] as const)("returns JSON 400 for %s", async (_name, bytes, reason) => {
    const { app } = makeApp(bytes);
    const res = await app.request(explicitUrl);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Cannot load iconPath "logo.png"', details: expect.stringMatching(reason) });
  });

  it("reports byte limit failures from the image fetcher", async () => {
    const { app } = makeApp(createImageFetcher({
      fetchImpl: vi.fn(async () => new Response(new Uint8Array(LIMITS.iconMaxBytes + 1))),
    }));
    const res = await app.request(explicitUrl);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ details: expect.stringContaining("byte cap") });
  });

  it("renders the requested image after a failed request", async () => {
    const fetcher = vi.fn<ImageFetcher>()
      .mockRejectedValueOnce(new Error("image fetch failed: 404"))
      .mockResolvedValue(metadataPng);
    const { app } = makeApp(fetcher);
    expect((await app.request(explicitUrl)).status).toBe(400);
    const res = await app.request(explicitUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-icon")).toBe("repo");
  });
});

describe("automatic icon fallback", () => {
  it("keeps the builtin fallback for unavailable or corrupt default images", async () => {
    const fetcher = vi.fn<ImageFetcher>()
      .mockRejectedValueOnce(new Error("image fetch failed: 404"))
      .mockResolvedValue(Buffer.from("invalid image"));
    const { app } = makeApp(fetcher);
    const res = await app.request("/v1/banner/Some/Project.png?scale=0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-icon")).toBe("builtin");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("PNG metadata through the API", () => {
  it("renders embedded SVG metadata as PNG pixels", async () => {
    const { app } = makeApp(async () => metadataPng);
    const res = await app.request(explicitUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-banner-icon")).toBe("repo");
    expect(res.headers.get("content-type")).toBe("image/png");
    const image = await loadImage(Buffer.from(await res.arrayBuffer()));
    const ctx = createCanvas(image.width, image.height).getContext("2d");
    ctx.drawImage(image, 0, 0);
    expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([18, 90, 202, 255]);
  });
});
