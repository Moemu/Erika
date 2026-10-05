/** Pure layout engine: measure function is injected, so everything is testable
 * without a canvas. Colors are decided here ("accent"/"base"), painting happens
 * in render.ts. */

import type { DescriptionSlot, TitleSlot } from "./types.js";

export interface TextRun {
  text: string;
  color: "accent" | "base";
}

/** (text, fontSize, trackingEm) -> rendered width in canvas units */
export type MeasureFn = (text: string, size: number, tracking: number) => number;

const DEFAULT_TOKENIZE = "[-_\u2013\u2014\\s]|[\\u4e00-\\u9fff]";
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const TRAILING_SEPS_RE = /[\s\u2013\u2014_-]+$/u;

function isSeparator(ch: string, re: RegExp): boolean {
  return re.test(ch);
}

function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.color === run.color) prev.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

/** Word-initial accent runs: first char of each word uses the accent color.
 * Separators (- _ – — whitespace) end the current word and stay base-colored,
 * matching the PSD style runs (e.g. M|uika-|A|fter-|S|tory). Consecutive CJK
 * chars form one word so only the first char is accented. */
export function buildTitleRuns(text: string, tokenizeSource?: string): TextRun[] {
  const re = new RegExp(tokenizeSource ?? DEFAULT_TOKENIZE, "u");
  const runs: TextRun[] = [];
  let baseBuf = "";
  let expectingAccent = true;
  let inCjkWord = false;

  const flushBase = () => {
    if (baseBuf) {
      runs.push({ text: baseBuf, color: "base" });
      baseBuf = "";
    }
  };

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      // CJK chars are word boundaries, not separators: consecutive CJK chars
      // form one word, its first char accented.
      if (inCjkWord) {
        baseBuf += ch;
      } else {
        flushBase();
        runs.push({ text: ch, color: "accent" });
        inCjkWord = true;
        expectingAccent = false;
      }
    } else if (isSeparator(ch, re)) {
      flushBase();
      runs.push({ text: ch, color: "base" });
      expectingAccent = true;
      inCjkWord = false;
    } else {
      if (expectingAccent) {
        flushBase();
        runs.push({ text: ch, color: "accent" });
        expectingAccent = false;
      } else {
        baseBuf += ch;
      }
      inCjkWord = false;
    }
  }
  flushBase();
  return mergeRuns(runs);
}

export function runsWidth(
  runs: TextRun[],
  size: number,
  tracking: number,
  measure: MeasureFn,
): number {
  return runs.reduce((acc, r) => acc + measure(r.text, size, tracking), 0);
}

export interface FitTitleResult {
  runs: TextRun[];
  size: number;
  ellipsized: boolean;
}

/** Scale the title down to fit maxWidth (floor minScale), then ellipsize. */
export function fitTitle(
  text: string,
  slot: TitleSlot,
  measure: MeasureFn,
): FitTitleResult {
  const tokenize = slot.tokenize;
  const widthAt = (t: string, size: number) =>
    runsWidth(buildTitleRuns(t, tokenize), size, slot.tracking, measure);

  let size = slot.size;
  if (slot.autoFit?.mode === "scale-down" && widthAt(text, size) > slot.maxWidth) {
    const target = (size * slot.maxWidth) / widthAt(text, size);
    size = Math.max(slot.autoFit.minScale * slot.size, target);
  }

  let current = text;
  let ellipsized = false;
  if (slot.overflow === "ellipsis" && widthAt(current, size) > slot.maxWidth) {
    while (current.length > 1 && widthAt(current + "\u2026", size) > slot.maxWidth) {
      current = current.slice(0, -1).replace(TRAILING_SEPS_RE, "");
      ellipsized = true;
    }
    if (ellipsized) current = current.replace(TRAILING_SEPS_RE, "") + "\u2026";
  }

  return { runs: buildTitleRuns(current, tokenize), size, ellipsized };
}

export interface WrapResult {
  lines: string[];
  /** offset of each line's first character in the wrapped text, so callers can
   * map character ranges (e.g. accent spans) onto the wrapped lines */
  lineStarts: number[];
  ellipsized: boolean;
}

/** 描述自动缩排搜索：从 1.0 起按步长下探，返回能容纳 text 的最大字号
 * （供渲染端以真实 wrap 验证后采用）。 */
export function descriptionFitSearch(
  slot: DescriptionSlot,
  minScale: number,
): Array<number> {
  const scales: number[] = [];
  for (let s = 1; s >= minScale - 1e-9; s = Math.round((s - 0.04) * 100) / 100) {
    scales.push(s);
  }
  return scales;
}

/** manual-first: keep explicit line breaks, wrap overlong lines greedily on
 * spaces (char-level binary search as bound), clamp to maxLines with ellipsis. */
export function wrapDescription(
  text: string,
  slot: DescriptionSlot,
  measure: MeasureFn,
): WrapResult {
  const m = (s: string) => measure(s, slot.size, slot.tracking);
  // split with offsets so each wrapped line keeps the position of its first
  // character in the input text (accent spans are mapped through this)
  const segments: Array<{ text: string; start: number }> = [];
  {
    const re = /\r\n|\r|\n/gu;
    let start = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(text)) !== null) {
      segments.push({ text: text.slice(start, hit.index), start });
      start = hit.index + hit[0].length;
    }
    segments.push({ text: text.slice(start), start });
  }
  const manual = segments.map((seg) => ({ start: seg.start, text: seg.text.replace(/\s+$/u, "") }));
  while (manual.length > 0 && manual[manual.length - 1].text === "") manual.pop();

  const lines: string[] = [];
  const lineStarts: number[] = [];
  let ellipsized = false;

  for (const segment of manual) {
    const line = segment.text;
    if (lines.length >= slot.maxLines) {
      ellipsized = true;
      break;
    }
    if (line === "" || m(line) <= slot.maxWidth) {
      lines.push(line);
      lineStarts.push(segment.start);
      continue;
    }
    let rest = line;
    let cursor = segment.start;
    while (rest.length > 0) {
      if (lines.length >= slot.maxLines) {
        ellipsized = true;
        break;
      }
      if (m(rest) <= slot.maxWidth) {
        lines.push(rest);
        lineStarts.push(cursor);
        rest = "";
        break;
      }
      let lo = 1;
      let hi = rest.length;
      let fit = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (m(rest.slice(0, mid)) <= slot.maxWidth) {
          fit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      let cut = rest.slice(0, fit);
      const sp = cut.lastIndexOf(" ");
      if (sp > 0 && sp >= fit * 0.5) cut = rest.slice(0, sp);
      lines.push(cut.replace(/\s+$/u, ""));
      lineStarts.push(cursor);
      const next = rest.slice(cut.length).replace(/^\s+/u, "");
      cursor += rest.length - next.length;
      rest = next;
    }
  }

  if (ellipsized && slot.overflow?.mode === "ellipsis" && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && m(last + "\u2026") > slot.maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last.replace(/\s+$/u, "") + "\u2026";
  }

  return { lines, lineStarts, ellipsized };
}

export interface AccentSpan {
  /** inclusive start offset in the parsed (marker-free) text */
  start: number;
  /** exclusive end offset */
  end: number;
}

export interface ParsedDescription {
  /** marker-free text: this is what gets measured, wrapped and drawn */
  text: string;
  /** accent spans over `text` */
  spans: AccentSpan[];
}

/** `**…**` marks an accent span (paired, non-nested). The markers never reach
 * measurement, so they cost no width; an unpaired `**` stays literal. */
export function parseAccentMarkers(text: string): ParsedDescription {
  let out = "";
  const spans: AccentSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        spans.push({ start: out.length, end: out.length + (close - (i + 2)) });
        out += text.slice(i + 2, close);
        i = close + 2;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return { text: out, spans };
}

/** Split one wrapped line into plain/accent segments (theme accent paints the
 * accent ones). Both offsets and spans live in the marker-free text. */
export function accentSegments(
  line: string,
  lineStart: number,
  spans: AccentSpan[],
): Array<{ text: string; accent: boolean }> {
  const lineEnd = lineStart + line.length;
  const hits = spans
    .filter((s) => s.end > lineStart && s.start < lineEnd)
    .map((s) => ({
      start: Math.max(s.start, lineStart) - lineStart,
      end: Math.min(s.end, lineEnd) - lineStart,
    }))
    .sort((a, b) => a.start - b.start);
  const out: Array<{ text: string; accent: boolean }> = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) out.push({ text: line.slice(cursor, hit.start), accent: false });
    out.push({ text: line.slice(hit.start, hit.end), accent: true });
    cursor = hit.end;
  }
  if (cursor < line.length) out.push({ text: line.slice(cursor), accent: false });
  return out;
}

