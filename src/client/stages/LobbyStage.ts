/**
 * CLobbyStage — interim: ORIGINAL lobby background + dynamic room list from the
 * self-created server. Exact lobby UI (room slots, buttons from CA.exe) is
 * extracted next phase. No invented chrome.
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";
import type { RoomInfo } from "../../shared/protocol.ts";

export class LobbyStage extends Stage {
  private bg!: Sprite;
  private rooms: RoomInfo[] = [];
  private users = 0;

  override async enter(): Promise<void> {
    const a = this.ctx.assets;
    await a.preload(["Lobby/CAStage"]);
    this.bg = a.getCached("Lobby/CAStage")!;
    this.ctx.net.on("lobbyState", (m) => {
      if (m.t === "lobbyState") {
        this.rooms = m.rooms;
        this.users = m.users;
      }
    });
    this.ctx.net.send({ t: "enterLobby" });
  }

  override update(_dt: number): void {
    const p = this.ctx.input.beginFrame();
    // interim: click a room row to join
    this.rooms.forEach((rm, i) => {
      const y = 180 + i * 30;
      if (p.clicked && p.x >= 120 && p.x <= 680 && p.y >= y && p.y <= y + 26) {
        this.ctx.net.send({ t: "joinRoom", room: rm.id });
        this.ctx.changeStage("prepare", { room: rm.id });
      }
    });
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    const head = textSprite(`遊戲大廳  —  ${this.users} 人在線`, { size: 16, color: "#ffffff", bold: true });
    r.draw(head, { x: 120, y: 140, w: head.w, h: head.h });
    if (this.rooms.length === 0) {
      const t = textSprite("目前沒有房間（房間列表將於下一階段忠實還原）", { size: 13, color: "#ffffff" });
      r.draw(t, { x: 120, y: 180, w: t.w, h: t.h });
    }
    this.rooms.forEach((rm, i) => {
      const y = 180 + i * 30;
      const t = textSprite(`#${rm.id}  ${rm.title}  (${rm.players}/${rm.max})`, { size: 14, color: "#ffffff" });
      r.draw(t, { x: 130, y: y + 4, w: t.w, h: t.h });
    });
    r.end();
  }
}