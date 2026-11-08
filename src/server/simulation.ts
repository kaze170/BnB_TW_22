/**
 * Game simulation for the vertical slice. The SERVER is original (project
 * decision), but it consumes the decrypted ORIGINAL data: 15x13 maps, tile
 * types, character stats, item drop weights. Core constants recovered from
 * CA.exe: TILE=40, fixed update step=30ms (CGameStage::sub_4F5658), practice
 * fuse=2000ms (sub_4E87D8). Movement is grid-locked like CGOBomber; fire-cell
 * TTL currently uses the 300ms effect-scheduling base as an interim value.
 */
import type { GameInitState, GameSnapshot, MapCell, BomberState } from "../shared/protocol.ts";
import {
  MAPS, ITEMS, TILE, EXPLOSION_MS, FUSE_MS, MAP_NAMES,
  tileName, tileType, charStats, rollItem, itemType,
} from "./gameData.ts";
import { ORIGINAL_TICK_MS } from "../shared/timing.ts";

export interface SimPlayer {
  id: string; slot: number; character: number; bot: boolean;
  x: number; y: number;           // pixel position (tile top-left)
  tx: number; ty: number;         // current tile
  gx: number; gy: number;         // target tile while moving
  moving: boolean;
  dir: number;                    // 0 down, 1 up, 2 left, 3 right
  alive: boolean;
  speed: number; bombCount: number; power: number;
  speedCap: number; bombCap: number; powerCap: number;
  baseSpeed: number;
  input: { dx: number; dy: number; bomb: boolean };
  bombLatch: boolean;
  aiTimer: number;
}
interface Bomb { id: number; x: number; y: number; owner: string; timer: number; power: number; }
interface Fire { x: number; y: number; ttl: number; age: number; role: "center" | "arm" | "tip"; dir: number; }
interface Item { id: number; x: number; y: number; item: string; asset: string; }

const DIRS = [[0, 1], [0, -1], [-1, 0], [1, 0]]; // down, up, left, right

export class GameSimulation {
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  cells: MapCell[];
  bombers: SimPlayer[] = [];
  bombs: Bomb[] = [];
  fires: Fire[] = [];
  items: Item[] = [];
  frame = 0;
  over = false;
  winner: string | null = null;
  draw = false;
  private nextId = 1;
  private destroyed: number[] = [];
  private mapDrops: Array<{ name: string; weight: number }>;
  private rand: () => number;

  constructor(mapIndex: number, players: Array<{ id: string; slot: number; character: number; bot?: boolean }>, rand: () => number = Math.random) {
    this.rand = rand;
    this.mapName = MAP_NAMES[((mapIndex % MAP_NAMES.length) + MAP_NAMES.length) % MAP_NAMES.length]!;
    const m = MAPS[this.mapName]!;
    this.width = m.width;
    this.height = m.height;
    this.mapDrops = m.drops;
    this.cells = m.grid.map(([g, o]) => {
      const ground = tileName(g!);
      const object = tileName(o!);
      const kind = object ? tileType(object) : tileType(ground);
      return { ground, object, kind };
    });
    const spawns = m.spawns.length ? m.spawns : [[1, 1]];
    players.forEach((p, i) => {
      const sp = spawns[i % spawns.length]!;
      const st = charStats(p.character);
      this.bombers.push({
        id: p.id, slot: p.slot, character: p.character, bot: p.bot ?? false,
        x: sp[0]! * TILE, y: sp[1]! * TILE, tx: sp[0]!, ty: sp[1]!, gx: sp[0]!, gy: sp[1]!,
        moving: false, dir: 0, alive: true,
        speed: st.speed, bombCount: st.bombCount, power: st.power,
        speedCap: st.speedCap, bombCap: st.bombCap, powerCap: st.powerCap, baseSpeed: st.speed,
        input: { dx: 0, dy: 0, bomb: false }, bombLatch: false, aiTimer: 0,
      });
    });
  }

  initState(): GameInitState {
    return {
      map: this.mapName, width: this.width, height: this.height,
      cells: this.cells.map((c) => ({ ...c })),
      players: this.bombers.map((b) => ({
        id: b.id, slot: b.slot, character: b.character, x: b.x, y: b.y,
        speed: b.speed, bombCount: b.bombCount, power: b.power, bot: b.bot,
      })),
      fuseMs: FUSE_MS, explosionMs: EXPLOSION_MS,
    };
  }

  setInput(id: string, dx: number, dy: number, bomb: boolean) {
    const b = this.bombers.find((x) => x.id === id);
    if (b && !b.bot) b.input = { dx: Math.sign(dx), dy: Math.sign(dy), bomb };
  }

  /** A disconnect/leave eliminates the bomber but keeps the match authoritative. */
  removePlayer(id: string) {
    const b = this.bombers.find((x) => x.id === id);
    if (b) {
      b.alive = false;
      b.input = { dx: 0, dy: 0, bomb: false };
    }
  }

  private idx(x: number, y: number) { return y * this.width + x; }
  private inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  private walkable(x: number, y: number, who?: SimPlayer): boolean {
    if (!this.inBounds(x, y)) return false;
    const k = this.cells[this.idx(x, y)]!.kind;
    if (k === 1 || k === 2) return false;
    // bombs block once the owner has left the cell
    for (const bomb of this.bombs) {
      if (bomb.x === x && bomb.y === y) {
        const owner = this.bombers.find((b) => b.id === bomb.owner);
        if (!owner || owner.tx !== x || owner.ty !== y) return false;
        if (who && who.id !== bomb.owner) return false;
      }
    }
    return true;
  }
  private bombAt(x: number, y: number) { return this.bombs.find((b) => b.x === x && b.y === y); }
  private fireAt(x: number, y: number) { return this.fires.some((f) => f.x === x && f.y === y); }

  tick(dtMs: number) {
    if (this.over) return;
    this.frame++;
    this.destroyed = [];
    for (const b of this.bombers) if (b.alive && b.bot) this.botThink(b, dtMs);
    for (const b of this.bombers) if (b.alive) this.move(b, dtMs);
    for (const b of this.bombers) if (b.alive) this.pickup(b);
    for (const b of this.bombers) if (b.alive) this.tryBomb(b);
    // bomb timers
    const explode: Bomb[] = [];
    for (const bomb of this.bombs) {
      bomb.timer -= dtMs;
      if (bomb.timer <= 0) explode.push(bomb);
    }
    for (const bomb of explode) this.explode(bomb);
    // fire damage + ttl
    for (const b of this.bombers) {
      if (b.alive && this.fireAt(b.tx, b.ty)) b.alive = false;
    }
    for (const f of this.fires) { f.ttl -= dtMs; f.age += dtMs; }
    this.fires = this.fires.filter((f) => f.ttl > 0);
    // win check
    const alive = this.bombers.filter((b) => b.alive);
    if (alive.length <= 1 && this.bombers.length > 1) {
      this.over = true;
      this.winner = alive[0]?.id ?? null;
      this.draw = alive.length === 0;
    }
  }

  private move(b: SimPlayer, dtMs: number) {
    // m_nSpeed is pixels per original 30ms fixed update (CGameStage::sub_4F5658).
    const step = b.speed * (dtMs / ORIGINAL_TICK_MS);
    if (b.moving) {
      const tx = b.gx * TILE, ty = b.gy * TILE;
      const dx = tx - b.x, dy = ty - b.y;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist <= step) {
        b.x = tx; b.y = ty; b.tx = b.gx; b.ty = b.gy; b.moving = false;
      } else {
        b.x += Math.sign(dx) * Math.min(step, Math.abs(dx));
        b.y += Math.sign(dy) * Math.min(step, Math.abs(dy));
      }
      if (this.fireAt(b.tx, b.ty)) b.alive = false;
      return;
    }
    let dir = -1;
    if (b.input.dy > 0) dir = 0; else if (b.input.dy < 0) dir = 1;
    else if (b.input.dx < 0) dir = 2; else if (b.input.dx > 0) dir = 3;
    if (dir < 0) return;
    b.dir = dir;
    const [dx, dy] = DIRS[dir]!;
    const nx = b.tx + dx!, ny = b.ty + dy!;
    if (this.walkable(nx, ny, b)) {
      b.gx = nx; b.gy = ny; b.moving = true;
    }
  }

  private tryBomb(b: SimPlayer) {
    if (!b.input.bomb) { b.bombLatch = false; return; }
    if (b.bombLatch) return;
    b.bombLatch = true;
    const owned = this.bombs.filter((x) => x.owner === b.id).length;
    if (owned >= b.bombCount) return;
    if (this.bombAt(b.tx, b.ty)) return;
    this.bombs.push({ id: this.nextId++, x: b.tx, y: b.ty, owner: b.id, timer: FUSE_MS, power: b.power });
  }

  private explode(bomb: Bomb) {
    this.bombs = this.bombs.filter((b) => b.id !== bomb.id);
    const cells: Array<{ x: number; y: number; role: Fire["role"]; dir: number }> = [
      { x: bomb.x, y: bomb.y, role: "center", dir: 0 },
    ];
    for (let dir = 0; dir < DIRS.length; dir++) {
      const [dx, dy] = DIRS[dir]!;
      for (let i = 1; i <= bomb.power; i++) {
        const x = bomb.x + dx! * i, y = bomb.y + dy! * i;
        if (!this.inBounds(x, y)) break;
        const cell = this.cells[this.idx(x, y)]!;
        if (cell.kind === 1) break; // static wall stops fire
        const isTip = i === bomb.power;
        cells.push({ x, y, role: cell.kind === 2 || isTip ? "tip" : "arm", dir });
        if (cell.kind === 2) { // box: destroy, drop item, stop
          cell.kind = 0; cell.object = null;
          this.destroyed.push(this.idx(x, y));
          const item = rollItem(this.rand, this.mapDrops);
          if (item) this.items.push({ id: this.nextId++, x, y, item, asset: ITEMS.find((e) => e.name === item)?.name2 ?? "Item/Bomb" });
          break;
        }
        const other = this.bombAt(x, y);
        if (other) { other.timer = 0; } // chain reaction
      }
    }
    for (const c of cells) {
      const existing = this.fires.find((f) => f.x === c.x && f.y === c.y);
      if (existing) { existing.ttl = EXPLOSION_MS; existing.age = 0; existing.role = c.role; existing.dir = c.dir; }
      else this.fires.push({ x: c.x, y: c.y, ttl: EXPLOSION_MS, age: 0, role: c.role, dir: c.dir });
      // items burn? original keeps items; we keep them.
    }
    // chain bombs whose timer hit 0 explode next tick (timer<=0 handled above already this tick;
    // ensure they detonate promptly)
    for (const b of this.bombs) if (b.timer <= 0) this.explode(b);
  }

  private pickup(b: SimPlayer) {
    const it = this.items.find((i) => i.x === b.tx && i.y === b.ty);
    if (!it) return;
    this.items = this.items.filter((i) => i.id !== it.id);
    const t = itemType(it.item);
    switch (t) {
      case 1: b.bombCount = Math.min(b.bombCap, b.bombCount + 1); break;
      case 2: b.power = Math.min(b.powerCap, b.power + 1); break;
      case 3: case 4: b.speed = Math.min(b.speedCap, b.speed + 1); break;
      case 6: b.power = b.powerCap; break;
      case 8: case 9: b.speed = Math.max(b.baseSpeed, b.speed - 1); break;
      default: break; // coins/event items: score only (later phase)
    }
  }

  // ---- simple bot AI (server-original) ----
  private danger(x: number, y: number): boolean {
    if (this.fireAt(x, y)) return true;
    for (const bomb of this.bombs) {
      if (bomb.timer > 1200) continue;
      if (bomb.x === x && bomb.y === y) return true;
      for (const [dx, dy] of DIRS) {
        for (let i = 1; i <= bomb.power; i++) {
          const cx = bomb.x + dx! * i, cy = bomb.y + dy! * i;
          if (!this.inBounds(cx, cy)) break;
          const k = this.cells[this.idx(cx, cy)]!.kind;
          if (k === 1) break;
          if (cx === x && cy === y) return true;
          if (k === 2) break;
        }
      }
    }
    return false;
  }

  private botThink(b: SimPlayer, dtMs: number) {
    b.aiTimer -= dtMs;
    if (b.moving) return;
    if (b.aiTimer > 0) return;
    b.aiTimer = 100 + this.rand() * 150;
    const options = DIRS.map(([dx, dy], dir) => ({ dir, x: b.tx + dx!, y: b.ty + dy! }))
      .filter((o) => this.walkable(o.x, o.y, b));
    const safe = options.filter((o) => !this.danger(o.x, o.y));
    // flee imminent danger
    if (this.danger(b.tx, b.ty) && safe.length) {
      const o = safe[Math.floor(this.rand() * safe.length)]!;
      this.botStep(b, o.dir);
      return;
    }
    // place bomb when adjacent to a box or an opponent, then retreat
    const nearBox = DIRS.some(([dx, dy]) => { const x = b.tx + dx!, y = b.ty + dy!; return this.inBounds(x, y) && this.cells[this.idx(x, y)]!.kind === 2; });
    const enemy = this.bombers.find((e) => e.alive && e.id !== b.id && Math.abs(e.tx - b.tx) + Math.abs(e.ty - b.ty) <= 2);
    const owned = this.bombs.filter((x) => x.owner === b.id).length;
    if ((nearBox || enemy) && owned < b.bombCount && !this.bombAt(b.tx, b.ty) && safe.length) {
      b.input.bomb = true;
      const o = safe[Math.floor(this.rand() * safe.length)]!;
      this.botStep(b, o.dir);
      return;
    }
    b.input.bomb = false;
    // seek nearest box / item / enemy greedily
    const pool = safe.length ? safe : options;
    if (!pool.length) { b.input.dx = 0; b.input.dy = 0; return; }
    let best = pool[0]!, bestScore = -Infinity;
    for (const o of pool) {
      let score = this.rand() * 0.5;
      for (const it of this.items) score += 3 / (1 + Math.abs(it.x - o.x) + Math.abs(it.y - o.y));
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        if (this.cells[this.idx(x, y)]!.kind === 2) score += 1 / (1 + Math.abs(x - o.x) + Math.abs(y - o.y));
      }
      if (score > bestScore) { bestScore = score; best = o; }
    }
    this.botStep(b, best.dir);
  }

  private botStep(b: SimPlayer, dir: number) {
    b.input.dx = dir === 2 ? -1 : dir === 3 ? 1 : 0;
    b.input.dy = dir === 0 ? 1 : dir === 1 ? -1 : 0;
  }

  snapshot(): GameSnapshot {
    const bombers: BomberState[] = this.bombers.map((b) => ({
      id: b.id, x: b.x, y: b.y, dir: b.dir, alive: b.alive,
      speed: b.speed, bombCount: b.bombCount, power: b.power, bot: b.bot,
    }));
    return {
      frame: this.frame,
      timeMs: this.frame * ORIGINAL_TICK_MS,
      bombers,
      bombs: this.bombs.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, timer: b.timer, power: b.power })),
      explosions: this.fires.map((f) => ({ x: f.x, y: f.y, ttl: f.ttl, age: f.age, role: f.role, dir: f.dir })),
      items: this.items.map((i) => ({ id: i.id, x: i.x, y: i.y, item: i.asset })),
      destroyed: this.destroyed,
    };
  }
}
