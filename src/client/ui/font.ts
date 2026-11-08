/**
 * Original FxFont (.fft) decoder — port of CFontMan loader sub_676700.
 *
 * Format (verified against CxUni.fft):
 *   32-byte header; dword[2]=glyphCount(65535), [3]=width, [4]=height,
 *   [7]=bitmapBytesPerGlyph. Each glyph = [u8 advance][bitmapBytes] where the
 *   bitmap is MSB-first, row-major, tightly packed (width*height bits).
 *   The file also contains a second (w+2)x(h+2) outline face after the first.
 *
 * We decode the primary face into a 256x256 cell atlas (Unicode BMP index) and
 * render strings by advancing per-glyph, exactly like the original bitmap font.
 */
import type { Sprite } from "../engine/assets.ts";

interface FontFace {
  width: number;
  height: number;
  advance: Uint8Array;
  atlas: HTMLCanvasElement;
}

const faces = new Map<string, FontFace>();
let ready = false;

export async function loadFonts(base = ""): Promise<void> {
  await Promise.all([decodeFont(`${base}/fonts/CxUni.fft`, "regular"), decodeFont(`${base}/fonts/CxUniBold.fft`, "bold")]);
  ready = true;
}

export function fontsReady(): boolean {
  return ready;
}

async function decodeFont(url: string, name: string): Promise<void> {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const count = dv.getUint32(8, true);
  const w = dv.getUint32(12, true);
  const h = dv.getUint32(16, true);
  const bitmapBytes = dv.getUint32(28, true);
  const stride = bitmapBytes + 1; // advance byte + bitmap
  const cols = 256;
  const rows = Math.ceil(count / cols);
  const atlas = document.createElement("canvas");
  atlas.width = cols * w;
  atlas.height = rows * h;
  const ctx = atlas.getContext("2d")!;
  const img = ctx.createImageData(atlas.width, atlas.height);
  const advance = new Uint8Array(count);
  let off = 32;
  for (let cp = 0; cp < count; cp++) {
    advance[cp] = buf[off]!;
    const gx = (cp % cols) * w;
    const gy = Math.floor(cp / cols) * h;
    let bit = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byte = buf[off + 1 + (bit >> 3)]!;
        const on = (byte >> (7 - (bit & 7))) & 1;
        bit++;
        if (on) {
          const p = ((gy + y) * atlas.width + (gx + x)) * 4;
          img.data[p] = 255; img.data[p + 1] = 255; img.data[p + 2] = 255; img.data[p + 3] = 255;
        }
      }
    }
    off += stride;
  }
  ctx.putImageData(img, 0, 0);
  faces.set(name, { width: w, height: h, advance, atlas });
}

export interface TextStyle {
  size?: number;
  color?: string;
  bold?: boolean;
  align?: "left" | "center";
}

const cache = new Map<string, Sprite>();

/** Render a string with the original bitmap font. Returns a cacheable Sprite. */
export function textSprite(text: string, style: TextStyle = {}): Sprite {
  const face = faces.get(style.bold ? "bold" : "regular") ?? faces.get("regular");
  const scale = (style.size ?? 12) / (face?.height ?? 12);
  const color = style.color ?? "#000000";
  const key = `${text}|${style.bold ? "b" : "r"}|${scale}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!face) return fallback(text, style, key);

  const codes = Array.from(text).map((c) => c.codePointAt(0)!).filter((c) => c < face.advance.length);
  let adv = 0;
  for (const c of codes) adv += face.advance[c]!;
  const w = Math.max(1, Math.round(adv * scale));
  const h = Math.round(face.height * scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  let x = 0;
  const cols = 256;
  for (const c of codes) {
    const gx = (c % cols) * face.width;
    const gy = Math.floor(c / cols) * face.height;
    ctx.drawImage(face.atlas, gx, gy, face.width, face.height, Math.round(x * scale), 0, Math.round(face.width * scale), h);
    x += face.advance[c]!;
  }
  // tint the white glyph mask
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  const spr: Sprite = { name: `text:${key}`, url: `text:${key}`, w, h, frames: [{ x: 0, y: 0, w, h }], bitmap: cv as unknown as ImageBitmap };
  cache.set(key, spr);
  return spr;
}

/** Measure text width in original font pixels (unscaled). */
export function measureText(text: string, bold = false): number {
  const face = faces.get(bold ? "bold" : "regular") ?? faces.get("regular");
  if (!face) return text.length * 12;
  let adv = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < face.advance.length) adv += face.advance[c]!;
  }
  return adv;
}

function fallback(text: string, style: TextStyle, key: string): Sprite {
  const size = style.size ?? 12;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d")!;
  ctx.font = `${style.bold ? "bold " : ""}${size}px sans-serif`;
  const w = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const h = Math.ceil(size * 1.3);
  cv.width = w; cv.height = h;
  ctx.font = `${style.bold ? "bold " : ""}${size}px sans-serif`;
  ctx.fillStyle = style.color ?? "#000";
  ctx.textBaseline = "top";
  ctx.fillText(text, 0, 0);
  const spr: Sprite = { name: `text:${key}`, url: `text:${key}`, w, h, frames: [{ x: 0, y: 0, w, h }], bitmap: cv as unknown as ImageBitmap };
  cache.set(key, spr);
  return spr;
}
