// Exact port of CFxFontReal / CFontMan (.fft bitmap font loader & glyph rasterizer)
// Verified byte-exact: 32 + 65535 * 19 + 65535 * 26 === 2,949,107 bytes for CxUni*.fft

export interface FftGlyph {
  codepoint: number;
  advance: number;
  width: number;
  height: number;
  /** RGBA8888 bitmap (12x12 for normal, 14x14 for outlined) */
  rgba: Uint8Array;
}

export class FftFont {
  public readonly name: string;
  private readonly raw: Uint8Array;
  public readonly isUnicodeTable: boolean;
  public readonly glyphWidth: number;
  public readonly glyphHeight: number;
  public readonly ascent: number;
  public readonly descent: number;

  private static readonly HEADER_BYTES = 32;
  private static readonly GLYPH_COUNT = 65535;
  private static readonly NORMAL_STRIDE = 19; // 1B advance + 18B (144 bits = 12x12)
  private static readonly OUTLINE_STRIDE = 26; // 1B advance + 25B (200 bits >= 196 bits = 14x14)
  private static readonly OUTLINE_BASE = 32 + 65535 * 19; // 1,245,197

  constructor(name: string, raw: Uint8Array) {
    this.name = name;
    this.raw = raw;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const minCp = view.getUint16(0, true);
    const maxCp = view.getUint16(2, true);
    this.isUnicodeTable = minCp === 0 && maxCp === 65535 && raw.byteLength >= 2949107;
    this.glyphWidth = this.isUnicodeTable ? view.getUint32(12, true) || 12 : 12;
    this.glyphHeight = this.isUnicodeTable ? view.getUint32(16, true) || 12 : 12;
    this.ascent = this.isUnicodeTable ? view.getUint32(20, true) || 10 : 10;
    this.descent = this.isUnicodeTable ? view.getUint32(24, true) || 2 : 2;
  }

  getAdvance(codepoint: number, outlined = false): number {
    if (codepoint === 0x20) return outlined ? 7 : 6;
    if (codepoint === 0x09) return 24;
    if (!this.isUnicodeTable || codepoint < 0 || codepoint >= FftFont.GLYPH_COUNT) {
      return codepoint < 0x80 ? 6 : 12;
    }
    const off = outlined
      ? FftFont.OUTLINE_BASE + codepoint * FftFont.OUTLINE_STRIDE
      : FftFont.HEADER_BYTES + codepoint * FftFont.NORMAL_STRIDE;
    const adv = this.raw[off]!;
    if (adv === 0) return codepoint < 0x80 ? 6 : 12;
    return adv;
  }

  measureText(text: string, outlined = false): number {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp === 0x0a || cp === 0x0d) continue;
      width += this.getAdvance(cp, outlined);
    }
    return width;
  }

  /**
   * Decodes a UTF-16 BMP codepoint into an RGBA8888 glyph bitmap.
   * For outlined=false: white (255,255,255,255) foreground so WebGPU vertex color modulates it.
   * For outlined=true: combines the 14x14 outline mask (black, alpha=255) with the 12x12 inner
   * glyph shifted by (+1, +1) (white, alpha=255) so vertex tinting colors the fill or we can
   * render outline + fill in two crisp passes or precomposited!
   */
  decodeGlyph(
    codepoint: number,
    outlined = false,
    fillRGB: [number, number, number] = [255, 255, 255],
    outlineRGB: [number, number, number] = [0, 0, 0],
  ): FftGlyph {
    if (!this.isUnicodeTable || codepoint <= 0x20 || codepoint >= FftFont.GLYPH_COUNT) {
      const w = outlined ? 14 : 12;
      const h = outlined ? 14 : 12;
      return {
        codepoint,
        advance: this.getAdvance(codepoint, outlined),
        width: w,
        height: h,
        rgba: new Uint8Array(w * h * 4),
      };
    }

    const normOff = FftFont.HEADER_BYTES + codepoint * FftFont.NORMAL_STRIDE;
    const normAdv = this.raw[normOff]! || (codepoint < 0x80 ? 6 : 12);

    if (!outlined) {
      const w = 12;
      const h = 12;
      const rgba = new Uint8Array(w * h * 4);
      let bitIdx = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const byteVal = this.raw[normOff + 1 + (bitIdx >>> 3)]!;
          const bit = (byteVal >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
          if (bit !== 0) {
            const dst = (y * w + x) * 4;
            rgba[dst] = fillRGB[0];
            rgba[dst + 1] = fillRGB[1];
            rgba[dst + 2] = fillRGB[2];
            rgba[dst + 3] = 255;
          }
        }
      }
      return { codepoint, advance: normAdv, width: w, height: h, rgba };
    }

    // Outlined 14x14 glyph: read 14x14 outline plane first, then overlay 12x12 fill at (+1, +1)
    const outOff = FftFont.OUTLINE_BASE + codepoint * FftFont.OUTLINE_STRIDE;
    const outAdv = this.raw[outOff]! || normAdv + 1;
    const w = 14;
    const h = 14;
    const rgba = new Uint8Array(w * h * 4);

    let outBitIdx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byteVal = this.raw[outOff + 1 + (outBitIdx >>> 3)]!;
        const bit = (byteVal >>> (7 - (outBitIdx & 7))) & 1;
        outBitIdx++;
        if (bit !== 0) {
          const dst = (y * w + x) * 4;
          rgba[dst] = outlineRGB[0];
          rgba[dst + 1] = outlineRGB[1];
          rgba[dst + 2] = outlineRGB[2];
          rgba[dst + 3] = 255;
        }
      }
    }

    let inBitIdx = 0;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const byteVal = this.raw[normOff + 1 + (inBitIdx >>> 3)]!;
        const bit = (byteVal >>> (7 - (inBitIdx & 7))) & 1;
        inBitIdx++;
        if (bit !== 0) {
          const dst = ((y + 1) * w + (x + 1)) * 4;
          rgba[dst] = fillRGB[0];
          rgba[dst + 1] = fillRGB[1];
          rgba[dst + 2] = fillRGB[2];
          rgba[dst + 3] = 255;
        }
      }
    }

    return { codepoint, advance: outAdv, width: w, height: h, rgba };
  }
}
