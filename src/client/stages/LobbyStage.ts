/**
 * CLobbyStage — original lobby chrome + live room list.
 * Coordinates recovered from CA.exe sub_4C99DC / sub_4C6D83 / sub_4C70F0:
 *   room slots (214/490, 121/205/289), room-info buttons (+242,+49),
 *   create/quick-join NM/MM (214/306/404/496,59), ShowAll (595,66),
 *   Practice (685,66), room-page arrows (431/494,376).
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect, rectContains } from "../engine/types.ts";
import { Button, Edit } from "../ui/controls.ts";
import { drawLogical, drawText, drawTextCentered } from "../ui/draw.ts";
import type { RoomInfo } from "../../shared/protocol.ts";

const SLOT_X = [214, 490, 214, 490, 214, 490];
const SLOT_Y = [121, 121, 205, 205, 289, 289];
const PAGE_SIZE = 6;

export class LobbyStage extends Stage {
  private bg!: Sprite;
  private slotSpr!: Sprite;
  private infoSpr!: Sprite;
  private rooms: RoomInfo[] = [];
  private users = 0;
  private page = 0;
  private showAll = true;
  private slotButtons: Button[] = [];
  private infoButtons: Button[] = [];
  private createNM!: Button;
  private createMM!: Button;
  private quickNM!: Button;
  private quickMM!: Button;
  private showAllBtn!: Button;
  private practiceBtn!: Button;
  private left!: Button;
  private right!: Button;
  private chatEdit!: Edit;
  private chatLog: Array<{ from: string; text: string }> = [];
  private status = "";
  private offs: Array<() => void> = [];
  // original create-room dialog
  private createDlg: Sprite | null = null;
  private okSpr!: Sprite;
  private cancelSpr!: Sprite;
  private titleEdit!: Edit;
  private okBtn!: Button;
  private cancelBtn!: Button;
  private creating = false;
  private createMode = 0;
  private selectedInfo: RoomInfo | null = null;
  private roomInfoDlg: Sprite | null = null;

  override async enter(): Promise<void> {
    const a = this.ctx.assets;
    await a.preload([
      "Lobby/CAStage", "Lobby/LB_Bt_SessionSlot", "Lobby/LB_Bt_RoomInfo",
      "Lobby/LB_Bt_T_Create-NM", "Lobby/LB_Bt_T_Create-MM", "Lobby/LB_Bt_T_QuickJoin-NM", "Lobby/LB_Bt_T_QuickJoin-MM",
      "Lobby/LB_Bt_T_ShowAll", "Lobby/LB_Bt_T_Practice", "Lobby/LB_Bt_Left01", "Lobby/LB_Bt_Right01",
      "Lobby/Dlg_LB-NMCreate", "Lobby/Dlg_LB-RoomInfo8", "Etc/BtOk", "Etc/BtCancel", "Etc/BtClose",
    ]);
    this.bg = a.getCached("Lobby/CAStage")!;
    this.slotSpr = a.getCached("Lobby/LB_Bt_SessionSlot")!;
    this.infoSpr = a.getCached("Lobby/LB_Bt_RoomInfo")!;
    this.createDlg = a.getCached("Lobby/Dlg_LB-NMCreate") ?? null;
    this.roomInfoDlg = a.getCached("Lobby/Dlg_LB-RoomInfo8") ?? null;
    this.okSpr = a.getCached("Etc/BtOk")!;
    this.cancelSpr = a.getCached("Etc/BtCancel")!;
    for (let i = 0; i < PAGE_SIZE; i++) {
      const x = SLOT_X[i]!, y = SLOT_Y[i]!;
      const slot = new Button(this.slotSpr, x, y, { onClick: () => this.joinVisible(i) });
      const info = new Button(this.infoSpr, x + 242, y + 49, { onClick: () => { this.selectedInfo = this.visibleRooms()[this.page * PAGE_SIZE + i] ?? null; } });
      this.slotButtons.push(slot); this.infoButtons.push(info);
    }
    this.createNM = new Button(a.getCached("Lobby/LB_Bt_T_Create-NM")!, 214, 59, { onClick: () => this.openCreate(0) });
    this.quickNM = new Button(a.getCached("Lobby/LB_Bt_T_QuickJoin-NM")!, 306, 59, { onClick: () => this.quickJoin(0) });
    this.createMM = new Button(a.getCached("Lobby/LB_Bt_T_Create-MM")!, 404, 59, { onClick: () => this.openCreate(14) });
    this.quickMM = new Button(a.getCached("Lobby/LB_Bt_T_QuickJoin-MM")!, 496, 59, { onClick: () => this.quickJoin(14) });
    this.showAllBtn = new Button(a.getCached("Lobby/LB_Bt_T_ShowAll")!, 595, 66, { onClick: () => { this.showAll = !this.showAll; this.page = 0; } });
    this.practiceBtn = new Button(a.getCached("Lobby/LB_Bt_T_Practice")!, 685, 66, { onClick: () => this.openCreate(0, true) });
    this.left = new Button(a.getCached("Lobby/LB_Bt_Left01")!, 431, 376, { onClick: () => { this.page = Math.max(0, this.page - 1); } });
    this.right = new Button(a.getCached("Lobby/LB_Bt_Right01")!, 494, 376, { onClick: () => { this.page++; } });
    this.chatEdit = new Edit(365, 532, 347, 16, false, { color: "#ffffff" });
    this.chatEdit.maxLength = 120;
    this.chatEdit.onSubmit = () => {
      const text = this.chatEdit.value.trim();
      if (text) { this.ctx.net.send({ t: "chat", text }); this.chatEdit.value = ""; }
    };
    this.titleEdit = new Edit(307, 145, 274, 20, false, { color: "#1a1a1a" });
    this.titleEdit.maxLength = 30;
    this.okBtn = new Button(this.okSpr, 288, 482, { onClick: () => this.doCreate() });
    this.cancelBtn = new Button(this.cancelSpr, 406, 482, { onClick: () => { this.creating = false; } });

    this.offs.push(this.ctx.net.on("lobbyState", (m) => {
      if (m.t === "lobbyState") { this.rooms = m.rooms; this.users = m.users; this.clampPage(); }
    }));
    this.offs.push(this.ctx.net.on("roomState", (m) => {
      if (m.t === "roomState") { this.creating = false; this.ctx.changeStage("prepare", { room: m.room }); }
    }));
    this.offs.push(this.ctx.net.on("chat", (m) => {
      if (m.t === "chat") { this.chatLog.push({ from: m.from, text: m.text }); if (this.chatLog.length > 6) this.chatLog.shift(); }
    }));
    this.offs.push(this.ctx.net.on("error", (m) => { if (m.t === "error") { this.status = m.message; this.creating = false; } }));
    this.ctx.net.send({ t: "enterLobby" });
  }

  private visibleRooms(): RoomInfo[] {
    return this.showAll ? this.rooms : this.rooms.filter((r) => r.state === "waiting" && r.players < r.max);
  }
  private clampPage() {
    const pages = Math.max(1, Math.ceil(this.visibleRooms().length / PAGE_SIZE));
    this.page = Math.max(0, Math.min(pages - 1, this.page));
  }
  private joinVisible(i: number) {
    const rm = this.visibleRooms()[this.page * PAGE_SIZE + i];
    if (rm && rm.state === "waiting" && rm.players < rm.max) this.ctx.net.send({ t: "joinRoom", room: rm.id });
  }
  private quickJoin(mode: number) {
    const rm = this.rooms.find((r) => r.mode === mode && r.state === "waiting" && r.players < r.max);
    if (rm) this.ctx.net.send({ t: "joinRoom", room: rm.id });
    else this.status = "目前沒有可加入的房間";
  }
  private openCreate(mode: number, practice = false) {
    this.creating = true; this.createMode = mode; this.status = "";
    this.titleEdit.value = practice ? "練習模式" : `${this.ctx.net.user?.nickname ?? "玩家"} 的房間`;
    this.titleEdit.focused = true;
  }
  private doCreate() {
    const names = this.ctx.net.mapNames;
    const map = Math.max(0, names.indexOf("Village00"));
    this.ctx.net.send({ t: "createRoom", title: this.titleEdit.value.trim() || "新房間", map, mode: this.createMode });
  }

  override exit(): void { for (const off of this.offs) off(); this.offs = []; }

  override update(dtMs: number): void {
    const p = this.ctx.input.beginFrame();
    const inp = this.ctx.input;
    if (this.selectedInfo) {
      if (p.clicked || inp.justPressed("Escape") || inp.justPressed("Enter")) this.selectedInfo = null;
      inp.endFrame(); return;
    }
    if (this.creating) {
      this.titleEdit.update(p, inp, dtMs);
      this.okBtn.update(p); this.cancelBtn.update(p);
      if (inp.justPressed("Escape")) this.creating = false;
      inp.endFrame(); return;
    }
    if (inp.justPressed("Escape")) { this.ctx.changeStage("selectServer"); inp.endFrame(); return; }
    this.chatEdit.update(p, inp, dtMs);
    const rooms = this.visibleRooms();
    const pages = Math.max(1, Math.ceil(rooms.length / PAGE_SIZE));
    this.left.enabled = this.page > 0;
    this.right.enabled = this.page < pages - 1;
    for (let i = 0; i < PAGE_SIZE; i++) {
      const rm = rooms[this.page * PAGE_SIZE + i];
      this.slotButtons[i]!.visible = !!rm;
      this.infoButtons[i]!.visible = !!rm;
      this.slotButtons[i]!.enabled = !!rm && rm.state === "waiting" && rm.players < rm.max;
      this.slotButtons[i]!.update(p); this.infoButtons[i]!.update(p);
    }
    for (const b of [this.createNM, this.quickNM, this.createMM, this.quickMM, this.showAllBtn, this.practiceBtn, this.left, this.right]) b.update(p);
    inp.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    drawText(r, `${this.ctx.net.user?.nickname ?? ""}  ·  ${this.users} 人在線`, 224, 8, { color: "#9fd8ff" });
    for (const b of [this.createNM, this.quickNM, this.createMM, this.quickMM, this.showAllBtn, this.practiceBtn, this.left, this.right]) b.draw(r);
    const rooms = this.visibleRooms();
    for (let i = 0; i < PAGE_SIZE; i++) {
      const rm = rooms[this.page * PAGE_SIZE + i];
      if (!rm) continue;
      const x = SLOT_X[i]!, y = SLOT_Y[i]!;
      this.slotButtons[i]!.draw(r); this.infoButtons[i]!.draw(r);
      drawText(r, rm.title.slice(0, 18), x + 66, y + 12, { color: "#ffffff" });
      const mapName = this.ctx.net.mapNames[rm.map] ?? `Map ${rm.map}`;
      drawText(r, mapName, x + 66, y + 30, { color: "#9fd8ff" });
      drawText(r, rm.state === "waiting" ? "等待中" : "遊戲中", x + 66, y + 48, { color: rm.state === "waiting" ? "#b8ffb8" : "#ffb0b0" });
      drawText(r, `${rm.players}/${rm.max}`, x + 204, y + 58, { color: "#ffffff" });
    }
    if (rooms.length === 0) drawTextCentered(r, "目前沒有房間，請開啟新局", 480, 220, { color: "#9fd8ff" });
    const pages = Math.max(1, Math.ceil(rooms.length / PAGE_SIZE));
    drawTextCentered(r, `${this.page + 1} / ${pages}`, 474, 380, { color: "#ffffff" });
    // chat
    let cy = 416;
    for (const line of this.chatLog) { drawText(r, `${line.from}: ${line.text}`.slice(0, 60), 224, cy, { color: "#ffffff" }); cy += 14; }
    this.chatEdit.draw(r);
    if (this.status) drawText(r, this.status, 224, 514, { color: "#ffe08a" });

    if (this.creating && this.createDlg) {
      r.draw(this.createDlg, rect(193, 72, this.createDlg.w, this.createDlg.h));
      this.titleEdit.draw(r);
      drawText(r, this.createMode === 14 ? "對戰模式" : "一般模式", 307, 176, { color: "#ffffff" });
      drawText(r, this.ctx.net.mapNames[Math.max(0, this.ctx.net.mapNames.indexOf("Village00"))] ?? "Village00", 307, 202, { color: "#ffffff" });
      this.okBtn.draw(r); this.cancelBtn.draw(r);
    }
    if (this.selectedInfo && this.roomInfoDlg) {
      const x = 248, y = 100;
      r.draw(this.roomInfoDlg, rect(x, y, this.roomInfoDlg.w, this.roomInfoDlg.h));
      drawTextCentered(r, this.selectedInfo.title, x + 151, y + 40, { color: "#ffffff", bold: true });
      drawText(r, `房號: ${this.selectedInfo.id}`, x + 40, y + 80, { color: "#ffffff" });
      drawText(r, `地圖: ${this.ctx.net.mapNames[this.selectedInfo.map] ?? this.selectedInfo.map}`, x + 40, y + 104, { color: "#ffffff" });
      drawText(r, `人數: ${this.selectedInfo.players} / ${this.selectedInfo.max}`, x + 40, y + 128, { color: "#ffffff" });
      drawText(r, `狀態: ${this.selectedInfo.state === "waiting" ? "等待中" : "遊戲中"}`, x + 40, y + 152, { color: "#ffffff" });
      drawTextCentered(r, "點擊任意處關閉", x + 151, y + 340, { color: "#9fd8ff" });
    }
    r.end();
  }
}
