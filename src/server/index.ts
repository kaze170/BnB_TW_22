import type { ServerWebSocket } from "bun";
import { Direction, GameMode, TICK_MS } from "../shared/constants.ts";
import { BinaryReader, BinaryWriter, PacketCipher } from "../shared/crypto.ts";
import type { ArchiveName } from "../shared/formats/packIndex.ts";
import {
  type ChannelInfoDTO,
  ClientOpcode,
  EMPTY_EQUIPPED,
  type ExchangeStateDTO,
  type FriendDTO,
  type MatchPlayerScore,
  type MatchResultPayload,
  type MatchStartPayload,
  type RoomDetailDTO,
  type RoomSlotDTO,
  type RoomSummaryDTO,
  ServerOpcode,
  type ShopItemDTO,
  type UserProfileDTO,
  decodeJsonPayload,
  encodeJsonPayload,
} from "../shared/protocol.ts";
import { computeBotInput } from "../shared/sim/ai.ts";
import { GameWorld, type PlayerInputState } from "../shared/sim/world.ts";
import { GameDatabase } from "./db.ts";
import { ServerPackManager } from "./packReader.ts";
import { buildShopCatalog } from "./shopCatalog.ts";

console.log("[BnB Server] Loading native .idx/.idd packs & game data...");
const packs = new ServerPackManager(".");
const db = new GameDatabase("bnb_tw22.sqlite");
const shopCatalog = buildShopCatalog(packs);
const shopById = new Map<number, ShopItemDTO>(shopCatalog.map((i) => [i.itemId, i]));

console.log(
  `[BnB Server] Ready: ${packs.mapNames.length} maps, ${packs.bombers.length} characters, ${shopCatalog.length} shop items.`,
);

interface ClientSession {
  id: number;
  ws: ServerWebSocket<ClientSession>;
  cipher: PacketCipher;
  profile: UserProfileDTO | null;
  hasLocal2P: boolean;
  local2PNickname: string;
  local2PChar: number;
  channelId: number;
  roomId: number;
  stageName: string;
  exchangeSessionId: number;
}

interface ActiveRoom {
  roomId: number;
  roomNumber: number;
  channelId: number;
  title: string;
  password: string;
  mode: GameMode;
  mapName: string;
  status: "waiting" | "playing";
  hostSlot: number;
  slots: (RoomSlotDTO & { sessionId: number })[];
  // Active authoritative simulation during match
  world: GameWorld | null;
  latestInputs: Map<number, PlayerInputState>;
  seed: number;
}

interface ExchangeSession {
  sessionId: number;
  a: ClientSession;
  b: ClientSession;
  itemsA: number[];
  lucciA: number;
  lockedA: boolean;
  itemsB: number[];
  lucciB: number;
  lockedB: boolean;
}

const CHANNELS: Omit<ChannelInfoDTO, "currentUsers">[] = [
  { id: 1, name: "新手歡樂頻道 1", category: "beginner", maxUsers: 200, minLevel: 1, maxLevel: 50 },
  { id: 2, name: "自由對戰頻道 1", category: "free", maxUsers: 300, minLevel: 1, maxLevel: 450 },
  { id: 3, name: "自由對戰頻道 2", category: "free", maxUsers: 300, minLevel: 1, maxLevel: 450 },
  { id: 4, name: "高手競技頻道", category: "pro", maxUsers: 200, minLevel: 1, maxLevel: 450 },
  { id: 5, name: "怪物合作挑戰", category: "mission", maxUsers: 200, minLevel: 1, maxLevel: 450 },
  { id: 6, name: "自由拍賣市場", category: "market", maxUsers: 300, minLevel: 1, maxLevel: 450 },
];

let nextSessionId = 1;
let nextRoomId = 1;
let nextExchangeId = 1;

const sessions = new Map<number, ClientSession>();
const sessionsByUserId = new Map<number, ClientSession>();
const rooms = new Map<number, ActiveRoom>();
const exchanges = new Map<number, ExchangeSession>();

function sendPacket(sess: ClientSession, opcode: ServerOpcode, payload: Uint8Array): void {
  try {
    const frame = sess.cipher.framePacket(opcode, payload, true);
    sess.ws.sendBinary(frame);
  } catch {
    // closed socket
  }
}

function sendJson<T>(sess: ClientSession, opcode: ServerOpcode, data: T): void {
  sendPacket(sess, opcode, encodeJsonPayload(data));
}

function sendToast(sess: ClientSession, message: string): void {
  sendJson(sess, ServerOpcode.SystemToast, { message });
}

function getChannelList(): ChannelInfoDTO[] {
  return CHANNELS.map((c) => {
    let count = 0;
    for (const s of sessions.values()) {
      if (s.channelId === c.id) count++;
    }
    return { ...c, currentUsers: count };
  });
}

function summarizeRoom(r: ActiveRoom): RoomSummaryDTO {
  const activeCount = r.slots.filter((s) => s.state === "human" || s.state === "bot").length;
  const maxOpen = r.slots.filter((s) => s.state !== "closed").length;
  return {
    roomId: r.roomId,
    roomNumber: r.roomNumber,
    title: r.title,
    hasPassword: r.password.length > 0,
    mode: r.mode,
    mapName: r.mapName,
    playerCount: activeCount,
    maxPlayers: Math.max(1, maxOpen),
    status: r.status,
  };
}

function detailRoom(r: ActiveRoom): RoomDetailDTO {
  return {
    roomId: r.roomId,
    roomNumber: r.roomNumber,
    title: r.title,
    hasPassword: r.password.length > 0,
    mode: r.mode,
    mapName: r.mapName,
    status: r.status,
    hostSlot: r.hostSlot,
    slots: r.slots.map(({ sessionId: _sid, ...rest }) => rest),
  };
}

function broadcastChannelLobby(channelId: number): void {
  const roomList = [...rooms.values()]
    .filter((r) => r.channelId === channelId)
    .map(summarizeRoom);
  const users = [...sessions.values()]
    .filter((s) => s.channelId === channelId && s.profile)
    .map((s) => ({
      userId: s.profile!.userId,
      nickname: s.profile!.nickname,
      level: s.profile!.level,
      roomId: s.roomId,
    }));

  for (const s of sessions.values()) {
    if (s.channelId === channelId && s.roomId === 0) {
      sendJson(s, ServerOpcode.RoomListSync, { rooms: roomList });
      sendJson(s, ServerOpcode.OnlineUsersList, { users });
    }
  }
}

function broadcastRoom(r: ActiveRoom, opcode: ServerOpcode, payload: Uint8Array): void {
  const notified = new Set<number>();
  for (const slot of r.slots) {
    if (slot.state === "human" && slot.sessionId > 0 && !notified.has(slot.sessionId)) {
      notified.add(slot.sessionId);
      const sess = sessions.get(slot.sessionId);
      if (sess) sendPacket(sess, opcode, payload);
    }
  }
}

function syncRoomState(r: ActiveRoom): void {
  const payload = encodeJsonPayload(detailRoom(r));
  broadcastRoom(r, ServerOpcode.RoomStateSync, payload);
  broadcastChannelLobby(r.channelId);
}

function syncUserEconomyAndInventory(sess: ClientSession): void {
  if (!sess.profile) return;
  const fresh = db.getProfileById(sess.profile.userId);
  if (fresh) sess.profile = fresh;
  sendJson(sess, ServerOpcode.ProfileAndWalletSync, sess.profile);
  sendJson(sess, ServerOpcode.InventorySync, { items: db.getInventory(sess.profile.userId) });
  sendJson(sess, ServerOpcode.QuestSync, { quests: db.getQuests(sess.profile.userId) });
  sendJson(sess, ServerOpcode.NoteListSync, { notes: db.getNotes(sess.profile.nickname) });
  syncFriends(sess);
}

function syncFriends(sess: ClientSession): void {
  if (!sess.profile) return;
  const fids = db.getFriendIds(sess.profile.userId);
  const friends: FriendDTO[] = [];
  for (const fid of fids) {
    const fp = db.getProfileById(fid);
    if (!fp) continue;
    const onlineSess = sessionsByUserId.get(fid);
    friends.push({
      userId: fp.userId,
      nickname: fp.nickname,
      level: fp.level,
      online: !!onlineSess,
      channelId: onlineSess?.channelId ?? 0,
      roomId: onlineSess?.roomId ?? 0,
    });
  }
  sendJson(sess, ServerOpcode.FriendListSync, { friends });
}

function leaveCurrentRoom(sess: ClientSession): void {
  if (sess.roomId === 0) return;
  const room = rooms.get(sess.roomId);
  sess.roomId = 0;
  if (!room) return;

  for (const sl of room.slots) {
    if (sl.sessionId === sess.id) {
      sl.state = "open";
      sl.sessionId = 0;
      sl.userId = 0;
      sl.nickname = "";
      sl.isHost = false;
      sl.isReady = false;
      sl.isLocal2P = false;
      sl.equipped = { ...EMPTY_EQUIPPED };
    }
  }

  const remainingHumans = room.slots.filter((s) => s.state === "human");
  if (remainingHumans.length === 0) {
    rooms.delete(room.roomId);
    broadcastChannelLobby(room.channelId);
    return;
  }

  if (!room.slots[room.hostSlot] || room.slots[room.hostSlot]!.state !== "human") {
    const nextHost = remainingHumans[0]!;
    room.hostSlot = nextHost.slotIndex;
    nextHost.isHost = true;
    nextHost.isReady = true;
  }

  syncRoomState(room);
}

const BOT_NAMES = [
  "藍寶AI",
  "痞子妹AI",
  "工頭AI",
  "粟子AI",
  "小蜜桃AI",
  "睏寶AI",
  "囡囡AI",
  "ㄚ肥AI",
];

function createNewRoom(
  sess: ClientSession,
  title: string,
  password: string,
  mode: GameMode,
  mapName: string,
): ActiveRoom {
  leaveCurrentRoom(sess);
  const p = sess.profile!;

  // Pick smallest unused room number in channel
  const usedNums = new Set(
    [...rooms.values()].filter((r) => r.channelId === sess.channelId).map((r) => r.roomNumber),
  );
  let roomNumber = 1;
  while (usedNums.has(roomNumber)) roomNumber++;

  const validMap = packs.getMapOrFallback(mapName).mapName;
  const slots: (RoomSlotDTO & { sessionId: number })[] = [];
  for (let i = 0; i < 8; i++) {
    slots.push({
      slotIndex: i,
      state: "open",
      sessionId: 0,
      userId: 0,
      nickname: "",
      level: 1,
      isHost: false,
      isReady: false,
      isLocal2P: false,
      charIndex: i % 8,
      team: i % 2 === 0 ? 0 : 5, // Default Red (0) vs Blue (5)!
      equipped: { ...EMPTY_EQUIPPED },
    });
  }

  slots[0] = {
    slotIndex: 0,
    state: "human",
    sessionId: sess.id,
    userId: p.userId,
    nickname: p.nickname,
    level: p.level,
    isHost: true,
    isReady: true,
    isLocal2P: false,
    charIndex: p.defaultChar,
    team: 0,
    equipped: { ...p.equipped },
  };

  // Auto-seat 2P if logged in on same PC!
  if (sess.hasLocal2P) {
    slots[1] = {
      slotIndex: 1,
      state: "human",
      sessionId: sess.id,
      userId: p.userId,
      nickname: sess.local2PNickname || `${p.nickname}_2P`,
      level: p.level,
      isHost: false,
      isReady: true,
      isLocal2P: true,
      charIndex: sess.local2PChar,
      team: 0,
      equipped: { ...p.equipped },
    };
  }

  // If Practice mode or Mission channel, pre-add a friendly/rival AI bot in slot 1/2 so user can start in 1 click!
  if (mode === GameMode.Practice) {
    const botSlot = sess.hasLocal2P ? 2 : 1;
    slots[botSlot] = {
      slotIndex: botSlot,
      state: "bot",
      sessionId: 0,
      userId: 0,
      nickname: BOT_NAMES[botSlot % BOT_NAMES.length]!,
      level: Math.max(1, p.level),
      isHost: false,
      isReady: true,
      isLocal2P: false,
      charIndex: botSlot % 8,
      team: 5, // Blue
      equipped: { ...EMPTY_EQUIPPED },
    };
  }

  const room: ActiveRoom = {
    roomId: nextRoomId++,
    roomNumber,
    channelId: sess.channelId,
    title: title.trim() || "一起來玩爆爆王吧！",
    password: password.trim(),
    mode,
    mapName: validMap,
    status: "waiting",
    hostSlot: 0,
    slots,
    world: null,
    latestInputs: new Map(),
    seed: 0,
  };

  rooms.set(room.roomId, room);
  sess.roomId = room.roomId;
  return room;
}

function startRoomMatch(room: ActiveRoom): void {
  const mapObj = packs.getMapOrFallback(room.mapName);
  room.mapName = mapObj.mapName;
  room.status = "playing";
  room.seed = (Date.now() ^ (room.roomId * 0x9e3779b9)) >>> 0;
  room.latestInputs.clear();

  const cleanSlots: RoomSlotDTO[] = room.slots.map(({ sessionId: _s, ...dto }) => dto);
  room.world = new GameWorld(room.mode, mapObj, cleanSlots, room.seed, packs.staticMapData);

  // Notify each connected human session with their primary & secondary (2P) slot indices
  const notified = new Set<number>();
  for (const sl of room.slots) {
    if (sl.state !== "human" || sl.sessionId === 0 || notified.has(sl.sessionId)) continue;
    notified.add(sl.sessionId);
    const sess = sessions.get(sl.sessionId);
    if (!sess) continue;

    const myPrimary = room.slots.find((x) => x.sessionId === sess.id && !x.isLocal2P)?.slotIndex ?? sl.slotIndex;
    const mySecondary = room.slots.find((x) => x.sessionId === sess.id && x.isLocal2P)?.slotIndex ?? -1;

    const startPayload: MatchStartPayload = {
      roomId: room.roomId,
      seed: room.seed,
      mode: room.mode,
      mapName: room.mapName,
      slots: cleanSlots,
      myPrimarySlot: myPrimary,
      mySecondarySlot: mySecondary,
    };
    sendJson(sess, ServerOpcode.MatchStartLoad, startPayload);
  }

  broadcastChannelLobby(room.channelId);
}

/**
 * Authoritative 30 ms simulation loop across all playing rooms!
 */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== "playing" || !room.world) continue;
    const world = room.world;

    // Compute CAIPlayer bot inputs
    for (const b of world.bombers) {
      if (b.isBot) {
        room.latestInputs.set(b.slotIndex, computeBotInput(world, b));
      }
    }

    world.stepTick(room.latestInputs);

    // Clear one-shot action flags (placeBomb / useCtrl / useAlt) after tick consumption
    for (const inp of room.latestInputs.values()) {
      inp.placeBomb = false;
      inp.useCtrl = false;
      inp.useAlt = false;
    }

    // Broadcast compact binary PlayerStateSync (opcode 144) every 2 ticks (60 ms) for multi-client lockstep correction
    if (world.tick % 2 === 0) {
      const w = new BinaryWriter(256);
      w.u32(world.tick);
      w.u16(world.timeRemainingTicks);
      w.u8(world.bombers.length);
      for (const b of world.bombers) {
        w.u8(b.slotIndex);
        w.i16(b.x);
        w.i16(b.y);
        w.i8(b.dir);
        w.u8(b.moving ? 1 : 0);
        w.u8(b.status);
        w.u16(b.statusTicks);
        w.u8(b.bombsCur);
        w.u8(b.powerCur);
        w.u8(b.speedCur);
        w.i8(b.mountType);
        w.u8(b.ctrlItem);
        w.u8(b.ctrlCount);
        w.u8(b.altItem);
        w.u8(b.altCount);
      }
      w.u8(world.bombs.length);
      for (const bm of world.bombs) {
        w.u16(bm.uid & 0xffff);
        w.u8(bm.ownerSlot);
        w.u8(bm.row);
        w.u8(bm.col);
        w.i16(bm.x);
        w.i16(bm.y);
        w.u8(bm.power);
        w.u16(Math.max(0, bm.fuseTicks));
      }
      broadcastRoom(room, ServerOpcode.PlayerStateSync, w.toUint8Array());
    }

    world.soundEvents.length = 0;

    if (world.finished) {
      finishRoomMatch(room);
    }
  }
}, TICK_MS);

function finishRoomMatch(room: ActiveRoom): void {
  const world = room.world!;
  const scores: MatchPlayerScore[] = [];
  const winnerSlots: number[] = [];

  for (const b of world.bombers) {
    const isWinner =
      world.winningTeam >= 100
        ? b.slotIndex === world.winningTeam - 100
        : world.winningTeam >= 0 && b.team === world.winningTeam;
    if (isWinner) winnerSlots.push(b.slotIndex);

    const outcome: "win" | "loss" | "draw" =
      world.winningTeam < 0 ? "draw" : isWinner ? "win" : "loss";
    const expGain =
      (outcome === "win" ? 120 : outcome === "draw" ? 55 : 40) +
      b.kills * 35 +
      b.saves * 25 +
      Math.min(40, b.blocksDestroyed * 2);
    const lucciGain =
      (outcome === "win" ? 350 : outcome === "draw" ? 150 : 100) +
      b.kills * 80 +
      b.saves * 50 +
      b.bonusLucci;

    let leveledUp = false;
    let newLevel = 1;

    const slotMeta = room.slots[b.slotIndex];
    if (slotMeta && slotMeta.state === "human" && !slotMeta.isLocal2P && slotMeta.userId > 0) {
      const updated = db.recordMatchOutcome(
        slotMeta.userId,
        outcome,
        expGain,
        lucciGain,
        b.kills,
      );
      leveledUp = updated.leveledUp;
      newLevel = updated.profile.level;
      slotMeta.level = newLevel;

      const sess = sessions.get(slotMeta.sessionId);
      if (sess) {
        sess.profile = updated.profile;
        syncUserEconomyAndInventory(sess);
      }
    }

    scores.push({
      slotIndex: b.slotIndex,
      nickname: b.nickname,
      team: b.team,
      kills: b.kills,
      saves: b.saves,
      blocks: b.blocksDestroyed,
      expGain,
      lucciGain,
      leveledUp,
      newLevel,
    });
  }

  const resPayload: MatchResultPayload = {
    winningTeam: world.winningTeam,
    winnerSlots,
    scores,
  };
  broadcastRoom(room, ServerOpcode.MatchResult, encodeJsonPayload(resPayload));

  room.status = "waiting";
  room.world = null;
  room.latestInputs.clear();
  for (const sl of room.slots) {
    if (sl.state === "human" && !sl.isHost && !sl.isLocal2P) {
      sl.isReady = false;
    }
  }
  syncRoomState(room);
}

function handleGmCommand(sess: ClientSession, rawText: string): boolean {
  if (!rawText.startsWith("/") || !sess.profile) return false;
  const parts = rawText.trim().split(/\s+/);
  const cmd = parts[0]!.toLowerCase();

  if (cmd === "/give_lucci") {
    const amt = Number(parts[1] || 100000);
    db.addCurrency(sess.profile.userId, amt, 0);
    syncUserEconomyAndInventory(sess);
    sendToast(sess, `[GM] 已獲得 ${amt.toLocaleString()} Lucci！`);
    return true;
  }
  if (cmd === "/give_cash") {
    const amt = Number(parts[1] || 50000);
    db.addCurrency(sess.profile.userId, 0, amt);
    syncUserEconomyAndInventory(sess);
    sendToast(sess, `[GM] 已獲得 ${amt.toLocaleString()} 樂豆點 (Cash)！`);
    return true;
  }
  if (cmd === "/unlock_all") {
    for (const item of shopCatalog) {
      if (!item.isPackage) db.grantItem(sess.profile.userId, item.itemId, 1);
    }
    syncUserEconomyAndInventory(sess);
    sendToast(sess, `[GM] 已解鎖全部 ${shopCatalog.length} 件商城造型與道具！`);
    return true;
  }
  if (cmd === "/level") {
    const lv = Number(parts[1] || 100);
    db.setLevel(sess.profile.userId, lv);
    syncUserEconomyAndInventory(sess);
    sendToast(sess, `[GM] 等級已設定為 Lv.${lv}！`);
    return true;
  }
  if (cmd === "/bot" && sess.roomId > 0) {
    const room = rooms.get(sess.roomId);
    if (room && room.status === "waiting") {
      const openSlot = room.slots.find((s) => s.state === "open");
      if (openSlot) {
        openSlot.state = "bot";
        openSlot.nickname = BOT_NAMES[openSlot.slotIndex]!;
        openSlot.isReady = true;
        openSlot.charIndex = openSlot.slotIndex % 8;
        openSlot.team = openSlot.slotIndex % 2 === 0 ? 0 : 5;
        syncRoomState(room);
      }
    }
    return true;
  }
  if (cmd === "/map" && sess.roomId > 0 && parts[1]) {
    const room = rooms.get(sess.roomId);
    if (room && room.status === "waiting") {
      const query = parts[1]!.toLowerCase();
      const found = packs.mapNames.find((m) => m.toLowerCase().includes(query));
      if (found) {
        room.mapName = found;
        syncRoomState(room);
        sendToast(sess, `[GM] 地圖已切換為 ${found}`);
      }
    }
    return true;
  }
  return false;
}

function handleClientPacket(sess: ClientSession, opcode: ClientOpcode, r: BinaryReader): void {
  switch (opcode) {
    case ClientOpcode.KeepAlive: {
      sendPacket(sess, ServerOpcode.Pong, new Uint8Array(0));
      break;
    }

    case ClientOpcode.Login1P:
    case ClientOpcode.RegisterAccount: {
      const req = decodeJsonPayload<{ username: string; password: string }>(r);
      const res = db.loginOrAutoRegister(req.username, req.password, shopCatalog);
      if (!res.ok || !res.profile) {
        sendJson(sess, ServerOpcode.LoginResult, { ok: false, error: res.error ?? "登入失敗" });
        return;
      }
      sess.profile = res.profile;
      sessionsByUserId.set(res.profile.userId, sess);
      sendJson(sess, ServerOpcode.LoginResult, { ok: true, profile: res.profile });
      sendJson(sess, ServerOpcode.ChannelList, { channels: getChannelList() });
      syncUserEconomyAndInventory(sess);
      break;
    }

    case ClientOpcode.Login2P: {
      if (!sess.profile) return;
      const req = decodeJsonPayload<{ enable: boolean; nickname?: string; charIndex?: number }>(r);
      sess.hasLocal2P = req.enable;
      sess.local2PNickname = req.nickname?.trim() || `${sess.profile.nickname}_2P`;
      sess.local2PChar = req.charIndex ?? 1;
      sendJson(sess, ServerOpcode.Login2PResult, {
        enable: sess.hasLocal2P,
        nickname: sess.local2PNickname,
        charIndex: sess.local2PChar,
      });

      if (sess.roomId > 0) {
        const room = rooms.get(sess.roomId);
        if (room && room.status === "waiting") {
          const existing2P = room.slots.find((s) => s.sessionId === sess.id && s.isLocal2P);
          if (sess.hasLocal2P && !existing2P) {
            const open = room.slots.find((s) => s.state === "open");
            if (open) {
              open.state = "human";
              open.sessionId = sess.id;
              open.userId = sess.profile.userId;
              open.nickname = sess.local2PNickname;
              open.level = sess.profile.level;
              open.isLocal2P = true;
              open.isReady = true;
              open.charIndex = sess.local2PChar;
              open.team = 0;
              open.equipped = { ...sess.profile.equipped };
            }
          } else if (!sess.hasLocal2P && existing2P) {
            existing2P.state = "open";
            existing2P.sessionId = 0;
            existing2P.nickname = "";
            existing2P.isLocal2P = false;
            existing2P.isReady = false;
          }
          syncRoomState(room);
        }
      }
      break;
    }

    case ClientOpcode.RefreshChannels: {
      sendJson(sess, ServerOpcode.ChannelList, { channels: getChannelList() });
      break;
    }

    case ClientOpcode.SelectChannel: {
      const { channelId } = decodeJsonPayload<{ channelId: number }>(r);
      leaveCurrentRoom(sess);
      sess.channelId = channelId;
      sendJson(sess, ServerOpcode.ChannelEnterResult, { ok: true, channelId });
      broadcastChannelLobby(channelId);
      break;
    }

    case ClientOpcode.RoomListRequest: {
      broadcastChannelLobby(sess.channelId);
      break;
    }

    case ClientOpcode.CreateRoom: {
      if (!sess.profile) return;
      const req = decodeJsonPayload<{
        title: string;
        password: string;
        mode: GameMode;
        mapName: string;
      }>(r);
      const room = createNewRoom(sess, req.title, req.password, req.mode, req.mapName);
      sendJson(sess, ServerOpcode.RoomEnterResult, { ok: true, room: detailRoom(room) });
      broadcastChannelLobby(sess.channelId);
      break;
    }

    case ClientOpcode.JoinRoom:
    case ClientOpcode.QuickJoin: {
      if (!sess.profile) return;
      const req = decodeJsonPayload<{ roomId?: number; password?: string }>(r);
      let target: ActiveRoom | undefined;
      if (opcode === ClientOpcode.QuickJoin) {
        target = [...rooms.values()].find(
          (rm) =>
            rm.channelId === sess.channelId &&
            rm.status === "waiting" &&
            rm.password === "" &&
            rm.slots.some((s) => s.state === "open"),
        );
        if (!target) {
          // Auto-create a quick match room with an AI rival ready to play!
          const created = createNewRoom(sess, "快速對戰房間", "", GameMode.Practice, "patrit_00");
          sendJson(sess, ServerOpcode.RoomEnterResult, { ok: true, room: detailRoom(created) });
          broadcastChannelLobby(sess.channelId);
          return;
        }
      } else if (req.roomId) {
        target = rooms.get(req.roomId);
      }

      if (!target || target.status !== "waiting") {
        sendJson(sess, ServerOpcode.RoomEnterResult, { ok: false, error: "房間不存在或對戰已開始！" });
        return;
      }
      if (target.password && target.password !== (req.password ?? "")) {
        sendJson(sess, ServerOpcode.RoomEnterResult, { ok: false, error: "房間密碼不正確！" });
        return;
      }
      const openSlot = target.slots.find((s) => s.state === "open");
      if (!openSlot) {
        sendJson(sess, ServerOpcode.RoomEnterResult, { ok: false, error: "房間人數已滿！" });
        return;
      }

      leaveCurrentRoom(sess);
      openSlot.state = "human";
      openSlot.sessionId = sess.id;
      openSlot.userId = sess.profile.userId;
      openSlot.nickname = sess.profile.nickname;
      openSlot.level = sess.profile.level;
      openSlot.isHost = false;
      openSlot.isReady = false;
      openSlot.isLocal2P = false;
      openSlot.charIndex = sess.profile.defaultChar;
      openSlot.team = openSlot.slotIndex % 2 === 0 ? 0 : 5;
      openSlot.equipped = { ...sess.profile.equipped };

      sess.roomId = target.roomId;
      sendJson(sess, ServerOpcode.RoomEnterResult, { ok: true, room: detailRoom(target) });
      syncRoomState(target);
      break;
    }

    case ClientOpcode.LeaveRoom: {
      const ch = sess.channelId;
      leaveCurrentRoom(sess);
      broadcastChannelLobby(ch);
      break;
    }

    case ClientOpcode.RoomSettingChange: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "waiting") return;
      const host = room.slots[room.hostSlot];
      if (!host || host.sessionId !== sess.id) return;

      const req = decodeJsonPayload<{
        title?: string;
        mode?: GameMode;
        mapName?: string;
        password?: string;
      }>(r);
      if (req.title !== undefined) room.title = req.title.slice(0, 30);
      if (req.mode !== undefined) room.mode = req.mode;
      if (req.mapName !== undefined) room.mapName = packs.getMapOrFallback(req.mapName).mapName;
      if (req.password !== undefined) room.password = req.password.slice(0, 12);
      syncRoomState(room);
      break;
    }

    case ClientOpcode.SlotStateChange: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "waiting") return;
      const host = room.slots[room.hostSlot];
      if (!host || host.sessionId !== sess.id) return;

      const { slotIndex } = decodeJsonPayload<{ slotIndex: number }>(r);
      const sl = room.slots[slotIndex];
      if (!sl || sl.state === "human") return;

      // Cycle: open -> bot -> closed -> open
      if (sl.state === "open") {
        sl.state = "bot";
        sl.nickname = BOT_NAMES[slotIndex % BOT_NAMES.length]!;
        sl.level = sess.profile?.level ?? 5;
        sl.isReady = true;
        sl.charIndex = slotIndex % 8;
        sl.team = slotIndex % 2 === 0 ? 0 : 5;
      } else if (sl.state === "bot") {
        sl.state = "closed";
        sl.nickname = "";
        sl.isReady = false;
      } else {
        sl.state = "open";
        sl.nickname = "";
        sl.isReady = false;
      }
      syncRoomState(room);
      break;
    }

    case ClientOpcode.SelectCharacterTeam: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "waiting") return;
      const req = decodeJsonPayload<{
        is2P?: boolean;
        charIndex?: number;
        team?: number;
      }>(r);
      const sl = room.slots.find(
        (s) => s.sessionId === sess.id && s.isLocal2P === Boolean(req.is2P),
      );
      if (!sl) return;
      if (req.charIndex !== undefined && req.charIndex >= 0 && req.charIndex <= 10) {
        sl.charIndex = req.charIndex;
      }
      if (req.team !== undefined && req.team >= 0 && req.team <= 8) {
        sl.team = req.team;
      }
      syncRoomState(room);
      break;
    }

    case ClientOpcode.ToggleReady: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "waiting") return;
      const sl = room.slots.find((s) => s.sessionId === sess.id && !s.isLocal2P);
      if (!sl || sl.isHost) return;
      sl.isReady = !sl.isReady;
      syncRoomState(room);
      break;
    }

    case ClientOpcode.StartMatch: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "waiting") return;
      const host = room.slots[room.hostSlot];
      if (!host || host.sessionId !== sess.id) return;

      const unreadyHuman = room.slots.find(
        (s) => s.state === "human" && !s.isHost && !s.isLocal2P && !s.isReady,
      );
      if (unreadyHuman) {
        sendToast(sess, `玩家 ${unreadyHuman.nickname} 尚未準備就緒！`);
        return;
      }
      startRoomMatch(room);
      break;
    }

    case ClientOpcode.ChatMessage: {
      if (!sess.profile) return;
      const { text } = decodeJsonPayload<{ text: string }>(r);
      const clean = text.trim().slice(0, 120);
      if (!clean) return;
      if (handleGmCommand(sess, clean)) return;

      // Filter words check
      let filtered = clean;
      for (const fw of packs.filterWords) {
        if (fw.length >= 2 && filtered.includes(fw)) {
          filtered = filtered.split(fw).join("**");
        }
      }

      if (sess.roomId > 0) {
        const room = rooms.get(sess.roomId);
        if (room) {
          broadcastRoom(
            room,
            ServerOpcode.RoomChatBroadcast,
            encodeJsonPayload({ sender: sess.profile.nickname, text: filtered }),
          );
        }
      } else {
        for (const other of sessions.values()) {
          if (other.channelId === sess.channelId) {
            sendJson(other, ServerOpcode.ChatBroadcast, {
              sender: sess.profile.nickname,
              text: filtered,
            });
          }
        }
      }
      break;
    }

    case ClientOpcode.WhisperMessage: {
      if (!sess.profile) return;
      const { target, text } = decodeJsonPayload<{ target: string; text: string }>(r);
      const targetProf = db.getProfileByNickname(target);
      const dest = targetProf ? sessionsByUserId.get(targetProf.userId) : undefined;
      if (!dest) {
        sendToast(sess, `玩家 ${target} 目前不在線上！`);
        return;
      }
      const msg = { from: sess.profile.nickname, to: targetProf!.nickname, text: text.slice(0, 120) };
      sendJson(dest, ServerOpcode.WhisperBroadcast, msg);
      sendJson(sess, ServerOpcode.WhisperBroadcast, msg);
      break;
    }

    case ClientOpcode.EmotionTrigger: {
      const room = rooms.get(sess.roomId);
      if (!room) return;
      const { emotionId } = decodeJsonPayload<{ emotionId: number }>(r);
      const sl = room.slots.find((s) => s.sessionId === sess.id && !s.isLocal2P);
      if (!sl) return;
      broadcastRoom(
        room,
        ServerOpcode.EmotionBroadcast,
        encodeJsonPayload({ slotIndex: sl.slotIndex, emotionId }),
      );
      break;
    }

    // Real-time CGameStage binary inputs (106, 107, 112)
    case ClientOpcode.BomberPosSync: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "playing") return;
      const slotIndex = r.u8();
      const dir = r.i8() as Direction;
      const flags = r.u8();
      const sl = room.slots[slotIndex];
      if (!sl || sl.sessionId !== sess.id) return;

      const prev = room.latestInputs.get(slotIndex) ?? {
        dir: Direction.None,
        placeBomb: false,
        useCtrl: false,
        useAlt: false,
      };
      prev.dir = dir;
      if (flags & 1) prev.placeBomb = true;
      if (flags & 2) prev.useCtrl = true;
      if (flags & 4) prev.useAlt = true;
      room.latestInputs.set(slotIndex, prev);
      break;
    }

    case ClientOpcode.PlaceBomb: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "playing") return;
      const slotIndex = r.u8();
      const sl = room.slots[slotIndex];
      if (!sl || sl.sessionId !== sess.id) return;
      const prev = room.latestInputs.get(slotIndex) ?? {
        dir: Direction.None,
        placeBomb: false,
        useCtrl: false,
        useAlt: false,
      };
      prev.placeBomb = true;
      room.latestInputs.set(slotIndex, prev);
      break;
    }

    case ClientOpcode.UseActiveItem: {
      const room = rooms.get(sess.roomId);
      if (!room || room.status !== "playing") return;
      const slotIndex = r.u8();
      const which = r.u8(); // 0 = Ctrl, 1 = Alt
      const sl = room.slots[slotIndex];
      if (!sl || sl.sessionId !== sess.id) return;
      const prev = room.latestInputs.get(slotIndex) ?? {
        dir: Direction.None,
        placeBomb: false,
        useCtrl: false,
        useAlt: false,
      };
      if (which === 1) prev.useAlt = true;
      else prev.useCtrl = true;
      room.latestInputs.set(slotIndex, prev);
      break;
    }

    // Shop, Inventory, Gacha Slot, Exchange, User Market, Social
    case ClientOpcode.ShopCatalogReq: {
      sendJson(sess, ServerOpcode.ShopCatalogSync, { items: shopCatalog });
      break;
    }

    case ClientOpcode.ShopBuyItem: {
      if (!sess.profile) return;
      const { itemId, useCash } = decodeJsonPayload<{ itemId: number; useCash: boolean }>(r);
      const item = shopById.get(itemId);
      if (!item) return;

      const cur = db.getProfileById(sess.profile.userId)!;
      if (useCash && item.priceCash > 0) {
        if (cur.cash < item.priceCash) {
          sendJson(sess, ServerOpcode.ShopPurchaseResult, { ok: false, error: "樂豆點數不足！" });
          return;
        }
        db.addCurrency(cur.userId, 0, -item.priceCash);
      } else {
        if (cur.lucci < item.priceLucci) {
          sendJson(sess, ServerOpcode.ShopPurchaseResult, { ok: false, error: "Lucci 餘額不足！" });
          return;
        }
        db.addCurrency(cur.userId, -item.priceLucci, 0);
      }

      if (item.isPackage && item.packageItems.length > 0) {
        for (const subId of item.packageItems) {
          db.grantItem(cur.userId, subId, 1);
        }
      } else {
        db.grantItem(cur.userId, item.itemId, 1);
      }

      syncUserEconomyAndInventory(sess);
      sendJson(sess, ServerOpcode.ShopPurchaseResult, {
        ok: true,
        message: `成功購買「${item.name}」！已放入您的道具欄。`,
      });
      break;
    }

    case ClientOpcode.ShopGiftItem: {
      if (!sess.profile) return;
      const { itemId, receiver, message } = decodeJsonPayload<{
        itemId: number;
        receiver: string;
        message: string;
      }>(r);
      const item = shopById.get(itemId);
      const dest = db.getProfileByNickname(receiver);
      if (!item || !dest) {
        sendJson(sess, ServerOpcode.ShopPurchaseResult, { ok: false, error: "找不到收禮玩家暱稱！" });
        return;
      }
      const cur = db.getProfileById(sess.profile.userId)!;
      if (cur.lucci < item.priceLucci) {
        sendJson(sess, ServerOpcode.ShopPurchaseResult, { ok: false, error: "Lucci 餘額不足！" });
        return;
      }
      db.addCurrency(cur.userId, -item.priceLucci, 0);
      db.grantItem(dest.userId, item.itemId, 1);
      db.sendNote(cur.nickname, dest.nickname, message || `送給你「${item.name}」！`, item.itemId);
      syncUserEconomyAndInventory(sess);
      const destSess = sessionsByUserId.get(dest.userId);
      if (destSess) syncUserEconomyAndInventory(destSess);
      sendJson(sess, ServerOpcode.ShopPurchaseResult, {
        ok: true,
        message: `已將「${item.name}」贈送給 ${dest.nickname}！`,
      });
      break;
    }

    case ClientOpcode.EquipAvatarItem: {
      if (!sess.profile) return;
      const { itemId } = decodeJsonPayload<{ itemId: number }>(r);
      const updated = db.equipItem(sess.profile.userId, itemId, shopById);
      if (updated) {
        sess.profile = updated;
        syncUserEconomyAndInventory(sess);
        // Update room slot preview if in a room!
        if (sess.roomId > 0) {
          const room = rooms.get(sess.roomId);
          if (room) {
            for (const sl of room.slots) {
              if (sl.sessionId === sess.id) sl.equipped = { ...updated.equipped };
            }
            syncRoomState(room);
          }
        }
      }
      break;
    }

    case ClientOpcode.SlotMachinePlay: {
      if (!sess.profile) return;
      const cur = db.getProfileById(sess.profile.userId)!;
      const cost = 1500;
      if (cur.lucci < cost) {
        sendToast(sess, "轉蛋需要 1,500 Lucci！");
        return;
      }
      db.addCurrency(cur.userId, -cost, 0);
      const pool = shopCatalog.filter((i) => !i.isPackage);
      const prize = pool[Math.floor(Math.random() * pool.length)]!;
      const reels = [
        Math.floor(Math.random() * 6),
        Math.floor(Math.random() * 6),
        Math.floor(Math.random() * 6),
      ];
      db.grantItem(cur.userId, prize.itemId, 1);
      syncUserEconomyAndInventory(sess);
      sendJson(sess, ServerOpcode.SlotMachineResult, {
        reels,
        prizeItem: prize,
      });
      break;
    }

    case ClientOpcode.MarketListReq: {
      sendJson(sess, ServerOpcode.MarketListingsSync, { listings: db.listMarketItems() });
      break;
    }

    case ClientOpcode.MarketCreateListing: {
      if (!sess.profile) return;
      const { itemId, quantity, priceLucci } = decodeJsonPayload<{
        itemId: number;
        quantity: number;
        priceLucci: number;
      }>(r);
      const ok = db.createMarketListing(
        sess.profile.userId,
        sess.profile.nickname,
        itemId,
        quantity,
        priceLucci,
      );
      syncUserEconomyAndInventory(sess);
      sendJson(sess, ServerOpcode.MarketListingsSync, { listings: db.listMarketItems() });
      sendJson(sess, ServerOpcode.MarketActionResult, {
        ok,
        message: ok ? "商品已成功上架至自由拍賣市場！" : "上架失敗：數量或金額無效。",
      });
      break;
    }

    case ClientOpcode.MarketBuyListing: {
      if (!sess.profile) return;
      const { listingId } = decodeJsonPayload<{ listingId: number }>(r);
      const res = db.buyMarketListing(sess.profile.userId, listingId);
      syncUserEconomyAndInventory(sess);
      sendJson(sess, ServerOpcode.MarketListingsSync, { listings: db.listMarketItems() });
      sendJson(sess, ServerOpcode.MarketActionResult, {
        ok: res.ok,
        message: res.ok ? "購買成功！物品已放入您的道具欄。" : res.error ?? "購買失敗",
      });
      break;
    }

    case ClientOpcode.MarketCancelListing: {
      if (!sess.profile) return;
      const { listingId } = decodeJsonPayload<{ listingId: number }>(r);
      db.cancelMarketListing(sess.profile.userId, listingId);
      syncUserEconomyAndInventory(sess);
      sendJson(sess, ServerOpcode.MarketListingsSync, { listings: db.listMarketItems() });
      break;
    }

    case ClientOpcode.ExchangeRequest: {
      if (!sess.profile) return;
      const { partnerNickname } = decodeJsonPayload<{ partnerNickname: string }>(r);
      const partnerProf = db.getProfileByNickname(partnerNickname);
      const partnerSess = partnerProf ? sessionsByUserId.get(partnerProf.userId) : undefined;
      if (!partnerSess || partnerSess.id === sess.id) {
        sendToast(sess, "找不到線上的交易對象！");
        return;
      }
      const ex: ExchangeSession = {
        sessionId: nextExchangeId++,
        a: sess,
        b: partnerSess,
        itemsA: [],
        lucciA: 0,
        lockedA: false,
        itemsB: [],
        lucciB: 0,
        lockedB: false,
      };
      exchanges.set(ex.sessionId, ex);
      sess.exchangeSessionId = ex.sessionId;
      partnerSess.exchangeSessionId = ex.sessionId;
      syncExchange(ex);
      break;
    }

    case ClientOpcode.ExchangeUpdateOffer: {
      const ex = exchanges.get(sess.exchangeSessionId);
      if (!ex) return;
      const { items, lucci } = decodeJsonPayload<{ items: number[]; lucci: number }>(r);
      if (ex.a.id === sess.id && !ex.lockedA) {
        ex.itemsA = items.slice(0, 6);
        ex.lucciA = Math.max(0, Math.floor(lucci));
      } else if (ex.b.id === sess.id && !ex.lockedB) {
        ex.itemsB = items.slice(0, 6);
        ex.lucciB = Math.max(0, Math.floor(lucci));
      }
      syncExchange(ex);
      break;
    }

    case ClientOpcode.ExchangeConfirm: {
      const ex = exchanges.get(sess.exchangeSessionId);
      if (!ex || !ex.a.profile || !ex.b.profile) return;
      if (ex.a.id === sess.id) ex.lockedA = true;
      if (ex.b.id === sess.id) ex.lockedB = true;

      if (ex.lockedA && ex.lockedB) {
        // Execute atomic P2P swap!
        const pA = db.getProfileById(ex.a.profile.userId)!;
        const pB = db.getProfileById(ex.b.profile.userId)!;
        if (pA.lucci >= ex.lucciA && pB.lucci >= ex.lucciB) {
          for (const id of ex.itemsA) {
            if (db.consumeItem(pA.userId, id, 1)) db.grantItem(pB.userId, id, 1);
          }
          for (const id of ex.itemsB) {
            if (db.consumeItem(pB.userId, id, 1)) db.grantItem(pA.userId, id, 1);
          }
          db.addCurrency(pA.userId, ex.lucciB - ex.lucciA, 0);
          db.addCurrency(pB.userId, ex.lucciA - ex.lucciB, 0);
          syncUserEconomyAndInventory(ex.a);
          syncUserEconomyAndInventory(ex.b);
          sendToast(ex.a, "交易完成！");
          sendToast(ex.b, "交易完成！");
        }
        ex.a.exchangeSessionId = 0;
        ex.b.exchangeSessionId = 0;
        exchanges.delete(ex.sessionId);
        sendJson(ex.a, ServerOpcode.ExchangeStateSync, { closed: true });
        sendJson(ex.b, ServerOpcode.ExchangeStateSync, { closed: true });
        return;
      }
      syncExchange(ex);
      break;
    }

    case ClientOpcode.ExchangeCancel: {
      const ex = exchanges.get(sess.exchangeSessionId);
      if (!ex) return;
      ex.a.exchangeSessionId = 0;
      ex.b.exchangeSessionId = 0;
      exchanges.delete(ex.sessionId);
      sendJson(ex.a, ServerOpcode.ExchangeStateSync, { closed: true });
      sendJson(ex.b, ServerOpcode.ExchangeStateSync, { closed: true });
      break;
    }

    case ClientOpcode.FriendAction: {
      if (!sess.profile) return;
      const { action, nickname } = decodeJsonPayload<{ action: "add" | "remove"; nickname: string }>(r);
      const target = db.getProfileByNickname(nickname);
      if (!target) {
        sendToast(sess, `找不到玩家「${nickname}」`);
        return;
      }
      if (action === "add") {
        db.addFriend(sess.profile.userId, target.userId);
        sendToast(sess, `已將 ${target.nickname} 加入好友名單！`);
      } else {
        db.removeFriend(sess.profile.userId, target.userId);
      }
      syncFriends(sess);
      break;
    }

    case ClientOpcode.NoteAction: {
      if (!sess.profile) return;
      const { receiver, content } = decodeJsonPayload<{ receiver: string; content: string }>(r);
      if (typeof receiver !== "string" || receiver.trim().length === 0) {
        sendToast(sess, "請輸入收件人暱稱");
        return;
      }
      const target = db.getProfileByNickname(receiver);
      if (!target) {
        sendToast(sess, `找不到收件人「${receiver}」`);
        return;
      }
      const body = typeof content === "string" ? content.slice(0, 500) : "";
      if (body.trim().length === 0) {
        sendToast(sess, "請輸入信件內容");
        return;
      }
      db.sendNote(sess.profile.nickname, target.nickname, body, 0);
      sendToast(sess, `信件已寄出給 ${target.nickname}！`);
      const destSess = sessionsByUserId.get(target.userId);
      if (destSess) syncUserEconomyAndInventory(destSess);
      break;
    }

    case ClientOpcode.CoupleAction: {
      if (!sess.profile) return;
      const { partnerNickname } = decodeJsonPayload<{ partnerNickname: string }>(r);
      const partner = db.getProfileByNickname(partnerNickname);
      if (!partner || partner.userId === sess.profile.userId) {
        sendToast(sess, "請輸入有效的線上夥伴暱稱！");
        return;
      }
      db.setCouple(sess.profile.userId, sess.profile.nickname, partner.userId, partner.nickname, 1);
      syncUserEconomyAndInventory(sess);
      const pSess = sessionsByUserId.get(partner.userId);
      if (pSess) syncUserEconomyAndInventory(pSess);
      sendToast(sess, `恭喜與 ${partner.nickname} 締結情侶關係！`);
      break;
    }

    case ClientOpcode.QuestAction: {
      if (!sess.profile) return;
      const { questId } = decodeJsonPayload<{ questId: number }>(r);
      const res = db.claimQuest(sess.profile.userId, questId);
      if (res.ok) {
        syncUserEconomyAndInventory(sess);
        sendToast(sess, "任務獎勵領取成功！");
      }
      break;
    }
  }
}

function syncExchange(ex: ExchangeSession): void {
  const dtoA: ExchangeStateDTO = {
    sessionId: ex.sessionId,
    partnerId: ex.b.profile?.userId ?? 0,
    partnerName: ex.b.profile?.nickname ?? "",
    myItems: ex.itemsA,
    myLucci: ex.lucciA,
    myLocked: ex.lockedA,
    partnerItems: ex.itemsB,
    partnerLucci: ex.lucciB,
    partnerLocked: ex.lockedB,
  };
  const dtoB: ExchangeStateDTO = {
    sessionId: ex.sessionId,
    partnerId: ex.a.profile?.userId ?? 0,
    partnerName: ex.a.profile?.nickname ?? "",
    myItems: ex.itemsB,
    myLucci: ex.lucciB,
    myLocked: ex.lockedB,
    partnerItems: ex.itemsA,
    partnerLucci: ex.lucciA,
    partnerLocked: ex.lockedA,
  };
  sendJson(ex.a, ServerOpcode.ExchangeStateSync, dtoA);
  sendJson(ex.b, ServerOpcode.ExchangeStateSync, dtoB);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const bootstrapJson = JSON.stringify({
  mapNames: packs.mapNames,
  mapGroups: packs.mapGroups,
  bombers: packs.bombers,
  ships: packs.ships,
  shopCatalog,
});

const port = Number(process.env.PORT || 3000);

const server = Bun.serve<ClientSession>({
  hostname: "0.0.0.0",
  port,
  async fetch(req, srv) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    // WebSocket upgrade for CPacketSocket binary stream
    if (pathname === "/ws") {
      const id = nextSessionId++;
      const upgraded = srv.upgrade(req, {
        data: {
          id,
          ws: null as unknown as ServerWebSocket<ClientSession>,
          cipher: new PacketCipher(),
          profile: null,
          hasLocal2P: false,
          local2PNickname: "",
          local2PChar: 1,
          channelId: 0,
          roomId: 0,
          stageName: "Title",
          exchangeSessionId: 0,
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Bootstrap metadata
    if (pathname === "/api/bootstrap") {
      return new Response(bootstrapJson, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    // Native .idx binary endpoint: /api/pack/:archive/idx
    const idxMatch = pathname.match(/^\/api\/pack\/(Fx|CharTE|EmoTE)\/idx$/);
    if (idxMatch) {
      const arc = idxMatch[1] as ArchiveName;
      const bytes = packs.rawIdx.get(arc);
      if (!bytes) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Native .idd entry endpoint: /api/pack/:archive/entry?path=...
    const entryMatch = pathname.match(/^\/api\/pack\/(Fx|CharTE|EmoTE)\/entry$/);
    if (entryMatch) {
      const arc = entryMatch[1] as ArchiveName;
      const entryPath = url.searchParams.get("path") ?? "";
      const bytes = packs.readEntry(arc, entryPath);
      if (!bytes) {
        return new Response("Entry not found", { status: 404, headers: CORS_HEADERS });
      }
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // High-throughput batch pack endpoint: POST /api/pack/:archive/batch { paths: string[] }
    const batchMatch = pathname.match(/^\/api\/pack\/(Fx|CharTE|EmoTE)\/batch$/);
    if (batchMatch && req.method === "POST") {
      const arc = batchMatch[1] as ArchiveName;
      const body = (await req.json()) as { paths: string[] };
      const list = Array.isArray(body.paths) ? body.paths.slice(0, 256) : [];

      const chunks: { path: string; data: Uint8Array }[] = [];
      let totalBytes = 4;
      for (const p of list) {
        const d = packs.readEntry(arc, p);
        if (d) {
          chunks.push({ path: p, data: d });
          totalBytes += 2 + new TextEncoder().encode(p).byteLength + 4 + d.byteLength;
        }
      }

      const w = new BinaryWriter(totalBytes + 64);
      w.u32(chunks.length);
      for (const ch of chunks) {
        w.str16UTF8(ch.path);
        w.u32(ch.data.byteLength);
        w.bytes(ch.data);
      }
      return new Response(w.toUint8Array() as unknown as BodyInit, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/octet-stream",
        },
      });
    }

    // Standalone binary files (Cx*.fft, csysstr.ssd, stringtable.ini, nm.bik)
    if (pathname.startsWith("/api/raw/")) {
      const fname = decodeURIComponent(pathname.slice("/api/raw/".length));
      const bytes = packs.rawStandaloneFiles.get(fname) ?? packs.rawStandaloneFiles.get(fname.toLowerCase());
      if (!bytes) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Static SPA routes
    if (pathname === "/" || pathname === "/index.html") {
      const file = Bun.file("public/index.html");
      return new Response(file, {
        headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (pathname === "/dist/client.js") {
      const file = Bun.file("public/dist/client.js");
      if (await file.exists()) {
        return new Response(file, {
          headers: { ...CORS_HEADERS, "Content-Type": "application/javascript; charset=utf-8" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },

  websocket: {
    open(ws) {
      ws.data.ws = ws;
      sessions.set(ws.data.id, ws.data);
    },
    message(ws, message) {
      const sess = ws.data;
      const bytes =
        message instanceof Uint8Array
          ? message
          : new Uint8Array(message as unknown as ArrayBuffer);

      // Parse one or more concatenated CPacketSocket frames
      let offset = 0;
      while (offset + 7 <= bytes.byteLength) {
        const bodyLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        const frameLen = 5 + bodyLen;
        if (offset + frameLen > bytes.byteLength) break;

        const slice = bytes.subarray(offset, offset + frameLen);
        offset += frameLen;

        const decoded = sess.cipher.unframePacket(slice, false);
        if (decoded) {
          handleClientPacket(sess, decoded.opcode as ClientOpcode, decoded.reader);
        }
      }
    },
    close(ws) {
      const sess = ws.data;
      leaveCurrentRoom(sess);
      if (sess.profile) {
        sessionsByUserId.delete(sess.profile.userId);
      }
      if (sess.exchangeSessionId > 0) {
        const ex = exchanges.get(sess.exchangeSessionId);
        if (ex) {
          const other = ex.a.id === sess.id ? ex.b : ex.a;
          other.exchangeSessionId = 0;
          exchanges.delete(ex.sessionId);
          sendJson(other, ServerOpcode.ExchangeStateSync, { closed: true });
        }
      }
      const ch = sess.channelId;
      sessions.delete(sess.id);
      if (ch > 0) broadcastChannelLobby(ch);
    },
  },
});

console.log(`[BnB Server] Listening on http://0.0.0.0:${server.port}`);
