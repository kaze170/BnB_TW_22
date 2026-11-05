import { Direction, GameMode } from "../shared/constants.ts";
import { BinaryReader } from "../shared/crypto.ts";
import {
  type ChannelInfoDTO,
  ClientOpcode,
  type ExchangeStateDTO,
  type FriendDTO,
  type MarketListingDTO,
  type MatchResultPayload,
  type MatchStartPayload,
  type NoteDTO,
  type OwnedItemDTO,
  type QuestDTO,
  type RoomDetailDTO,
  type RoomSummaryDTO,
  ServerOpcode,
  type ShopItemDTO,
  type UserProfileDTO,
  decodeJsonPayload,
} from "../shared/protocol.ts";
import { computeBotInput } from "../shared/sim/ai.ts";
import { GameWorld, type PlayerInputState } from "../shared/sim/world.ts";
import type { ClientAssetManager } from "./assets.ts";
import type { WebAudioEngine } from "./audio.ts";
import type { PacketSocketClient } from "./net.ts";
import type { UiInputSystem } from "./ui.ts";

export type StageId =
  | "Title"
  | "Login"
  | "SelectServer"
  | "Lobby"
  | "Prepare"
  | "Game"
  | "Shop"
  | "Exchange"
  | "UserMarket"
  | "Chatting"
  | "Credit";

export type ModalId =
  | "none"
  | "newId"
  | "createRoom"
  | "roomInfo"
  | "practice"
  | "selectMap"
  | "myPage"
  | "messenger"
  | "smsMail"
  | "tutorial"
  | "option"
  | "sendGift"
  | "gachapon"
  | "saleReg";

export class ClientAppState {
  public stage: StageId = "Title";
  public modal: ModalId = "none";
  public globalMenuOpen = false;
  public animTick = 0;

  public profile: UserProfileDTO | null = null;
  public local2PEnabled = false;
  public local2PNickname = "Player2";
  public local2PChar = 1;

  public channels: ChannelInfoDTO[] = [];
  public currentChannelId = 0;
  public rooms: RoomSummaryDTO[] = [];
  public onlineUsers: { userId: number; nickname: string; level: number; roomId: number }[] = [];
  public chatLog: { sender: string; text: string; isWhisper?: boolean }[] = [];
  public chatBubbles = new Map<string, { text: string; ticks: number }>();

  public currentRoom: RoomDetailDTO | null = null;
  public activeEmotions = new Map<number, { emotionId: number; ticks: number }>();

  public inventory: OwnedItemDTO[] = [];
  public friends: FriendDTO[] = [];
  public notes: NoteDTO[] = [];
  public quests: QuestDTO[] = [];
  public marketListings: MarketListingDTO[] = [];
  public exchangeState: ExchangeStateDTO | null = null;
  public lastSlotResult: { reels: number[]; prizeItem: ShopItemDTO } | null = null;

  // Active CGameStage simulation state
  public world: GameWorld | null = null;
  public myPrimarySlot = 0;
  public mySecondarySlot = -1;
  public isOfflineSolo = false;
  public matchResult: MatchResultPayload | null = null;

  public readonly assets: ClientAssetManager;
  public readonly audio: WebAudioEngine;
  public readonly net: PacketSocketClient;
  public readonly ui: UiInputSystem;

  constructor(
    assets: ClientAssetManager,
    audio: WebAudioEngine,
    net: PacketSocketClient,
    ui: UiInputSystem,
  ) {
    this.assets = assets;
    this.audio = audio;
    this.net = net;
    this.ui = ui;

    this.net.onPacket((op, r) => this.handleServerPacket(op, r));
  }

  public switchStage(next: StageId): void {
    this.stage = next;
    this.modal = "none";
    this.globalMenuOpen = false;
    this.ui.blurField();

    if (next === "Login" || next === "Title") {
      void this.audio.playBgm("MP3/StageLogin");
    } else if (next === "SelectServer" || next === "Lobby" || next === "Chatting") {
      void this.audio.playBgm("MP3/StageChannel");
    } else if (
      next === "Prepare" ||
      next === "Shop" ||
      next === "Exchange" ||
      next === "UserMarket"
    ) {
      void this.audio.playBgm("MP3/Prepare");
    } else if (next === "Credit") {
      void this.audio.playBgm("MP3/EventBgm");
    }
  }

  private handleServerPacket(opcode: ServerOpcode, r: BinaryReader): void {
    switch (opcode) {
      case ServerOpcode.LoginResult: {
        const res = decodeJsonPayload<{ ok: boolean; error?: string; profile?: UserProfileDTO }>(r);
        if (!res.ok || !res.profile) {
          this.ui.pushToast(res.error ?? "登入失敗");
          return;
        }
        this.profile = res.profile;
        this.switchStage("SelectServer");
        break;
      }

      case ServerOpcode.Login2PResult: {
        const res = decodeJsonPayload<{ enable: boolean; nickname: string; charIndex: number }>(r);
        this.local2PEnabled = res.enable;
        this.local2PNickname = res.nickname;
        this.local2PChar = res.charIndex;
        break;
      }

      case ServerOpcode.ChannelList: {
        const { channels } = decodeJsonPayload<{ channels: ChannelInfoDTO[] }>(r);
        this.channels = channels;
        break;
      }

      case ServerOpcode.ChannelEnterResult: {
        const { ok, channelId } = decodeJsonPayload<{ ok: boolean; channelId: number }>(r);
        if (ok) {
          this.currentChannelId = channelId;
          this.switchStage("Lobby");
        }
        break;
      }

      case ServerOpcode.RoomListSync: {
        const { rooms } = decodeJsonPayload<{ rooms: RoomSummaryDTO[] }>(r);
        this.rooms = rooms;
        break;
      }

      case ServerOpcode.OnlineUsersList: {
        const { users } = decodeJsonPayload<{
          users: { userId: number; nickname: string; level: number; roomId: number }[];
        }>(r);
        this.onlineUsers = users;
        break;
      }

      case ServerOpcode.ChatBroadcast:
      case ServerOpcode.RoomChatBroadcast: {
        const msg = decodeJsonPayload<{ sender: string; text: string }>(r);
        this.chatLog.push(msg);
        if (this.chatLog.length > 60) this.chatLog.shift();
        this.chatBubbles.set(msg.sender, { text: msg.text, ticks: 135 });
        break;
      }

      case ServerOpcode.WhisperBroadcast: {
        const msg = decodeJsonPayload<{ from: string; to: string; text: string }>(r);
        this.chatLog.push({
          sender: `[密語 ${msg.from}->${msg.to}]`,
          text: msg.text,
          isWhisper: true,
        });
        if (this.chatLog.length > 60) this.chatLog.shift();
        break;
      }

      case ServerOpcode.SystemToast: {
        const { message } = decodeJsonPayload<{ message: string }>(r);
        this.ui.pushToast(message);
        break;
      }

      case ServerOpcode.RoomEnterResult: {
        const res = decodeJsonPayload<{ ok: boolean; error?: string; room?: RoomDetailDTO }>(r);
        if (!res.ok || !res.room) {
          this.ui.pushToast(res.error ?? "無法進入房間");
          return;
        }
        this.currentRoom = res.room;
        this.matchResult = null;
        this.switchStage("Prepare");
        void this.assets.prefetchMapAssets(res.room.mapName);
        break;
      }

      case ServerOpcode.RoomStateSync: {
        const room = decodeJsonPayload<RoomDetailDTO>(r);
        this.currentRoom = room;
        void this.assets.prefetchMapAssets(room.mapName);
        break;
      }

      case ServerOpcode.EmotionBroadcast: {
        const { slotIndex, emotionId } = decodeJsonPayload<{
          slotIndex: number;
          emotionId: number;
        }>(r);
        this.activeEmotions.set(slotIndex, { emotionId, ticks: 90 });
        break;
      }

      case ServerOpcode.MatchStartLoad: {
        const start = decodeJsonPayload<MatchStartPayload>(r);
        void this.launchMultiplayerMatch(start);
        break;
      }

      case ServerOpcode.PlayerStateSync: {
        this.applyAuthoritativeSync(r);
        break;
      }

      case ServerOpcode.MatchResult: {
        const res = decodeJsonPayload<MatchResultPayload>(r);
        this.matchResult = res;
        break;
      }

      case ServerOpcode.ProfileAndWalletSync: {
        this.profile = decodeJsonPayload<UserProfileDTO>(r);
        break;
      }

      case ServerOpcode.InventorySync: {
        const { items } = decodeJsonPayload<{ items: OwnedItemDTO[] }>(r);
        this.inventory = items;
        break;
      }

      case ServerOpcode.ShopCatalogSync: {
        const { items } = decodeJsonPayload<{ items: ShopItemDTO[] }>(r);
        this.assets.shopCatalog = items;
        for (const it of items) this.assets.shopById.set(it.itemId, it);
        break;
      }

      case ServerOpcode.ShopPurchaseResult: {
        const res = decodeJsonPayload<{ ok: boolean; message?: string; error?: string }>(r);
        this.ui.pushToast(res.ok ? res.message ?? "購買成功！" : res.error ?? "購買失敗");
        if (res.ok) this.audio.playSfxById(24);
        break;
      }

      case ServerOpcode.SlotMachineResult: {
        const res = decodeJsonPayload<{ reels: number[]; prizeItem: ShopItemDTO }>(r);
        this.lastSlotResult = res;
        this.audio.playSfxById(22);
        this.ui.pushToast(`恭喜抽中「${res.prizeItem.name}」！`);
        break;
      }

      case ServerOpcode.FriendListSync: {
        const { friends } = decodeJsonPayload<{ friends: FriendDTO[] }>(r);
        this.friends = friends;
        break;
      }

      case ServerOpcode.NoteListSync: {
        const { notes } = decodeJsonPayload<{ notes: NoteDTO[] }>(r);
        this.notes = notes;
        break;
      }

      case ServerOpcode.QuestSync: {
        const { quests } = decodeJsonPayload<{ quests: QuestDTO[] }>(r);
        this.quests = quests;
        break;
      }

      case ServerOpcode.MarketListingsSync: {
        const { listings } = decodeJsonPayload<{ listings: MarketListingDTO[] }>(r);
        this.marketListings = listings;
        break;
      }

      case ServerOpcode.MarketActionResult: {
        const res = decodeJsonPayload<{ ok: boolean; message: string }>(r);
        this.ui.pushToast(res.message);
        break;
      }

      case ServerOpcode.ExchangeStateSync: {
        const raw = decodeJsonPayload<ExchangeStateDTO & { closed?: boolean }>(r);
        if (raw.closed) {
          this.exchangeState = null;
          if (this.stage === "Exchange") this.switchStage("Lobby");
        } else {
          this.exchangeState = raw;
          if (this.stage !== "Exchange") this.switchStage("Exchange");
        }
        break;
      }
    }
  }

  private async launchMultiplayerMatch(start: MatchStartPayload): Promise<void> {
    this.myPrimarySlot = start.myPrimarySlot;
    this.mySecondarySlot = start.mySecondarySlot;
    this.isOfflineSolo = false;
    this.matchResult = null;

    const mapObj = await this.assets.prefetchMapAssets(start.mapName);
    if (!mapObj) return;

    // Prefetch participating characters
    await Promise.all(
      start.slots
        .filter((s) => s.state === "human" || s.state === "bot")
        .map((s) => this.assets.prefetchCharacterBase(s.charIndex)),
    );

    this.world = new GameWorld(
      start.mode,
      mapObj,
      start.slots,
      start.seed,
      this.assets.staticMapData,
    );
    this.stage = "Game";
    this.modal = "none";
    this.ui.blurField();
    this.audio.playSfxById(20); // Wave/Start
    void this.audio.playBgm(
      start.mode === GameMode.Bonus
        ? "MP3/Bonus"
        : start.mode === GameMode.Monster
          ? "MP3/Monster"
          : start.mode === GameMode.Kart
            ? "MP3/Kart"
            : this.audio.selectMapBgm(start.mapName),
    );
  }

  private applyAuthoritativeSync(r: BinaryReader): void {
    const world = this.world;
    if (!world || this.isOfflineSolo) return;

    const srvTick = r.u32();
    const srvTime = r.u16();
    world.timeRemainingTicks = srvTime;
    void srvTick;

    const bCount = r.u8();
    for (let i = 0; i < bCount; i++) {
      const slotIdx = r.u8();
      const x = r.i16();
      const y = r.i16();
      const dir = r.i8() as Direction;
      const moving = r.u8() !== 0;
      const status = r.u8();
      const statusTicks = r.u16();
      const bombsCur = r.u8();
      const powerCur = r.u8();
      const speedCur = r.u8();
      const mountType = r.i8();
      const ctrlItem = r.u8();
      const ctrlCount = r.u8();
      const altItem = r.u8();
      const altCount = r.u8();

      const b = world.bombers.find((p) => p.slotIndex === slotIdx);
      if (!b) continue;

      const isLocal = slotIdx === this.myPrimarySlot || slotIdx === this.mySecondarySlot;
      if (!isLocal) {
        b.prevX = b.x;
        b.prevY = b.y;
        b.x = x;
        b.y = y;
        b.dir = dir;
        b.moving = moving;
      } else {
        // Local player uses client-side prediction; server snapshot lags by ~1..3 ticks of RTT.
        // Only hard-snap on status change (e.g. trapped/rescued/died) or major desync (> 68px),
        // and gently converge tiny drift so movement NEVER rubber-bands!
        const dx = x - b.x;
        const dy = y - b.y;
        if (b.status !== status || Math.abs(dx) > 68 || Math.abs(dy) > 68) {
          b.x = x;
          b.y = y;
          b.prevX = x;
          b.prevY = y;
        } else if (!b.moving && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
          b.x += Math.sign(dx) * Math.min(Math.abs(dx), 3);
          b.y += Math.sign(dy) * Math.min(Math.abs(dy), 3);
        }
      }
      b.status = status;
      b.statusTicks = statusTicks;
      b.bombsCur = bombsCur;
      b.powerCur = powerCur;
      b.speedCur = speedCur;
      b.mountType = mountType;
      b.ctrlItem = ctrlItem;
      b.ctrlCount = ctrlCount;
      b.altItem = altItem;
      b.altCount = altCount;
    }
  }

  public stepClientFixedTick(
    p1Input: PlayerInputState,
    p2Input: PlayerInputState,
  ): void {
    this.animTick++;
    for (const [slot, em] of this.activeEmotions) {
      em.ticks--;
      if (em.ticks <= 0) this.activeEmotions.delete(slot);
    }
    for (const [sender, cb] of this.chatBubbles) {
      cb.ticks--;
      if (cb.ticks <= 0) this.chatBubbles.delete(sender);
    }

    if (this.stage !== "Game" || !this.world || this.matchResult) return;

    const inputs = new Map<number, PlayerInputState>();
    inputs.set(this.myPrimarySlot, p1Input);
    if (!this.isOfflineSolo) {
      this.net.sendBomberInput(
        this.myPrimarySlot,
        p1Input.dir,
        p1Input.placeBomb,
        p1Input.useCtrl,
        p1Input.useAlt,
      );
    }

    if (this.mySecondarySlot >= 0) {
      inputs.set(this.mySecondarySlot, p2Input);
      if (!this.isOfflineSolo) {
        this.net.sendBomberInput(
          this.mySecondarySlot,
          p2Input.dir,
          p2Input.placeBomb,
          p2Input.useCtrl,
          p2Input.useAlt,
        );
      }
    }

    for (const b of this.world.bombers) {
      if (b.isBot) {
        inputs.set(b.slotIndex, computeBotInput(this.world, b));
      }
    }

    this.world.stepTick(inputs);
    for (const ev of this.world.soundEvents) {
      this.audio.playSfxById(ev.sfxId);
    }
    this.world.soundEvents.length = 0;

    if (this.isOfflineSolo && this.world.finished && !this.matchResult) {
      this.matchResult = {
        winningTeam: this.world.winningTeam,
        winnerSlots: [],
        scores: this.world.bombers.map((b) => ({
          slotIndex: b.slotIndex,
          nickname: b.nickname,
          team: b.team,
          kills: b.kills,
          saves: b.saves,
          blocks: b.blocksDestroyed,
          expGain: 120,
          lucciGain: 300 + b.bonusLucci,
          leveledUp: false,
          newLevel: this.profile?.level ?? 1,
        })),
      };
    }
  }
}

export { ClientOpcode };
