export {};
/** WS lifecycle smoke: channel isolation, host/ready enforcement, character/map
 * selection, start, in-game leave, and lobby cleanup. Requires the dev server. */
const URL = process.env.SMOKE_URL ?? "ws://localhost:3000/ws";

class TestClient {
  ws: WebSocket;
  inbox: any[] = [];
  waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(public name: string) {
    this.ws = new WebSocket(URL);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      this.inbox.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]!;
        if (w.pred(m)) {
          clearTimeout(w.timer); this.waiters.splice(i, 1);
          const idx = this.inbox.indexOf(m); if (idx >= 0) this.inbox.splice(idx, 1);
          w.resolve(m);
        }
      }
    };
  }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error(`${this.name} ws error`)); }); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  next(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} timeout waiting message`)), timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
  close() { this.ws.close(); }
}

const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const A = new TestClient("host");
const B = new TestClient("guest");
await Promise.all([A.open(), B.open()]);
A.send({ t: "login", id: "room-host", pw: "x" });
B.send({ t: "login", id: "room-guest", pw: "x" });
await Promise.all([A.next((m) => m.t === "loginResult" && m.ok), B.next((m) => m.t === "loginResult" && m.ok)]);
A.send({ t: "selectServer", server: 1 });
B.send({ t: "selectServer", server: 1 });
await Promise.all([A.next((m) => m.t === "channelList"), B.next((m) => m.t === "channelList")]);
A.send({ t: "selectChannel", channel: 0 });
B.send({ t: "selectChannel", channel: 1 });
const mapList = await A.next((m) => m.t === "mapList");
await B.next((m) => m.t === "mapList");
const village = mapList.names.indexOf("Village00");
const village05 = mapList.names.indexOf("Village05");
assert(village >= 0 && village05 >= 0, "map catalog missing Village maps");
A.send({ t: "createRoom", title: "lifecycle", map: village, mode: 0 });
const created = await A.next((m) => m.t === "roomState" && m.room.title === "lifecycle");
const roomId = created.room.id;
assert(created.room.hostId === "room-host", "hostId not set");
B.send({ t: "enterLobby" });
const isolated = await B.next((m) => m.t === "lobbyState");
assert(!isolated.rooms.some((r: any) => r.id === roomId), "channel isolation failed");
B.send({ t: "selectChannel", channel: 0 });
const lobby = await B.next((m) => m.t === "lobbyState" && m.rooms.some((r: any) => r.id === roomId));
assert(lobby, "room not visible after channel switch");
B.send({ t: "joinRoom", room: roomId });
const joined = await B.next((m) => m.t === "roomState" && m.room.players.length === 2);
assert(joined.room.players.find((p: any) => p.id === "room-guest").ready === false, "guest should start unready");
A.send({ t: "startGame" });
const notReady = await A.next((m) => m.t === "error" && m.code === "notReady");
assert(notReady, "host start should require ready guests");
B.send({ t: "selectCharacter", character: 1 });
const charChanged = await B.next((m) => m.t === "roomState" && m.room.players.find((p: any) => p.id === "room-guest")?.character === 1);
assert(charChanged, "character selection failed");
B.send({ t: "ready", ready: true });
await B.next((m) => m.t === "roomState" && m.room.players.find((p: any) => p.id === "room-guest")?.ready === true);
A.send({ t: "setMap", map: village05 });
const mapChanged = await A.next((m) => m.t === "roomState" && m.room.map === village05);
assert(mapChanged.room.players.find((p: any) => p.id === "room-guest").ready === false, "map change should reset ready");
B.send({ t: "ready", ready: true });
await B.next((m) => m.t === "roomState" && m.room.players.find((p: any) => p.id === "room-guest")?.ready === true);
A.send({ t: "startGame" });
const [ga, gb] = await Promise.all([A.next((m) => m.t === "gameStart"), B.next((m) => m.t === "gameStart")]);
assert(ga.state.map === "Village05" && gb.state.map === "Village05", "game started on wrong map");
assert(ga.state.fuseMs === 2000, "practice fuse reference should be 2000ms");
const frame = await A.next((m) => m.t === "gameFrame");
assert(frame.state.timeMs % 30 === 0, "snapshot time must be a 30ms multiple");
B.send({ t: "leaveRoom" });
await B.next((m) => m.t === "lobbyState");
const afterLeave = await A.next((m) => m.t === "roomState" && m.room.players.length === 1);
assert(afterLeave.room.hostId === "room-host", "host lost after guest leave");
A.send({ t: "leaveRoom" });
const empty = await A.next((m) => m.t === "lobbyState" && !m.rooms.some((r: any) => r.id === roomId));
assert(empty, "room not cleaned up after last player leaves");
A.close(); B.close();
console.log("ROOMS_OK", JSON.stringify({ roomId, map: ga.state.map, players: ga.state.players.length, fuseMs: ga.state.fuseMs, frameMs: frame.state.timeMs }));
process.exit(0);
