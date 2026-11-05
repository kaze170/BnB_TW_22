import type { GameMode } from "./constants.ts";
import { BinaryReader, BinaryWriter } from "./crypto.ts";

/**
 * Exact C->S opcodes from CA.exe CSendPacket calls (0..338)
 */
export const enum ClientOpcode {
  KeepAlive = 0,
  Login1P = 2,
  RegisterAccount = 3,
  Login2P = 4,
  SelectChannel = 9,
  RefreshChannels = 10,
  EnterStage = 14,
  ChatMessage = 19,
  WhisperMessage = 20,
  FindUser = 22,
  RoomListRequest = 60,
  CreateRoom = 61,
  JoinRoom = 62,
  QuickJoin = 63,
  LeaveRoom = 65,
  RoomSettingChange = 90, // map / mode / title / password
  SlotStateChange = 91, // open / close / AI bot
  SelectCharacterTeam = 92, // charIndex, teamColor, subPlayer
  ToggleReady = 93,
  StartMatch = 94,
  KickPlayer = 95,
  EmotionTrigger = 98,
  // Real-time CGameStage C->S opcodes (CA.exe 106..138)
  BomberPosSync = 106, // x, y, dir, animState, moving
  PlaceBomb = 107, // row, col, power, bombSkin
  BombExplodeReq = 109, // bombId, row, col, reason
  PickupItemReq = 110, // row, col, itemUid
  PushOrKickAction = 111, // kind (0=pushBlock, 1=kickBomb, 2=throwBomb), row, col, dir
  UseActiveItem = 112, // slotIdx (0=Ctrl, 1=Alt) or needle/dart/radar/shield/spring
  BomberStateEvent = 113, // subcode: 0x10=jump, 0x20=trapped, 0x30=rescued, 0x40=killed, 0x50=needleRescue, 0x60=shipHit
  KartCheckpoint = 128, // sub_44FED9 packet 128
  MonsterEvent = 131, // monster trap / damage / boss hit
  RoundLoaded = 135,
  // Economy, Shop, Inventory, Gacha, Exchange, Market, Social
  ShopCatalogReq = 190,
  ShopBuyItem = 191,
  ShopGiftItem = 192,
  EquipAvatarItem = 195,
  SlotMachinePlay = 201,
  ExchangeRequest = 210,
  ExchangeUpdateOffer = 211,
  ExchangeConfirm = 212,
  ExchangeCancel = 213,
  FriendAction = 240, // add / remove / list
  NoteAction = 250, // send / read / delete / list
  CoupleAction = 260, // propose / accept / break
  QuestAction = 268, // list / claim
  MyInfoRequest = 273,
  MarketListReq = 274,
  MarketCreateListing = 275,
  MarketBuyListing = 276,
  MarketCancelListing = 277,
}

/**
 * Exact S->C opcodes from CA.exe CStage::OnPacket (sub_4BDBF5, CLoginStage::sub_569420,
 * CSelectServerStage::sub_56D2FB, CLobbyStage::sub_4C86A2, CPrepareStage::sub_4DCF07,
 * CGameStage::sub_4F672F, CShopStageNew::sub_53C550, CExchangeStage::sub_55C714, CUserMarketStage::sub_574380)
 */
export const enum ServerOpcode {
  Pong = 1,
  LoginResult = 4, // CLoginStage::sub_569420 case 4
  Login2PResult = 5, // case 5
  ServerNotice = 6, // case 6
  ChannelList = 7, // CSelectServerStage::sub_56D2FB case 7
  ChannelEnterResult = 12, // case 12
  OnlineUsersList = 15, // CLobbyStage case 15
  ChatBroadcast = 21, // CSessionStage case 21
  WhisperBroadcast = 25, // CLobbyStage case 25
  FindUserResult = 29, // CLobbyStage case 29
  SystemToast = 48, // CStage / CLobbyStage case 48
  RoomListSync = 79, // CLobbyStage case 79
  RoomUpdated = 80, // CLobbyStage case 80
  RoomEnterResult = 83, // CLobbyStage case 83
  RoomStateSync = 109, // CPrepareStage case 109
  RoomSlotSync = 111, // CPrepareStage case 111
  RoomChatBroadcast = 114, // CPrepareStage case 114
  EmotionBroadcast = 116, // CPrepareStage case 116
  MatchStartLoad = 124, // CPrepareStage case 124 -> enter CGameStage!
  // Real-time CGameStage S->C opcodes (sub_4F672F)
  BombExploded = 140, // sub_4EC806
  ItemPickedUp = 141, // sub_4ECAAA
  TileDestroyed = 142, // sub_4EB01C
  PlayerStateSync = 144, // sub_4F267E (move / trap / rescue / kill / needle / mount)
  BombPlacedSync = 145, // sub_4EA9CC
  ItemSpawned = 146, // ground item revealed / dropped
  MatchRoundReset = 153, // sub_4F2D1A
  PushOrKickSync = 154, // sub_4ECD11
  ModeFlagSync = 156, // sub_4ECDDB (Bula / Captain / Survival / Timebomb / Kart / Monster)
  ModeObjectHit = 157, // sub_4ECEF0
  RebirthToGhost = 158, // sub_4F13F5
  MatchResult = 165, // sub_4EAC12 (Win/Lose/Draw + XP + Lucci + LevelUp)
  // Economy, Shop, Inventory, Social, Trade, Market
  ProfileAndWalletSync = 194, // CStage::sub_4BDBF5 case 194
  InventorySync = 197, // case 197
  ShopCatalogSync = 204, // CShopStageNew::sub_53C550 case 204
  ShopPurchaseResult = 214, // case 214
  SlotMachineResult = 238, // case 238
  FriendListSync = 240, // CStage case 240
  NoteListSync = 250, // CStage case 250..254
  CoupleSync = 265, // CStage case 265
  QuestSync = 268, // CStage case 268
  MarketListingsSync = 274, // CUserMarketStage::sub_574380 case 274
  MarketActionResult = 275, // case 275
  ExchangeStateSync = 280, // CExchangeStage sync
}

// Structured DTOs carried over binary packets

export interface EquippedAvatar {
  head: number; // itemId or 0
  body: number;
  eyes: number;
  mouth: number;
  cap: number;
  flag: number;
  wing: number;
  effect: number;
  bombSkin: number;
  balloon: number;
  foreground: number;
  background: number;
}

export const EMPTY_EQUIPPED: EquippedAvatar = {
  head: 0,
  body: 0,
  eyes: 0,
  mouth: 0,
  cap: 0,
  flag: 0,
  wing: 0,
  effect: 0,
  bombSkin: 0,
  balloon: 0,
  foreground: 0,
  background: 0,
};

export interface UserProfileDTO {
  userId: number;
  username: string;
  nickname: string;
  level: number;
  exp: number;
  nextExp: number;
  lucci: number;
  cash: number;
  wins: number;
  losses: number;
  draws: number;
  guildName: string;
  couplePartner: string;
  coupleRingId: number;
  defaultChar: number;
  equipped: EquippedAvatar;
}

export interface OwnedItemDTO {
  invId: number;
  itemId: number;
  quantity: number;
  equippedSlot: number; // -1 if unequipped, else AvatarSlot enum
  expiresAt: number; // 0 = permanent
}

export const enum AvatarSlot {
  Cap = 0,
  Head = 1,
  Clothes = 2,
  Face = 3,
  Flag = 4,
  Wing = 5,
  Effect = 6,
  BombSkin = 7,
  Balloon = 8,
  Consumable = 255,
}

export interface ShopItemDTO {
  itemId: number;
  code: string; // template path in CharTE / EmoTE / Fx
  name: string;
  description: string;
  tab: number; // 0=套裝/服飾, 1=帽子/頭髮, 2=表情/臉飾, 3=水球/特效, 4=旗幟/背飾, 5=道具/功能, 6=禮包
  slot: number; // AvatarSlot
  priceLucci: number;
  priceCash: number;
  minLevel: number;
  isPackage: boolean;
  packageItems: number[];
}

export interface ChannelInfoDTO {
  id: number;
  name: string;
  category: "beginner" | "free" | "pro" | "guild" | "mission" | "market";
  currentUsers: number;
  maxUsers: number;
  minLevel: number;
  maxLevel: number;
}

export interface RoomSummaryDTO {
  roomId: number;
  roomNumber: number;
  title: string;
  hasPassword: boolean;
  mode: GameMode;
  mapName: string;
  playerCount: number;
  maxPlayers: number;
  status: "waiting" | "playing";
}

export interface RoomSlotDTO {
  slotIndex: number; // 0..7
  state: "open" | "closed" | "human" | "bot";
  userId: number;
  nickname: string;
  level: number;
  isHost: boolean;
  isReady: boolean;
  isLocal2P: boolean;
  charIndex: number; // 0..10
  team: number; // 0..8
  equipped: EquippedAvatar;
}

export interface RoomDetailDTO {
  roomId: number;
  roomNumber: number;
  title: string;
  hasPassword: boolean;
  mode: GameMode;
  mapName: string;
  status: "waiting" | "playing";
  hostSlot: number;
  slots: RoomSlotDTO[];
}

export interface FriendDTO {
  userId: number;
  nickname: string;
  level: number;
  online: boolean;
  channelId: number;
  roomId: number;
}

export interface NoteDTO {
  noteId: number;
  sender: string;
  receiver: string;
  content: string;
  giftItemId: number;
  createdAt: number;
  isRead: boolean;
}

export interface QuestDTO {
  questId: number;
  title: string;
  description: string;
  progress: number;
  target: number;
  rewardLucci: number;
  rewardCash: number;
  rewardExp: number;
  claimed: boolean;
}

export interface MarketListingDTO {
  listingId: number;
  sellerId: number;
  sellerName: string;
  itemId: number;
  quantity: number;
  priceLucci: number;
  createdAt: number;
}

export interface ExchangeStateDTO {
  sessionId: number;
  partnerId: number;
  partnerName: string;
  myItems: number[];
  myLucci: number;
  myLocked: boolean;
  partnerItems: number[];
  partnerLucci: number;
  partnerLocked: boolean;
}

export interface MatchStartPayload {
  roomId: number;
  seed: number;
  mode: GameMode;
  mapName: string;
  slots: RoomSlotDTO[];
  myPrimarySlot: number;
  mySecondarySlot: number; // -1 unless 2P local active
}

export interface MatchPlayerScore {
  slotIndex: number;
  nickname: string;
  team: number;
  kills: number;
  saves: number;
  blocks: number;
  expGain: number;
  lucciGain: number;
  leveledUp: boolean;
  newLevel: number;
}

export interface MatchResultPayload {
  winningTeam: number; // -1 = draw, 0..7 = team
  winnerSlots: number[];
  scores: MatchPlayerScore[];
}

/**
 * Compact JSON-over-Binary payload helpers inside PacketCipher frames for complex DTOs,
 * while high-frequency real-time CGameStage packets (106..158) use raw fixed-width binary bytes!
 */
export function encodeJsonPayload<T>(data: T): Uint8Array {
  const w = new BinaryWriter(256);
  w.str16UTF8(JSON.stringify(data));
  return w.toUint8Array();
}

export function decodeJsonPayload<T>(r: BinaryReader): T {
  const json = r.str16UTF8();
  return JSON.parse(json) as T;
}
