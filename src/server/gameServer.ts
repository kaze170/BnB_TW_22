/**
 * Original (self-created) game server. Mirrors the semantic flow of the NMCO
 * client: login -> server select -> lobby -> room/prepare -> game. Gameplay
 * simulation will be ported faithfully from CA.exe in the gameplay phase; this
 * establishes the connection/room lifecycle so the client flow is complete.
 */
import type { C2S, S2C, RoomState, ServerInfo, GameInitState } from "../shared/protocol.ts";
import type { ServerWebSocket } from "bun";

interface Client {
  ws: ServerWebSocket<unknown>;
  id: string;
  nickname: string;
  room: number | null;
}

const SERVERS: ServerInfo[] = [
  { id: 1, name: "爆爆王 1 區", online: 0 },
  { id: 2, name: "爆爆王 2 區", online: 0 },
];

export class GameServer {
  private clients = new Map<ServerWebSocket<unknown>, Client>();
  private rooms = new Map<number, RoomState>();
  private nextRoom = 1;

  get onlineCount() {
    return this.clients.size;
  }

  open(ws: ServerWebSocket<unknown>) {
    this.clients.set(ws, { ws, id: "", nickname: "", room: null });
  }

  close(ws: ServerWebSocket<unknown>) {
    const c = this.clients.get(ws);
    if (c?.room != null) this.leaveRoom(c);
    this.clients.delete(ws);
    SERVERS.forEach((s) => (s.online = this.clients.size));
  }

  private send(ws: ServerWebSocket<unknown>, msg: S2C) {
    ws.send(JSON.stringify(msg));
  }

  message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
    const c = this.clients.get(ws);
    if (!c) return;
    let msg: C2S;
    try {
      msg = JSON.parse(raw.toString()) as C2S;
    } catch {
      return;
    }
    this.handle(c, msg);
  }

  private handle(c: Client, msg: C2S) {
    switch (msg.t) {
      case "login": {
        // Platform auth is intentionally emulated (project decision: skip DRM).
        c.id = msg.id;
        c.nickname = msg.id;
        SERVERS.forEach((s) => (s.online = this.clients.size));
        this.send(c.ws, {
          t: "loginResult",
          ok: true,
          user: { id: c.id, nickname: c.nickname, character: 0, level: 1 },
        });
        break;
      }
      case "enterLobby": {
        this.send(c.ws, { t: "serverList", servers: SERVERS });
        this.send(c.ws, { t: "lobbyState", rooms: [...this.rooms.values()].map(roomInfo), users: this.clients.size });
        break;
      }
      case "selectServer": {
        this.send(c.ws, { t: "lobbyState", rooms: [...this.rooms.values()].map(roomInfo), users: this.clients.size });
        break;
      }
      case "createRoom": {
        const id = this.nextRoom++;
        const room: RoomState = {
          id,
          title: msg.title || `${c.nickname} 的房間`,
          map: msg.map,
          mode: msg.mode,
          max: 8,
          players: [{ id: c.id, nickname: c.nickname, character: 0, slot: 0, ready: false, team: 0 }],
        };
        this.rooms.set(id, room);
        c.room = id;
        this.send(c.ws, { t: "roomState", room });
        this.broadcastLobby();
        break;
      }
      case "joinRoom": {
        const room = this.rooms.get(msg.room);
        if (!room) return this.send(c.ws, { t: "error", code: "noRoom", message: "房間不存在" });
        if (room.players.length >= room.max) return this.send(c.ws, { t: "error", code: "full", message: "房間已滿" });
        if (c.room != null) this.leaveRoom(c);
        room.players.push({ id: c.id, nickname: c.nickname, character: 0, slot: room.players.length, ready: false, team: 0 });
        c.room = room.id;
        this.broadcastRoom(room);
        this.broadcastLobby();
        break;
      }
      case "leaveRoom": {
        this.leaveRoom(c);
        this.broadcastLobby();
        break;
      }
      case "ready": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        const pl = room?.players.find((p) => p.id === c.id);
        if (pl) pl.ready = msg.ready;
        if (room) this.broadcastRoom(room);
        break;
      }
      case "startGame": {
        const room = c.room != null ? this.rooms.get(c.room) : null;
        if (!room) return;
        const init = this.makeMap(room);
        for (const p of room.players) {
          const pc = [...this.clients.values()].find((cl) => cl.id === p.id);
          if (pc) this.send(pc.ws, { t: "gameStart", state: init });
        }
        break;
      }
      case "chat": {
        for (const cl of this.clients.values()) this.send(cl.ws, { t: "chat", from: c.nickname, text: msg.text });
        break;
      }
      case "ping":
        this.send(c.ws, { t: "pong", time: msg.time });
        break;
      default:
        break;
    }
  }

  private leaveRoom(c: Client) {
    if (c.room == null) return;
    const room = this.rooms.get(c.room);
    c.room = null;
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== c.id);
    if (room.players.length === 0) this.rooms.delete(room.id);
    else this.broadcastRoom(room);
  }

  private broadcastRoom(room: RoomState) {
    for (const p of room.players) {
      const c = [...this.clients.values()].find((cl) => cl.id === p.id);
      if (c) this.send(c.ws, { t: "roomState", room });
    }
  }

  private broadcastLobby() {
    const rooms = [...this.rooms.values()].map(roomInfo);
    for (const c of this.clients.values()) this.send(c.ws, { t: "lobbyState", rooms, users: this.clients.size });
  }

  /** Placeholder map generator; faithful map data (Attr/MapGroup, TileInfoList) next phase. */
  private makeMap(room: RoomState): GameInitState {
    const width = 15;
    const height = 13;
    const tiles = new Array(width * height).fill(0);
    return {
      map: room.map,
      width,
      height,
      tiles,
      players: room.players.map((p) => ({ id: p.id, slot: p.slot, character: p.character, x: 1 + p.slot, y: 1 })),
    };
  }
}

function roomInfo(r: RoomState) {
  return { id: r.id, title: r.title, map: r.map, mode: r.mode, players: r.players.length, max: r.max, state: "waiting" as const };
}