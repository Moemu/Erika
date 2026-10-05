/** Icon archetype routing through the API:
 * - a project's own Grokbot icon (public path in the subject repo) with a
 *   uniform top-right backdrop adopts that backdrop as the canvas colour and
 *   blends full-bleed in the template's blend box;
 * - a non-uniform backdrop falls back to the card box with the theme background;
 * - `icon=avatar` uses the avatar template: card box, never captured, so an
 *   avatar's corner colour can never repaint the banner. */

import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createApp, type ApiDeps } from "../src/app.js";

function makeApp(files: { icon?: Buffer; avatar?: Buffer }) {
  const deps: Partial<ApiDeps> = {
    imageFetcher: async (url: string) => {
      if (url.includes("avatars.githubusercontent.com")) {
        if (!files.avatar) throw new Error("no avatar fixture");
        return files.avatar;
      }
      if (files.icon) return files.icon;
      throw new Error("no icon fixture");
    },
  };
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
          defaultBranch: "main",
          private: false,
        },
      }),
    },
    ...deps,
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

const BG: [number, number, number] = [36, 32, 31]; // grokbot dark #24201F

async function solid(size: number, color: string): Promise<Buffer> {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  return c.encode("png");
}

/** Solid artwork with a black square partially covering the sampled top-right
 * corner (the window is the last 64x64 inset by 2px). */
async function markedCorner(size: number, color: string): Promise<Buffer> {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  ctx.fillRect(size - 30, 0, 30, 30);
  return c.encode("png");
}

async function render(app: ReturnType<typeof createApp>, query = ""): Promise<Buffer> {
  const res = await app.request(`/v1/banner/Some/One.webp?scale=1${query}`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe("icon archetype routing", () => {
  it("project icon, uniform backdrop: canvas adopts it and the artwork blends", async () => {
    const app = makeApp({ icon: await solid(500, "#ff0000") });
    const webp = await render(app);
    for (const [x, y] of [[300, 300], [1450, 450], [2400, 1600]]) {
      expect(near(await pixelAt(webp, x, y), [255, 0, 0])).toBe(true);
    }
  }, 20000);

  it("project icon, non-uniform corner: card box + theme background", async () => {
    const app = makeApp({ icon: await markedCorner(500, "#ff0000") });
    const webp = await render(app);
    expect(near(await pixelAt(webp, 762, 900), [255, 0, 0])).toBe(true); // inside the card box
    expect(near(await pixelAt(webp, 300, 300), BG)).toBe(true); // above the card, outside the blend box
    expect(near(await pixelAt(webp, 1300, 450), BG)).toBe(true); // gap region stays background
  }, 20000);

  it("avatar: avatar template, never captured, theme background kept", async () => {
    const app = makeApp({ avatar: await solid(64, "#ff0000") }); // uniform corner on purpose
    const res = await app.request("/v1/banner/Some/One.webp?scale=1&icon=avatar");
    expect(res.headers.get("x-banner-icon")).toBe("avatar");
    expect(res.headers.get("x-banner-template")).toBe("avatar");
    const webp = Buffer.from(await res.arrayBuffer());
    expect(near(await pixelAt(webp, 762, 900), [255, 0, 0])).toBe(true); // inside the card box
    expect(near(await pixelAt(webp, 300, 300), BG)).toBe(true); // above the card
    expect(near(await pixelAt(webp, 1450, 450), BG)).toBe(true); // canvas was NOT repainted
  }, 20000);

  it("the project icon is read from the subject repo's conventional path", async () => {
    const requested: string[] = [];
    const app = createApp({
      provider: {
        getRepo: async () => ({
          freshness: "fresh" as const,
          version: "v1",
          data: {
            fullName: "Some/One",
            name: "One",
            description: null,
            stargazersCount: 1,
            avatarUrl: "https://avatars.githubusercontent.com/u/99?v=4",
            defaultBranch: "trunk",
            private: false,
          },
        }),
      },
      imageFetcher: async (url: string) => {
        requested.push(url);
        return solid(64, "#ff0000");
      },
    });
    await render(app);
    expect(requested[0]).toBe(
      "https://raw.githubusercontent.com/Some/One/trunk/assets/grokbot-icon.webp",
    );
  }, 20000);
});
