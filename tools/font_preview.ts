/** Headless validation of the original .fft font decoder using @napi-rs/canvas. */
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// shim browser canvas + fetch for font.ts
(globalThis as any).document = { createElement: (tag: string) => { if (tag !== "canvas") throw new Error(tag); return createCanvas(1, 1); } };
(globalThis as any).ImageData = ImageData;
const origFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string) => {
  if (url.startsWith("/fonts/")) {
    const buf = readFileSync(join(ROOT, url.slice("/fonts/".length)));
    return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
  return origFetch(url);
};

const { loadFonts, textSprite, measureText } = await import("../src/client/ui/font.ts");
await loadFonts();
const samples = ["彈水阿給 BnB", "登入 Login 123", "房間準備中…"];
const cv = createCanvas(420, 140);
const ctx = cv.getContext("2d");
ctx.fillStyle = "#1a1a2e";
ctx.fillRect(0, 0, 420, 140);
let y = 16;
for (const s of samples) {
  const spr = textSprite(s, { size: 24, color: "#ffe08a", bold: s.includes("BnB") });
  ctx.drawImage(spr.bitmap as any, 16, y);
  console.log(JSON.stringify({ text: s, w: spr.w, h: spr.h, advance: measureText(s) }));
  y += 40;
}
const png = await cv.encode("png");
writeFileSync(join(ROOT, "build", "font_preview.png"), png);
// count non-background pixels to prove glyphs rendered
const data = ctx.getImageData(0, 0, 420, 140).data;
let lit = 0;
for (let i = 0; i < data.length; i += 4) if (data[i]! > 100 && data[i + 1]! > 100) lit++;
console.log("lit pixels", lit);
console.log(lit > 500 ? "FONT_OK" : "FONT_FAIL");
