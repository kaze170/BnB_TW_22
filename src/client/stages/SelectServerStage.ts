/**
 * CSelectServerStage — interim: renders the ORIGINAL background and lists the
 * servers reported by the (self-created) server. Exact channel-button layout
 * (CH_Bt_Channel / CH_Tab_* positions from CA.exe) is extracted next phase.
 * No invented UI chrome: only the original background + dynamic server text.
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";
import type { ServerInfo } from "../../shared/protocol.ts";

export class SelectServerStage extends Stage {
  private bg!: Sprite;
  private servers: ServerInfo[] = [];
  private hover = -1;

  override async enter(): Promise<void> {
    const a = this.ctx.assets;
    await a.preload(["SelectServerStage/CAStage"]);
    this.bg = a.getCached("SelectServerStage/CAStage")!;
    this.ctx.net.on("serverList", (m) => {
      if (m.t === "serverList") this.servers = m.servers;
    });
    this.ctx.net.send({ t: "enterLobby" }); // request server list (server replies serverList)
  }

  override update(_dt: number): void {
    const p = this.ctx.input.beginFrame();
    this.hover = -1;
    this.servers.forEach((s, i) => {
      const y = 250 + i * 40;
      if (p.x >= 250 && p.x <= 550 && p.y >= y && p.y <= y + 32) {
        this.hover = i;
        if (p.clicked) {
          this.ctx.net.send({ t: "selectServer", server: s.id });
          this.ctx.changeStage("lobby", { server: s.id });
        }
      }
    });
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    const title = textSprite("選擇伺服器", { size: 20, color: "#ffffff", bold: true });
    r.draw(title, { x: 400 - title.w / 2, y: 200, w: title.w, h: title.h });
    this.servers.forEach((s, i) => {
      const y = 250 + i * 40;
      const label = textSprite(`${s.name}  (${s.online} 人在線)`, {
        size: 16,
        color: this.hover === i ? "#ffe08a" : "#ffffff",
      });
      r.draw(label, { x: 270, y: y + 6, w: label.w, h: label.h });
    });
    r.end();
  }
}