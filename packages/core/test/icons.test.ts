import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { LIMITS } from "@erika/shared";
import { REPO_ICON_PATHS, isRepoRelativePath, presetIconPaths, repoIconUrlsFor, resolveIconChain, validateIconImage } from "../src/icons.js";
import { renderBanner } from "../src/render.js";
import { DEFAULT_TEMPLATES_DIR, loadTemplate } from "../src/templates.js";
import { fileURLToPath } from "node:url";

const metadataPngPath = fileURLToPath(new URL("../../../tests/fixtures/png-svg-metadata.png", import.meta.url));
const metadataPng = readFileSync(metadataPngPath);

describe("PNG with embedded SVG metadata", () => {
  it("decodes PNG pixels and preserves the original metadata bytes", async () => {
    expect(metadataPng.includes(Buffer.from("caBX"))).toBe(true);
    expect(metadataPng.includes(Buffer.from("<svg"))).toBe(true);
    expect(await validateIconImage(metadataPng)).toBe(metadataPng);
    const image = await loadImage(metadataPng);
    expect([image.width, image.height]).toEqual([2, 2]);
    const ctx = createCanvas(2, 2).getContext("2d");
    ctx.drawImage(image, 0, 0);
    expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([18, 90, 202, 255]);
  });

  it("selects the repository image instead of falling back", async () => {
    const icon = await resolveIconChain(["repo", "builtin"], {
      repoIconUrls: ["https://raw.githubusercontent.com/Some/Project/main/logo.png"],
      imageFetcher: async () => metadataPng,
      builtinPath: "missing-builtin.png",
    });
    expect(icon).toEqual({ kind: "repo", buffer: metadataPng });
  });

  it("renders identical output from a buffer and a local path", async () => {
    const input = {
      template: loadTemplate("grokbot"),
      data: { fullName: "Some/Project", name: "Project", private: false },
      params: { scale: 0.1, meta: [] },
      fontDirs: [join(DEFAULT_TEMPLATES_DIR, "fonts")],
      format: "png" as const,
    };
    const fromPath = await renderBanner({ ...input, iconOverride: { path: metadataPngPath, kind: "repo" } });
    const fromBuffer = await renderBanner({ ...input, iconOverride: { buffer: metadataPng, kind: "repo" } });
    expect(fromBuffer.buffer).toEqual(fromPath.buffer);
  });
});

describe("icon validation", () => {
  it("rejects corrupt data and images over the pixel limit", async () => {
    await expect(validateIconImage(Buffer.from("invalid image"))).rejects.toThrow();
    const oversized = await createCanvas(LIMITS.iconMaxPixels + 1, 1).encode("png");
    await expect(validateIconImage(oversized)).rejects.toThrow("icon exceeds pixel cap");
  });

  it("continues to accept SVG images", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
    expect(await validateIconImage(svg)).toBe(svg);
  });
});

describe("theme icon candidates", () => {
  const preset = { icon: { path: "assets/original.webp", pathLight: "assets/light.webp", pathTransparent: "assets/transparent.png" } };

  it("uses light, transparent and original assets in order, without changing auto", () => {
    expect(presetIconPaths(preset, "light")).toEqual(["assets/light.webp", "assets/transparent.png", "assets/original.webp"]);
    expect(presetIconPaths(preset, "dark")).toEqual(["assets/transparent.png", "assets/original.webp"]);
    expect(presetIconPaths(preset)).toEqual(["assets/original.webp"]);
  });

  it("keeps ordered fallbacks and excludes filesystem paths from raw URLs", () => {
    expect(repoIconUrlsFor({ owner: "A", repo: "b", explicit: ["C:/private.png", ...presetIconPaths(preset, "light")] }))
      .toEqual(["light.webp", "transparent.png", "original.webp"].map((name) => `https://raw.githubusercontent.com/A/b/HEAD/assets/${name}`));
  });
});

describe("isRepoRelativePath", () => {
  it("accepts paths inside the repository", () => {
    for (const p of ["assets/grokbot-icon.webp", "icon.png", "docs/img/logo.webp", "a_b-c.1.webp"]) {
      expect(isRepoRelativePath(p), p).toBe(true);
    }
  });

  it("rejects absolute filesystem paths and parent traversal", () => {
    for (const p of [
      "/home/app/assets/icon.webp",
      "\\assets\\icon.webp",
      "C:\\Users\\me\\icon.webp",
      "D:/assets/icon.webp",
      "\\\\server\\share\\icon.webp",
      "assets/../../etc/passwd",
      "..",
      "   ",
    ]) {
      expect(isRepoRelativePath(p), p).toBe(false);
    }
  });
});

describe("repoIconUrlsFor", () => {
  const base = "https://raw.githubusercontent.com/Moemu/Erika/main";

  it("uses an explicit repo-relative path", () => {
    expect(repoIconUrlsFor({ owner: "Moemu", repo: "Erika", branch: "main", explicit: "assets/mine.webp" }))
      .toEqual([`${base}/assets/mine.webp`]);
  });

  it("falls back to the conventional paths when no explicit path is given", () => {
    expect(repoIconUrlsFor({ owner: "Moemu", repo: "Erika", branch: "main" }))
      .toEqual(REPO_ICON_PATHS.map((p) => `${base}/${p}`));
  });

  it("never concatenates a non-repo-relative path into the raw base", () => {
    for (const explicit of ["/home/app/icon.webp", "C:\\icons\\a.webp", "assets/../secret.webp"]) {
      const urls = repoIconUrlsFor({ owner: "Moemu", repo: "Erika", branch: "main", explicit });
      expect(urls, explicit).toEqual(REPO_ICON_PATHS.map((p) => `${base}/${p}`));
      expect(urls.some((u) => u.includes("home/app") || u.includes("C:") || u.includes("..")), explicit).toBe(false);
    }
  });
});
