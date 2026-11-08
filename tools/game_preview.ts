/** Headless gameplay render: runs the real simulation on an original map and
 * composites a frame with the extracted sprites, to validate asset mapping. */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";

const ROOT = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "build/manifest.json"), "utf8"));
const TILE = 40;
const cache = new Map<string, any>();
async function sprite(name: string) {
  if (cache.has(name)) return cache.get(name);
  const key = name.startsWith("Fx/") || name.startsWith("CharTE/") ? name : `Fx/${name}`;
  const e = manifest[key];
  if (!e || e.kind !== "sprite") { cache.set(name, null); return null; }
  const img = await loadImage(join(ROOT, "build", e.url));
  const s = { img, frames: e.frames, w: e.w, h: e.h };
  cache.set(name, s);
  return s;
}
function tileAsset(n: string) { const i = n.indexOf("/"); return i < 0 ? n : `${n.slice(0, i).split("_")[0]}/${n.slice(i + 1)}`; }
const DIR = ["WalkDown", "WalkUp", "WalkLeft", "WalkRight"];

const mapIndex = MAP_NAMES.indexOf("Village00");
const sim = new GameSimulation(mapIndex, [
  { id: "human", slot: 0, character: 0, bot: false },
  { id: "bot1", slot: 1, character: 1, bot: true },
  { id: "bot2", slot: 2, character: 2, bot: true },
  { id: "bot3", slot: 3, character: 3, bot: true },
]);
const init = sim.initState();
// run until we catch an explosion with fire on screen
let snap = sim.snapshot();
for (let i = 0; i < 400; i++) {
  const dir = Math.floor(i / 15) % 4;
  sim.setInput("human", dir === 2 ? -1 : dir === 3 ? 1 : 0, dir === 0 ? 1 : dir === 1 ? -1 : 0, i % 50 === 0);
  sim.tick(50);
  snap = sim.snapshot();
  if (snap.explosions.length >= 3 && snap.bombs.length >= 1) break;
}

const cv = createCanvas(800, 600);
const ctx = cv.getContext("2d");
ctx.imageSmoothingEnabled = false;
const bg = await sprite("Game/CAStage");
if (bg) ctx.drawImage(bg.img, 0, 0, 800, 600);
else { ctx.fillStyle = "#203040"; ctx.fillRect(0, 0, 800, 600); }
const ox = Math.floor((800 - init.width * TILE) / 2);
const oy = Math.floor((600 - init.height * TILE) / 2);
// draw ground + objects from CURRENT sim cells (boxes already removed)
for (let y = 0; y < init.height; y++) for (let x = 0; x < init.width; x++) {
  const c = sim.cells[y * init.width + x]!;
  if (c.ground) { const s = await sprite(tileAsset(c.ground)); if (s) ctx.drawImage(s.img, s.frames[0].x, s.frames[0].y, s.frames[0].w, s.frames[0].h, ox + x * TILE, oy + y * TILE, TILE, TILE); }
  if (c.object) { const s = await sprite(tileAsset(c.object)); if (s) ctx.drawImage(s.img, s.frames[0].x, s.frames[0].y, s.frames[0].w, s.frames[0].h, ox + x * TILE, oy + y * TILE, TILE, TILE); }
}
for (const it of snap.items) { const s = await sprite(it.item); if (s) ctx.drawImage(s.img, s.frames[0].x, s.frames[0].y, s.frames[0].w, s.frames[0].h, ox + it.x * TILE + 6, oy + it.y * TILE + 6, 28, 28); }
const bomb = await sprite("Bomb/Bomb00");
for (const b of snap.bombs) if (bomb) ctx.drawImage(bomb.img, bomb.frames[0].x, bomb.frames[0].y, bomb.frames[0].w, bomb.frames[0].h, ox + b.x * TILE + 4, oy + b.y * TILE + 4, 32, 32);
const fire = await sprite("Bomb/Fire00");
for (const f of snap.explosions) if (fire && fire.frames[3]) ctx.drawImage(fire.img, fire.frames[3].x, fire.frames[3].y, fire.frames[3].w, fire.frames[3].h, ox + f.x * TILE, oy + f.y * TILE, TILE, TILE);
for (const b of [...snap.bombers].sort((a, b) => a.y - b.y)) {
  if (!b.alive) continue;
  const meta = init.players.find((p) => p.id === b.id)!;
  const s = await sprite(`Character/C${String(meta.character).padStart(2, "0")}-${DIR[b.dir]}_ALayerStatic`);
  if (s) { const fr = s.frames[0]; ctx.drawImage(s.img, fr.x, fr.y, fr.w, fr.h, ox + b.x + (TILE - fr.w) / 2, oy + b.y + TILE - fr.h, fr.w, fr.h); }
}
writeFileSync(join(ROOT, "build/game_preview.png"), await cv.encode("png"));
console.log(JSON.stringify({ map: init.map, frame: snap.frame, bombs: snap.bombs.length, fire: snap.explosions.length, items: snap.items.length, alive: snap.bombers.filter((b) => b.alive).length }));
console.log("GAME_PREVIEW_OK");
