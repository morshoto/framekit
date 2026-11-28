import { readFileSync } from "node:fs";
import { create } from "fontkit";
import type { TimelineIrTitle } from "@framekit/runtime";

export interface TitleFontFace {
  family: string;
  style: string;
  postscriptName: string;
}

/** Inspect the first face and glyphs from the same immutable font bytes. */
export function inspectTitleFont(bytes: Buffer, texts: readonly string[]): { face?: TitleFontFace; problem?: string } {
  try {
    const opened = create(bytes);
    const font = "fonts" in opened ? opened.fonts[0] : opened;
    if (!font) return { problem: "the selected title font has no first face" };
    const { familyName, subfamilyName, postscriptName } = font;
    if (![familyName, subfamilyName, postscriptName].every((value) => typeof value === "string" && value.trim().length > 0)) {
      return { problem: "the selected title font has no identifiable family or face" };
    }
    for (const text of texts) {
      for (const character of text) {
        const codepoint = character.codePointAt(0)!;
        if (character === "\n" || character === "\r" || character === "\t") continue;
        // A character-map check cannot establish variation or joined shaping.
        if (codepoint === 0x200d || (codepoint >= 0xfe00 && codepoint <= 0xfe0f) || (codepoint >= 0xe0100 && codepoint <= 0xe01ef)) {
          return { problem: `title uses an unverified shaping sequence at U+${codepoint.toString(16).toUpperCase()}` };
        }
        if (!font.hasGlyphForCodePoint(codepoint)) return { problem: `selected font lacks glyph U+${codepoint.toString(16).toUpperCase()}` };
      }
    }
    return { face: { family: familyName, style: subfamilyName, postscriptName } };
  } catch {
    return { problem: "the selected title font could not be inspected" };
  }
}

/** Check the same face that FFmpeg drawtext selects for an explicit font file. */
export function titleGlyphProblem(fontFile: string | undefined, texts: readonly string[]): string | undefined {
  if (texts.length === 0) return undefined;
  if (!fontFile) return "no title font is available to check; set FRAMEKIT_RENDER_FONT to a readable font file";
  try {
    return inspectTitleFont(readFileSync(fontFile), texts).problem;
  } catch {
    return "the selected title font could not be inspected";
  }
}

/** Canvas-scaled outline for the default headless title, in output pixels. */
export function basicTitleOutlineWidth(height: number): number {
  return Math.max(1, Math.round(height / 360));
}

/** Conservatively check shaped text bounds against the requested canvas. */
export function titleFitProblem(bytes: Buffer, titles: readonly TimelineIrTitle[], width: number, height: number): string | undefined {
  try {
    const opened = create(bytes);
    const font = "fonts" in opened ? opened.fonts[0] : opened;
    if (!font || !Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0) return "title font metrics are unavailable";
    const bounds = font.bbox;
    if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, font.ascent, font.descent, font.lineGap].every(Number.isFinite)) return "title font bounds are unavailable";
    for (const title of titles) {
      const basicDefault = title.style === undefined && title.position === undefined;
      const size = title.style?.fontSize ?? (basicDefault ? height * 44 / 720 : 32);
      const outline = basicDefault ? basicTitleOutlineWidth(height) : 0;
      const center = title.position ? width / 2 + title.position.x * width / 2 : width / 2;
      const available = title.position ? 2 * Math.min(center, width - center)
        : title.style?.alignment === "left" || title.style?.alignment === "right" ? width - 20 : width;
      const lines = title.text.split(/\r?\n/u);
      const verticalCenter = title.position ? height / 2 - title.position.y * height / 2 : height / 2;
      const availableHeight = title.position ? 2 * Math.min(verticalCenter, height - verticalCenter) : basicDefault ? height / 2 : height;
      const lineHeight = Math.max(bounds.maxY - bounds.minY, font.ascent - font.descent + Math.max(0, font.lineGap));
      const verticalPixels = lineHeight * size / font.unitsPerEm * lines.length;
      if (!Number.isFinite(verticalPixels) || !Number.isFinite(availableHeight) || verticalPixels * 1.05 + 4 + 2 * outline > availableHeight) return "title text cannot fit vertically in the requested output";
      for (const line of lines) {
        const run = font.layout(line);
        let pen = 0; let minimum = 0; let maximum = 0;
        for (let index = 0; index < run.positions.length; index++) {
          const position = run.positions[index]!;
          // Some subset fonts cannot expose glyph paths; the whole-font box
          // is a conservative fallback for those fonts.
          let glyphBounds = bounds;
          try { glyphBounds = run.glyphs[index]!.bbox; } catch { /* use font bounds */ }
          minimum = Math.min(minimum, pen + position.xOffset + glyphBounds.minX);
          maximum = Math.max(maximum, pen + position.xOffset + glyphBounds.maxX);
          pen += position.xAdvance;
        }
        const pixels = (Math.max(maximum, pen) - Math.min(minimum, 0)) * size / font.unitsPerEm;
        // Leave room for rasterization and conservative font-metric differences.
        if (!Number.isFinite(pixels) || !Number.isFinite(available) || pixels * 1.05 + 4 + 2 * outline > available) return "title text cannot fit horizontally in the requested output";
      }
    }
    return undefined;
  } catch {
    return "title font metrics could not be inspected";
  }
}
