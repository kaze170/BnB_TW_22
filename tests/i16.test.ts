import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeI16 } from "../tools/i16.ts";
import { logicalImage, imageCount, type Sprite } from "../src/client/engine/assets.ts";

const ROOT = join(import.meta.dir, "..");
function decode(rel: string) {
  return decodeI16(new Uint8Array(readFileSync(join(ROOT, "extracted", rel))));
}
function asSprite(img: ReturnType<typeof decode>): Sprite {
  let y = 0;
  const frames = img.frames.map((f) => { const r = { x: 0, y, w: f.width, h: f.height }; y += f.height; return r; });
  return { name: "test", url: "test", w: Math.max(...frames.map((f) => f.w)), h: y, frames, images: img.images, bitmap: null as unknown as ImageBitmap };
}

describe("I16 logical images", () => {
  test("packed button states are logical images, not vertical physical frames", () => {
    const img = decode("Fx/Lobby/LB_Bt_T_Create.i16");
    expect(img.frames.length).toBe(1);
    expect(img.images.length).toBe(9);
    const spr = asSprite(img);
    expect(imageCount(spr)).toBe(9);
    const normal = logicalImage(spr, 0)!;
    const hover = logicalImage(spr, 3)!;
    expect(normal.src).toEqual({ x: 0, y: 0, w: 133, h: 63 });
    expect(hover.src).toEqual({ x: 0, y: 189, w: 133, h: 63 });
  });

  test("multi-page channel button resolves source rects inside the right page", () => {
    const img = decode("Fx/SelectServerStage/CH_Bt_Channel.i16");
    expect(img.frames.length).toBe(2);
    expect(img.images.length).toBe(4);
    const spr = asSprite(img);
    const normal = logicalImage(spr, 0)!;
    const hover = logicalImage(spr, 3)!;
    expect(normal.src.y).toBe(0);
    expect(hover.src.y).toBe(img.frames[0]!.height); // second physical page
    expect(hover.src.w).toBe(167);
  });

  test("Fire00 keeps all 100 logical cells over 53 packed pages", () => {
    const img = decode("Fx/Bomb/Fire00.i16");
    expect(img.frames.length).toBe(53);
    expect(img.images.length).toBe(100);
    const spr = asSprite(img);
    for (let i = 0; i < 100; i++) {
      const li = logicalImage(spr, i)!;
      const page = spr.frames[img.images[i]!.frame]!;
      expect(li.src.x).toBeGreaterThanOrEqual(page.x);
      expect(li.src.y).toBeGreaterThanOrEqual(page.y);
      expect(li.src.x + li.src.w).toBeLessThanOrEqual(page.x + page.w);
      expect(li.src.y + li.src.h).toBeLessThanOrEqual(page.y + page.h);
    }
  });
});
