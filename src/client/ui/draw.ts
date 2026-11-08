/** Drawing helpers for logical I16 images and the original bitmap font. */
import { logicalImage, type Sprite } from "../engine/assets.ts";
import type { Renderer } from "../engine/renderer.ts";
import { rect, type Rect } from "../engine/types.ts";
import { textSprite, type TextStyle } from "./text.ts";

/** Draw logical image `index` with its recovered dx/dy offset. */
export function drawLogical(r: Renderer, spr: Sprite, index: number, x: number, y: number, alpha = 1): Rect | null {
  const img = logicalImage(spr, index);
  if (!img) return null;
  const dst = rect(x + img.dx, y + img.dy, img.src.w, img.src.h);
  r.draw(spr, dst, { src: img.src, alpha });
  return dst;
}

/** Draw a logical image centred in `box` (used for packed HUD glyphs). */
export function drawLogicalCentered(r: Renderer, spr: Sprite, index: number, box: Rect, alpha = 1) {
  const img = logicalImage(spr, index);
  if (!img) return;
  const x = box.x + (box.w - img.src.w) / 2;
  const y = box.y + (box.h - img.src.h) / 2;
  r.draw(spr, rect(x, y, img.src.w, img.src.h), { src: img.src, alpha });
}

export function drawText(r: Renderer, text: string, x: number, y: number, style: TextStyle = {}) {
  const spr = textSprite(text, { size: 12, ...style });
  r.draw(spr, rect(x, y, spr.w, spr.h));
  return spr;
}

export function drawTextCentered(r: Renderer, text: string, cx: number, y: number, style: TextStyle = {}) {
  const spr = textSprite(text, { size: 12, ...style });
  r.draw(spr, rect(cx - spr.w / 2, y, spr.w, spr.h));
  return spr;
}

/** Draw a decimal number using a packed original digit atlas. */
export function drawDigits(r: Renderer, spr: Sprite, value: number, x: number, y: number, digitCount = 10) {
  const text = String(Math.max(0, Math.floor(value)));
  let cx = x;
  for (const ch of text) {
    const d = ch.charCodeAt(0) - 48;
    if (d < 0 || d >= digitCount) continue;
    const dst = drawLogical(r, spr, d, cx, y);
    const info = spr.images?.[d];
    cx += info?.w ?? dst?.w ?? 8;
  }
}
