/**
 * Text rendering helper. Produces cached Sprites from strings via an offscreen
 * canvas. NOTE: the original client uses a custom FxFont (.fft); decoding that
 * bitmap font is tracked separately. This interim renderer uses a matched
 * system font so dynamic text (edit fields, chat) is visible meanwhile.
 */
import type { Sprite } from "../engine/assets.ts";

export interface TextStyle {
  size?: number;
  color?: string;
  font?: string;
  bold?: boolean;
  align?: "left" | "center";
}

const cache = new Map<string, Sprite>();
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

function ensure() {
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d")!;
  }
  return ctx!;
}

export function textSprite(text: string, style: TextStyle = {}): Sprite {
  const size = style.size ?? 12;
  const color = style.color ?? "#000000";
  const font = style.font ?? '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
  const weight = style.bold ? "bold " : "";
  const key = `${text}|${size}|${color}|${font}|${weight}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = ensure();
  c.font = `${weight}${size}px ${font}`;
  const w = Math.max(1, Math.ceil(c.measureText(text).width));
  const h = Math.ceil(size * 1.4);
  canvas!.width = w;
  canvas!.height = h;
  c.font = `${weight}${size}px ${font}`;
  c.textBaseline = "top";
  c.fillStyle = color;
  c.clearRect(0, 0, w, h);
  c.fillText(text, 0, size * 0.15);
  const url = `text:${key}`;
  // synchronous bitmap via transferToImageBitmap is not available on 2d; use a
  // HTMLCanvasElement-backed sprite. The renderer accepts ImageBitmap, so we
  // create one lazily; for sync draws we wrap the canvas as a bitmap source.
  const spr: Sprite = {
    name: url,
    url,
    w,
    h,
    frames: [{ x: 0, y: 0, w, h }],
    bitmap: canvas as unknown as ImageBitmap,
  };
  // Clone the canvas content into a stable bitmap source (canvas is reused).
  const stable = document.createElement("canvas");
  stable.width = w;
  stable.height = h;
  stable.getContext("2d")!.drawImage(canvas!, 0, 0);
  spr.bitmap = stable as unknown as ImageBitmap;
  cache.set(key, spr);
  return spr;
}