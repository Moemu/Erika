/** Erika template / data / preset schema. */

import type { MetaField } from "@erika/shared";

export interface AutoFitSpec {
  mode: "scale-down";
  minScale: number;
}

export interface TitleSlot {
  x: number;
  /** ink top (cap-top) anchor; baseline derived per font from cap height.
   * Preferred over baselineY so layouts survive font substitution. */
  inkTop?: number;
  /** absolute baseline (legacy/override); ignored when inkTop is set */
  baselineY?: number;
  maxWidth: number;
  font: string;
  fontFallback?: string[];
  size: number;
  /** em units, e.g. 0.1 = Photoshop tracking 100 */
  tracking: number;
  accentMode?: "word-initial";
  /** regex source; CJK matches are word boundaries, others are separators */
  tokenize?: string;
  autoFit?: AutoFitSpec;
  overflow?: "ellipsis";
}

export interface DescriptionSlot {
  x: number;
  top: number;
  maxWidth: number;
  maxLines: number;
  font: string;
  fontFallback?: string[];
  size: number;
  tracking: number;
  leading: number;
  /** baseline of first line = top + firstBaselineOffset.
   * Omit to auto-derive from the resolved font's cap height (font-independent). */
  firstBaselineOffset?: number;
  wrap?: "manual-first";
  overflow?: { mode: "ellipsis" };
  /** 垂直版式带底（canvas px）：描述自动缩排的可用带下限。 */
  bandBottom?: number;
  /** 描述自动缩排：文案超出 maxLines 时字号在 [1.0, minScale] 内下探。 */
  autoFit?: { mode: "scale-down"; minScale: number };
}

/** Absolute icon box inside the canvas (canvas units). */
export interface IconBox {
  x: number;
  y: number;
  size: number;
  /** display mode, independent of where the image comes from:
   * - "contain": scale to fit the whole image inside the area (letterbox),
   *   never crops content -- logos, illustrations
   * - "cover": scale to fill and crop -- flat-backdrop bot artwork
   * The layout guarantees the gap between this area and the text column for a
   * fully-filling image; images are not expected to bring their own padding. */
  fit: "contain" | "cover";
  /** inset ratio inside the area, applied in both modes (breathing room) */
  padding: number;
  /** corner radius in canvas units; size/2 = circle (explicit opt-in) */
  radius: number;
  /** cover crop focal point, normalized (0..1); default center */
  position?: { x: number; y: number };
  /** when background capture is unavailable (complex/transparent bg), the icon
   * area shrinks by this inset ratio (per side) so the layout still guarantees
   * the gap to the text column */
  fallbackInset?: number;
}

export interface IconSlot extends IconBox {
  /** Explicit themes share this opaque-artwork inset; incompatible backdrops
   * also receive rounded corners. Ratios of the active image box. */
  frame?: { padding: number; radius: number };
}

/** Ratio layout in template data files: every value is a
 * fraction of the canvas, induced from the reference PSDs by `erika-psd induce`.
 * The loader expands it into absolute slot geometry, so published templates
 * carry no project-specific pixel values. */
export interface RatioIconBox {
  /** left edge / canvas width */
  x: number;
  /** vertical center / canvas height */
  centerY: number;
  /** edge length / canvas width */
  size: number;
  fit?: "contain" | "cover";
  padding?: number;
  radius?: number;
}

export interface RatioLayout {
  /** full-bleed Grokbot artwork box: used when the backdrop was captured */
  iconBlend?: RatioIconBox;
  /** generic card box for any opaque image (avatars): keeps the text gap */
  iconCard?: RatioIconBox;
  title?: { x: number; inkTop: number };
  description?: { x: number; top: number; bottom?: number };
  /** text column right edge / canvas width -- maxWidth = rightEdge - x */
  text?: { rightEdge: number };
}

/** The repo-name row. Its position comes from the quadrant rules (centred in
 * the quarter above the 25% divider), so it carries no gap knob. */
export interface MetaTopline {
  fields: MetaField[];
}

/** The stats row: anchored below the description's ink bottom by an ink gap
 * (ratio of canvas height), so a short description never leaves a hole. */
export interface MetaFooter {
  gap: number;
  fields: MetaField[];
}

export interface MetaSlot {
  /** Fields shown when meta is omitted; defaults to all declared fields. */
  defaultFields?: MetaField[];
  /** glyph+value size in canvas units */
  size: number;
  tracking: number;
  /** value/plain-text colour (theme key) */
  color: keyof ThemeColors;
  /** glyph colour (theme key) */
  accent: keyof ThemeColors;
  /** separator between segments */
  separator: string;
  /** separator gap, ratio of the glyph size */
  separatorGap: number;
  topline?: MetaTopline;
  footer?: MetaFooter;
}

export interface ThemeColors {
  background: string;
  title: string;
  accent: string;
  description: string;
  stats?: string;
}

export interface Template {
  schemaVersion: number;
  id: string;
  version: number;
  /** inherit slots/themes from a base template */
  extends?: string;
  canvas: { width: number; height: number };
  defaults: { theme: string; scale: number };
  /** ratio layout (data files); the loader expands it into absolute slots */
  layout?: RatioLayout;
  slots: {
    title: TitleSlot;
    description: DescriptionSlot;
    icon: IconSlot;
    /** full-bleed Grokbot box, resolved from `layout.iconBlend` */
    iconBlend?: IconBox;
    meta: MetaSlot | null;
  };
  themes: Record<string, ThemeColors>;
  /** font files expected in the fonts dir (family resolution is runtime-side) */
  fonts: string[];
  /** CJK companion family routed per-glyph (e.g. "Noto Sans SC"); omit for single-font mode */
  fontCjk?: string;
  _notes?: string;
}

/** Provider-shaped data snapshot (GitHub REST field mapping, camelCase). */
export interface BannerData {
  fullName?: string;
  name: string;
  description: string | null;
  stargazersCount?: number;
  forksCount?: number;
  openIssuesCount?: number;
  /** latest release tag, fetched lazily when a template displays it */
  releaseTag?: string | null;
  licenseSpdxId?: string | null;
  language?: string | null;
  /** Latest code push timestamp, formatted as a UTC date by last_updated. */
  pushedAt?: string | null;
  defaultBranch?: string;
  private?: boolean;
}

export interface Preset {
  template?: string;
  title?: string;
  /** null = use Provider description; string = override */
  description?: string | null;
  /** the project's own icon, as a path IN THE SUBJECT REPO (fetched through the
   * public interface, same as any user); placement comes from the template's
   * ratio layout, never from per-project pixel values */
  icon?: {
    path?: string;
    /** optional light-theme variant for solid-background assets (design 10.0:
     * known solid-bg images may ship dark/light pairs) */
    pathLight?: string;
    /** Transparent variant shared by explicitly selected themes. */
    pathTransparent?: string;
  };
  theme?: string;
  /** per-theme color overrides: only the entry matching the resolved theme is
   * applied, so an explicit theme=light is never painted with dark overrides */
  themeOverrides?: Record<string, Partial<ThemeColors>>;
}

export interface RenderParams {
  /** Explicit #RRGGBB or opt-in artwork detection (auto). */
  accent?: string;
  theme?: string;
  scale?: number;
  title?: string;
  description?: string;
  /** metadata fields to show; [] = none; undefined = the template's declared set */
  meta?: string[];
  /** explicit icon display overrides (query params); win over slot/preset */
  iconFit?: "contain" | "cover";
  iconRound?: boolean;
  /** Default true: inspect artwork for blend placement; auto mode also adopts
   * its background. False keeps the theme background and the card layout. */
  bgCapture?: boolean;
}

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: "png" | "webp";
  fontUsed: string;
  accent: string;
}
