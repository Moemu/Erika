/** Canvas renderer: paints a resolved template + data + preset + params.
 * Pure drawing over @napi-rs/canvas; file/IO only for font registration and
 * the icon asset passed in by the caller. */

import {
  createCanvas,
  GlobalFonts,
  loadImage,
} from "@napi-rs/canvas";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  accentSegments,
  buildTitleRuns,
  descriptionFitSearch,
  fitTitle,
  parseAccentMarkers,
  wrapDescription,
  type MeasureFn,
} from "./layout.js";
import { captureBackgroundColor, presetIconPaths } from "./icons.js";
import { defaultMetaFields, fitMetadataRow, metadataSegments } from "./metadata.js";
import type {
  BannerData,
  DescriptionSlot,
  IconBox,
  MetaSlot,
  Preset,
  RenderParams,
  RenderResult,
  Template,
  ThemeColors,
  TitleSlot,
} from "./types.js";
import { accentSchema, type MetaField } from "@erika/shared";
import { detectAccentColor } from "./accent.js";

type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

const FONT_EXTS = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const registeredAliases = new Set<string>();
/** Ink gap between the repo-name row and the title's ink top, as a ratio of
 * canvas height: the row is a label ON the title (one unit), not a block of
 * its own. */
const TOPLINE_INK_GAP = 0.022;

/** Register every font file in the given dirs; alias = filename stem.
 * Idempotent per alias -- safe to call on every request. */
export function registerFontDirs(dirs: string[]): string[] {
  const registered: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!FONT_EXTS.has(extname(entry).toLowerCase())) continue;
      const alias = basename(entry, extname(entry));
      if (registeredAliases.has(alias)) {
        registered.push(alias);
        continue;
      }
      if (GlobalFonts.registerFromPath(join(dir, entry), alias)) {
        registeredAliases.add(alias);
        registered.push(alias);
      }
    }
  }
  return registered;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
const stripWeight = (s: string) => norm(s).replace(/(semibold|medium|regular|bold)$/u, "");

/** Match a requested family ("Torus SemiBold") against registered aliases
 * ("Torus-SemiBold"): exact-normalized, weight-stripped, then prefix. */
export function resolveFontFamily(requested: string, registered: string[]): string | null {
  if (!requested || registered.length === 0) return null;
  const n = norm(requested);
  let hit = registered.find((a) => norm(a) === n);
  if (hit) return hit;
  const nw = stripWeight(requested);
  hit = registered.find((a) => stripWeight(a) === nw);
  if (hit) return hit;
  hit = registered.find((a) => stripWeight(a).startsWith(nw) && nw.length >= 3);
  return hit ?? null;
}

function resolveFontChain(candidates: Array<string | undefined>, registered: string[]): string {
  for (const c of candidates) {
    const hit = resolveFontFamily(c ?? "", registered);
    if (hit) return hit;
  }
  throw new Error(
    `no font resolved for candidates [${candidates.join(", ")}]; registered: [${registered.join(", ")}]`,
  );
}

/** Width measurement with letter-spacing, script-routed across the font pair. */
function makeMeasurer(ctx: Ctx, router: FontRouter): MeasureFn {
  let letterSpacingOk: boolean | null = null;
  const lsOk = () => {
    if (letterSpacingOk === null) letterSpacingOk = "letterSpacing" in ctx;
    return letterSpacingOk as boolean;
  };
  return (text, size, tracking) => {
    let w = 0;
    for (const run of splitScriptRuns(text, router)) {
      ctx.font = `${size}px "${run.family}"`;
      if (lsOk()) {
        (ctx as unknown as { letterSpacing: string }).letterSpacing = `${tracking * size}px`;
        w += ctx.measureText(run.text).width;
      } else {
        for (const ch of run.text) w += ctx.measureText(ch).width + tracking * size;
      }
    }
    return w;
  };
}

function drawTextRouted(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  tracking: number,
  router: FontRouter,
  letterSpacingOk: boolean,
): number {
  let cursor = x;
  for (const run of splitScriptRuns(text, router)) {
    cursor += drawText(ctx, run.text, cursor, y, size, tracking, run.family, letterSpacingOk);
  }
  return cursor - x;
}

function drawText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  tracking: number,
  family: string,
  letterSpacingOk: boolean,
): number {
  ctx.font = `${size}px "${family}"`;
  if (letterSpacingOk) {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${tracking * size}px`;
    ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  }
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking * size;
  }
  return cursor - x;
}

function drawIcon(
  ctx: Ctx,
  img: Awaited<ReturnType<typeof loadImage>>,
  box: IconBox,
  display: { fit: "contain" | "cover"; padding: number; radius: number; position: { x: number; y: number } },
): void {
  // Display is configured by the box (+ params), never by the image source.
  // The template geometry already guarantees the gap to the text column, so a
  // fully-filling image still leaves the designed spacing.
  const inset = display.padding;
  const size = box.size * (1 - inset * 2);
  const x = box.x + box.size * inset;
  const y = box.y + box.size * inset;
  ctx.save();
  ctx.beginPath();
  if (display.radius > 0) {
    ctx.roundRect
      ? ctx.roundRect(x, y, size, size, display.radius)
      : ctx.rect(x, y, size, size);
  } else {
    ctx.rect(x, y, size, size);
  }
  ctx.clip();
  const s =
    display.fit === "contain"
      ? Math.min(size / img.width, size / img.height)
      : Math.max(size / img.width, size / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  // cover crop focal point (normalized); contain centers by definition
  const fx = display.fit === "cover" ? display.position.x : 0.5;
  const fy = display.fit === "cover" ? display.position.y : 0.5;
  // Mipmaps preserve thin outlines when artwork is reduced.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(
    img as unknown as Parameters<Ctx["drawImage"]>[0],
    x + (size - dw) * fx,
    y + (size - dh) * fy,
    dw,
    dh,
  );
  ctx.restore();
}

function drawStar(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.42;
    const px = cx + rr * Math.cos(rad);
    const py = cy + rr * Math.sin(rad);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/** Branch glyph: two dots joined into a stem (forks). */
function drawFork(ctx: Ctx, cx: number, cy: number, r: number): void {
  const fill = ctx.fillStyle as string;
  const topY = cy - r * 0.6;
  const junctionY = cy + r * 0.1;
  const bottomY = cy + r * 0.62;
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1.5, r * 0.42);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.6, topY);
  ctx.lineTo(cx - r * 0.6, junctionY);
  ctx.lineTo(cx + r * 0.6, junctionY);
  ctx.moveTo(cx + r * 0.6, topY);
  ctx.lineTo(cx + r * 0.6, junctionY);
  ctx.moveTo(cx, junctionY);
  ctx.lineTo(cx, bottomY);
  ctx.stroke();
  for (const [dx, dy] of [[-r * 0.6, topY], [r * 0.6, topY], [0, bottomY]] as const) {
    ctx.beginPath();
    ctx.arc(cx + dx, dy, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Ring glyph with a centre dot (open issues). */
function drawIssue(ctx: Ctx, cx: number, cy: number, r: number): void {
  const fill = ctx.fillStyle as string;
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1.5, r * 0.38);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

export { declaredMetaFields, defaultMetaFields } from "./metadata.js";

/** One metadata row: glyph+value segments separated by `separator`. Fields
 * without data are skipped, so the row never renders a dangling label. */
function drawMetaRow(
  ctx: Ctx,
  slot: MetaSlot,
  fields: MetaField[],
  x: number,
  baseline: number,
  data: BannerData,
  colors: ThemeColors,
  router: FontRouter,
  letterSpacingOk: boolean,
  maxWidth: number,
): void {
  const { size, segments } = fitMetadataRow(metadataSegments(fields, data), slot, maxWidth, makeMeasurer(ctx, router));
  const glyphCy = baseline - size * 0.3;
  let cursor = x;
  segments.forEach((segment, i) => {
    if (i > 0) {
      ctx.fillStyle = colors[slot.color] ?? colors.description;
      cursor += size * slot.separatorGap;
      cursor += drawTextRouted(
        ctx, slot.separator, cursor, baseline, size, slot.tracking, router, letterSpacingOk,
      );
      cursor += size * slot.separatorGap;
    }
    if (segment.glyph) {
      const r = size * 0.42;
      ctx.fillStyle = colors[slot.accent] ?? colors.accent;
      if (segment.glyph === "star") drawStar(ctx, cursor + r, glyphCy, r);
      else if (segment.glyph === "fork") drawFork(ctx, cursor + r, glyphCy, r);
      else if (segment.glyph === "tag") drawTag(ctx, cursor + r, glyphCy, r);
      else if (segment.glyph === "license") drawLicense(ctx, cursor + r, glyphCy, r);
      else if (segment.glyph === "code") drawCode(ctx, cursor + r, glyphCy, r);
      else if (segment.glyph === "clock") drawClock(ctx, cursor + r, glyphCy, r);
      else drawIssue(ctx, cursor + r, glyphCy, r);
      cursor += r * 2 + size * 0.18;
    }
    ctx.fillStyle = colors[slot.color] ?? colors.description;
    cursor += drawTextRouted(
      ctx, segment.text, cursor, baseline, size, slot.tracking, router, letterSpacingOk,
    );
  });
}

function drawLicense(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = r * 0.2;
  ctx.strokeRect(cx - r * 0.65, cy - r * 0.85, r * 1.3, r * 1.7);
  for (const offset of [-0.35, 0.1, 0.55]) {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.35, cy + r * offset);
    ctx.lineTo(cx + r * 0.35, cy + r * offset);
    ctx.stroke();
  }
}

function drawCode(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = r * 0.22;
  ctx.beginPath();
  for (const direction of [-1, 1]) {
    ctx.moveTo(cx + direction * r * 0.45, cy - r * 0.65);
    ctx.lineTo(cx + direction * r * 0.9, cy);
    ctx.lineTo(cx + direction * r * 0.45, cy + r * 0.65);
  }
  ctx.moveTo(cx + r * 0.2, cy - r * 0.8);
  ctx.lineTo(cx - r * 0.2, cy + r * 0.8);
  ctx.stroke();
}

function drawClock(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.48);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + r * 0.38, cy + r * 0.2);
  ctx.stroke();
  ctx.restore();
}

/** Price-tag glyph for the release field: a slim tag with a round tip and a
 * punched hole near the flat end (proportions follow the Octicons/Lucide tag),
 * filled in the accent colour like the other meta glyphs. */
function drawTag(ctx: Ctx, cx: number, cy: number, r: number): void {
  const len = r * 2.0; // length along the tag axis (~2.2x the width)
  const width = r * 0.9; // across the tag
  const cap = width / 2; // round tip radius
  const corner = r * 0.2; // flat-end corner rounding
  const holeR = r * 0.26;
  const holeX = -len / 2 + r * 0.52;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4); // hole end lower-left, tip upper-right
  ctx.beginPath();
  ctx.moveTo(len / 2 - cap, -width / 2);
  ctx.lineTo(-len / 2 + corner, -width / 2);
  ctx.arcTo(-len / 2, -width / 2, -len / 2, -width / 2 + corner, corner);
  ctx.lineTo(-len / 2, width / 2 - corner);
  ctx.arcTo(-len / 2, width / 2, -len / 2 + corner, width / 2, corner);
  ctx.lineTo(len / 2 - cap, width / 2);
  ctx.arc(len / 2 - cap, 0, cap, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath();
  // punched hole: even-odd fill ignores the winding, so one subpath is enough
  ctx.arc(holeX, 0, holeR, 0, Math.PI * 2);
  ctx.fill("evenodd");
  ctx.restore();
}

/** Cap height (ink ascent of "M") for the resolved family at a given size. */
function capHeight(ctx: Ctx, family: string, size: number): number {
  ctx.font = `${size}px "${family}"`;
  const m = ctx.measureText("M");
  return m.actualBoundingBoxAscent ?? size * 0.7;
}

/** Ink descent of a sample (descenders), used to find where a text block's
 * ink actually ends before anchoring something below it. */
function inkDescent(ctx: Ctx, family: string, size: number): number {
  ctx.font = `${size}px "${family}"`;
  const m = ctx.measureText("yg");
  return m.actualBoundingBoxDescent ?? size * 0.22;
}

/** Ink ascent of a sample string (e.g. "Mk" covers caps + ascenders), used to
 * convert an inkTop anchor into a baseline. PSD ink bboxes top out at the
 * tallest ascender, not the cap height. */
function inkAscent(ctx: Ctx, family: string, size: number, sample: string): number {
  ctx.font = `${size}px "${family}"`;
  const m = ctx.measureText(sample);
  return m.actualBoundingBoxAscent ?? capHeight(ctx, family, size);
}

// --- font router: per-glyph CJK routing so substituted CJK fonts actually render ---

interface FontRouter {
  primary: string;
  /** companion CJK family, or null for single-font mode */
  cjk: string | null;
}

const CJK_CHAR_RE =
  /[\u1100-\u11FF\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/u;

function splitScriptRuns(text: string, router: FontRouter): Array<{ text: string; family: string }> {
  if (!router.cjk) return [{ text, family: router.primary }];
  const out: Array<{ text: string; family: string }> = [];
  let buf = "";
  let cur: "cjk" | "lat" | null = null;
  const flush = () => {
    if (buf) out.push({ text: buf, family: cur === "cjk" ? (router.cjk as string) : router.primary });
    buf = "";
  };
  for (const ch of text) {
    const kind = CJK_CHAR_RE.test(ch) ? "cjk" : "lat";
    if (cur === kind) buf += ch;
    else {
      flush();
      buf = ch;
      cur = kind;
    }
  }
  flush();
  return out;
}

export interface RenderInput {
  template: Template;
  data: BannerData;
  preset?: Preset | null;
  params?: RenderParams;
  /** dirs of font files; family resolution order = fontOverride > slot font > fallbacks */
  fontDirs?: string[];
  fontOverride?: string;
  /** icon source override (e.g. fetched avatar bytes); wins over preset icon.
   * Grokbot-style kinds ("repo"/"builtin") may use the template's blend box;
   * anything else (avatars) always lands in the card box, so the designed gap
   * to the text column holds. */
  iconOverride?: { path?: string; buffer?: Buffer; kind?: "repo" | "avatar" | "builtin" };
  format?: "png" | "webp";
  webpQuality?: number;
}

export async function renderBanner(input: RenderInput): Promise<RenderResult> {
  const {
    template,
    data,
    preset = null,
    params = {},
    fontDirs = [],
    fontOverride,
    format = "webp",
    webpQuality = 92,
  } = input;

  const registered = registerFontDirs(fontDirs);
  const titleSlot = template.slots.title;
  const descSlot = template.slots.description;
  // icon source resolution happens early: background capture needs the pixels
  let iconSource = input.iconOverride;
  if (!iconSource) {
    const presetPaths = presetIconPaths(preset, params.theme);
    const presetPath = presetPaths.find(existsSync) ?? presetPaths[0];
    if (presetPath) iconSource = { path: presetPath, kind: "repo" };
  }
  let iconImg: Awaited<ReturnType<typeof loadImage>> | null = null;
  if (iconSource?.buffer) {
    iconImg = await loadImage(iconSource.buffer);
  } else if (iconSource?.path) {
    if (!existsSync(iconSource.path)) {
      throw new Error(`icon asset not found: ${iconSource.path}`);
    }
    iconImg = await loadImage(iconSource.path);
  }

  // An explicit theme fixes the palette, while artwork inspection determines
  // placement independently. Auto mode may also adopt the artwork backdrop.
  const accent = params.accent === undefined ? undefined : accentSchema.parse(params.accent);
  const explicitThemeName = params.theme || null; // only a non-empty query theme is explicit
  if (explicitThemeName !== null && !template.themes[explicitThemeName]) {
    throw new Error(`unknown theme "${explicitThemeName}"; available: ${Object.keys(template.themes).join(", ")}`);
  }
  // only Grokbot-style artwork has a backdrop worth adopting; an avatar's
  // corner colour must never repaint the canvas (avatars take the card path)
  const BOT_ICON_KINDS = new Set(["repo", "builtin"]);
  const botIcon = BOT_ICON_KINDS.has(iconSource?.kind ?? "");
  const captureAllowed = params.bgCapture !== false && botIcon;
  const captured =
    captureAllowed && iconImg ? captureBackgroundColor(iconImg) : null;

  // Flat or transparent artwork keeps its blend geometry across themes.
  // Complex images and avatars keep the contained card geometry.
  const blendBox = template.slots.iconBlend ?? null;
  const artwork = blendBox !== null && botIcon && (captured?.color != null || captured?.transparent === true);
  const box: IconBox = artwork ? blendBox! : template.slots.icon;

  let paletteName: string;
  let background: string;
  if (explicitThemeName === null && captured?.color) {
    const luma =
      0.2126 * parseInt(captured.color.slice(1, 3), 16) +
      0.7152 * parseInt(captured.color.slice(3, 5), 16) +
      0.0722 * parseInt(captured.color.slice(5, 7), 16);
    paletteName = luma >= 140 ? "light" : "dark";
    background = captured.color;
  } else {
    // explicit theme wins; auto without a successful capture: preset.theme
    // (brand palette) wins over the template default
    paletteName = explicitThemeName ?? (preset?.theme || template.defaults.theme);
    const paletteOverrides = preset?.themeOverrides?.[paletteName] ?? {};
    background = paletteOverrides.background ?? template.themes[paletteName].background;
  }
  // NOTE: `background` (capture or theme) must win over the palette spread,
  // but preset per-theme overrides must not be clobbered by the theme's own
  // background -- hence overrides are folded in first, background last.
  const colors: ThemeColors = {
    ...template.themes[paletteName],
    ...(preset?.themeOverrides?.[paletteName] ?? {}),
    background,
  };

  if (accent === "auto" && iconImg) {
    colors.accent = detectAccentColor(iconImg, background, captured?.color ?? null) ?? colors.accent;
  } else if (accent && accent !== "auto") {
    colors.accent = accent.toUpperCase();
  }

  // Small encoding differences are compatible; unlike auto mode, explicit
  // themes never replace their background with the sampled colour.
  const rgb = (color: string): [number, number, number] | null => /^#[0-9a-f]{6}$/iu.test(color)
    ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)]
    : null;
  const sourceRgb = captured?.color ? rgb(captured.color) : null;
  const themeRgb = rgb(colors.background);
  const matches = sourceRgb !== null && themeRgb !== null &&
    sourceRgb.every((channel, i) => Math.abs(channel - themeRgb[i]) <= 8);
  const frame = artwork && explicitThemeName !== null && captured?.color
    ? template.slots.icon.frame
    : undefined;
  const padding = Math.max(box.padding ?? 0, frame?.padding ?? 0);
  const imageSize = box.size * (1 - padding * 2);
  const radius = params.iconRound === undefined
    ? frame && !matches ? imageSize * frame.radius : box.radius
    : params.iconRound ? imageSize / 2 : 0;
  const display = {
    fit: params.iconFit ?? box.fit,
    padding,
    radius,
    position: box.position ?? { x: 0.5, y: 0.5 },
  };

  const family = resolveFontChain(
    [fontOverride, titleSlot.font, ...(titleSlot.fontFallback ?? [])],
    registered,
  );
  const cjkFamily = template.fontCjk ? resolveFontFamily(template.fontCjk, registered) : null;
  const router: FontRouter = { primary: family, cjk: cjkFamily };

  const scale = params.scale ?? template.defaults.scale;
  const width = Math.round(template.canvas.width * scale);
  const height = Math.round(template.canvas.height * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, template.canvas.width, template.canvas.height);

  if (iconImg) {
    drawIcon(ctx, iconImg, box, display);
  }

  const measure = makeMeasurer(ctx, router);
  const letterSpacingOk = "letterSpacing" in ctx;
  const metaSlot = template.slots.meta;
  const metaFields: string[] = params.meta ?? defaultMetaFields(metaSlot);
  const footerFields = metaSlot?.footer?.fields.filter((field) => metaFields.includes(field)) ?? [];
  const canvasH = template.canvas.height;

  // ---- 文本列垂直版式（紧凑栈）----
  // 文字的有效 y 轴带 = 图标上下限 [bandTop, bandBottom]。
  // 上 25% 基线（bandTop + 25% 带高）是 Repo Name（topline）与 Project Name
  // （title）的分隔线：
  // - topline 居中于分隔线之上的 25% 区；
  // - title 居中于分隔线之下的 25% 区——topline 的存在与否不影响 title 位置；
  // - Desc 在第四象限：墨顶到 x 轴（中线）的距离 = Project Name 墨顶到
  //   x 轴距离的一半（此约束持续有效）。
  // - 带底部预留给 metadata footer（如声明并启用）；未启用时描述动态字号
  //   调节用满剩余空间。
  // Theme variants may use different materials; the template's artwork band
  // keeps the text anchored even when one variant needs the smaller card box.
  const bandBox = explicitThemeName !== null && botIcon && blendBox && params.bgCapture !== false ? blendBox : box;
  const bandTop = bandBox.y;
  const bandBottom = bandBox.y + bandBox.size;
  const bandH = bandBottom - bandTop;
  const divider = bandTop + bandH * 0.25; // 上 25% 基线：topline / title 分隔
  const midline = bandTop + bandH / 2; // x 轴：Desc 距离的基准线

  // title — centered in the quarter BELOW the divider, so the topline's
  // presence never shifts it; baseline via ink ascent for font substitution.
  const titleText = params.title ?? preset?.title ?? data.name;
  const fit = fitTitle(titleText, titleSlot, measure);
  const titleInkH = inkAscent(ctx, family, fit.size, "Mk") + inkDescent(ctx, family, fit.size);
  const titleInkTop = divider + (bandH * 0.25 - titleInkH) / 2;
  const titleBaseline = titleInkTop + inkAscent(ctx, family, fit.size, "Mk");
  let tx = titleSlot.x;
  for (const run of fit.runs) {
    ctx.fillStyle = run.color === "accent" ? colors.accent : colors.title;
    tx += drawTextRouted(
      ctx,
      run.text,
      tx,
      titleBaseline,
      fit.size,
      titleSlot.tracking,
      router,
      letterSpacingOk,
    );
  }

  // description
  const rawDescription =
    params.description !== undefined
      ? params.description
      : preset?.description != null
        ? preset.description
        : (data.description ?? "");
  // `**…**` marks an accent span; the markers are stripped before measuring and
  // wrapping, so the span survives re-wrapping without costing any width
  const { text: description, spans: descriptionSpans } = parseAccentMarkers(rawDescription);
  const metaReserve =
    metaSlot && metaSlot.footer && metadataSegments(footerFields, data).length > 0
      ? metaSlot.footer.gap * canvasH +
        inkAscent(ctx, family, metaSlot.size, "Mk") +
        inkDescent(ctx, family, metaSlot.size)
      : 0;
  // Desc 在第四象限：墨顶到 x 轴（中线）的距离 = Project Name 墨顶到
  // x 轴距离的一半（该约束不因 topline/title 分隔规则而废除）
  const descInkTop = midline + (midline - titleInkTop) / 2;
  const descBandBottom = bandBottom - metaReserve;
  let descLastBaseline: number | null = null;
  let descLastSize = descSlot.size;
  if (description) {
    // description autoFit（象限规范的释放阀）：描述必须装进自己的子带
    // [descInkTop, descBandBottom]，装不下时字号在 [1.0, minScale] 内下探，
    // 直到整个文本都在带内——LIMITS.descriptionChars 的容量承诺由此兑现。
    // 仍放不下（触底）才省略。
    // 几何一律走基线：首行基线 = 墨顶 + 升部，末行墨底 = 基线 + 降部；
    // 与页脚守卫用的是同一套量，两者不会互相打架。
    const descBaseline = (s: number) => descInkTop + inkAscent(ctx, family, s * descSlot.size, "Akd");
    const descLineHeight = (s: number) => s * descSlot.size * descSlot.leading;
    const descInkBottom = (lines: number, s: number) =>
      descBaseline(s) + (lines - 1) * descLineHeight(s) + inkDescent(ctx, family, s * descSlot.size);
    const descBandLines = (s: number) =>
      Math.max(
        1,
        Math.floor(
          (descBandBottom - descBaseline(s) - inkDescent(ctx, family, s * descSlot.size)) /
            descLineHeight(s),
        ) + 1,
      );
    const fitsBand = (w: { lines: string[] }, s: number): boolean =>
      descInkBottom(w.lines.length, s) <= descBandBottom;

    let size = descSlot.size;
    let wrap = wrapDescription(description, descSlot, measure);
    const minScale =
      descSlot.autoFit?.mode === "scale-down" ? (descSlot.autoFit.minScale ?? 0.6) : 1;
    const baseOverflows = wrap.lines.length > descBandLines(1);
    if (descSlot.autoFit && (wrap.ellipsized || baseOverflows)) {
      for (const s of descriptionFitSearch(descSlot, minScale)) {
        const cand = {
          ...descSlot,
          size: Math.round(descSlot.size * s * 100) / 100,
          maxLines: descBandLines(s),
        };
        const w = wrapDescription(description, cand, measure);
        if (!w.ellipsized && fitsBand(w, s)) {
          size = cand.size;
          wrap = w;
          break;
        }
      }
    }
    ctx.fillStyle = colors.description;
    const firstBaseline =
      descInkTop + (descSlot.firstBaselineOffset ?? inkAscent(ctx, family, size, "Akd"));
    const accentColor = colors.accent ?? colors.description;
    wrap.lines.forEach((line, i) => {
      const baseline = firstBaseline + i * descSlot.leading * size;
      let x = descSlot.x;
      for (const segment of accentSegments(line, wrap.lineStarts[i] ?? 0, descriptionSpans)) {
        if (segment.text === "") continue;
        ctx.fillStyle = segment.accent ? accentColor : colors.description;
        x += drawTextRouted(
          ctx,
          segment.text,
          x,
          baseline,
          size,
          descSlot.tracking,
          router,
          letterSpacingOk,
        );
      }
    });
    descLastBaseline = firstBaseline + (wrap.lines.length - 1) * size * descSlot.leading;
    descLastSize = size;
  }

  // metadata rows: the topline (Repo Name) hugs the title's ink top -- the two
  // read as ONE unit (Project Name / Repo Name), so the 25% divider lands just
  // above the pair instead of splitting them apart; the title's position never
  // depends on the topline's presence. The footer sits in the reserved
  // band-bottom zone and is skipped when it would overflow (the description has
  // priority over the metadata row)
  if (metaSlot && metaFields.length > 0) {
    if (metaSlot.topline && metaSlot.topline.fields.length > 0) {
      const toplineBaseline =
        titleInkTop - TOPLINE_INK_GAP * canvasH - inkDescent(ctx, family, metaSlot.size);
      drawMetaRow(
        ctx,
        metaSlot,
        metaSlot.topline.fields.filter((f) => metaFields.includes(f)),
        titleSlot.x,
        toplineBaseline,
        data,
        colors,
        router,
        letterSpacingOk,
        titleSlot.maxWidth,
      );
    }
    if (metaSlot.footer && metaSlot.footer.fields.length > 0) {
      // anchor by INK, like the title's inkTop: the description's ink bottom and
      // the meta row's ink top decide the visual air, not the baselines (a
      // baseline-relative gap made the row hug the description)
      const descInkBottom =
        descLastBaseline !== null
          ? descLastBaseline + inkDescent(ctx, family, descLastSize)
          : bandBottom - metaReserve;
      const metaInkTop = inkAscent(ctx, family, metaSlot.size, "Mk");
      const footerInkBottom =
        descInkBottom + metaSlot.footer.gap * canvasH + metaInkTop + inkDescent(ctx, family, metaSlot.size);
      if (footerInkBottom <= bandBottom) {
        drawMetaRow(
          ctx,
          metaSlot,
          metaSlot.footer.fields.filter((f) => metaFields.includes(f)),
          descSlot.x,
          descInkBottom + metaSlot.footer.gap * canvasH + metaInkTop,
          data,
          colors,
          router,
          letterSpacingOk,
          descSlot.maxWidth,
        );
      }
    }
  }

  const buffer =
    format === "png" ? await canvas.encode("png") : await canvas.encode("webp", webpQuality);

  return { buffer, width, height, format, fontUsed: family, accent: colors.accent };
}
