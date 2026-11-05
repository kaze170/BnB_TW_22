import type { Direction } from "../shared/constants.ts";
import { type BinaryReader, BinaryWriter, PacketCipher } from "../shared/crypto.ts";
import {
  ClientOpcode,
  ServerOpcode,
  encodeJsonPayload,
} from "../shared/protocol.ts";

export type PacketListener = (opcode: ServerOpcode, reader: BinaryReader) => void;

export class PacketSocketClient {
  private ws: WebSocket | null = null;
  private cipher = new PacketCipher();
  private listeners: PacketListener[] = [];
  public connected = false;

  public connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.cipher = new PacketCipher();
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        resolve();
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        let offset = 0;
        while (offset + 7 <= bytes.byteLength) {
          const bodyLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
          const frameLen = 5 + bodyLen;
          if (offset + frameLen > bytes.byteLength) break;

          const slice = bytes.subarray(offset, offset + frameLen);
          offset += frameLen;

          const decoded = this.cipher.unframePacket(slice, true);
          if (decoded) {
            for (const fn of this.listeners) {
              fn(decoded.opcode as ServerOpcode, decoded.reader);
              decoded.reader.seek(0);
            }
          }
        }
      };

      ws.onclose = () => {
        this.connected = false;
      };
      ws.onerror = () => {
        resolve();
      };
    });
  }

  public onPacket(fn: PacketListener): void {
    this.listeners.push(fn);
  }

  public sendRaw(opcode: ClientOpcode, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = this.cipher.framePacket(opcode, payload, false);
    this.ws.send(frame as unknown as BufferSource);
  }

  public sendJson<T>(opcode: ClientOpcode, data: T): void {
    this.sendRaw(opcode, encodeJsonPayload(data));
  }

  public sendBomberInput(
    slotIndex: number,
    dir: Direction,
    placeBomb: boolean,
    useCtrl: boolean,
    useAlt: boolean,
  ): void {
    const w = new BinaryWriter(8);
    w.u8(slotIndex);
    w.i8(dir);
    let flags = 0;
    if (placeBomb) flags |= 1;
    if (useCtrl) flags |= 2;
    if (useAlt) flags |= 4;
    w.u8(flags);
    this.sendRaw(ClientOpcode.BomberPosSync, w.toUint8Array());
  }
}
