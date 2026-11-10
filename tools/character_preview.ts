/** Headless character-action sheet preview: Throw / Faint / Die / Ghost (C00).
 * Validates ObjectTable asset mapping + logical I16 frames without a browser. */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Assets } from "../src/client/engine/assets.ts";
import { logicalImage } from "../src/client/engine/assets.ts";
import { animationGroup, animationImageAtTicks } from "../src/shared/animations.ts";

const ROOT = join(import.meta.dir, "..");
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any) => {
  const url = String(input);
  if (/^https?:/.test(url)) return realFetch(input);
  const path = url.startsWith("/") ? url.slice(1) : url;
  const file = path === "manifest.json" ? join(ROOT, "build/manifest.json") : join(ROOT, "build", path);
  return new Response(Bun.file(file));
};
(globalThis as any).document = { createElement: () => createCanvas(1, 1) };
(globalThis as any).createImageBitmap = async (blob: Blob) => loadImage(Buffer.from(await blob.arrayBuffer()));

const assets = new Assets();
await assets.loadManifest();
const rows = [
  { label: "Throw Down (18)", group: 18 },
  { label: "Faint (2)", group: 2 },
  { label: "Die (1)", group: 1 },
  { label: "Ghost Appear (43)", group: 43 },
  { label: "Ghost Stop Down (51)", group: 51 },
];
const cellW = 96, cellH = 110, labelW = 170, cols = 12;
const canvas = createCanvas(labelW + cols * cellW, rows.length * cellH + 30);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#101820"; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#ffe08a"; ctx.font = "16px sans-serif";
ctx.fillText("Character/C00_A — CGOBomber action states (original I16)", 12, 20);
for (let r = 0; r < rows.length; r++) {
  const { label, group } = rows[r]!;
  const g = animationGroup("Character/C00_A", group)!;
  const spr = await assets.sprite(`${g.asset}LayerStatic`);
  const oy = 30 + r * cellH;
  ctx.fillStyle = "#9fd8ff"; ctx.font = "13px sans-serif";
  ctx.fillText(label, 12, oy + 20);
  ctx.fillStyle = "#667"; ctx.fillText(g.asset, 12, oy + 38);
  if (!spr) continue;
  const total = g.frames.reduce((s, [, d]) => s + (d > 0 ? d : 0), 0);
  for (let c = 0; c < cols; c++) {
    const ticks = Math.floor(c * total / cols);
    const idx = animationImageAtTicks(g, ticks, false);
    const img = logicalImage(spr, idx);
    const ox = labelW + c * cellW;
    ctx.strokeStyle = "#234"; ctx.strokeRect(ox, oy, cellW, cellH);
    ctx.fillStyle = "#556"; ctx.font = "10px sans-serif";
    ctx.fillText(`t${ticks} #${idx}`, ox + 4, oy + 12);
    if (img && img.src.w > 0 && img.src.h > 0) {
      const scale = 2;
      const dx = ox + cellW / 2 - img.src.w * scale / 2;
      const dy = oy + cellH - img.src.h * scale - 8;
      ctx.drawImage(spr.bitmap as any, img.src.x, img.src.y, img.src.w, img.src.h, dx, dy, img.src.w * scale, img.src.h * scale);
    }
  }
}
writeFileSync(join(ROOT, "build", "character_action_preview.png"), canvas.toBuffer("image/png"));
console.log("CHARACTER_PREVIEW_OK");
