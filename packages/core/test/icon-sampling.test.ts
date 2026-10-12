import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderBanner } from "../src/render.js";
import { DEFAULT_TEMPLATES_DIR, loadTemplate } from "../src/templates.js";

describe("thin artwork outlines", () => {
  it.each([0, 5])("preserves coverage after reduction with a %s-unit horizontal offset", async (offset) => {
    const source = createCanvas(1024, 1024);
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "#000000";
    for (let i = 0; i < 1024; i++) sourceContext.fillRect(i, i, 1, 1);

    const template = loadTemplate("grokbot");
    const result = await renderBanner({
      template: {
        ...template,
        slots: {
          ...template.slots,
          icon: { ...template.slots.icon, x: 200 + offset, y: 200, size: 1280, padding: 0, radius: 0 },
        },
        themes: { ...template.themes, light: { ...template.themes.light, background: "#FFFFFF" } },
      },
      data: { fullName: "Test/Line", name: "Line", private: false },
      iconOverride: { buffer: await source.encode("png"), kind: "avatar" },
      fontDirs: [join(DEFAULT_TEMPLATES_DIR, "fonts")],
      params: { theme: "light", scale: 0.1, meta: [] },
      format: "png",
    });

    const image = await loadImage(result.buffer);
    const context = createCanvas(image.width, image.height).getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const coverage: number[] = [];
    for (let row = 10; row < 110; row++) {
      let darkness = 0;
      for (let dx = -2; dx <= 2; dx++) {
        darkness += 255 - pixels[((20 + row) * image.width + 20 + row + dx) * 4];
      }
      coverage.push(darkness);
    }

    // A one-pixel source line contributes 1/8 pixel of coverage after reduction.
    expect(Math.min(...coverage)).toBeGreaterThan(24);
    expect(Math.max(...coverage)).toBeLessThan(40);
  });
});
