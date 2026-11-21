import { openSync } from "fontkit";

/** Check the same face that FFmpeg drawtext selects for an explicit font file. */
export function titleGlyphProblem(fontFile: string | undefined, texts: readonly string[]): string | undefined {
  if (texts.length === 0) return undefined;
  if (!fontFile) return "no title font is available to check; set FRAMEKIT_RENDER_FONT to a readable font file";
  try {
    const opened = openSync(fontFile);
    const font = "fonts" in opened ? opened.fonts[0] : opened;
    if (!font) return "the selected title font has no first face";
    for (const text of texts) {
      for (const character of text) {
        const codepoint = character.codePointAt(0)!;
        if (character === "\n" || character === "\r" || character === "\t") continue;
        // A character-map check cannot establish whether a variation or joined
        // emoji sequence is supported by drawtext's shaping configuration.
        if (codepoint === 0x200d || (codepoint >= 0xfe00 && codepoint <= 0xfe0f) || (codepoint >= 0xe0100 && codepoint <= 0xe01ef)) {
          return `title uses an unverified shaping sequence at U+${codepoint.toString(16).toUpperCase()}`;
        }
        if (!font.hasGlyphForCodePoint(codepoint)) return `selected font lacks glyph U+${codepoint.toString(16).toUpperCase()}`;
      }
    }
    return undefined;
  } catch {
    return "the selected title font could not be inspected";
  }
}
