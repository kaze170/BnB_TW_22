/**
 * Client<->Server protocol. The SERVER is original (per project decision); this
 * protocol mirrors the semantic flow of the original NMCO client (login ->
 * server select -> channel/lobby -> room/prepare -> game) using JSON over WS.
 * Gameplay constants and UI remain strictly faithful to CA.exe.
 */

export type C2S =
  | { t: "login"; id: string; pw: string }
  | { t: "selectServer"; server: number }
  | { t: "selectChannel"; channel: number }
  | { t: "enterLobby" }
  | { t: "chat"; text: string }
  | { t: "createRoom"; title: string; map: number; mode: number }
  | { t: "joinRoom"; room: number }
  | { t: "leaveRoom" }
  | { t: "returnToRoom" }
  | { t: "ready"; ready: boolean }
  | { t: "selectCharacter"; character: number }
  | { t: "setMap"; map: number }
  | { t: "startGame" }
  | { t: "gameInput"; seq: number; dx: number; dy: number; bomb: boolean }
  | { t: "ping"; time: number };

export type S2C =
  | { t: "loginResult"; ok: boolean; reason?: string; user?: UserInfo }
  | { t: "serverList"; servers: ServerInfo[] }
  | { t: "channelList"; channels: ChannelInfo[] }
  | { t: "lobbyState"; rooms: RoomInfo[]; users: number }
  | { t: "mapList"; names: string[]; groups: Array<{ name: string; maps: string[] }> }
  | { t: "chat"; from: string; text: string }
  | { t: "roomState"; room: RoomState }
  | { t: "gameStart"; state: GameInitState }
  | { t: "gameFrame"; frame: number; state: GameSnapshot }
  | { t: "gameEnd"; result: GameResult }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; time: number };

export interface UserInfo {
  id: string;
  nickname: string;
  character: number;
  level: number;
}
export interface ServerInfo {
  id: number;
  name: string;
  online: number;
}
export interface ChannelInfo {
  id: number;
  name: string;
  users: number;
  max: number;
}
export interface RoomInfo {
  id: number;
  title: string;
  map: number;
  mode: number;
  players: number;
  max: number;
  /** results: match finished, waiting for players to acknowledge returnToRoom */
  state: "waiting" | "playing" | "results";
}
export interface RoomPlayer {
  id: string;
  nickname: string;
  character: number;
  slot: number;
  ready: boolean;
  team: number;
}
export interface RoomState {
  id: number;
  title: string;
  map: number;
  mode: number;
  players: RoomPlayer[];
  max: number;
  hostId: string;
  state: "waiting" | "playing" | "results";
}

/** Gameplay snapshot types — map/character/item data are the decrypted originals
 * (data/original/*.json); tile=40px, maps 15x13. Server simulation is original. */
export interface MapCell {
  ground: string | null;
  object: string | null;
  /** TileInfo type of the blocking layer: 0 ground, 1 static, 2 box, 3 passable */
  kind: number;
}
export interface InitPlayer {
  id: string;
  slot: number;
  character: number;
  x: number;
  y: number;
  speed: number;
  bombCount: number;
  power: number;
  bot: boolean;
}
export interface GameInitState {
  map: string;
  width: number;
  height: number;
  cells: MapCell[];
  players: InitPlayer[];
  fuseMs: number;
  /** @deprecated legacy effect-scheduling base; exact fire lifetime is per
   * ObjectTable animation group and is carried by ExplosionState. */
  explosionMs?: number;
}
export interface BomberState {
  id: string;
  x: number;
  y: number;
  dir: number;
  alive: boolean;
  speed: number;
  bombCount: number;
  power: number;
  bot: boolean;
  /** true while the authoritative grid move is in progress (walk animation). */
  moving?: boolean;
}
export interface BombState {
  id: number;
  x: number;
  y: number;
  owner: string;
  timer: number;
  power: number;
}
export interface ExplosionState {
  x: number;
  y: number;
  /** remaining active lifetime of the drawn flame segment, ms */
  ttl: number;
  /** ms since the drawn segment ignited (counter * 30ms) */
  age?: number;
  /** ObjectTable animation asset, e.g. Bomb/Fire00. */
  asset?: string;
  /** Flame/Flame group index (center power-1, directional 15*dir+14+range). */
  group?: number;
  /** logical I16 image index; CGOFlame uses the segment tick counter directly. */
  frame?: number;
  /** @deprecated center / arm / tip role kept for older snapshots/debug. */
  role?: "center" | "arm" | "tip";
  /** @deprecated 0 down, 1 up, 2 left, 3 right. */
  dir?: number;
}
export interface ItemState {
  id: number;
  x: number;
  y: number;
  item: string;
}
export interface GameSnapshot {
  frame: number;
  /** elapsed match time in ms (frame * 30ms fixed step) */
  timeMs?: number;
  bombers: BomberState[];
  bombs: BombState[];
  explosions: ExplosionState[];
  items: ItemState[];
  /** cell indices whose box was destroyed this frame (object removed) */
  destroyed: number[];
}
export interface ResultRow {
  id: string;
  slot: number;
  character: number;
  bot: boolean;
  alive: boolean;
  /** server-original vertical-slice stats */
  kills: number;
  deaths: number;
  boxes: number;
  items: number;
  score: number;
  rank: number;
  /** Game/ResultImg logical badge index (server-original award assignment) */
  award?: number;
}
export interface GameResult {
  winner: string | null;
  draw: boolean;
  durationMs?: number;
  rows?: ResultRow[];
}
