/** Query -> renderer wiring for the icon display overrides. Both params must
 * reach renderBanner AND take part in the render cache key: a missing key
 * field would make the second request return the first image unchanged. */

import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createApp } from "../src/app.js";

function makeApp(avatar: Buffer) {
  return createApp({
    provider: {
      getRepo: async () => ({
        freshness: "fresh" as const,
        version: "stranger-v1",
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
    imageFetcher: async () => avatar,
  });
}

async function pixelAt(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img as unknown as Parameters<typeof ctx.drawImage>[0], 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

const near = (p: [number, number, number], q: [number, number, number], tol = 12) =>
  Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol && Math.abs(p[2] - q[2]) < tol;

const BG: [number, number, number] = [36, 32, 31]; // classic dark #24201F

/** 64x64 black|white split: capture fails, so the contained card is used. */
async function splitAvatar(): Promise<Buffer> {
  const c = createCanvas(64, 64);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(32, 0, 32, 64);
  return c.encode("png");
}

/** 900x200 split (left black / right white): wide image, capture fails. */
async function wideSplitAvatar(): Promise<Buffer> {
  const c = createCanvas(900, 200);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 450, 200);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(450, 0, 450, 200);
  return c.encode("png");
}

async function fetchBanner(app: ReturnType<typeof createApp>, query: string): Promise<Buffer> {
  const res = await app.request(`/v1/banner/Some/One.webp?scale=1&icon=avatar${query}`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe("icon query params reach the renderer", () => {
  it("iconRound=1 clips the contained card corner; default stays square", async () => {
    const app = makeApp(await splitAvatar());
    const square = await fetchBanner(app, "");
    const round = await fetchBanner(app, "&iconRound=1");
    expect(Buffer.compare(square, round)).not.toBe(0); // param active AND in the cache key
    expect(near(await pixelAt(square, 270, 410), [0, 0, 0])).toBe(true); // card corner: content
    expect(near(await pixelAt(round, 270, 410), BG)).toBe(true); // masked away
    expect(near(await pixelAt(round, 500, 900), [0, 0, 0])).toBe(true); // card center area: content
  }, 20000);

  it("iconFit=cover fills the card; default contain letterboxes the wide image", async () => {
    const app = makeApp(await wideSplitAvatar());
    const contain = await fetchBanner(app, "");
    const cover = await fetchBanner(app, "&iconFit=cover");
    expect(Buffer.compare(contain, cover)).not.toBe(0); // param active AND in the cache key
    expect(near(await pixelAt(contain, 700, 500), BG)).toBe(true); // letterbox above the image
    expect(near(await pixelAt(cover, 700, 500), [0, 0, 0])).toBe(true); // cover reaches there (left half)
  }, 20000);
});
