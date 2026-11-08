/**
 * CGameStage — vertical slice: renders the decrypted ORIGINAL map (15x13,
 * 40px tiles), characters, bombs, fire and items; streams input to the
 * authoritative server. Tile asset paths map ObjectTable names
 * ("Tile00_Ground/Road00") to extracted files ("Tile00/Road00").
 */
import { Stage } from "./stage.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";
import type { GameInitState, GameSnapshot } from "../../shared/protocol.ts";

const TILE = 40;

function tileAsset(name: string): string {
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  const folder = name.slice(0, slash).split("_")[0]!;
  return `${folder}/${name.slice(slash + 1)}`;
}
const DIR_NAME = ["WalkDown", "WalkUp", "WalkLeft", "WalkRight"];

export class GameStage extends Stage {
  private init: GameInitState | null = null;
  private snap: GameSnapshot | null = null;
  private bg: Sprite | null = null;
  private tiles = new Map<string, Sprite>();
  private chars = new Map<number, Map<number, Sprite>>();
  private bomb: Sprite | null = null;
  private fire: Sprite | null = null;
  private itemSprites = new Map<string, Sprite>();
  private destroyedSet = new Set<number>();
  private result: string | null = null;
  private offs: Array<() => void> = [];
  private time = 0;
  private sendAcc = 0;
  private lastInput = { dx: 0, dy: 0, bomb: false };
  private seq = 0;
  private offsetX = 100;
  private offsetY = 40;

  override async enter(params?: Record<string, unknown>): Promise<void> {
    this.init = (params?.init as GameInitState) ?? null;
    const a = this.ctx.assets;
    this.bg = (await a.sprite("Game/CAStage")) ?? null;
    if (this.init) await this.loadMapAssets(this.init);
    this.bomb = (await a.sprite("Bomb/Bomb00")) ?? null;
    this.fire = (await a.sprite("Bomb/Fire00")) ?? null;
    this.offs.push(this.ctx.net.on("gameFrame", (m) => {
      if (m.t === "gameFrame") { this.snap = m.state; for (const i of m.state.destroyed) this.destroyedSet.add(i); }
    }));
    this.offs.push(this.ctx.net.on("gameEnd", (m) => {
      if (m.t === "gameEnd") this.result = m.result.draw ? "平手" : m.result.winner ? "勝利" : "結束";
    }));
    if (this.init) {
      this.offsetX = Math.floor((800 - this.init.width * TILE) / 2);
      this.offsetY = Math.floor((600 - this.init.height * TILE) / 2);
    }
  }

  private async loadMapAssets(init: GameInitState) {
    const a = this.ctx.assets;
    const names = new Set<string>();
    for (const c of init.cells) {
      if (c.ground) names.add(tileAsset(c.ground));
      if (c.object) names.add(tileAsset(c.object));
    }
    await Promise.all([...names].map(async (n) => {
      const s = await a.sprite(n);
      if (s) this.tiles.set(n, s);
    }));
    const chars = new Set(init.players.map((p) => p.character));
    await Promise.all([...chars].map(async (ch) => {
      const m = new Map<number, Sprite>();
      for (let d = 0; d < 4; d++) {
        const s = await a.sprite(`Character/C${String(ch).padStart(2, "0")}-${DIR_NAME[d]}_ALayerStatic`);
        if (s) m.set(d, s);
      }
      this.chars.set(ch, m);
    }));
  }

  override exit(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  override update(dt: number): void {
    this.time += dt;
    const inp = this.ctx.input;
    inp.beginFrame();
    let dx = 0, dy = 0;
    if (inp.keys.has("ArrowLeft")) dx = -1;
    else if (inp.keys.has("ArrowRight")) dx = 1;
    if (inp.keys.has("ArrowUp")) dy = -1;
    else if (inp.keys.has("ArrowDown")) dy = 1;
    const bomb = inp.keys.has(" ");
    this.sendAcc += dt;
    if (this.sendAcc >= 50 || dx !== this.lastInput.dx || dy !== this.lastInput.dy || bomb !== this.lastInput.bomb) {
      this.sendAcc = 0;
      this.lastInput = { dx, dy, bomb };
      this.ctx.net.send({ t: "gameInput", seq: this.seq++, dx, dy, bomb });
    }
    if (this.result && inp.justPressed("Enter")) {
      this.ctx.net.send({ t: "leaveRoom" });
      this.ctx.changeStage("lobby");
    }
    inp.endFrame();
  }

  private tileAt(x: number, y: number) {
    if (!this.init) return null;
    return this.init.cells[y * this.init.width + x] ?? null;
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    if (this.bg) r.draw(this.bg, rect(0, 0, 800, 600));
    const init = this.init;
    if (!init) {
      const t = textSprite("等待遊戲資料…", { size: 18, color: "#ffffff" });
      r.draw(t, { x: 320, y: 280, w: t.w, h: t.h });
      r.end();
      return;
    }
    const ox = this.offsetX, oy = this.offsetY;
    const destroyed = this.destroyedSet;
    // ground + objects
    for (let y = 0; y < init.height; y++) {
      for (let x = 0; x < init.width; x++) {
        const i = y * init.width + x;
        const c = init.cells[i]!;
        if (c.ground) {
          const g = this.tiles.get(tileAsset(c.ground));
          if (g) r.draw(g, rect(ox + x * TILE, oy + y * TILE, TILE, TILE));
        }
        if (c.object && !destroyed.has(i)) {
          const o = this.tiles.get(tileAsset(c.object));
          if (o) r.draw(o, rect(ox + x * TILE, oy + y * TILE, TILE, TILE));
        }
      }
    }
    const snap = this.snap;
    if (snap) {
      // items
      for (const it of snap.items) {
        let s = this.itemSprites.get(it.item);
        if (!s) {
          void this.ctx.assets.sprite(it.item).then((sp) => { if (sp) this.itemSprites.set(it.item, sp); });
        } else {
          r.draw(s, rect(ox + it.x * TILE + 6, oy + it.y * TILE + 6, TILE - 12, TILE - 12));
        }
      }
      // bombs
      for (const b of snap.bombs) {
        if (this.bomb) {
          const pulse = 1 + 0.08 * Math.sin(this.time / 120);
          const w = 32 * pulse;
          r.draw(this.bomb, rect(ox + b.x * TILE + (TILE - w) / 2, oy + b.y * TILE + (TILE - w) / 2, w, w));
        }
      }
      // fire
      for (const f of snap.explosions) {
        if (this.fire && this.fire.frames.length > 3) {
          r.draw(this.fire, rect(ox + f.x * TILE, oy + f.y * TILE, TILE, TILE), { src: this.fire.frames[3] });
        }
      }
      // characters sorted by y
      const players = init.players;
      const sorted = [...snap.bombers].sort((a, b) => a.y - b.y);
      for (const b of sorted) {
        if (!b.alive) continue;
        const meta = players.find((p) => p.id === b.id);
        const anim = this.chars.get(meta?.character ?? 0)?.get(b.dir);
        const px = ox + b.x, py = oy + b.y;
        if (anim) {
          const frame = anim.frames[Math.floor(this.time / 120) % anim.frames.length] ?? anim.frames[0]!;
          r.draw(anim, rect(px + (TILE - frame.w) / 2, py + TILE - frame.h, frame.w, frame.h), { src: frame });
        } else {
          // fallback marker
          if (this.bomb) r.draw(this.bomb, rect(px + 8, py + 8, 24, 24));
        }
      }
    }
    // HUD
    const me = this.ctx.net;
    void me;
    const hint = textSprite(this.result ? `${this.result} — Enter 回房間` : "方向鍵移動 · 空白鍵放炸彈", { size: 12, color: "#ffe08a" });
    r.draw(hint, { x: 12, y: 578, w: hint.w, h: hint.h });
    r.end();
  }
}
