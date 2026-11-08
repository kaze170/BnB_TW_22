/**
 * Original (self-created) game server. Mirrors the semantic flow of the NMCO
 * client: login -> server/channel select -> lobby -> room/prepare -> game.
 * Gameplay runs on the decrypted original data at the exe's 30ms fixed step
 * (CGameStage::sub_4F5658), with catch-up capped at 15 updates per timer callback.
 */
import type { C2S, S2C, RoomState, RoomInfo, ServerInfo, ChannelInfo } from "../shared/protocol.ts";
import { GameSimulation } from "./simulation.ts";
import { CHARACTERS, MAPS, MAP_NAMES, MAP_GROUPS } from "./gameData.ts";
import { FixedStepper, ORIGINAL_TICK_MS } from "../shared/timing.ts";
import type { ServerWebSocket } from "bun";

interface Client {
  ws: ServerWebSocket<unknown>;
  id: string;
  nickname: string;
  room: number | null;
  server: number;
  channel: number;
}
interface Room extends RoomState { server: number; channel: number; }

const SERVERS: ServerInfo[] = [
  { id: 1, name: "爆爆王 1 區", online: 0 },
  { id: 2, name: "爆爆王 2 區", online: 0 },
];
/** Original channel screen has 5 pages × 10 buttons (sub_56DBA5). */
const CHANNELS: ChannelInfo[] = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1,
  name: `頻道 ${i + 1}`,
  users: 0,
  max: 200,
}));
const ROOM_MAX = 8;

export class GameServer {
  private clients = new Map<ServerWebSocket<unknown>, Client>();
  private rooms = new Map<number, Room>();
  private nextRoom = 1;
  private sims = new Map<number, { sim: GameSimulation; timer: ReturnType<typeof setInterval> }>();
  /** Players that acknowledged the result screen; room stays closed until all return. */
  private returned = new Map<number, Set<string>>();

  get onlineCount() { return this.clients.size; }

  open(ws: ServerWebSocket<unknown>) {
    this.clients.set(ws, { ws, id: "", nickname: "", room: null, server: 1, channel: 0 });
  }

  close(ws: ServerWebSocket<unknown>) {
    const c = this.clients.get(ws);
    if (c?.room != null) this.leaveRoom(c);
    this.clients.delete(ws);
    this.refreshPresence();
    this.broadcastLobby();
  }

  private send(ws: ServerWebSocket<unknown>, msg: S2C) { ws.send(JSON.stringify(msg)); }
  private err(c: Client, code: string, message: string) { this.send(c.ws, { t: "error", code, message }); }
  private clientById(id: string): Client | undefined {
    for (const c of this.clients.values()) if (c.id === id) return c;
    return undefined;
  }
  private refreshPresence() {
    for (const s of SERVERS) s.online = [...this.clients.values()].filter((c) => c.id && c.server === s.id).length;
  }
  private channelsFor(server: number): ChannelInfo[] {
    return CHANNELS.map((ch, i) => ({
      ...ch,
      users: [...this.clients.values()].filter((c) => c.id && c.server === server && c.channel === i).length,
    }));
  }
  private channelUsers(server: number, channel: number): number {
    return [...this.clients.values()].filter((c) => c.id && c.server === server && c.channel === channel).length;
  }

  message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
    const c = this.clients.get(ws);
    if (!c) return;
    let msg: C2S;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { t?: unknown }).t !== "string") return;
      msg = parsed as C2S;
    } catch { return; }
    this.handle(c, msg);
  }

  private handle(c: Client, msg: C2S) {
    switch (msg.t) {
      case "login": {
        const id = String(msg.id ?? "").trim().slice(0, 16);
        if (!id) return this.err(c, "badId", "請輸入遊戲暱稱");
        if (this.clientById(id)) return this.send(c.ws, { t: "loginResult", ok: false, reason: "暱稱已被使用" });
        // Platform auth is intentionally emulated (project decision: skip DRM).
        c.id = id; c.nickname = id;
        this.refreshPresence();
        this.send(c.ws, { t: "loginResult", ok: true, user: { id: c.id, nickname: c.nickname, character: 0, level: 1 } });
        break;
      }
      case "selectServer": {
        if (!c.id) return this.err(c, "noLogin", "請先登入");
        const server = SERVERS.some((s) => s.id === msg.server) ? msg.server : 1;
        if (c.room != null) this.leaveRoom(c);
        c.server = server; c.channel = 0;
        this.refreshPresence();
        this.send(c.ws, { t: "serverList", servers: SERVERS });
        this.send(c.ws, { t: "channelList", channels: this.channelsFor(server) });
        break;
      }
      case "selectChannel": {
        if (!c.id) return this.err(c, "noLogin", "請先登入");
        const idx = Number.isFinite(msg.channel) ? Math.max(0, Math.min(CHANNELS.length - 1, Math.floor(msg.channel))) : 0;
        if (c.room != null) this.leaveRoom(c);
        c.channel = idx;
        this.send(c.ws, { t: "channelList", channels: this.channelsFor(c.server) });
        this.send(c.ws, { t: "mapList", names: MAP_NAMES, groups: MAP_GROUPS });
        this.send(c.ws, { t: "lobbyState", rooms: this.lobbyRooms(c), users: this.channelUsers(c.server, c.channel) });
        this.broadcastLobby();
        break;
      }
      case "enterLobby": {
        if (!c.id) return this.err(c, "noLogin", "請先登入");
        this.send(c.ws, { t: "mapList", names: MAP_NAMES, groups: MAP_GROUPS });
        this.send(c.ws, { t: "lobbyState", rooms: this.lobbyRooms(c), users: this.channelUsers(c.server, c.channel) });
        break;
      }
      case "createRoom": {
        if (!c.id) return this.err(c, "noLogin", "請先登入");
        if (c.room != null) return this.err(c, "inRoom", "你已經在房間中");
        const map = Number.isInteger(msg.map) && msg.map >= 0 && msg.map < MAP_NAMES.length ? msg.map : 0;
        const id = this.nextRoom++;
        const room: Room = {
          id,
          title: String(msg.title ?? "").trim().slice(0, 30) || `${c.nickname} 的房間`,
          map,
          mode: msg.mode === 14 ? 14 : 0,
          max: ROOM_MAX,
          hostId: c.id,
          state: "waiting",
          server: c.server,
          channel: c.channel,
          players: [{ id: c.id, nickname: c.nickname, character: 0, slot: 0, ready: true, team: 0 }],
        };
        this.rooms.set(id, room);
        c.room = id;
        this.send(c.ws, { t: "roomState", room });
        this.broadcastLobby();
        break;
      }
      case "joinRoom": {
        if (!c.id) return this.err(c, "noLogin", "請先登入");
        const room = this.rooms.get(msg.room);
        if (!room || room.server !== c.server || room.channel !== c.channel) return this.err(c, "noRoom", "房間不存在");
        if (room.state !== "waiting") return this.err(c, "playing", "房間遊戲進行中");
        if (room.players.length >= room.max) return this.err(c, "full", "房間已滿");
        if (c.room === room.id) return this.send(c.ws, { t: "roomState", room });
        if (c.room != null) this.leaveRoom(c);
        const used = new Set(room.players.map((p) => p.slot));
        let slot = 0; while (used.has(slot)) slot++;
        room.players.push({ id: c.id, nickname: c.nickname, character: 0, slot, ready: false, team: 0 });
        c.room = room.id;
        this.broadcastRoom(room);
        this.broadcastLobby();
        break;
      }
      case "leaveRoom": {
        this.leaveRoom(c);
        this.send(c.ws, { t: "lobbyState", rooms: this.lobbyRooms(c), users: this.channelUsers(c.server, c.channel) });
        this.broadcastLobby();
        break;
      }
      case "returnToRoom": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room || this.sims.has(room.id) || room.state === "playing") return;
        if (room.state === "results") {
          let set = this.returned.get(room.id);
          if (!set) { set = new Set(); this.returned.set(room.id, set); }
          set.add(c.id);
          // The requesting client may enter Prepare immediately (disabled until
          // everyone returns); other clients keep their result screen.
          this.finishResultsIfReady(room);
          this.broadcastRoom(room);
        } else {
          this.send(c.ws, { t: "roomState", room });
        }
        break;
      }
      case "ready": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room || room.state !== "waiting") return;
        const pl = room.players.find((p) => p.id === c.id);
        if (!pl || pl.id === room.hostId) return; // host starts instead of readying
        pl.ready = !!msg.ready;
        this.broadcastRoom(room);
        break;
      }
      case "selectCharacter": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room || room.state !== "waiting") return;
        const ch = Math.floor(msg.character);
        if (!Number.isInteger(ch) || ch < 0 || ch >= CHARACTERS.length) return;
        const pl = room.players.find((p) => p.id === c.id);
        if (!pl) return;
        pl.character = ch;
        if (pl.id !== room.hostId) pl.ready = false;
        this.broadcastRoom(room);
        break;
      }
      case "setMap": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room || room.state !== "waiting" || room.hostId !== c.id) return;
        if (!Number.isInteger(msg.map) || msg.map < 0 || msg.map >= MAP_NAMES.length) return;
        room.map = msg.map;
        for (const p of room.players) if (p.id !== room.hostId) p.ready = false;
        this.broadcastRoom(room);
        this.broadcastLobby();
        break;
      }
      case "startGame": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room || room.state !== "waiting" || this.sims.has(room.id)) return;
        if (room.hostId !== c.id) return this.err(c, "notHost", "只有房主可以開始遊戲");
        if (room.players.some((p) => p.id !== room.hostId && !p.ready)) return this.err(c, "notReady", "尚有玩家尚未準備");
        this.startSimulation(room);
        break;
      }
      case "gameInput": {
        const entry = c.room != null ? this.sims.get(c.room) : null;
        if (!entry) return;
        const dx = Number.isFinite(msg.dx) ? Math.sign(msg.dx) : 0;
        const dy = Number.isFinite(msg.dy) ? Math.sign(msg.dy) : 0;
        entry.sim.setInput(c.id, dx, dy, !!msg.bomb);
        break;
      }
      case "chat": {
        const text = String(msg.text ?? "").slice(0, 120);
        if (!text) return;
        const room = c.room != null ? this.rooms.get(c.room) : null;
        const targets = room
          ? room.players.map((p) => this.clientById(p.id)).filter((x): x is Client => !!x)
          : [...this.clients.values()].filter((x) => x.id && x.room == null && x.server === c.server && x.channel === c.channel);
        for (const cl of targets) this.send(cl.ws, { t: "chat", from: c.nickname, text });
        break;
      }
      case "ping":
        this.send(c.ws, { t: "pong", time: msg.time });
        break;
      default: break;
    }
  }

  private leaveRoom(c: Client) {
    if (c.room == null) return;
    const room = this.rooms.get(c.room);
    c.room = null;
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== c.id);
    const entry = this.sims.get(room.id);
    if (entry) entry.sim.removePlayer(c.id);
    if (room.players.length === 0) {
      this.stopSimulation(room.id);
      this.rooms.delete(room.id);
      this.returned.delete(room.id);
    } else {
      if (room.hostId === c.id) {
        room.hostId = room.players[0]!.id;
        room.players[0]!.ready = true;
      }
      this.finishResultsIfReady(room);
      this.broadcastRoom(room);
    }
  }

  private stopSimulation(roomId: number) {
    const entry = this.sims.get(roomId);
    if (entry) clearInterval(entry.timer);
    this.sims.delete(roomId);
    this.returned.delete(roomId);
  }

  /** Reopen the room only after every remaining human acknowledged the result. */
  private finishResultsIfReady(room: Room) {
    if (room.state !== "results") return;
    const set = this.returned.get(room.id) ?? new Set<string>();
    if (!room.players.every((p) => set.has(p.id))) return;
    room.state = "waiting";
    for (const p of room.players) p.ready = p.id === room.hostId;
    this.returned.delete(room.id);
    this.broadcastLobby();
  }

  private broadcastRoom(room: Room) {
    for (const p of room.players) {
      const c = this.clientById(p.id);
      if (c) this.send(c.ws, { t: "roomState", room });
    }
  }

  private lobbyRooms(c: Client): RoomInfo[] {
    return [...this.rooms.values()]
      .filter((r) => r.server === c.server && r.channel === c.channel)
      .map(roomInfo);
  }

  private broadcastLobby() {
    for (const c of this.clients.values()) {
      if (c.id && c.room == null) this.send(c.ws, { t: "lobbyState", rooms: this.lobbyRooms(c), users: this.channelUsers(c.server, c.channel) });
    }
  }

  /** Start an authoritative match. Bots fill empty slots up to the map's original
   * spawn count (at least 4, capped at the 8-slot room) so a single player can
   * validate gameplay without overlap on four-spawn maps such as Village00. */
  private startSimulation(room: Room) {
    const players = room.players.map((p) => ({ id: p.id, slot: p.slot, character: p.character, bot: false }));
    const usedSlots = new Set(players.map((p) => p.slot));
    const mapName = MAP_NAMES[room.map]!;
    const spawnCount = MAPS[mapName]?.spawns.length ?? 4;
    const target = Math.min(room.max, Math.max(4, spawnCount));
    let slot = 0;
    while (players.length < target) {
      while (usedSlots.has(slot)) slot++;
      usedSlots.add(slot);
      players.push({ id: `bot-${room.id}-${slot}`, slot, character: (room.id + slot) % CHARACTERS.length, bot: true });
      slot++;
    }
    const sim = new GameSimulation(room.map, players);
    const init = sim.initState();
    room.state = "playing";
    for (const p of room.players) {
      const pc = this.clientById(p.id);
      if (pc) this.send(pc.ws, { t: "gameStart", state: init });
    }
    this.broadcastRoom(room);

    const stepper = new FixedStepper();
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const steps = stepper.add(now - last);
      last = now;
      for (let i = 0; i < steps && !sim.over; i++) sim.tick(ORIGINAL_TICK_MS);
      if (steps > 0) {
        const snap = sim.snapshot();
        for (const p of room.players) {
          const pc = this.clientById(p.id);
          if (pc) this.send(pc.ws, { t: "gameFrame", frame: snap.frame, state: snap });
        }
      }
      if (sim.over) {
        this.stopSimulation(room.id);
        // Results is a closed lifecycle state: no join/start until every remaining
        // human acknowledges returnToRoom (or leaves). Each client keeps its own
        // result screen until it requests the return.
        room.state = "results";
        this.returned.set(room.id, new Set());
        for (const p of room.players) {
          const pc = this.clientById(p.id);
          if (pc) {
            this.send(pc.ws, { t: "gameEnd", result: sim.result() });
            this.send(pc.ws, { t: "roomState", room });
          }
        }
        this.broadcastLobby();
      }
    }, ORIGINAL_TICK_MS);
    this.sims.set(room.id, { sim, timer });
  }
}

function roomInfo(r: Room): RoomInfo {
  return { id: r.id, title: r.title, map: r.map, mode: r.mode, players: r.players.length, max: r.max, state: r.state };
}
