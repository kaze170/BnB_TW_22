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
import {
  BOMB_OBJECT, CHARACTER_WALK_GROUP, animationGroup, animationImageAtTicks,
} from "../../shared/animations.ts";
import type { GameInitState, GameSnapshot, GameResult, ResultRow } from "../../shared/protocol.ts";
import {
  RESULT_DIALOG_WIDTH, RESULT_ROW_Y0, RESULT_ROW_PITCH, RESULT_RANK_X,
  RESULT_PORTRAIT_X, RESULT_NAME_X, RESULT_BAR_X, RESULT_COL2_X, RESULT_AWARD_X,
  resultBarSegments, resultDialogHeight,
} from "../../shared/resultLayout.ts";

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

export class GameStage extends Stage {
  private init: GameInitState | null = null;
  private snap: GameSnapshot | null = null;
  private bg: Sprite | null = null;
  private tiles = new Map<string, Sprite>();
  private chars = new Map<number, Map<number, Sprite>>();
  /** Action I16 sheets keyed by ObjectTable asset (e.g. Character/C00-Throw_A). */
  private charActions = new Map<string, Sprite>();
  private portraits = new Map<number, Sprite>();
  private bomb: Sprite | null = null;
  private fireSprites = new Map<string, Sprite>();
  private fireRequests = new Set<string>();
  private itemSprites = new Map<string, Sprite>();
  private itemRequests = new Set<string>();
  private itemIcons: Sprite[] = [];
  private timerSpr: Sprite | null = null;
  private itemBox: Sprite | null = null;
  private resultSprites = new Map<string, Sprite>();
  private resultDlg: Sprite | null = null;
  private resultImg: Sprite | null = null;
  private resultInfoBar: Sprite | null = null;
  private exitBtn: Button | null = null;
  private okBtn: Button | null = null;
  private destroyedSet = new Set<number>();
  private result: GameResult | null = null;
  /** gameEnd arrives immediately, but the overlay waits for the authoritative
   * post-match action playback (snapshot.presentation) to finish. */
  private pendingResult: GameResult | null = null;
  private returnRequested = false;
  private offs: Array<() => void> = [];
  private sendAcc = 0;
  private lastInput = { dx: 0, dy: 0, bomb: false };
  private seq = 0;
  private offsetX = 20;
  private offsetY = 41;
  private moving = new Set<string>();
  private walkTicks = new Map<string, number>();
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
    // Flame/Flame ObjectTable groups reference Bomb/Fire00 (normal water-balloon
    // fire) and Bomb/TimebombFrame (special center). Both are original I16 assets.
    for (const asset of ["Bomb/Fire00", "Bomb/TimebombFrame"]) {
      const s = await a.sprite(asset);
      if (s) this.fireSprites.set(asset, s);
    }
    this.timerSpr = (await a.sprite("Game/Timer")) ?? null;
    this.itemBox = (await a.sprite("Game/ItemBox01")) ?? null;
    for (const key of ["Win", "Lose", "Draw"]) {
      const s = await a.sprite(`Game/${key}`);
      if (s) this.resultSprites.set(key, s);
    }
    this.resultDlg = (await a.sprite("Game/PatResultDlg")) ?? null;
    this.resultImg = (await a.sprite("Game/ResultImg")) ?? null;
    this.resultInfoBar = (await a.sprite("Game/ResultInfoBar")) ?? null;
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
      const delta = prev?.timeMs != null && m.state.timeMs != null
        ? Math.max(ORIGINAL_TICK_MS, m.state.timeMs - prev.timeMs)
        : ORIGINAL_TICK_MS;
      for (const b of m.state.bombers) {
        const old = prev?.bombers.find((x) => x.id === b.id);
        const moving = b.moving ?? Boolean(old && (old.x !== b.x || old.y !== b.y));
        if (moving) {
          this.moving.add(b.id);
          const dirChanged = Boolean(old && old.dir !== b.dir);
          this.walkTicks.set(b.id, dirChanged ? delta : (this.walkTicks.get(b.id) ?? 0) + delta);
        } else {
          this.walkTicks.set(b.id, 0);
        }
      }
      // The result report waits until the server finishes the authoritative
      // faint/die/ghost playback (presentation clears on the final frame).
      if (this.pendingResult && !m.state.presentation) {
        this.result = this.pendingResult;
        this.pendingResult = null;
      }
    }));
    this.offs.push(this.ctx.net.on("gameEnd", (m) => {
      if (m.t !== "gameEnd") return;
      if (this.snap?.presentation) this.pendingResult = m.result;
      else this.result = m.result;
    }));
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
      // CGOBomber action sheets: Throw/Die/Faint/Hurrah/Start/Ghost (ObjectTable).
      const prefix = `Character/C${String(ch).padStart(2, "0")}`;
      for (const suffix of ["Throw_A", "Die", "Faint", "Hurrah_A", "Start_A", "Ghost", "GhostInOut"]) {
        const asset = `${prefix}-${suffix}`;
        const s = await a.sprite(`${asset}LayerStatic`);
        if (s) this.charActions.set(asset, s);
      }
      const portrait = await a.sprite(`${prefix}-Portrait_ALayerStatic`);
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
      const bombAnim = animationGroup(BOMB_OBJECT, 0);
      for (const b of snap.bombs) {
        if (!this.bomb) continue;
        const elapsedTicks = Math.max(0, Math.floor((init.fuseMs - b.timer) / ORIGINAL_TICK_MS));
        const idx = animationImageAtTicks(bombAnim, elapsedTicks);
        const img = logicalImage(this.bomb, Math.min(idx, imageCount(this.bomb) - 1));
        if (!img) continue;
        const x = ox + b.x * TILE + TILE / 2 - img.src.w / 2 + img.dx;
        const y = oy + b.y * TILE + TILE - img.src.h + (img.dy - 40);
        r.draw(this.bomb, rect(x, y, img.src.w, img.src.h), { src: img.src });
      }
      for (const f of snap.explosions) {
        const asset = f.asset ?? "Bomb/Fire00";
        let spr = this.fireSprites.get(asset);
        if (!spr) {
          if (!this.fireRequests.has(asset)) {
            this.fireRequests.add(asset);
            void this.ctx.assets.sprite(asset).then((sp) => { if (sp) this.fireSprites.set(asset, sp); });
          }
          continue;
        }
        // CGOFlame draws logical image = segment tick counter; the ObjectTable
        // group already encodes direction, so no runtime flipping is needed.
        const idx = Math.min(f.frame ?? 0, imageCount(spr) - 1);
        const img = logicalImage(spr, idx);
        if (!img) continue;
        const x = ox + f.x * TILE + img.dx;
        const y = oy + f.y * TILE + TILE - img.src.h + (img.dy - 39);
        r.draw(spr, rect(x, y, img.src.w, img.src.h), { src: img.src });
      }
      const sorted = [...snap.bombers].sort((a, b) => a.y - b.y);
      for (const b of sorted) {
        // Dead bombers keep playing the server-driven faint/die/ghost sequence.
        if (!b.alive && !b.action) continue;
        const meta = init.players.find((p) => p.id === b.id);
        const ch = meta?.character ?? 0;
        const px = ox + b.x, py = oy + b.y;
        // Prefer the authoritative action sheet/frame; fall back to walk sprites.
        let anim: Sprite | undefined;
        let frame = 0;
        if (b.animAsset) {
          anim = this.charActions.get(b.animAsset);
          frame = b.animFrame ?? 0;
        }
        if (!anim) {
          anim = this.chars.get(ch)?.get(b.dir);
          const chName = `Character/C${String(ch).padStart(2, "0")}_A`;
          const walkGroup = animationGroup(chName, CHARACTER_WALK_GROUP[b.dir] ?? 23);
          frame = this.moving.has(b.id)
            ? animationImageAtTicks(walkGroup, this.walkTicks.get(b.id) ?? 0)
            : 0;
        }
        if (anim) {
          const count = imageCount(anim);
          const img = logicalImage(anim, Math.min(frame, count - 1));
          if (img && img.src.w > 0 && img.src.h > 0) {
            const baseDy = anim.images?.[0]?.dy ?? img.dy;
            const x = px + TILE / 2 - img.src.w / 2 + img.dx;
            const y = py + TILE - img.src.h + (img.dy - baseDy);
            // Ghost sheets are the original translucent-looking I16 art; no
            // extra client alpha is invented on top of them.
            r.draw(anim, rect(x, y, img.src.w, img.src.h), { src: img.src });
          }
        } else if (this.bomb && b.alive) {
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

  /** Original CGOGameResult report: PatResultDlg 9-slice, ResultInfoBar header,
   * 8 rows at y=51+25i, ResultImg rank/digits/bar/awards (sub_4548CD/454DAC/
   * 454A43/454B49/454E96). Stats/awards are supplied by the original server. */
  private drawResult(r: import("../engine/renderer.ts").Renderer) {
    const res = this.result!;
    const me = this.ctx.net.user?.id;
    const key = res.draw ? "Draw" : res.winner === me ? "Win" : "Lose";
    const banner = this.resultSprites.get(key);
    if (banner) drawLogical(r, banner, 0, 366, 18);

    const rows: ResultRow[] = res.rows?.length
      ? res.rows.slice(0, 8)
      : (this.init?.players ?? []).slice(0, 8).map((p, i) => ({
        id: p.id, slot: p.slot, character: p.character, bot: p.bot, alive: true,
        kills: 0, deaths: 0, boxes: 0, items: 0, score: 0, rank: i + 1,
      }));
    const w = RESULT_DIALOG_WIDTH;
    const h = resultDialogHeight(rows.length);
    const x = Math.floor((800 - w) / 2);
    const y = 92;
    if (this.resultDlg) this.draw9Slice(r, this.resultDlg, x, y, w, h);
    if (this.resultInfoBar) drawLogical(r, this.resultInfoBar, 0, x + RESULT_PORTRAIT_X, y + 20);

    const img = this.resultImg;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const ry = y + RESULT_ROW_Y0 + i * RESULT_ROW_PITCH;
      const self = row.id === me;
      if (img) {
        const rank = Math.max(0, Math.min(7, row.rank - 1));
        this.drawResultImage(r, img, 37 + rank, x + RESULT_RANK_X, ry);
      }
      const portrait = this.portraits.get(row.character);
      if (portrait) {
        const pi = logicalImage(portrait, 0);
        if (pi) r.draw(portrait, rect(x + RESULT_PORTRAIT_X, ry, 18, 18), { src: pi.src });
      }
      const name = self ? "你" : row.bot ? `電腦${row.slot + 1}` : row.id;
      drawText(r, name.slice(0, 8), x + RESULT_NAME_X, ry + 2, { color: self ? "#ffe08a" : row.alive ? "#ffffff" : "#8899aa" });
      if (img) {
        this.drawResultDigits(r, img, row.kills, x + 244, ry + 2, 2);
        this.drawResultDigits(r, img, 0, x + 300, ry + 2, 2); // 救援數 (no rescue mechanic in slice)
        this.drawResultBar(r, img, row.score, x + RESULT_BAR_X, ry - 1);
        this.drawResultDigits(r, img, row.items * 10, x + RESULT_COL2_X + 24, ry + 2, 3);
        if (row.award != null) this.drawResultImage(r, img, row.award, x + RESULT_AWARD_X, ry);
      }
    }
    const label = res.draw ? "平手" : res.winner === me ? "勝利" : "失敗";
    const secs = Math.floor((res.durationMs ?? 0) / 1000);
    drawTextCentered(r, `${label} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`, 400, y + h + 2, { color: "#ffffff" });
    if (this.okBtn) {
      this.okBtn.x = Math.floor((800 - this.okBtn.w) / 2);
      this.okBtn.y = y + h + 22;
      this.okBtn.draw(r);
    }
    drawTextCentered(r, "Enter 返回房間", 400, y + h + 62, { color: "#9fd8ff" });
  }

  private draw9Slice(r: import("../engine/renderer.ts").Renderer, spr: Sprite, x: number, y: number, w: number, h: number) {
    const s = 10;
    const iw = Math.max(0, w - s * 2), ih = Math.max(0, h - s * 2);
    const piece = (i: number, dx: number, dy: number, dw: number, dh: number) => {
      const img = logicalImage(spr, i);
      if (img && dw > 0 && dh > 0) r.draw(spr, rect(dx, dy, dw, dh), { src: img.src });
    };
    piece(0, x, y, s, s); piece(1, x + s, y, iw, s); piece(2, x + w - s, y, s, s);
    piece(3, x, y + s, s, ih); piece(4, x + s, y + s, iw, ih); piece(5, x + w - s, y + s, s, ih);
    piece(6, x, y + h - s, s, s); piece(7, x + s, y + h - s, iw, s); piece(8, x + w - s, y + h - s, s, s);
  }

  private drawResultImage(r: import("../engine/renderer.ts").Renderer, spr: Sprite, index: number, x: number, y: number) {
    const img = logicalImage(spr, index);
    if (!img) return;
    r.draw(spr, rect(x + img.dx, y + img.dy, img.src.w, img.src.h), { src: img.src });
  }

  private drawResultDigits(r: import("../engine/renderer.ts").Renderer, spr: Sprite, value: number, rightX: number, y: number, digits: number) {
    const text = String(Math.max(0, Math.floor(value))).padStart(digits, "0").slice(-digits);
    let cx = rightX - text.length * 8;
    for (const ch of text) {
      this.drawResultImage(r, spr, ch.charCodeAt(0) - 48, cx, y);
      cx += 8;
    }
  }

  private drawResultBar(r: import("../engine/renderer.ts").Renderer, spr: Sprite, value: number, x: number, y: number) {
    this.drawResultImage(r, spr, 45, x, y);
    for (const seg of resultBarSegments(value)) {
      const img = logicalImage(spr, seg.image);
      if (!img) continue;
      r.draw(spr, rect(x + seg.x + img.dx, y + img.dy, seg.w, img.src.h), { src: img.src });
    }
  }
}
