/** WebSocket client for the original (self-created) game server. */
import type { C2S, S2C } from "../../shared/protocol.ts";

type Handler = (msg: S2C) => void;

export class NetClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();
  private queue: C2S[] = [];
  connected = false;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        for (const m of this.queue) ws.send(JSON.stringify(m));
        this.queue.length = 0;
        resolve();
      };
      ws.onerror = () => reject(new Error("ws error"));
      ws.onclose = () => {
        this.connected = false;
      };
      ws.onmessage = (ev) => {
        let msg: S2C;
        try {
          msg = JSON.parse(ev.data as string) as S2C;
        } catch {
          return;
        }
        this.handlers.get(msg.t)?.forEach((h) => h(msg));
        this.anyHandlers.forEach((h) => h(msg));
      };
    });
  }

  send(msg: C2S) {
    if (this.ws && this.connected) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  on(type: S2C["t"], handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }
}