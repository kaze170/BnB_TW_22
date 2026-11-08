/**
 * CPrepareStage — original room/prepare screen.
 * Coordinates recovered from CA.exe sub_4D7376 / sub_4DB16C:
 *   normal slots x=27/133/239/345, y=94/239; Ready/Start (512,494);
 *   AutoReady (719,525); Selectmap (646,428); Roominfo (344,61).
 * Character portraits, ready/host badges, map dialog and buttons are original assets.
 */
import { Stage } from "./stage.ts";
import { logicalImage, type Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { Button } from "../ui/controls.ts";
import { drawLogical, drawText, drawTextCentered } from "../ui/draw.ts";
import type { RoomState } from "../../shared/protocol.ts";

const SLOT_X = [27, 133, 239, 345, 27, 133, 239, 345];
const SLOT_Y = [94, 94, 94, 94, 239, 239, 239, 239];
const CHAR_COUNT = 11;

export class PrepareStage extends Stage {
  private bg!: Sprite;
  private room: RoomState | null = null;
  private preImg!: Sprite;
  private startSpr!: Sprite;
  private readySpr!: Sprite;
  private checkSpr!: Sprite;
  private selectMapBtn!: Button;
  private roomInfoBtn!: Button;
  private actionBtn!: Button;
  private autoBtn!: Button;
  private autoReady = false;
  private charButtons: Button[] = [];
  private charSprites: Sprite[] = [];
  private slotSprites = new Map<number, Sprite>();
  private charPage = 0;
  private charLeft!: Button;
  private charRight!: Button;
  private status = "";
  private offs: Array<() => void> = [];
  // map selection dialog
  private mapDlg: Sprite | null = null;
  private okSpr!: Sprite;
  private cancelSpr!: Sprite;
  private mapOk!: Button;
  private mapCancel!: Button;
  private selectingMap = false;
  private mapScroll = 0;
  private pendingMap = 0;
  private roomInfoDlg: Sprite | null = null;
  private showRoomInfo = false;

  override async enter(params?: Record<string, unknown>): Promise<void> {
    this.room = (params?.room as RoomState) ?? null;
    const a = this.ctx.assets;
    await a.preload([
      "Prepare/CAStage", "Prepare/PRE_Img", "Prepare/PRE_Bt_Start", "Prepare/PRE_Bt_Ready",
      "Prepare/PRE_Bt_CheckBox", "Prepare/PRE_Bt_Selectmap", "Prepare/PRE_Bt_Roominfo",
      "Prepare/Dlg_PRE-SelMap", "Prepare/Dlg_PRE-NMRoominfo", "Etc/BtOk", "Etc/BtCancel",
      "SelectServerStage/CH_Bt_Left", "SelectServerStage/CH_Bt_Right", "Etc/Room_Num", "Prepare/PRE_SelChara",
    ]);
    this.bg = a.getCached("Prepare/CAStage")!;
    this.preImg = a.getCached("Prepare/PRE_Img")!;
    this.startSpr = a.getCached("Prepare/PRE_Bt_Start")!;
    this.readySpr = a.getCached("Prepare/PRE_Bt_Ready")!;
    this.checkSpr = a.getCached("Prepare/PRE_Bt_CheckBox")!;
    this.mapDlg = a.getCached("Prepare/Dlg_PRE-SelMap") ?? null;
    this.roomInfoDlg = a.getCached("Prepare/Dlg_PRE-NMRoominfo") ?? null;
    this.okSpr = a.getCached("Etc/BtOk")!;
    this.cancelSpr = a.getCached("Etc/BtCancel")!;
    this.actionBtn = new Button(this.startSpr, 512, 494, { onClick: () => this.onAction() });
    this.autoBtn = new Button(this.checkSpr, 719, 525, { onClick: () => { this.autoReady = !this.autoReady; } });
    this.selectMapBtn = new Button(a.getCached("Prepare/PRE_Bt_Selectmap")!, 646, 428, { onClick: () => this.openMapDialog() });
    this.roomInfoBtn = new Button(a.getCached("Prepare/PRE_Bt_Roominfo")!, 344, 61, { onClick: () => { this.showRoomInfo = true; } });
    this.mapOk = new Button(this.okSpr, 288, 494, { onClick: () => this.applyMap() });
    this.mapCancel = new Button(this.cancelSpr, 408, 494, { onClick: () => { this.selectingMap = false; } });
    this.charLeft = new Button(a.getCached("SelectServerStage/CH_Bt_Left")!, 640, 258, { onClick: () => { this.charPage = Math.max(0, this.charPage - 1); this.rebuildCharButtons(); } });
    this.charRight = new Button(a.getCached("SelectServerStage/CH_Bt_Right")!, 670, 258, { onClick: () => { this.charPage++; this.rebuildCharButtons(); } });
    for (let ch = 0; ch < CHAR_COUNT; ch++) {
      const spr = (await a.sprite(`Etc/SelChara${String(ch).padStart(2, "0")}`)) ?? a.getCached("Prepare/PRE_SelChara");
      if (spr) this.charSprites[ch] = spr;
      const portrait = await a.sprite(`Character/C${String(ch).padStart(2, "0")}-Start_ALayerStatic`);
      if (portrait) this.slotSprites.set(ch, portrait);
    }
    this.rebuildCharButtons();

    this.offs.push(this.ctx.net.on("roomState", (m) => {
      if (m.t !== "roomState") return;
      this.room = m.room;
      this.syncAction();
      const me = this.me();
      if (this.autoReady && me && me.id !== m.room.hostId && !me.ready && m.room.state === "waiting") {
        this.ctx.net.send({ t: "ready", ready: true });
      }
    }));
    this.offs.push(this.ctx.net.on("gameStart", (m) => {
      if (m.t === "gameStart") this.ctx.changeStage("game", { init: m.state });
    }));
    this.offs.push(this.ctx.net.on("error", (m) => { if (m.t === "error") this.status = m.message; }));
    this.syncAction();
  }

  private me() { return this.room?.players.find((p) => p.id === this.ctx.net.user?.id) ?? null; }
  private isHost() { return !!this.room && this.room.hostId === this.ctx.net.user?.id; }

  private syncAction() {
    if (!this.room) return;
    this.actionBtn.sprite = this.isHost() ? this.startSpr : this.readySpr;
    this.actionBtn.enabled = this.room.state === "waiting";
    this.selectMapBtn.enabled = this.isHost() && this.room.state === "waiting";
    this.roomInfoBtn.enabled = this.room.state === "waiting";
    this.autoBtn.visible = !this.isHost();
    const me = this.me();
    this.actionBtn.stateOverride = !this.isHost() && me?.ready ? 4 : null;
  }

  private onAction() {
    if (!this.room || this.room.state !== "waiting") return;
    if (this.isHost()) this.ctx.net.send({ t: "startGame" });
    else this.ctx.net.send({ t: "ready", ready: !this.me()?.ready });
  }

  private rebuildCharButtons() {
    this.charButtons = [];
    const start = this.charPage * 9;
    for (let i = 0; i < 9; i++) {
      const ch = start + i;
      const spr = this.charSprites[ch];
      if (!spr) continue;
      const x = 487 + (i % 3) * 102;
      const y = 66 + Math.floor(i / 3) * 66;
      const b = new Button(spr, x, y, { onClick: () => { this.ctx.net.send({ t: "selectCharacter", character: ch }); } });
      const me = this.me();
      b.stateOverride = me?.character === ch ? 3 : null;
      this.charButtons.push(b);
    }
    this.charLeft.enabled = this.charPage > 0;
    this.charRight.enabled = (this.charPage + 1) * 9 < CHAR_COUNT;
  }

  private openMapDialog() {
    if (!this.isHost()) return;
    this.selectingMap = true;
    this.pendingMap = this.room?.map ?? 0;
    this.mapScroll = Math.max(0, this.pendingMap - 10);
  }
  private applyMap() {
    this.ctx.net.send({ t: "setMap", map: this.pendingMap });
    this.selectingMap = false;
  }

  override exit(): void { for (const off of this.offs) off(); this.offs = []; }

  override update(_dtMs: number): void {
    const p = this.ctx.input.beginFrame();
    const inp = this.ctx.input;
    if (this.showRoomInfo) {
      if (p.clicked || inp.justPressed("Escape") || inp.justPressed("Enter")) this.showRoomInfo = false;
      inp.endFrame(); return;
    }
    if (this.selectingMap) {
      const names = this.ctx.net.mapNames;
      if (inp.justPressed("ArrowUp")) this.pendingMap = Math.max(0, this.pendingMap - 1);
      if (inp.justPressed("ArrowDown")) this.pendingMap = Math.min(names.length - 1, this.pendingMap + 1);
      if (inp.justPressed("PageUp")) this.pendingMap = Math.max(0, this.pendingMap - 20);
      if (inp.justPressed("PageDown")) this.pendingMap = Math.min(names.length - 1, this.pendingMap + 20);
      this.mapScroll = Math.max(0, Math.min(Math.max(0, names.length - 20), this.pendingMap - 10));
      // right-hand list rows: dialog (168,54), list starts local (196,92)
      if (p.clicked && p.x >= 364 && p.x < 616 && p.y >= 146 && p.y < 426) {
        const row = Math.floor((p.y - 146) / 14);
        const idx = this.mapScroll + row;
        if (idx < names.length) this.pendingMap = idx;
      }
      this.mapOk.update(p); this.mapCancel.update(p);
      if (inp.justPressed("Enter")) this.applyMap();
      if (inp.justPressed("Escape")) this.selectingMap = false;
      inp.endFrame(); return;
    }
    if (inp.justPressed("Escape")) { this.ctx.net.send({ t: "leaveRoom" }); this.ctx.changeStage("lobby"); inp.endFrame(); return; }
    if (inp.justPressed("Enter")) this.onAction();
    this.actionBtn.update(p); this.autoBtn.update(p); this.selectMapBtn.update(p); this.roomInfoBtn.update(p);
    this.charLeft.update(p); this.charRight.update(p);
    for (const b of this.charButtons) {
      b.enabled = this.room?.state === "waiting";
      b.update(p);
    }
    this.autoBtn.stateOverride = this.autoReady ? 1 : null;
    inp.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    const room = this.room;
    const titleSpr = drawText(r, room ? room.title : "房間準備", 32, 62, { color: "#ffffff", bold: true });
    if (room) {
      const num = this.ctx.assets.getCached("Etc/Room_Num");
      if (num) {
        let x = 32 + titleSpr.w + 10;
        for (const ch of String(room.id)) {
          const d = ch.charCodeAt(0) - 48;
          if (d >= 0 && d <= 9) { drawLogical(r, num, d, x, 62); x += num.images?.[d]?.w ?? 13; }
        }
      }
      for (const pl of room.players) {
        const slot = pl.slot;
        if (slot < 0 || slot >= 8) continue;
        const x = SLOT_X[slot]!, y = SLOT_Y[slot]!;
        const spr = this.slotSprites.get(pl.character);
        if (spr) {
          const img = logicalImage(spr, 0);
          if (img) r.draw(spr, rect(x + (98 - img.src.w) / 2, y + (98 - img.src.h) / 2, img.src.w, img.src.h), { src: img.src });
        }
        drawTextCentered(r, pl.nickname.slice(0, 8), x + 49, y + 102, { color: "#ffffff" });
        const badge = pl.id === room.hostId ? 2 : pl.ready ? 1 : 0;
        drawLogicalCenteredBadge(r, this.preImg, badge, x + 49, y + 122);
      }
      // character / team / map panel text
      const mapName = this.ctx.net.mapNames[room.map] ?? `Map ${room.map}`;
      drawText(r, mapName, 486, 352, { color: "#ffffff" });
      drawText(r, room.mode === 14 ? "對戰模式" : "一般模式", 486, 376, { color: "#9fd8ff" });
      drawText(r, `${room.players.length} / ${room.max}`, 486, 400, { color: "#9fd8ff" });
    }
    for (const b of this.charButtons) b.draw(r);
    this.charLeft.draw(r); this.charRight.draw(r);
    this.actionBtn.draw(r); this.autoBtn.draw(r); this.selectMapBtn.draw(r); this.roomInfoBtn.draw(r);
    if (!this.isHost()) drawText(r, "自動準備", 744, 528, { color: "#ffffff" });
    if (this.status) drawText(r, this.status, 28, 560, { color: "#ffe08a" });

    if (this.selectingMap && this.mapDlg) {
      r.draw(this.mapDlg, rect(168, 54, this.mapDlg.w, this.mapDlg.h));
      const names = this.ctx.net.mapNames;
      drawTextCentered(r, names[this.pendingMap] ?? "", 248, 150, { color: "#ffffff", bold: true });
      drawTextCentered(r, "地圖預覽", 248, 180, { color: "#9fd8ff" });
      for (let i = 0; i < 20; i++) {
        const idx = this.mapScroll + i;
        if (idx >= names.length) break;
        const y = 146 + i * 14;
        if (idx === this.pendingMap) drawText(r, "▶", 352, y, { color: "#ffe08a" });
        drawText(r, names[idx]!, 368, y, { color: idx === this.pendingMap ? "#ffe08a" : "#ffffff" });
      }
      drawText(r, `${this.mapScroll + 1}-${Math.min(names.length, this.mapScroll + 20)} / ${names.length}`, 190, 432, { color: "#9fd8ff" });
      this.mapOk.draw(r); this.mapCancel.draw(r);
    }
    if (this.showRoomInfo && this.roomInfoDlg && room) {
      const x = 193, y = 72;
      r.draw(this.roomInfoDlg, rect(x, y, this.roomInfoDlg.w, this.roomInfoDlg.h));
      drawTextCentered(r, room.title, x + 207, y + 60, { color: "#ffffff", bold: true });
      drawText(r, `房號: ${room.id}`, x + 60, y + 100, { color: "#ffffff" });
      drawText(r, `地圖: ${this.ctx.net.mapNames[room.map] ?? room.map}`, x + 60, y + 124, { color: "#ffffff" });
      drawText(r, `房主: ${room.hostId}`, x + 60, y + 148, { color: "#ffffff" });
      drawTextCentered(r, "點擊任意處關閉", x + 207, y + 400, { color: "#9fd8ff" });
    }
    r.end();
  }
}

function drawLogicalCenteredBadge(r: import("../engine/renderer.ts").Renderer, spr: Sprite, index: number, cx: number, y: number) {
  const img = logicalImage(spr, index);
  if (!img) return;
  r.draw(spr, rect(cx - img.src.w / 2, y, img.src.w, img.src.h), { src: img.src });
}
