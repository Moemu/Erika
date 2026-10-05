import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, DEFAULT_TEMPLATES_DIR, DEFAULT_PRESETS_PATH, loadPresetRegistry } from "@erika/core";
import { createApp } from "../src/app.js";

function app(imageFetcher?: (url: string) => Promise<Buffer>) {
  return createApp({
    staticRoot: join(REPO_ROOT, "apps/playground/dist"),
    imageFetcher,
    provider: {
      async getRepo(owner, repo) {
        return {
          freshness: "fresh" as const,
          version: "fixture-v1",
          data: {
            name: repo, fullName: `${owner}/${repo}`, description: "Deployment fixture",
            defaultBranch: "main", private: false, stargazersCount: 42, forksCount: 3,
          },
        };
      },
    },
  });
}

describe("deployed assets and documented API", () => {
  it("fetches Erika's preset from its public repo path", async () => {
    // the preset's declared path is the contract; expect exactly that URL
    const declared = loadPresetRegistry(DEFAULT_PRESETS_PATH).get("Moemu/Erika")?.icon?.path;
    expect(declared, "Moemu/Erika declares an icon path").toBeTruthy();
    const urls: string[] = [];
    const server = app(async (url) => {
      urls.push(url);
      expect(url).toBe(`https://raw.githubusercontent.com/Moemu/Erika/main/${declared}`);
      return readFileSync(join(DEFAULT_TEMPLATES_DIR, "assets", "erika.webp"));
    });
    const response = await server.request("/v1/banner/Moemu/Erika.webp?meta=");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-banner-icon")).toBe("repo");
    expect(urls).toHaveLength(1);
  });

  it("loads the built script, stylesheet and app icons from a nested SPA URL", async () => {
    const server = app();
    const url = "https://example.test/some/nested/page";
    const response = await server.request(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|png|ico|webmanifest))"/g)].map((m) => m[1]);
    expect(assets.some((p) => p.endsWith(".js"))).toBe(true);
    expect(assets.some((p) => p.endsWith(".css"))).toBe(true);
    // the app icon set ships with the SPA (favicon / touch icon / manifest)
    expect(assets.some((p) => p.endsWith(".ico"))).toBe(true);
    expect(assets.some((p) => p.endsWith("apple-touch-icon.png"))).toBe(true);
    for (const path of assets) {
      const asset = await server.request(new URL(path, url).href);
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get("content-type"), path).not.toContain("text/html");
    }
  });

  it.each(["/v1", "/v1/unknown", "/assets/missing.js"])("does not return the SPA for %s", async (path) => {
    const response = await app().request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("implements the documented metadata examples and schema limits", async () => {
    const server = app();
    const hidden = await server.request("/v1/banner/example/project.webp?icon=builtin&meta=");
    const visible = await server.request("/v1/banner/example/project.webp?icon=builtin&meta=stars,forks");
    expect(hidden.status).toBe(200);
    expect(visible.status).toBe(200);
    expect(hidden.headers.get("etag")).not.toBe(visible.headers.get("etag"));
    const doc = await (await server.request("/doc")).json();
    const params = doc.paths["/v1/banner/{owner}/{repo}{format}"].get.parameters;
    expect(params.find((p: { name: string }) => p.name === "icon").schema.enum).toEqual(["auto", "avatar", "builtin"]);
    expect(params.find((p: { name: string }) => p.name === "scale").schema.minimum).toBe(0.1);
  });
});
