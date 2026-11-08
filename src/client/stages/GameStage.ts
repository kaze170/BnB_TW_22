/**
 * CGameStage — renders the decrypted ORIGINAL map inside the recovered viewport,
 * streams input to the authoritative 30ms server, and draws the original HUD.
 * Map origin: sub_4E47B4 -> x = 40*(15-width)/2 + 20, y = 40*(13-height)/2 + 41.
 * Tile asset paths map ObjectTable names ("Tile00_Ground/Road00") to extracted
 * files ("Tile00/Road00"). Characters/bombs/fire/items use logical I16 images.
 */
import { Stage } from "./stage.ts";
import { imageCount, logicalImage, type Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { Button } from "../ui/controls.ts";
import { drawDigits, drawLogical, drawText, drawTextCentered } from "../ui/draw.ts";
import { ORIGINAL_TICK_MS } from "../../shared/timing.ts";
import type { GameInitState, GameSnapshot, GameResult } from "../../shared/protocol.ts";

const TILE = 40;
const DIR_NAME = ["WalkDown", "WalkUp", "WalkLeft", "WalkRight"];

export function mapOrigin(width: number, height: number): { x: number; y: number } {
  return { x: 40 * (15 - width) / 2 + 20, y: 40 * (13 - height) / 2 + 41 };
}

function tileAsset(name: string): string {
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  const folder = name.slice(0, slash).split("_")[0]!;
  return `${folder}/${name.slice(slash + 1)}`;
}

/** Provisional logical-image groups for Bomb/Fire00 (100 packed images).
 * The exact CGOFlame animation table is still being recovered; age is normalised
 * over the interim cell TTL so the original artwork animates instead of showing
 * a raw atlas page. */
function fireImageIndex(role: "center" | "arm" | "tip" | undefined, age: number, ttl: number): number {
  const base = role === "arm" ? 25 : role === "tip" ? 50 : 0;
  const life = Math.max(1, age + ttl);
  const t = Math.max(0, Math.min(0.999, age / life));
  return base + Math.floor(t * 25);
}

export class GameStage extends Stage {
  private init: GameInitState | null = null;
  private snap: GameSnapshot | null = null;
  private bg: Sprite | null = null;
  private tiles = new Map<string, Sprite>();
  private chars = new Map<number, Map<number, Sprite>>();
  private portraits = new Map<number, Sprite>();
  private bomb: Sprite | null = null;
  private fire: Sprite | null = null;
  private itemSprites = new Map<string, Sprite>();
  private itemRequests = new Set<string>();
  private itemIcons: Sprite[] = [];
  private timerSpr: Sprite | null = null;
  private itemBox: Sprite | null = null;
  private resultSprites = new Map<string, Sprite>();
  private exitBtn: Button | null = null;
  private okBtn: Button | null = null;
  private destroyedSet = new Set<number>();
  private result: GameResult | null = null;
  private returnRequested = false;
  private offs: Array<() => void> = [];
  private sendAcc = 0;
  private lastInput = { dx: 0, dy: 0, bomb: false };
  private seq = 0;
  private offsetX = 20;
  private offsetY = 41;
  private moving = new Set<string>();
  private status = "";

  override async enter(params?: Record<string, unknown>): Promise<void> {
    this.init = (params?.init as GameInitState) ?? null;
    const a = this.ctx.assets;
    this.bg = (await a.sprite("Game/CAStage")) ?? null;
    if (this.init) {
      const o = mapOrigin(this.init.width, this.init.height);
      this.offsetX = o.x; this.offsetY = o.y;
      await this.loadMapAssets(this.init);
    }
    this.bomb = (await a.sprite("Bomb/Bomb00")) ?? null;
    // Default Flame/Flame is absent from the extracted archives; Fire00 is the
    // available original water-balloon explosion artwork.
    this.fire = (await a.sprite("Bomb/Fire00")) ?? null;
    this.timerSpr = (await a.sprite("Game/Timer")) ?? null;
    this.itemBox = (await a.sprite("Game/ItemBox01")) ?? null;
    for (const key of ["Win", "Lose", "Draw"]) {
      const s = await a.sprite(`Game/${key}`);
      if (s) this.resultSprites.set(key, s);
    }
    for (const key of ["Item/Bomb", "Item/MaxPower", "Item/Skate"]) {
      const s = await a.sprite(key);
      if (s) this.itemIcons.push(s);
    }
    const exit = await a.sprite("Game/BtExit");
    if (exit) this.exitBtn = new Button(exit, 647, 561, { onClick: () => this.leave() });
    const ok = await a.sprite("Etc/BtOk");
    if (ok) this.okBtn = new Button(ok, 349, 380, { onClick: () => this.returnToRoom() });

    this.offs.push(this.ctx.net.on("gameFrame", (m) => {
      if (m.t !== "gameFrame") return;
      const prev = this.snap;
      this.snap = m.state;
      for (const i of m.state.destroyed) this.destroyedSet.add(i);
      this.moving.clear();
      for (const b of m.state.bombers) {
        const old = prev?.bombers.find((x) => x.id === b.id);
        if (old && (old.x !== b.x || old.y !== b.y)) this.moving.add(b.id);
      }
    }));
    this.offs.push(this.ctx.net.on("gameEnd", (m) => { if (m.t === "gameEnd") this.result = m.result; }));
    this.offs.push(this.ctx.net.on("roomState", (m) => {
      if (m.t === "roomState" && this.returnRequested && m.room.state !== "playing") {
        this.ctx.changeStage("prepare", { room: m.room });
      }
    }));
    this.offs.push(this.ctx.net.on("error", (m) => { if (m.t === "error") this.status = m.message; }));
  }

  private async loadMapAssets(init: GameInitState) {
    const a = this.ctx.assets;
    const names = new Set<string>();
    for (const c of init.cells) {
      if (c.ground) names.add(tileAsset(c.ground));
      if (c.object) names.add(tileAsset(c.object));
    }
    await Promise.all([...names].map(async (n) => { const s = await a.sprite(n); if (s) this.tiles.set(n, s); }));
    const chars = new Set(init.players.map((p) => p.character));
    await Promise.all([...chars].map(async (ch) => {
      const m = new Map<number, Sprite>();
      for (let d = 0; d < 4; d++) {
        const s = await a.sprite(`Character/C${String(ch).padStart(2, "0")}-${DIR_NAME[d]}_ALayerStatic`);
        if (s) m.set(d, s);
      }
      this.chars.set(ch, m);
      const portrait = await a.sprite(`Character/C${String(ch).padStart(2, "0")}-Portrait_ALayerStatic`);
      if (portrait) this.portraits.set(ch, portrait);
    }));
  }

  private leave() { this.ctx.net.send({ t: "leaveRoom" }); this.ctx.changeStage("lobby"); }
  private returnToRoom() {
    if (this.returnRequested) return;
    this.returnRequested = true;
    this.ctx.net.send({ t: "returnToRoom" });
  }

  override exit(): void { for (const off of this.offs) off(); this.offs = []; }

  override update(dtMs: number): void {
    const inp = this.ctx.input;
    const p = inp.beginFrame();
    if (this.result) {
      this.okBtn?.update(p);
      this.exitBtn?.update(p);
      if (inp.justPressed("Enter")) this.returnToRoom();
      if (inp.justPressed("Escape")) this.leave();
      inp.endFrame(); return;
    }
    let dx = 0, dy = 0;
    if (inp.keys.has("ArrowLeft") || inp.keys.has("a")) dx = -1;
    else if (inp.keys.has("ArrowRight") || inp.keys.has("d")) dx = 1;
    if (inp.keys.has("ArrowUp") || inp.keys.has("w")) dy = -1;
    else if (inp.keys.has("ArrowDown") || inp.keys.has("s")) dy = 1;
    const bomb = inp.keys.has(" ") || inp.keys.has("Control");
    this.sendAcc += dtMs;
    if (this.sendAcc >= ORIGINAL_TICK_MS || dx !== this.lastInput.dx || dy !== this.lastInput.dy || bomb !== this.lastInput.bomb) {
      this.sendAcc = 0;
      this.lastInput = { dx, dy, bomb };
      this.ctx.net.send({ t: "gameInput", seq: this.seq++, dx, dy, bomb });
    }
    this.exitBtn?.update(p);
    if (inp.justPressed("Escape")) this.leave();
    inp.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    if (this.bg) r.draw(this.bg, rect(0, 0, 800, 600));
    const init = this.init;
    if (!init) {
      drawTextCentered(r, "等待遊戲資料…", 400, 280, { color: "#ffffff" });
      r.end(); return;
    }
    const ox = this.offsetX, oy = this.offsetY;
    const destroyed = this.destroyedSet;
    for (let y = 0; y < init.height; y++) {
      for (let x = 0; x < init.width; x++) {
        const i = y * init.width + x;
        const c = init.cells[i]!;
        const px = ox + x * TILE, py = oy + y * TILE;
        if (c.ground) {
          const g = this.tiles.get(tileAsset(c.ground));
          if (g) this.drawTile(r, g, px, py);
        }
        if (c.object && !destroyed.has(i)) {
          const o = this.tiles.get(tileAsset(c.object));
          if (o) this.drawTile(r, o, px, py);
        }
      }
    }
    const snap = this.snap;
    const timeMs = snap?.timeMs ?? (snap?.frame ?? 0) * ORIGINAL_TICK_MS;
    if (snap) {
      for (const it of snap.items) {
        let s = this.itemSprites.get(it.item);
        if (!s) {
          if (!this.itemRequests.has(it.item)) {
            this.itemRequests.add(it.item);
            void this.ctx.assets.sprite(it.item).then((sp) => { if (sp) this.itemSprites.set(it.item, sp); });
          }
        } else {
          const img = logicalImage(s, 0);
          if (img) {
            const x = ox + it.x * TILE + TILE / 2 - img.src.w / 2 + img.dx;
            const y = oy + it.y * TILE + TILE - img.src.h;
            r.draw(s, rect(x, y, img.src.w, img.src.h), { src: img.src });
          }
        }
      }
      for (const b of snap.bombs) {
        if (!this.bomb) continue;
        const elapsed = Math.max(0, init.fuseMs - b.timer);
        const idx = Math.floor(elapsed / 150) % imageCount(this.bomb);
        const img = logicalImage(this.bomb, idx);
        if (!img) continue;
        const x = ox + b.x * TILE + TILE / 2 - img.src.w / 2 + img.dx;
        const y = oy + b.y * TILE + TILE - img.src.h + (img.dy - 40);
        r.draw(this.bomb, rect(x, y, img.src.w, img.src.h), { src: img.src });
      }
      for (const f of snap.explosions) {
        if (!this.fire) continue;
        const idx = fireImageIndex(f.role, f.age ?? 0, f.ttl);
        const img = logicalImage(this.fire, Math.min(idx, imageCount(this.fire) - 1));
        if (!img) continue;
        const x = ox + f.x * TILE + img.dx;
        const y = oy + f.y * TILE + TILE - img.src.h + (img.dy - 39);
        r.draw(this.fire, rect(x, y, img.src.w, img.src.h), { src: img.src, flipX: f.dir === 2, flipY: f.dir === 1 });
      }
      const sorted = [...snap.bombers].sort((a, b) => a.y - b.y);
      for (const b of sorted) {
        if (!b.alive) continue;
        const meta = init.players.find((p) => p.id === b.id);
        const anim = this.chars.get(meta?.character ?? 0)?.get(b.dir);
        const px = ox + b.x, py = oy + b.y;
        if (anim) {
          const count = imageCount(anim);
          const frame = this.moving.has(b.id) ? Math.floor(timeMs / 120) % count : 0;
          const img = logicalImage(anim, frame);
          if (img) {
            const baseDy = anim.images?.[0]?.dy ?? img.dy;
            const x = px + TILE / 2 - img.src.w / 2 + img.dx;
            const y = py + TILE - img.src.h + (img.dy - baseDy);
            r.draw(anim, rect(x, y, img.src.w, img.src.h), { src: img.src });
          }
        } else if (this.bomb) {
          drawLogical(r, this.bomb, 0, px, py);
        }
      }
    }
    this.drawHud(r, init, snap, timeMs);
    if (this.result) this.drawResult(r);
    this.exitBtn?.draw(r);
    r.end();
  }

  /** Map tiles use the exe's pivot formula (sub_4E47B4), not the UI dx/dy offset:
   * x = cellX - pivotX, y = cellY - pivotY + 39. */
  private drawTile(r: import("../engine/renderer.ts").Renderer, spr: Sprite, px: number, py: number) {
    const img = logicalImage(spr, 0);
    const info = spr.images?.[0];
    if (!img || img.src.w <= 0 || img.src.h <= 0) return;
    const x = px - (info?.pivotX ?? 0);
    const y = py - (info?.pivotY ?? 0) + 39;
    r.draw(spr, rect(x, y, img.src.w, img.src.h), { src: img.src });
  }

  private drawHud(r: import("../engine/renderer.ts").Renderer, init: GameInitState, snap: GameSnapshot | null, timeMs: number) {
    // The background already labels the timer; draw elapsed mm:ss with the original digits.
    if (this.timerSpr) {
      const sec = Math.floor(timeMs / 1000);
      const ss = sec % 60;
      drawDigits(r, this.timerSpr, Math.floor(sec / 60), 718, 78);
      drawText(r, ":", 734, 78, { color: "#ffffff" });
      drawDigits(r, this.timerSpr, Math.floor(ss / 10), 744, 78);
      drawDigits(r, this.timerSpr, ss % 10, 758, 78);
    }
    const meId = this.ctx.net.user?.id;
    for (const p of init.players) {
      const slot = p.slot;
      if (slot < 0 || slot >= 8) continue;
      const y = 100 + slot * 41;
      const b = snap?.bombers.find((x) => x.id === p.id);
      const alive = b?.alive ?? true;
      const portrait = this.portraits.get(p.character);
      if (portrait) drawLogical(r, portrait, 0, 656, y + 8, alive ? 1 : 0.35);
      const name = p.id === meId ? "你" : p.bot ? `電腦${slot + 1}` : p.id;
      drawText(r, name.slice(0, 6), 684, y + 4, { color: alive ? (p.id === meId ? "#ffe08a" : "#ffffff") : "#778899" });
      if (b) drawText(r, `炸${b.bombCount} 力${b.power} 速${b.speed}`, 684, y + 18, { color: alive ? "#9fd8ff" : "#556677" });
    }
    // The background supplies the "項目" label; GameStageItem's 337px banner is
    // for the full results UI, so only the original item box is overlaid here.
    if (this.itemBox) drawLogical(r, this.itemBox, 0, 647, 466);
    const me = snap?.bombers.find((b) => b.id === meId);
    if (me) {
      const vals = [me.bombCount, me.power, me.speed];
      for (let i = 0; i < this.itemIcons.length; i++) {
        const s = this.itemIcons[i]!;
        const img = logicalImage(s, 0);
        if (img) r.draw(s, rect(660 + i * 42, 488, 24, 24), { src: img.src });
        drawTextCentered(r, String(vals[i] ?? 0), 672 + i * 42, 516, { color: "#ffffff" });
      }
    }
    drawText(r, "方向鍵移動 · 空白鍵放水球 · Esc 離開", 25, 578, { color: "#ffe08a" });
    if (this.status) drawText(r, this.status, 25, 562, { color: "#ffb0b0" });
  }

  private drawResult(r: import("../engine/renderer.ts").Renderer) {
    const res = this.result!;
    const me = this.ctx.net.user?.id;
    const key = res.draw ? "Draw" : res.winner === me ? "Win" : "Lose";
    const spr = this.resultSprites.get(key);
    if (spr) drawLogical(r, spr, 0, 286, 220);
    const label = res.draw ? "平手" : res.winner === me ? "勝利" : "失敗";
    drawTextCentered(r, label, 320, 300, { color: "#ffffff", bold: true });
    if (res.winner) drawTextCentered(r, `贏家：${res.winner}`, 320, 324, { color: "#ffe08a" });
    drawTextCentered(r, "Enter 返回房間", 320, 352, { color: "#9fd8ff" });
    this.okBtn?.draw(r);
  }
}
