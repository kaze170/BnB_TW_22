/**
 * Game simulation for the vertical slice. The SERVER is original (project
 * decision), but it consumes the decrypted ORIGINAL data: 15x13 maps, tile
 * types, character stats, item drop weights, and ObjectTable animation groups.
 * Core constants recovered from CA.exe: TILE=40, fixed update step=30ms
 * (CGameStage::sub_4F5658), practice fuse=2000ms (sub_4E87D8). Movement is
 * grid-locked like CGOBomber. Flame cells follow CGOFlame: each explosion adds
 * a segment whose tick counter starts at -distanceDelay, becomes active at 0,
 * draws logical image = counter, and is removed at the group's frame count
 * (sub_454188/45436D/454545/45FE8B).
 */
import type { GameInitState, GameSnapshot, MapCell, BomberState, GameResult, ResultRow } from "../shared/protocol.ts";
import {
  MAPS, ITEMS, TILE, FUSE_MS, MAP_NAMES,
  tileName, tileType, charStats, rollItem, itemType,
} from "./gameData.ts";
import { ORIGINAL_TICK_MS } from "../shared/timing.ts";
import {
  FLAME_OBJECT, BUBBLE_OBJECT, BUBBLE_EXPKILL_GROUP, animationGroup, flameCenterGroup, flameArmGroup,
  characterActionGroup, characterActionLoops, animationImageAtTicks,
  type CharacterAction,
} from "../shared/animations.ts";

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
  /** server-original result stats */
  kills: number; deaths: number; boxes: number; items: number;
  /** Authoritative CGOBomber action + elapsed ticks (ObjectTable playback). */
  action: CharacterAction;
  actionTicks: number;
  /** Mirrors the original ghost flag; no current gameplay event enables it. */
  ghostAfterDeath: boolean;
}
interface Bomb { id: number; x: number; y: number; owner: string; timer: number; power: number; }
type FireRole = "center" | "arm" | "tip";
interface FlameSegment {
  group: number;
  /** tick counter; negative = propagation delay, >=0 active, >=frameCount removed */
  counter: number;
  frameCount: number;
  asset: string;
  role: FireRole;
  dir: number;
  owner: string;
}
interface Fire { x: number; y: number; segments: FlameSegment[]; }
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
  /** Server-original post-match presentation grace: action-only ticks still to
   * broadcast before the client covers the field with the result report. This
   * is NOT an exe-recovered result-screen delay; gameplay/scoring are already
   * frozen when `over` becomes true. */
  presentationTicksLeft = 0;
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
        kills: 0, deaths: 0, boxes: 0, items: 0,
        action: "idle", actionTicks: 0, ghostAfterDeath: false,
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
      fuseMs: FUSE_MS,
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
      this.beginAction(b, "die");
    }
  }

  // ---- CGOBomber action state (ObjectTable groups, 30ms tick domain) ----
  private actionDurationTicks(b: SimPlayer, action: CharacterAction = b.action): number {
    // sub_4470AF starts the Faint counter at 1; sub_4503B5 switches
    // to Stop Down when it reaches 80, after 79 subsequent updates.
    if (action === "faint") return 79;
    const group = animationGroup(`Character/C${String(b.character).padStart(2, "0")}_A`, characterActionGroup(action, b.dir));
    if (!group) return 0;
    return group.frames.reduce((sum, [, d]) => sum + (d > 0 ? d : 0), 0);
  }
  /** Longest remaining one-shot death sequence across the field. The winner's
   * Hurrah loops, so it does not extend the grace; it plays during the sequence. */
  private terminalPresentationTicks(): number {
    let max = 0;
    for (const b of this.bombers) {
      if (b.alive) continue;
      const left = (a: CharacterAction) => Math.max(0, this.actionDurationTicks(b, a) - (b.action === a ? b.actionTicks : 0));
      let n = 0;
      if (b.action === "die") n = left("die") + (b.ghostAfterDeath ? this.actionDurationTicks(b, "ghostAppear") : 0);
      else if (b.action === "ghostAppear") n = left("ghostAppear");
      max = Math.max(max, n);
    }
    return max;
  }
  private beginAction(b: SimPlayer, action: CharacterAction) {
    b.action = action;
    b.actionTicks = 0;
  }
  /** One-shot actions block grid movement (CGOBomber sub_446580 excludes them). */
  private actionLocks(b: SimPlayer): boolean {
    return b.action === "throw" || b.action === "start" || b.action === "faint"
      || b.action === "die" || b.action === "ghostAppear";
  }
  private stepActions(dtMs: number) {
    const ticks = Math.max(1, Math.round(dtMs / ORIGINAL_TICK_MS));
    for (const b of this.bombers) {
      b.actionTicks += ticks;
      if (characterActionLoops(b.action)) continue;
      const dur = this.actionDurationTicks(b);
      if (dur <= 0 || b.actionTicks < dur) continue;
      // Faint is not the fire-death path; it returns to Stop Down. Die
      // either hides or enters GhostAppear depending on the original flag.
      switch (b.action) {
        case "start": case "throw": this.beginAction(b, "idle"); break;
        case "faint": b.dir = 0; this.beginAction(b, "idle"); break;
        case "die": this.beginAction(b, b.ghostAfterDeath ? "ghostAppear" : "hidden"); break;
        case "ghostAppear": this.beginAction(b, "ghost"); break;
        default: this.beginAction(b, "idle"); break;
      }
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
  /** CGOFlame sub_454266 scans newest→oldest for the first non-negative counter. */
  private activeSegment(cell: Fire): FlameSegment | undefined {
    for (let i = cell.segments.length - 1; i >= 0; i--) {
      const seg = cell.segments[i]!;
      if (seg.counter >= 0) return seg;
    }
    return undefined;
  }
  private fireAt(x: number, y: number) {
    return this.fires.some((f) => f.x === x && f.y === y && this.activeSegment(f) !== undefined);
  }
  /** Apply lethal active flame to a bomber and credit the segment owner. */
  private fireKill(b: SimPlayer): boolean {
    if (!b.alive) return false;
    const cell = this.fires.find((f) => f.x === b.tx && f.y === b.ty);
    const seg = cell ? this.activeSegment(cell) : undefined;
    if (!seg) return false;
    b.alive = false;
    b.deaths++;
    b.moving = false;
    b.input = { dx: 0, dy: 0, bomb: false };
    // The recovered lethal-fire path enters Die directly (sub_44A0C8).
    this.beginAction(b, "die");
    if (seg.owner !== b.id) {
      const killer = this.bombers.find((x) => x.id === seg.owner);
      if (killer) killer.kills++;
    }
    return true;
  }
  private makeSegment(group: number, delayTicks: number, role: FireRole, dir: number, owner: string): FlameSegment {
    const anim = animationGroup(FLAME_OBJECT, group);
    return {
      group,
      counter: delayTicks > 0 ? -delayTicks : 0,
      frameCount: anim?.frames.length ?? 1,
      asset: anim?.asset ?? "Bomb/Fire00",
      role,
      dir,
      owner,
    };
  }
  private addFlame(x: number, y: number, seg: FlameSegment) {
    let cell = this.fires.find((f) => f.x === x && f.y === y);
    if (!cell) { cell = { x, y, segments: [] }; this.fires.push(cell); }
    cell.segments.push(seg);
    // sub_454188 keeps at most 15 segments per cell, dropping the oldest.
    if (cell.segments.length > 15) cell.segments.shift();
  }
  private stepFires(dtMs: number) {
    const ticks = Math.max(1, Math.round(dtMs / ORIGINAL_TICK_MS));
    for (const cell of this.fires) {
      for (const seg of cell.segments) seg.counter += ticks;
      cell.segments = cell.segments.filter((seg) => seg.counter < seg.frameCount);
    }
    this.fires = this.fires.filter((cell) => cell.segments.length > 0);
  }

  tick(dtMs: number) {
    if (this.over) {
      // Post-match: gameplay/scoring/clock are frozen; only the authoritative
      // action playback advances so clients can see the death animation.
      this.stepActions(dtMs);
      const ticks = Math.max(1, Math.round(dtMs / ORIGINAL_TICK_MS));
      this.presentationTicksLeft = Math.max(0, this.presentationTicksLeft - ticks);
      return;
    }
    this.frame++;
    this.destroyed = [];
    this.stepActions(dtMs);
    for (const b of this.bombers) if (b.alive && b.bot && !this.actionLocks(b)) this.botThink(b, dtMs);
    for (const b of this.bombers) if (b.alive && !this.actionLocks(b)) this.move(b, dtMs);
    for (const b of this.bombers) if (b.alive) this.pickup(b);
    for (const b of this.bombers) if (b.alive && !this.actionLocks(b)) this.tryBomb(b);
    // Walk/idle are presentation states derived from the authoritative move.
    for (const b of this.bombers) {
      if (!b.alive || this.actionLocks(b)) continue;
      const next: CharacterAction = b.moving ? "walk" : "idle";
      if (b.action !== next) this.beginAction(b, next);
    }
    // Advance existing flame counters before this tick's detonations so newly
    // scheduled segments start at counter 0 (frame 0) and live their full count.
    this.stepFires(dtMs);
    // bomb timers
    const explode: Bomb[] = [];
    for (const bomb of this.bombs) {
      bomb.timer -= dtMs;
      if (bomb.timer <= 0) explode.push(bomb);
    }
    for (const bomb of explode) this.explode(bomb);
    // fire damage (active segments only; delayed propagation is not lethal yet)
    for (const b of this.bombers) this.fireKill(b);
    // win check
    const alive = this.bombers.filter((b) => b.alive);
    if (alive.length <= 1 && this.bombers.length > 1) {
      this.over = true;
      this.winner = alive[0]?.id ?? null;
      this.draw = alive.length === 0;
      const w = alive[0];
      if (w) { w.moving = false; this.beginAction(w, "hurrah"); }
      this.presentationTicksLeft = this.terminalPresentationTicks();
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
      this.fireKill(b);
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
    // CGOBomber enters Throw Left/Up/Right/Down (groups 16–19) on placement.
    this.beginAction(b, "throw");
  }

  private explode(bomb: Bomb) {
    this.bombs = this.bombs.filter((b) => b.id !== bomb.id);
    const cells: Array<{ x: number; y: number; role: FireRole; dir: number; group: number; delay: number }> = [
      { x: bomb.x, y: bomb.y, role: "center", dir: 0, group: flameCenterGroup(bomb.power), delay: 0 },
    ];
    for (let dir = 0; dir < DIRS.length; dir++) {
      const [dx, dy] = DIRS[dir]!;
      for (let i = 1; i <= bomb.power; i++) {
        const x = bomb.x + dx! * i, y = bomb.y + dy! * i;
        if (!this.inBounds(x, y)) break;
        const cell = this.cells[this.idx(x, y)]!;
        if (cell.kind === 1) break; // static wall stops fire
        const isTip = i === bomb.power;
        cells.push({
          x, y, role: cell.kind === 2 || isTip ? "tip" : "arm", dir,
          group: flameArmGroup(bomb.power, dir, i),
          delay: i - 1, // sub_4E3CBE: counter starts 0,-1,-2,... per cell
        });
        if (cell.kind === 2) { // box: destroy, drop item, stop
          cell.kind = 0; cell.object = null;
          this.destroyed.push(this.idx(x, y));
          const owner = this.bombers.find((b) => b.id === bomb.owner);
          if (owner) owner.boxes++;
          const item = rollItem(this.rand, this.mapDrops);
          if (item) this.items.push({ id: this.nextId++, x, y, item, asset: ITEMS.find((e) => e.name === item)?.name2 ?? "Item/Bomb" });
          break;
        }
        const other = this.bombAt(x, y);
        if (other) { other.timer = 0; } // chain reaction
      }
    }
    for (const c of cells) {
      this.addFlame(c.x, c.y, this.makeSegment(c.group, c.delay, c.role, c.dir, bomb.owner));
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
    b.items++;
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

  /** Server-original vertical-slice scoreboard. The client renders it with the
   * recovered CGOGameResult layout/assets (Game/PatResultDlg, ResultImg,
   * ResultInfoBar); scoring/award assignment here is original, not exe packet
   * semantics (online scoring was server-authoritative). */
  result(): GameResult {
    const rows: ResultRow[] = this.bombers.map((b) => ({
      id: b.id, slot: b.slot, character: b.character, bot: b.bot, alive: b.alive,
      kills: b.kills, deaths: b.deaths, boxes: b.boxes, items: b.items,
      score: Math.min(999, b.kills * 100 + b.boxes * 10 + b.items * 5 + (b.alive ? 50 : 0)),
      rank: 0,
    }));
    rows.sort((a, b) => {
      if (a.id === this.winner) return -1;
      if (b.id === this.winner) return 1;
      return b.score - a.score || b.kills - a.kills || a.slot - b.slot;
    });
    const maxKills = Math.max(0, ...rows.map((r) => r.kills));
    const maxBoxes = Math.max(0, ...rows.map((r) => r.boxes));
    rows.forEach((r, i) => {
      r.rank = i + 1;
      if (!this.draw && r.rank === 1) r.award = 57;
      else if (maxKills > 0 && r.kills === maxKills) r.award = 64;
      else if (maxBoxes > 0 && r.boxes === maxBoxes) r.award = 66;
      else if (r.alive) r.award = 68;
    });
    return { winner: this.winner, draw: this.draw, durationMs: this.frame * ORIGINAL_TICK_MS, rows };
  }

  snapshot(): GameSnapshot {
    const bombers: BomberState[] = this.bombers.map((b) => {
      const object = `Character/C${String(b.character).padStart(2, "0")}_A`;
      const groupIndex = characterActionGroup(b.action, b.dir);
      const group = b.action === "hidden" ? undefined : animationGroup(object, groupIndex);
      const loop = characterActionLoops(b.action);
      const bubbleGroup = animationGroup(BUBBLE_OBJECT, BUBBLE_EXPKILL_GROUP);
      const bubbleTicks = bubbleGroup?.frames.reduce((sum, [, duration]) => sum + Math.max(0, duration), 0) ?? 0;
      const bubble = b.action === "die" && bubbleGroup && b.actionTicks < bubbleTicks
        ? { asset: bubbleGroup.asset, group: BUBBLE_EXPKILL_GROUP, frame: animationImageAtTicks(bubbleGroup, b.actionTicks, false) }
        : undefined;
      return {
        id: b.id, x: b.x, y: b.y, dir: b.dir, alive: b.alive,
        speed: b.speed, bombCount: b.bombCount, power: b.power, bot: b.bot, moving: b.moving,
        action: b.action, animGroup: group ? groupIndex : undefined, animTicks: b.actionTicks,
        animFrame: group ? animationImageAtTicks(group, b.actionTicks, loop) : undefined,
        animAsset: group?.asset, bubble,
      };
    });
    const explosions = this.fires.flatMap((cell) => {
      const seg = this.activeSegment(cell);
      if (!seg) return []; // propagation delay not yet active
      let ttl = 0;
      for (const s of cell.segments) {
        if (s.counter >= 0) ttl = Math.max(ttl, (s.frameCount - s.counter) * ORIGINAL_TICK_MS);
      }
      const frame = Math.floor(seg.counter);
      return [{
        x: cell.x, y: cell.y, ttl, age: frame * ORIGINAL_TICK_MS,
        asset: seg.asset, group: seg.group, frame, role: seg.role, dir: seg.dir,
      }];
    });
    return {
      frame: this.frame,
      timeMs: this.frame * ORIGINAL_TICK_MS,
      bombers,
      bombs: this.bombs.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, timer: b.timer, power: b.power })),
      explosions,
      items: this.items.map((i) => ({ id: i.id, x: i.x, y: i.y, item: i.asset })),
      destroyed: this.destroyed,
      presentation: this.over && this.presentationTicksLeft > 0,
    };
  }
}
