import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { GameServer } from "../src/server/gameServer.ts";
import type { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";
import type { S2C } from "../src/shared/protocol.ts";

class FakeSocket {
  messages: S2C[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw) as S2C); }
}
function socket(): ServerWebSocket<unknown> { return new FakeSocket() as unknown as ServerWebSocket<unknown>; }
function fake(ws: ServerWebSocket<unknown>) { return ws as unknown as FakeSocket; }
function send(server: GameServer, ws: ServerWebSocket<unknown>, msg: unknown) { server.message(ws, JSON.stringify(msg)); }
function last(ws: ServerWebSocket<unknown>, t: S2C["t"]): S2C | undefined {
  const list = fake(ws).messages;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.t === t) return list[i];
  return undefined;
}

describe("original server room lifecycle", () => {
  test("gameEnd enters results; room reopens only after every human returns", () => {
    const server = new GameServer();
    const host = socket(), guest = socket();
    server.open(host); server.open(guest);
    send(server, host, { t: "login", id: "lifecycle-host", pw: "" });
    send(server, guest, { t: "login", id: "lifecycle-guest", pw: "" });
    for (const ws of [host, guest]) {
      send(server, ws, { t: "selectServer", server: 1 });
      send(server, ws, { t: "selectChannel", channel: 0 });
    }
    const map = MAP_NAMES.indexOf("Village00");
    send(server, host, { t: "createRoom", title: "result-roundtrip", map, mode: 0 });
    const created = last(host, "roomState");
    if (!created || created.t !== "roomState") throw new Error("missing created room");
    const roomId = created.room.id;
    send(server, guest, { t: "joinRoom", room: roomId });
    send(server, guest, { t: "ready", ready: true });

    // Capture the production interval callback instead of waiting in real time.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let tick: (() => void) | null = null;
    let cleared = 0;
    globalThis.setInterval = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
      tick = () => handler(...args);
      return 987654 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((_id?: ReturnType<typeof setInterval>) => { cleared++; }) as typeof clearInterval;
    try {
      send(server, host, { t: "startGame" });
      expect(tick).not.toBeNull();
      const sims = (server as unknown as { sims: Map<number, { sim: GameSimulation }> }).sims;
      const sim = sims.get(roomId)!.sim;
      // Deterministically end the authoritative match: only the host survives.
      for (const b of sim.bombers) if (b.id !== "lifecycle-host") sim.removePlayer(b.id);
      sim.tick(30); // evaluate the win condition without relying on wall-clock delta
      tick!();
      expect(cleared).toBe(1);
      expect(sim.over).toBe(true);
      expect(last(host, "gameEnd")?.t).toBe("gameEnd");
      const ended = last(host, "roomState");
      if (!ended || ended.t !== "roomState") throw new Error("missing results roomState");
      expect(ended.room.state).toBe("results");

      send(server, host, { t: "returnToRoom" });
      const partial = last(host, "roomState");
      if (!partial || partial.t !== "roomState") throw new Error("missing partial return");
      expect(partial.room.state).toBe("results"); // guest has not acknowledged yet
      send(server, guest, { t: "joinRoom", room: roomId });
      const blocked = last(guest, "error");
      if (!blocked || blocked.t !== "error") throw new Error("results room should reject join");
      expect(blocked.code).toBe("playing");

      send(server, guest, { t: "returnToRoom" });
      for (const ws of [host, guest]) {
        const ready = last(ws, "roomState");
        if (!ready || ready.t !== "roomState") throw new Error("missing reopened room");
        expect(ready.room.state).toBe("waiting");
        expect(ready.room.players.find((p) => p.id === "lifecycle-host")?.ready).toBe(true);
        expect(ready.room.players.find((p) => p.id === "lifecycle-guest")?.ready).toBe(false);
      }
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});
