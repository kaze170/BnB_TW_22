/**
 * CPrepareStage — interim: ORIGINAL room/prepare background + live room state
 * from the self-created server. Exact slot/UI layout from CA.exe next phase.
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";
import type { RoomState } from "../../shared/protocol.ts";

export class PrepareStage extends Stage {
  private bg!: Sprite;
  private room: RoomState | null = null;

  override async enter(): Promise<void> {
    const a = this.ctx.assets;
    await a.preload(["Prepare/CAStage"]);
    this.bg = a.getCached("Prepare/CAStage")!;
    this.ctx.net.on("roomState", (m) => {
      if (m.t === "roomState") this.room = m.room;
    });
    this.ctx.net.on("gameStart", (m) => {
      if (m.t === "gameStart") this.ctx.changeStage("game", { init: m.state });
    });
  }

  override update(_dt: number): void {
    const p = this.ctx.input.beginFrame();
    // interim: press Enter to ready, Space to start (host)
    if (this.ctx.input.justPressed("Enter")) this.ctx.net.send({ t: "ready", ready: true });
    if (this.ctx.input.justPressed(" ")) this.ctx.net.send({ t: "startGame" });
    void p;
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    const title = textSprite(this.room ? `房間：${this.room.title}` : "房間準備", {
      size: 18, color: "#ffffff", bold: true,
    });
    r.draw(title, { x: 60, y: 60, w: title.w, h: title.h });
    const players = this.room?.players ?? [];
    players.forEach((pl, i) => {
      const t = textSprite(`${pl.slot + 1}. ${pl.nickname} ${pl.ready ? "✔ 準備" : ""}`, { size: 14, color: "#ffffff" });
      r.draw(t, { x: 80, y: 120 + i * 28, w: t.w, h: t.h });
    });
    const hint = textSprite("Enter = 準備  ·  Space = 開始（遊戲對戰將於下一階段忠實還原）", { size: 12, color: "#ffe08a" });
    r.draw(hint, { x: 60, y: 540, w: hint.w, h: hint.h });
    r.end();
  }
}