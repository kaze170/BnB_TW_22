/** Headless preview of the REAL client stages using @napi-rs/canvas.
 * This validates asset mapping/layout without a browser; it is not a WebGPU test. */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Assets } from "../src/client/engine/assets.ts";
import { createRenderer } from "../src/client/engine/renderer.ts";
import { loadFonts } from "../src/client/ui/font.ts";
import type { Input } from "../src/client/engine/input.ts";
import type { NetClient } from "../src/client/net/client.ts";
import type { GameContext } from "../src/client/stages/stage.ts";
import { LoginStage } from "../src/client/stages/LoginStage.ts";
import { SelectServerStage } from "../src/client/stages/SelectServerStage.ts";
import { LobbyStage } from "../src/client/stages/LobbyStage.ts";
import { PrepareStage } from "../src/client/stages/PrepareStage.ts";
import { GameStage } from "../src/client/stages/GameStage.ts";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES, MAP_GROUPS } from "../src/server/gameData.ts";
import type { S2C, RoomState, ChannelInfo } from "../src/shared/protocol.ts";

const ROOT = join(import.meta.dir, "..");
// Local fetch shim: manifest/assets/fonts are served from the workspace.
const realFetch = globalThis.fetch;
let lastUrl = "";
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input); lastUrl = url;
  if (/^https?:/.test(url)) return realFetch(input, init);
  let path = url.startsWith("/") ? url.slice(1) : url;
  if (path.startsWith("fonts/")) path = path.slice("fonts/".length); // server maps /fonts/* to repo root
  const file = path === "manifest.json" ? join(ROOT, "build/manifest.json")
    : path.startsWith("assets/") ? join(ROOT, "build", path)
    : join(ROOT, path);
  return new Response(Bun.file(file));
};
(globalThis as any).document = { createElement: (tag: string) => { if (tag !== "canvas") throw new Error(`unsupported tag ${tag}`); return createCanvas(1, 1); } };
(globalThis as any).createImageBitmap = async (blob: Blob) => {
  const buf = Buffer.from(await blob.arrayBuffer());
  try { return await loadImage(buf); }
  catch (e) { console.error("loadImage failed", lastUrl, blob.size, blob.type, buf.subarray(0, 33)); throw e; }
};

class PreviewNet {
  handlers = new Map<string, Set<(m: S2C) => void>>();
  sent: any[] = [];
  user = { id: "human", nickname: "預覽玩家", character: 0, level: 1 };
  mapNames = MAP_NAMES;
  mapGroups = MAP_GROUPS;
  send(m: any) { this.sent.push(m); }
  on(type: string, h: (m: S2C) => void) { let s = this.handlers.get(type); if (!s) { s = new Set(); this.handlers.set(type, s); } s.add(h); return () => s!.delete(h); }
  emit(m: S2C) { this.handlers.get(m.t)?.forEach((h) => h(m)); }
}
const input = {
  keys: new Set<string>(), typed: "",
  beginFrame: () => ({ x: -1, y: -1, down: false, clicked: false, pressed: false }),
  endFrame() {}, justPressed: (_k: string) => false,
} as unknown as Input;

await loadFonts();
const assets = new Assets();
await assets.loadManifest();
const canvas = createCanvas(800, 600);
const renderer = await createRenderer(canvas as unknown as HTMLCanvasElement);
const net = new PreviewNet();
const ctx: GameContext = { assets, renderer, input, net: net as unknown as NetClient, changeStage: () => {} };

async function save(stage: { draw(): void }, name: string) {
  stage.draw();
  writeFileSync(join(ROOT, "build", name), await (canvas as any).encode("png"));
}

const login = new LoginStage(ctx); await login.enter(); await save(login, "login_preview.png");

const channels: ChannelInfo[] = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `頻道 ${i + 1}`, users: i === 0 ? 12 : i * 3 % 200, max: 200 }));
const select = new SelectServerStage(ctx); await select.enter({ server: 1 });
net.emit({ t: "serverList", servers: [{ id: 1, name: "爆爆王 1 區", online: 123 }, { id: 2, name: "爆爆王 2 區", online: 45 }] });
net.emit({ t: "channelList", channels });
await save(select, "channels_preview.png");

const lobby = new LobbyStage(ctx); await lobby.enter();
net.emit({ t: "lobbyState", users: 12, rooms: [
  { id: 1, title: "新手練習房", map: MAP_NAMES.indexOf("Village00"), mode: 0, players: 2, max: 8, state: "waiting" },
  { id: 2, title: "村莊激戰", map: MAP_NAMES.indexOf("Village05"), mode: 0, players: 8, max: 8, state: "playing" },
  { id: 3, title: "一起來玩", map: MAP_NAMES.indexOf("Village10"), mode: 14, players: 1, max: 8, state: "waiting" },
] });
await save(lobby, "lobby_preview.png");

const village = MAP_NAMES.indexOf("Village00");
const room: RoomState = {
  id: 1, title: "新手練習房", map: village, mode: 0, max: 8, hostId: "human", state: "waiting",
  players: [
    { id: "human", nickname: "預覽玩家", character: 0, slot: 0, ready: true, team: 0 },
    { id: "p2", nickname: "小藍", character: 1, slot: 1, ready: true, team: 0 },
    { id: "p3", nickname: "小紅", character: 2, slot: 2, ready: false, team: 0 },
    { id: "p4", nickname: "電腦", character: 3, slot: 3, ready: true, team: 0 },
  ],
};
const prepare = new PrepareStage(ctx); await prepare.enter({ room });
net.emit({ t: "roomState", room });
await save(prepare, "prepare_preview.png");

// Real simulation frame rendered by the real GameStage.
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
const sim = new GameSimulation(village, [
  { id: "human", slot: 0, character: 0, bot: false },
  { id: "bot1", slot: 1, character: 1, bot: true },
  { id: "bot2", slot: 2, character: 2, bot: true },
  { id: "bot3", slot: 3, character: 3, bot: true },
], rand);
const init = sim.initState();
let snap = sim.snapshot();
for (let i = 0; i < 800; i++) {
  const dir = Math.floor(i / 18) % 4;
  sim.setInput("human", dir === 2 ? -1 : dir === 3 ? 1 : 0, dir === 0 ? 1 : dir === 1 ? -1 : 0, i % 55 === 0);
  sim.tick(30);
  snap = sim.snapshot();
  if (snap.explosions.length >= 3 && snap.bombers.some((b) => b.id === "human" && b.alive)) break;
}
const game = new GameStage(ctx); await game.enter({ init });
net.emit({ t: "gameFrame", frame: snap.frame, state: snap });
game.update(30);
await save(game, "game_preview.png");
// second draw lets lazily requested item sprites appear
await save(game, "game_preview.png");
sim.winner = "human"; sim.draw = false; sim.over = true;
net.emit({ t: "gameEnd", result: sim.result() });
game.update(30);
await save(game, "game_result_preview.png");
// Verify the real GameStage defers its result overlay until the terminal
// server frame, while rendering the authoritative Die action on the field.
game.exit();
const death = new GameSimulation(village, [
  { id: "human", slot: 0, character: 0 }, { id: "p2", slot: 1, character: 1 },
], () => 0.5);
const survivor = death.bombers[0]!, victim = death.bombers[1]!;
// Place both characters in the open center of the original map for the preview.
survivor.tx = 5; survivor.ty = 5; survivor.x = 200; survivor.y = 200;
victim.tx = 7; victim.ty = 5; victim.x = 280; victim.y = 200;
const deathInit = death.initState();
const deathGame = new GameStage(ctx); await deathGame.enter({ init: deathInit });
death.bombs.push({ id: 999, x: victim.tx, y: victim.ty, owner: survivor.id, timer: 30, power: 1 });
death.tick(30);
let deathSnap = death.snapshot();
net.emit({ t: "gameFrame", frame: deathSnap.frame, state: deathSnap });
net.emit({ t: "gameEnd", result: death.result() });
if (!(deathGame as any).pendingResult || (deathGame as any).result) throw new Error("result was not deferred");
for (let i = 0; i < 5; i++) death.tick(30);
deathSnap = death.snapshot();
net.emit({ t: "gameFrame", frame: deathSnap.frame, state: deathSnap });
if (deathSnap.bombers.find((b) => b.id === "p2")?.action !== "die") throw new Error("expected Die");
if (deathSnap.bombers.find((b) => b.id === "p2")?.bubble?.frame !== 4) throw new Error("expected ExpKill frame 4");
await save(deathGame, "game_death_preview.png");
const withBubble = Buffer.from(canvas.getContext("2d").getImageData(0, 0, 800, 600).data);
const noBubble = { ...deathSnap, bombers: deathSnap.bombers.map((b) => ({ ...b, bubble: undefined })) };
net.emit({ t: "gameFrame", frame: noBubble.frame, state: noBubble });
deathGame.draw();
const withoutBubble = canvas.getContext("2d").getImageData(0, 0, 800, 600).data;
if (withBubble.equals(Buffer.from(withoutBubble))) throw new Error("bubble was not rendered");
while (death.presentationTicksLeft > 0) death.tick(30);
deathSnap = death.snapshot();
net.emit({ t: "gameFrame", frame: deathSnap.frame, state: deathSnap });
if (!(deathGame as any).result || (deathGame as any).pendingResult) throw new Error("result did not appear");
if (deathSnap.bombers.find((b) => b.id === "p2")?.action !== "hidden") throw new Error("expected hidden");
await save(deathGame, "game_death_result_preview.png");
deathGame.exit();
console.log("DEATH_PRESENTATION_OK");
console.log(JSON.stringify({ renderer: renderer.kind, map: init.map, frame: snap.frame, bombs: snap.bombs.length, fire: snap.explosions.length, items: snap.items.length, alive: snap.bombers.filter((b) => b.alive).length }));
console.log("UI_PREVIEW_OK");
