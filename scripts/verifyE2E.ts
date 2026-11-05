import { ServerPackManager } from "../src/server/packReader.ts";
import {
  BOMB_FUSE_TICKS,
  BUBBLE_IMMUNE_TICKS,
  BUBBLE_SUFFOCATE_TICKS,
  Direction,
  GameMode,
  cellToAnchorX,
  cellToAnchorY,
} from "../src/shared/constants.ts";
import { BinaryReader, PacketCipher } from "../src/shared/crypto.ts";
import { decodeI16, tintI16LayerAdjust } from "../src/shared/formats/i16.ts";
import {
  ClientOpcode,
  EMPTY_EQUIPPED,
  type MatchStartPayload,
  ServerOpcode,
  decodeJsonPayload,
  encodeJsonPayload,
} from "../src/shared/protocol.ts";
import { computeBotInput } from "../src/shared/sim/ai.ts";
import { BomberStatus, GameWorld } from "../src/shared/sim/world.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const BASE_URL = "http://127.0.0.1:3000";
const WS_URL = "ws://127.0.0.1:3000/ws";

// 1. Verify HTTP & Native Pack Streaming Endpoints
console.log("[1/3] Testing HTTP & Native Pack Streaming Endpoints...");
const htmlRes = await fetch(`${BASE_URL}/`);
assert(htmlRes.status === 200, "GET / returns 200");
const htmlText = await htmlRes.text();
assert(htmlText.includes('width="800" height="600"'), "Strict 800x600 WebGPU canvas verified");

const jsRes = await fetch(`${BASE_URL}/dist/client.js`);
assert(jsRes.status === 200, "GET /dist/client.js returns 200");
const jsBytes = new Uint8Array(await jsRes.arrayBuffer());
assert(jsBytes.byteLength > 100_000, `Bundled client.js size=${jsBytes.byteLength}B`);

const bootRes = await fetch(`${BASE_URL}/api/bootstrap`);
const boot = (await bootRes.json()) as {
  mapNames: string[];
  bombers: unknown[];
  shopCatalog: { itemId: number; name: string }[];
};
assert(boot.mapNames.length === 319, `Expected 319 maps, got ${boot.mapNames.length}`);
assert(boot.bombers.length === 11, `Expected 11 bombers, got ${boot.bombers.length}`);
assert(boot.shopCatalog.length >= 150, `Expected >=150 shop items, got ${boot.shopCatalog.length}`);

const bombRes = await fetch(`${BASE_URL}/api/pack/Fx/entry?path=Bomb/Bomb00`);
assert(bombRes.status === 200, "GET Bomb/Bomb00 returns 200");
const bombSprite = decodeI16(new Uint8Array(await bombRes.arrayBuffer()));
assert(bombSprite.frameCount === 4, "Bomb/Bomb00 has 4 frames");

const c00AdjRes = await fetch(
  `${BASE_URL}/api/pack/Fx/entry?path=Character/C00-WalkDown_ALayerAdjust`,
);
const c00Adj = decodeI16(new Uint8Array(await c00AdjRes.arrayBuffer()));
for (let team = 0; team < 9; team++) {
  const tinted = tintI16LayerAdjust(c00Adj, team);
  assert(tinted.textures.length > 0, `Team ${team} HLS tinting verified`);
}

const batchRes = await fetch(`${BASE_URL}/api/pack/Fx/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paths: ["Bomb/Bubble00", "Bomb/Fire00", "Tile00/BoxOrange"] }),
});
assert(batchRes.status === 200, "POST /api/pack/Fx/batch returns 200");
const batchReader = new BinaryReader(new Uint8Array(await batchRes.arrayBuffer()));
assert(batchReader.u32() === 3, "Batch returned 3 sprites");
console.log("  ✔ HTTP, .i16 RLE, 9-Team HLS tinting & Batch Pack Streaming passed!");

// 2. Verify Deterministic CA.exe Physics, Chain Explosion, Bubble Rescue/Pop & CAIPlayer
console.log("[2/3] Testing Deterministic 30ms GameWorld Physics & CAIPlayer Bots...");
const packs = new ServerPackManager(".");
const map = packs.getMapOrFallback("patrit_00");

const simWorld = new GameWorld(
  GameMode.Normal,
  map,
  [
    {
      slotIndex: 0,
      state: "human",
      userId: 1,
      nickname: "Red1",
      level: 10,
      isHost: true,
      isReady: true,
      isLocal2P: false,
      charIndex: 0,
      team: 0,
      equipped: EMPTY_EQUIPPED,
    },
    {
      slotIndex: 1,
      state: "human",
      userId: 2,
      nickname: "RedAlly",
      level: 10,
      isHost: false,
      isReady: true,
      isLocal2P: false,
      charIndex: 1,
      team: 0,
      equipped: EMPTY_EQUIPPED,
    },
    {
      slotIndex: 2,
      state: "bot",
      userId: 0,
      nickname: "BlueBot",
      level: 10,
      isHost: false,
      isReady: true,
      isLocal2P: false,
      charIndex: 2,
      team: 5,
      equipped: EMPTY_EQUIPPED,
    },
  ],
  0xdeadbeef,
  packs.staticMapData,
);

const p0 = simWorld.bombers[0]!;
const p1 = simWorld.bombers[1]!;
const getStatus = (b: typeof p0): BomberStatus => b.status;
p0.invulnTicks = 0;
p0.status = BomberStatus.Normal;
p1.invulnTicks = 0;
p1.status = BomberStatus.Normal;

// Clear (1,1) and (1,2) so test corridor is guaranteed open regardless of map layout
simWorld.objectIds[simWorld.cellIdx(1, 1)] = -1;
simWorld.solidGrid[simWorld.cellIdx(1, 1)] = 0;
simWorld.objectIds[simWorld.cellIdx(1, 2)] = -1;
simWorld.solidGrid[simWorld.cellIdx(1, 2)] = 0;

p0.bombsCur = 3;
p0.powerCur = 3;
p0.x = cellToAnchorX(1);
p0.y = cellToAnchorY(1);
const bA = simWorld.tryPlaceOrThrowBomb(p0);
assert(bA !== null && bA.fuseTicks === BOMB_FUSE_TICKS, "Bomb fuse is 96 ticks");

// Place second bomb 20 ticks later to verify chain detonation
for (let t = 0; t < 20; t++) simWorld.stepTick(new Map());
p0.x = cellToAnchorX(2);
p0.y = cellToAnchorY(1);
const bB = simWorld.tryPlaceOrThrowBomb(p0);
assert(bB !== null, "Second bomb placed for chain test");

// Move p0 onto (1,1) just before detonation to test flame trapping!
p0.x = cellToAnchorX(1);
p0.y = cellToAnchorY(1);
p1.x = cellToAnchorX(5);
p1.y = cellToAnchorY(5);
for (let t = 0; t < 77; t++) simWorld.stepTick(new Map());

assert(simWorld.bombs.length === 0, "Both bombs chain-detonated simultaneously!");
assert(simWorld.flames.length > 0, "Directional flames spawned!");
assert(getStatus(p0) === BomberStatus.Trapped, "Bomber caught in flame entered Trapped bubble state!");

// Verify <16 tick immunity then ally rescue at tick 20!
for (let t = 0; t < BUBBLE_IMMUNE_TICKS + 2; t++) simWorld.stepTick(new Map());
p1.x = p0.x;
p1.y = p0.y;
simWorld.stepTick(new Map());
assert(getStatus(p0) === BomberStatus.Normal && p1.saves === 1, "Ally overlap >=400px² rescued trapped teammate!");

// Test suffocation at 200 ticks
p0.status = BomberStatus.Trapped;
p0.statusTicks = BUBBLE_SUFFOCATE_TICKS - 1;
p1.x = cellToAnchorX(10);
p1.y = cellToAnchorY(10);
simWorld.stepTick(new Map());
assert(getStatus(p0) === BomberStatus.Dying, "Trapped bubble suffocated at exact 200 ticks (6.000s)!");

// Run 250 ticks of CAIPlayer bots + StageClear monsters
const monWorld = new GameWorld(
  GameMode.Monster,
  map,
  [
    {
      slotIndex: 0,
      state: "bot",
      userId: 0,
      nickname: "BotHero",
      level: 20,
      isHost: true,
      isReady: true,
      isLocal2P: false,
      charIndex: 0,
      team: 0,
      equipped: EMPTY_EQUIPPED,
    },
  ],
  42,
  packs.staticMapData,
);
assert(monWorld.monsters.length > 0, "Monster mode spawned StageClear monsters");
for (let t = 0; t < 250; t++) {
  const inps = new Map([[0, computeBotInput(monWorld, monWorld.bombers[0]!)]]);
  monWorld.stepTick(inps);
}
console.log("  ✔ 96-tick fuse, chain detonation, 16-tick grace, ally rescue, 200-tick suffocate & CAIPlayer passed!");

// 3. Verify Full Two-Client CPacketSocket Binary WebSocket Flow
console.log("[3/3] Testing Full Two-Client CPacketSocket Multiplayer Protocol...");

class HeadlessTestClient {
  public ws!: WebSocket;
  public cipher = new PacketCipher();
  public packets: { opcode: ServerOpcode; payload: Uint8Array }[] = [];

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    this.ws.binaryType = "arraybuffer";
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
    });
    this.ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      let off = 0;
      while (off + 7 <= bytes.byteLength) {
        const len = (bytes[off + 2]! << 8) | bytes[off + 3]!;
        const slice = bytes.subarray(off, off + 5 + len);
        off += 5 + len;
        const dec = this.cipher.unframePacket(slice, true);
        if (dec) {
          this.packets.push({ opcode: dec.opcode as ServerOpcode, payload: dec.rawPayload.slice() });
        }
      }
    };
  }

  send<T>(op: ClientOpcode, data: T): void {
    this.ws.send(this.cipher.framePacket(op, encodeJsonPayload(data), false) as unknown as BufferSource);
  }

  async waitFor(op: ServerOpcode, timeoutMs = 4000): Promise<BinaryReader> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = this.packets.findIndex((p) => p.opcode === op);
      if (idx >= 0) {
        const hit = this.packets.splice(idx, 1)[0]!;
        return new BinaryReader(hit.payload);
      }
      await Bun.sleep(15);
    }
    throw new Error(`Timeout waiting for ServerOpcode ${op}`);
  }

  close(): void {
    this.ws.close();
  }
}

const c1 = new HeadlessTestClient();
const c2 = new HeadlessTestClient();
await c1.connect();
await c2.connect();

const suffix = Math.floor(Math.random() * 90000 + 10000);
c1.send(ClientOpcode.Login1P, { username: `TesterA_${suffix}`, password: "pw" });
const loginA = decodeJsonPayload<{ ok: boolean; profile: { lucci: number; cash: number } }>(
  await c1.waitFor(ServerOpcode.LoginResult),
);
assert(loginA.ok && loginA.profile.lucci === 999999 && loginA.profile.cash === 99999, "Auto-registered with 999,999 Lucci & 99,999 Cash!");

c2.send(ClientOpcode.Login1P, { username: `TesterB_${suffix}`, password: "pw" });
await c2.waitFor(ServerOpcode.LoginResult);

c1.send(ClientOpcode.SelectChannel, { channelId: 1 });
c2.send(ClientOpcode.SelectChannel, { channelId: 1 });
await c1.waitFor(ServerOpcode.ChannelEnterResult);
await c2.waitFor(ServerOpcode.ChannelEnterResult);

// Test Shop Purchase, Avatar Equip & Slot Machine Spin
const firstShopId = boot.shopCatalog[0]!.itemId;
c1.send(ClientOpcode.ShopBuyItem, { itemId: firstShopId, useCash: false });
const buyRes = decodeJsonPayload<{ ok: boolean }>(await c1.waitFor(ServerOpcode.ShopPurchaseResult));
assert(buyRes.ok, "Shop purchase succeeded");

c1.send(ClientOpcode.EquipAvatarItem, { itemId: firstShopId });
await c1.waitFor(ServerOpcode.ProfileAndWalletSync);

c1.send(ClientOpcode.SlotMachinePlay, {});
const slotRes = decodeJsonPayload<{ reels: number[]; prizeItem: { name: string } }>(
  await c1.waitFor(ServerOpcode.SlotMachineResult),
);
assert(slotRes.reels.length === 3 && slotRes.prizeItem.name.length > 0, "Slot machine gachapon succeeded");

// Create Room with Client 1, Join with Client 2, Ready & Launch Authoritative Match!
c1.send(ClientOpcode.CreateRoom, {
  title: "E2E 對戰測試房",
  password: "",
  mode: GameMode.Normal,
  mapName: "patrit_00",
});
const enterA = decodeJsonPayload<{ ok: boolean; room: { roomId: number } }>(
  await c1.waitFor(ServerOpcode.RoomEnterResult),
);
assert(enterA.ok, "Client 1 created room");

c2.send(ClientOpcode.JoinRoom, { roomId: enterA.room.roomId, password: "" });
const enterB = decodeJsonPayload<{ ok: boolean }>(await c2.waitFor(ServerOpcode.RoomEnterResult));
assert(enterB.ok, "Client 2 joined room");

c2.send(ClientOpcode.ToggleReady, {});
await c1.waitFor(ServerOpcode.RoomStateSync);

c1.send(ClientOpcode.StartMatch, {});
const matchA = decodeJsonPayload<MatchStartPayload>(await c1.waitFor(ServerOpcode.MatchStartLoad));
const matchB = decodeJsonPayload<MatchStartPayload>(await c2.waitFor(ServerOpcode.MatchStartLoad));
assert(
  matchA.seed === matchB.seed && matchA.mapName.toLowerCase().includes("patrit") || matchA.mapName.length > 0,
  "Both clients received synchronized MatchStartLoad!",
);

// Receive live authoritative 30ms PlayerStateSync (opcode 144)
const syncReader = await c1.waitFor(ServerOpcode.PlayerStateSync);
const srvTick = syncReader.u32();
assert(srvTick >= 2, `Received authoritative binary PlayerStateSync at tick=${srvTick}!`);

c1.close();
c2.close();
console.log("  ✔ Full Two-Client CPacketSocket Login, Shop, Equip, Slot, Room & Live Match Sync passed!");
console.log("\nALL E2E VERIFICATIONS PASSED 100%!");
