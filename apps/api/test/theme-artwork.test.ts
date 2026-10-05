import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEMPLATES_DIR, loadTemplate, renderBanner } from "@erika/core";
import { createApp } from "../src/app.js";
import type { GitHubProvider } from "@erika/providers";

const data = { fullName: "Some/Project", name: "Project", description: "A **fixed** description.", defaultBranch: "main", private: false };
const provider: GitHubProvider = {
  getRepo: async () => ({ data: { ...data }, freshness: "fresh", version: "v1" }),
  getLatestRelease: async () => null,
};

function presets() {
  const dir = mkdtempSync(join(tmpdir(), "erika-theme-"));
  const path = join(dir, "presets.json");
  writeFileSync(path, JSON.stringify({ "Some/Project": { icon: { path: "assets/original.png", pathLight: "assets/light.png", pathTransparent: "assets/transparent.png" } } }));
  return path;
}

async function solid(): Promise<Buffer> {
  const canvas = createCanvas(200, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#24201f";
  ctx.fillRect(0, 0, 200, 200);
  return canvas.encode("png");
}

describe("theme artwork through the API", () => {
  it("falls back through theme assets to the original and honors iconPath", async () => {
    const calls: string[] = [];
    const img = await solid();
    const app = createApp({ provider, presetsPath: presets(), imageFetcher: async (url) => {
      calls.push(url.split("/").pop()!);
      if (url.endsWith("/light.png") || url.endsWith("/transparent.png")) throw new Error("missing variant");
      return img;
    } });
    const response = await app.request("/v1/banner/Some/Project.png?theme=light&scale=0.3");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Banner-Icon")).toBe("repo");
    expect(calls).toEqual(["light.png", "transparent.png", "original.png"]);
    calls.length = 0;
    await app.request("/v1/banner/Some/Project.png?theme=light&iconPath=assets/custom.png&scale=0.3");
    expect(calls).toEqual(["custom.png"]);
  });

  it("uses the transparent builtin for each theme and caches their bytes separately", async () => {
    const app = createApp({ provider });
    const buffers: Buffer[] = [];
    for (const theme of ["light", "dark", "light"]) {
      const response = await app.request(`/v1/banner/Some/Project.png?theme=${theme}&icon=builtin&scale=0.3`);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Banner-Icon")).toBe("builtin");
      const buffer = Buffer.from(await response.arrayBuffer());
      const expected = await renderBanner({
        template: loadTemplate("grokbot"), data,
        iconOverride: { kind: "builtin", buffer: readFileSync(join(DEFAULT_TEMPLATES_DIR, "assets", "erika-transparent.png")) },
        fontDirs: [join(DEFAULT_TEMPLATES_DIR, "fonts")], params: { theme, scale: 0.3 }, format: "png",
      });
      expect(buffer).toEqual(expected.buffer);
      buffers.push(buffer);
      const img = await loadImage(buffer);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      expect(Array.from(ctx.getImageData(1, 1, 1, 1).data).slice(0, 3)).toEqual(theme === "light" ? [245, 241, 236] : [36, 32, 31]);
    }
    expect(buffers[0]).toEqual(buffers[2]);
    expect(buffers[0]).not.toEqual(buffers[1]);
  });
});
