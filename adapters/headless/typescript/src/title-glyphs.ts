import { readFileSync } from "node:fs";
import { create } from "fontkit";

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
