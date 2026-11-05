import { BinaryReader } from "../crypto.ts";
import { decodeCP950 } from "../cp950.ts";

export interface BomberCharacterAttr {
  index: number;
  rawId: string; // e.g. "Bomber/C00_Bazzi"
  codeName: string; // e.g. "Bazzi"
  prepareImage: string;
  displayImage: string;
  portraitImage: string;
  emotionImage: string;
  category: number;
  bombsInit: number;
  bombsMax: number;
  powerInit: number;
  powerMax: number;
  speedInit: number;
  speedMax: number;
  extra0: number;
  extra1: number;
  extra2: number;
}

export interface ShipAttr {
  index: number;
  shipType: number;
  name: string;
  speed: number;
  stats: number[];
}

export interface ItemAttrEntry {
  index: number;
  name: string; // e.g. "Item/ItemBomb"
  templateName: string;
  spawnWeight: number;
  effectCode: number;
  effectValue: number;
  params: number[];
}

export interface ParsedItemAttrTable {
  header0: number;
  header1: number;
  ships: ShipAttr[];
  items: ItemAttrEntry[];
  itemsByName: Map<string, ItemAttrEntry>;
}

export interface MapGroupEntry {
  groupName: string;
  maps: string[];
}

export interface MapSpawnPoint {
  row: number;
  col: number;
}

export interface MapWarpPortal {
  srcRow: number;
  srcCol: number;
  dstRow: number;
  dstCol: number;
}

export interface MapFixedItem {
  itemName: string;
  row: number;
  col: number;
  flag: number;
}

export interface MapMonsterSpawn {
  monsterName: string;
  row: number;
  col: number;
  pathIndex: number;
  param1: number;
  param2: number;
}

export interface ParsedGameMap {
  mapName: string;
  version: number;
  maxPlayers: number;
  modeFlag: number;
  cols: number;
  rows: number;
  dropRatePermille: number;
  themeFlags: [number, number, number, number];
  spawns: MapSpawnPoint[];
  warps: MapWarpPortal[];
  /** rows * cols ground template IDs (index into Fx ObjectTable, or -1) */
  groundIds: Int32Array;
  /** rows * cols object/block template IDs (index into Fx ObjectTable, or -1) */
  objectIds: Int32Array;
  itemPool: { itemName: string; count: number }[];
  maxTotalItems: number;
  fixedItems: MapFixedItem[];
  patrolPaths: MapSpawnPoint[][];
  monsters: MapMonsterSpawn[];
  mapScriptXml: string;
  timeLimitSec: number;
}

export interface BikVideoHeader {
  magic: string;
  fileSize: number;
  frameCount: number;
  largestFrameBytes: number;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  videoFlags: number;
  audioTrackCount: number;
  frameOffsets: number[];
}

/**
 * Exact port of CBomberAttr::sub_5C6920 ("Attr/BomberAttr") + CCharacterNameMan::sub_49D498.
 * Binary tuple layout per character (10 x i32 after rawId):
 *   [0] category       (v3+320)
 *   [1] speedInit      (v3+324 -> sub_5C67D9)
 *   [2] speedMax       (v3+336 -> sub_5C67F6)
 *   [3] bombsInit      (v3+348 -> sub_5C6813)
 *   [4] bombsMax <= 10 (v3+360 -> sub_5C6830)
 *   [5] powerInit      (v3+372 -> sub_5C684D)
 *   [6] powerMax       (v3+384 -> sub_5C686A)
 *   [7] extra0 (delay) (v3+396)
 *   [8] extra1         (v3+400)
 *   [9] extra2 (devilMaxSpeed) (v3+404)
 */
const CHAR_CODE_TO_NAME: Record<string, string> = {
  C00: "Dao",
  C01: "Dizini",
  C03: "Mos",
  C05: "Ethi",
  C04: "Marid",
  C06: "Bazzi",
  C02: "Uni",
  C07: "Kephi",
  C08: "Random",
  C09: "Super",
  C10: "LuxuryMarid",
};

export function parseBomberAttr(buf: Uint8Array): BomberCharacterAttr[] {
  const r = new BinaryReader(buf);
  const list: BomberCharacterAttr[] = [];
  let idx = 0;

  while (r.remaining >= 48) {
    const rawId = r.str32CP950().replace(/\\/g, "/");
    if (!rawId) break;
    const usPos = rawId.indexOf("_");
    const afterUs = usPos >= 0 ? rawId.slice(usPos + 1) : rawId;
    const cMatch = /(C\d\d)$/i.exec(rawId);
    const cCode = cMatch ? cMatch[1]!.toUpperCase() : `C0${idx}`;
    const codeName = CHAR_CODE_TO_NAME[cCode] ?? afterUs;

    const category = r.i32();
    const speedInit = r.i32();
    const speedMax = r.i32();
    const bombsInit = r.i32();
    const bombsMax = Math.min(10, r.i32());
    const powerInit = r.i32();
    const powerMax = r.i32();
    const extra0 = r.i32();
    const extra1 = r.i32();
    const extra2 = r.i32();

    list.push({
      index: idx++,
      rawId,
      codeName,
      prepareImage: `Prepare/${afterUs}`,
      displayImage: `${rawId}_Display`,
      portraitImage: `${rawId}_Portrait`,
      emotionImage: `${rawId}_Emotion`,
      category,
      bombsInit,
      bombsMax,
      powerInit,
      powerMax,
      speedInit,
      speedMax,
      extra0,
      extra1,
      extra2,
    });
  }

  return list;
}

/**
 * Exact port of CItemBoxOwner::sub_587E... ("Attr/ItemAttr", L365844..L365975).
 */
export function parseItemAttr(buf: Uint8Array): ParsedItemAttrTable {
  const r = new BinaryReader(buf);
  const header0 = r.i32();
  const header1 = r.i32();
  const shipCount = r.i32();

  const ships: ShipAttr[] = [];
  for (let i = 0; i < shipCount && !r.eof(); i++) {
    const shipType = r.i32();
    const name = r.str32CP950().replace(/\\/g, "/");
    const speed = r.i32();
    const stats: number[] = [];
    for (let k = 0; k < 7; k++) {
      stats.push(r.i32());
    }
    ships.push({ index: i, shipType, name, speed, stats });
  }

  const items: ItemAttrEntry[] = [];
  const itemsByName = new Map<string, ItemAttrEntry>();
  let idx = 0;
  while (r.remaining >= 16) {
    const name = r.str32CP950().replace(/\\/g, "/");
    const templateName = r.str32CP950().replace(/\\/g, "/");
    if (!name || !templateName) break;
    const spawnWeight = r.i32();
    const effectCode = r.i32();
    const effectValue = r.i32();
    const params: number[] = [];
    for (let k = 0; k < 5; k++) {
      params.push(r.i32());
    }
    const entry: ItemAttrEntry = {
      index: idx++,
      name,
      templateName,
      spawnWeight,
      effectCode,
      effectValue,
      params,
    };
    items.push(entry);
    itemsByName.set(name, entry);
    itemsByName.set(name.toLowerCase(), entry);
  }

  return { header0, header1, ships, items, itemsByName };
}

/**
 * Exact port of CMapGroup ("Attr/MapGroup").
 */
export function parseMapGroup(buf: Uint8Array): MapGroupEntry[] {
  const r = new BinaryReader(buf);
  const groupCount = r.u32();
  const groups: MapGroupEntry[] = [];
  for (let g = 0; g < groupCount && !r.eof(); g++) {
    const groupName = r.str32CP950();
    const mapCount = r.u32();
    const maps: string[] = [];
    for (let m = 0; m < mapCount && !r.eof(); m++) {
      maps.push(r.str32CP950());
    }
    groups.push({ groupName, maps });
  }
  return groups;
}

/**
 * Exact port of CGameMap::sub_4E5845 + sub_5868BD + sub_57B10A + sub_4E55D7 ("Map/*").
 */
export function parseGameMap(mapName: string, buf: Uint8Array): ParsedGameMap {
  const r = new BinaryReader(buf);

  const first = r.i32();
  let version: number;
  let maxPlayers: number;
  let modeFlag: number;
  let cols: number;

  if (first < 1000) {
    cols = first;
    version = 232;
    maxPlayers = 8;
    modeFlag = 1;
  } else {
    version = first;
    maxPlayers = r.i32();
    modeFlag = r.i32();
    cols = r.i32();
  }

  const rows = r.i32();
  const spawnCount = r.i32();
  r.skip(16); // v11 += 5 after reading *v11
  const dropRatePermille = r.i32();
  r.skip(8); // v11 += 3 after reading *v11
  const t0 = r.i32();
  const t1 = r.i32();
  const t2 = r.i32();
  const t3 = r.i32();
  r.skip(8); // v16 = v11 + 3 after reading *v11

  const spawns: MapSpawnPoint[] = [];
  for (let i = 0; i < spawnCount; i++) {
    const row = r.i32();
    const col = r.i32();
    spawns.push({ row, col });
  }

  const warpCount = r.i32();
  const warps: MapWarpPortal[] = [];
  for (let i = 0; i < warpCount; i++) {
    const srcRow = r.i32();
    const srcCol = r.i32();
    const dstRow = r.i32();
    const dstCol = r.i32();
    warps.push({ srcRow, srcCol, dstRow, dstCol });
  }

  const cellCount = rows * cols;
  const groundIds = new Int32Array(cellCount);
  const objectIds = new Int32Array(cellCount);
  for (let idx = 0; idx < cellCount; idx++) {
    groundIds[idx] = r.i32();
    objectIds[idx] = r.i32();
  }

  // sub_5868BD: Map item pool & fixed item placements
  const itemPool: { itemName: string; count: number }[] = [];
  let maxTotalItems = 0;
  const fixedItems: MapFixedItem[] = [];

  if (r.remaining >= 12) {
    const poolCount = r.i32();
    for (let i = 0; i < poolCount && !r.eof(); i++) {
      const itemName = r.str32CP950().replace(/\\/g, "/");
      const count = r.i32();
      itemPool.push({ itemName, count });
    }
    maxTotalItems = r.i32();
    const fixedCount = r.i32();
    for (let i = 0; i < fixedCount && !r.eof(); i++) {
      const itemName = r.str32CP950().replace(/\\/g, "/");
      const row = r.u8();
      const col = r.u8();
      const flag = r.u8();
      fixedItems.push({ itemName, row, col, flag });
    }
  }

  // sub_57B10A: Monster patrol paths & spawns
  const patrolPaths: MapSpawnPoint[][] = [];
  const monsters: MapMonsterSpawn[] = [];
  if (r.remaining >= 8) {
    const pathCount = r.i32();
    for (let p = 0; p < pathCount && !r.eof(); p++) {
      const wpCount = r.i32();
      const wps: MapSpawnPoint[] = [];
      for (let w = 0; w < wpCount && !r.eof(); w++) {
        const row = r.i32();
        const col = r.i32();
        wps.push({ row, col });
      }
      patrolPaths.push(wps);
    }
    const monCount = r.i32();
    for (let m = 0; m < monCount && !r.eof(); m++) {
      const monsterName = r.str32CP950().replace(/\\/g, "/");
      const row = r.u8();
      const col = r.u8();
      const pathIndex = r.i32();
      const param1 = r.i32();
      const param2 = r.i32();
      monsters.push({ monsterName, row, col, pathIndex, param1, param2 });
    }
  }

  // Embedded <mapscript> XML (sub_4E55D7)
  let mapScriptXml = "";
  let timeLimitSec = 180;
  if (r.remaining >= 4) {
    const scriptLen = r.i32();
    if (scriptLen > 0 && scriptLen <= r.remaining) {
      mapScriptXml = decodeCP950(r.slice(scriptLen));
      const mTime = /time[^>]*value="(\d+)"|<time>\s*(\d+)\s*<\/time>/i.exec(mapScriptXml);
      if (mTime) {
        const parsed = Number(mTime[1] ?? mTime[2]);
        if (parsed > 0 && parsed <= 3600) timeLimitSec = parsed;
      }
    }
  }

  return {
    mapName,
    version,
    maxPlayers,
    modeFlag,
    cols,
    rows,
    dropRatePermille,
    themeFlags: [t0, t1, t2, t3],
    spawns,
    warps,
    groundIds,
    objectIds,
    itemPool,
    maxTotalItems,
    fixedItems,
    patrolPaths,
    monsters,
    mapScriptXml,
    timeLimitSec,
  };
}

/**
 * Parses decompressed csysstr.ssd (u16 count + (str32CP950 key, str32CP950 val)*count).
 */
export function parseStringTableBuffer(buf: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  if (buf.byteLength < 6) return out;

  const r = new BinaryReader(buf);
  const count = r.u16();
  if (count > 0 && count < 65535) {
    let ok = true;
    for (let i = 0; i < count && !r.eof(); i++) {
      const kLen = r.u32();
      if (kLen > 4096 || kLen > r.remaining) {
        ok = false;
        break;
      }
      const rawKey = decodeCP950(r.slice(kLen));
      const vLen = r.u32();
      if (vLen > 32768 || vLen > r.remaining) {
        ok = false;
        break;
      }
      const val = decodeCP950(r.slice(vLen));
      if (rawKey) {
        out.set(rawKey, val);
        if (rawKey.startsWith("?")) {
          out.set(rawKey.slice(1), val);
        }
      }
    }
    if (ok && out.size > 0) return out;
  }

  // Fallback INI lines
  const cpText = decodeCP950(buf);
  for (const rawLine of cpText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("//") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return out;
}

/**
 * Parses decompressed stringtable.ini (u16 count + (u32 itemId, str32CP950 desc)*count).
 */
export function parseItemDescTable(buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.byteLength < 6) return out;
  const r = new BinaryReader(buf);
  const count = r.u16();
  for (let i = 0; i < count && r.remaining >= 8; i++) {
    const id = r.u32();
    const desc = r.str32CP950();
    out.set(id, desc);
  }
  return out;
}

/**
 * Parses decompressed filterstr.ssd (u16 count + u8 pad + (str32CP950 word + 5B flags)*count).
 */
export function parseFilterWords(buf: Uint8Array): string[] {
  const words: string[] = [];
  if (buf.byteLength < 4) return words;
  const r = new BinaryReader(buf);
  const count = r.u16();
  r.u8();
  for (let i = 0; i < count && r.remaining >= 9; i++) {
    const w = r.str32CP950();
    r.skip(5);
    if (w) words.push(w);
  }
  return words;
}

/**
 * Parses the RAD Game Tools Bink Video ("BIKi") header & frame index from nm.bik
 * (used by CLogoMan / CTitleStage in CA.exe).
 */
export function parseBikHeader(buf: Uint8Array): BikVideoHeader {
  const r = new BinaryReader(buf);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  const fileSize = r.u32() + 8;
  const frameCount = r.u32();
  const largestFrameBytes = r.u32();
  r.u32(); // internal frame count copy
  const width = r.u32();
  const height = r.u32();
  const fpsNum = r.u32();
  const fpsDen = r.u32();
  const videoFlags = r.u32();
  const audioTrackCount = r.u32();

  // Skip 12 bytes per audio track (maxPacket + sampleRate/flags +trackId)
  r.skip(audioTrackCount * 12);

  const frameOffsets: number[] = [];
  for (let i = 0; i <= frameCount && r.remaining >= 4; i++) {
    // Low bit marks keyframe in BIKi frame offset table
    frameOffsets.push(r.u32() & ~1);
  }

  return {
    magic,
    fileSize,
    frameCount,
    largestFrameBytes,
    width,
    height,
    fpsNum: fpsNum || 30,
    fpsDen: fpsDen || 1,
    videoFlags,
    audioTrackCount,
    frameOffsets,
  };
}
