/**
 * CSelectServerStage — original channel-selection screen.
 * Layout recovered from CA.exe sub_56DBA5 / sub_56D34E:
 *   tab (401,63); channel buttons x=428/595, y=218+56*row;
 *   page arrows (490,508)/(676,508); page numbers x=521+30*i, y=511.
 * Background and every control are extracted original assets.
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { Button } from "../ui/controls.ts";
import { drawLogical, drawText, drawTextCentered } from "../ui/draw.ts";
import type { ChannelInfo, ServerInfo } from "../../shared/protocol.ts";

const PAGE_SIZE = 10;

export class SelectServerStage extends Stage {
  private bg!: Sprite;
  private tab!: Sprite;
  private channelBtn!: Sprite;
  private numAtlas!: Sprite;
  private pageBg!: Sprite;
  private channels: ChannelInfo[] = [];
  private servers: ServerInfo[] = [];
  private buttons: Button[] = [];
  private left!: Button;
  private right!: Button;
  private page = 0;
  private server = 1;
  private offs: Array<() => void> = [];

  override async enter(params?: Record<string, unknown>): Promise<void> {
    this.server = Number(params?.server ?? 1);
    const a = this.ctx.assets;
    await a.preload([
      "SelectServerStage/CAStage", "SelectServerStage/CH_Tab_Free", "SelectServerStage/CH_Bt_Channel",
      "SelectServerStage/CH_Bt_Left", "SelectServerStage/CH_Bt_Right", "SelectServerStage/CH_Bt_ChNum",
      "SelectServerStage/CH_NuBg",
    ]);
    this.bg = a.getCached("SelectServerStage/CAStage")!;
    this.tab = a.getCached("SelectServerStage/CH_Tab_Free")!;
    this.channelBtn = a.getCached("SelectServerStage/CH_Bt_Channel")!;
    this.numAtlas = a.getCached("SelectServerStage/CH_Bt_ChNum")!;
    this.pageBg = a.getCached("SelectServerStage/CH_NuBg")!;
    this.left = new Button(a.getCached("SelectServerStage/CH_Bt_Left")!, 490, 508, { onClick: () => this.setPage(this.page - 1) });
    this.right = new Button(a.getCached("SelectServerStage/CH_Bt_Right")!, 676, 508, { onClick: () => this.setPage(this.page + 1) });
    // Page numbers use the original digit atlas + explicit 28×18 hit rects in
    // update(); CH_NuBg's logical states are not a five-button strip.
    this.rebuildChannels();
    this.offs.push(this.ctx.net.on("serverList", (m) => { if (m.t === "serverList") this.servers = m.servers; }));
    this.offs.push(this.ctx.net.on("channelList", (m) => {
      if (m.t === "channelList") { this.channels = m.channels; this.rebuildChannels(); }
    }));
    this.ctx.net.send({ t: "selectServer", server: this.server });
  }

  private rebuildChannels() {
    this.buttons = [];
    const start = this.page * PAGE_SIZE;
    for (let i = 0; i < PAGE_SIZE; i++) {
      const ch = this.channels[start + i];
      const x = i % 2 === 0 ? 428 : 595;
      const y = 218 + 56 * Math.floor(i / 2);
      const b = new Button(this.channelBtn, x, y, {
        onClick: () => {
          if (!ch) return;
          this.ctx.net.send({ t: "selectChannel", channel: start + i });
          this.ctx.changeStage("lobby", { channel: start + i });
        },
      });
      b.enabled = !!ch && ch.users < ch.max;
      this.buttons.push(b);
    }
  }

  private setPage(p: number) {
    const pages = Math.max(1, Math.ceil(this.channels.length / PAGE_SIZE));
    this.page = Math.max(0, Math.min(pages - 1, p));
    this.rebuildChannels();
  }

  override exit(): void { for (const off of this.offs) off(); this.offs = []; }

  override update(_dtMs: number): void {
    const p = this.ctx.input.beginFrame();
    this.left.enabled = this.page > 0;
    this.right.enabled = (this.page + 1) * PAGE_SIZE < this.channels.length;
    this.left.update(p); this.right.update(p);
    for (const b of this.buttons) b.update(p);
    // page number hit areas (28x18 original CH_NuBg canvas)
    const pages = Math.max(1, Math.ceil(this.channels.length / PAGE_SIZE));
    for (let i = 0; i < Math.min(5, pages); i++) {
      if (p.clicked && p.x >= 521 + 30 * i && p.x < 549 + 30 * i && p.y >= 511 && p.y < 529) this.setPage(i);
    }
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    drawLogical(r, this.tab, 3, 401, 63); // selected free-channel tab art
    const server = this.servers.find((s) => s.id === this.server);
    drawTextCentered(r, server?.name ?? "爆爆王", 594, 88, { color: "#ffffff", bold: true });
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i]!;
      b.draw(r);
      const ch = this.channels[this.page * PAGE_SIZE + i];
      if (!ch) continue;
      const x = i % 2 === 0 ? 428 : 595;
      const y = 218 + 56 * Math.floor(i / 2);
      drawTextCentered(r, ch.name, x + 80, y + 10, { color: ch.users >= ch.max ? "#8899aa" : "#ffffff" });
      drawTextCentered(r, `${ch.users} / ${ch.max}`, x + 80, y + 28, { color: "#9fd8ff" });
    }
    this.left.draw(r); this.right.draw(r);
    const pages = Math.max(1, Math.ceil(this.channels.length / PAGE_SIZE));
    for (let i = 0; i < Math.min(5, pages); i++) {
      const x = 521 + 30 * i;
      if (i === this.page) drawLogical(r, this.pageBg, 3, x, 511);
      drawLogical(r, this.numAtlas, i + 1, x + 8, 514);
    }
    r.end();
  }
}
