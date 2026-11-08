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
  | { t: "ready"; ready: boolean }
  | { t: "startGame" }
  | { t: "gameInput"; seq: number; dx: number; dy: number; bomb: boolean }
  | { t: "ping"; time: number };

export type S2C =
  | { t: "loginResult"; ok: boolean; reason?: string; user?: UserInfo }
  | { t: "serverList"; servers: ServerInfo[] }
  | { t: "channelList"; channels: ChannelInfo[] }
  | { t: "lobbyState"; rooms: RoomInfo[]; users: number }
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
  state: "waiting" | "playing";
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
}

/** Gameplay snapshot types — values/semantics follow CA.exe (40px tiles etc.). */
export interface GameInitState {
  map: number;
  width: number;
  height: number;
  tiles: number[];
  players: Array<{ id: string; slot: number; character: number; x: number; y: number }>;
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
}
export interface BombState {
  x: number;
  y: number;
  owner: string;
  timer: number;
  power: number;
}
export interface GameSnapshot {
  bombers: BomberState[];
  bombs: BombState[];
  tiles: number[];
  explosions: Array<{ x: number; y: number; ttl: number }>;
}
export interface GameResult {
  winner: string | null;
  draw: boolean;
}