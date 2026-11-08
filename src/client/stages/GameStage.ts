/**
 * CGameStage — interim scaffold. The full faithful gameplay (40px tile map,
 * CGOBomber movement, bomb fuse/explosion chain, items, monster AI) is the next
 * major phase, ported function-by-function from CA.exe. This renders the ORIGINAL
 * game background + the server-provided initial map so the flow is complete.
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";
import type { GameInitState } from "../../shared/protocol.ts";

export class GameStage extends Stage {
  private bg!: Sprite;
  private init: GameInitState | null = null;

  override async enter(params?: Record<string, unknown>): Promise<void> {
    this.init = (params?.init as GameInitState) ?? null;
    const a = this.ctx.assets;
    await a.preload(["Game/CAStage"]);
    this.bg = a.getCached("Game/CAStage")!;
  }

  override update(_dt: number): void {
    this.ctx.input.beginFrame();
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    const t = textSprite("遊戲對戰（完整玩法還原中）", { size: 20, color: "#ffffff", bold: true });
    r.draw(t, { x: 400 - t.w / 2, y: 280, w: t.w, h: t.h });
    if (this.init) {
      const info = textSprite(`地圖 ${this.init.width}×${this.init.height}  ·  ${this.init.players.length} 位玩家`, {
        size: 14, color: "#ffe08a",
      });
      r.draw(info, { x: 400 - info.w / 2, y: 320, w: info.w, h: info.h });
    }
    r.end();
  }
}