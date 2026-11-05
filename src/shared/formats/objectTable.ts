import { BinaryReader } from "../crypto.ts";

export interface AnimationFrame {
  frameIndex: number;
  delayTicks: number;
}

export interface ObjectStateAnim {
  stateName: string;
  imagePath: string;
  isUpDir: boolean;
  frames: AnimationFrame[];
  totalTicks: number;
}

export interface ObjectTemplateEntry {
  /** Global sequential index inside CGameObjectTemplateLib (used by Map/* tile IDs!) */
  id: number;
  name: string;
  offset: number;
  isFolder: boolean;
  rgbTag: [number, number, number];
  states: ObjectStateAnim[];
}

/**
 * Exact 52-byte TileInfo descriptor parsed from TileInfo/TileInfoList XML
 * (CA.exe sub_5C7AC3 + sub_4E1E69..sub_4E1F5D).
 */
export interface TileInfoDesc {
  name: string;
  rawBytes: Uint8Array;
  /** 0=Passable/Ground/Bush, 1=Obstacle/House/Tree/DirBox, 2=1x1 Soft/Push Box, 3=Special/Hazard */
  category: number;
  spanCols: number;
  spanRows: number;
  isSolid: boolean;
  isIndestructible: boolean;
  isPushable: boolean;
  pushDirs: [boolean, boolean, boolean, boolean];
  isBush: boolean;
  specialCode: number;
  friction: number;
}

/**
 * Exact port of CGameObjectTemplateLib::sub_462364 + CGameObjectTemplate::sub_4625B7.
 * Note: CGameObjectTemplateLib assigns sequential indices (0, 1, 2, ...) to EVERY entry
 * in ObjectTable (including 0xFFFFFFFF folder markers!), which Map/*.i16 references by ID!
 */
export function parseObjectTable(
  buf: Uint8Array,
  startGlobalIndex = 0,
): { entries: ObjectTemplateEntry[]; byName: Map<string, ObjectTemplateEntry> } {
  const r = new BinaryReader(buf);
  const count = r.u32();
  const entries: ObjectTemplateEntry[] = [];
  const byName = new Map<string, ObjectTemplateEntry>();

  const headers: { name: string; offset: number }[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.str32CP950().replace(/\\/g, "/");
    const offset = r.u32();
    headers.push({ name, offset });
  }

  for (let i = 0; i < headers.length; i++) {
    const { name, offset } = headers[i]!;
    const globalId = startGlobalIndex + i;
    if (offset === 0xffffffff || offset >= buf.byteLength) {
      const folderEntry: ObjectTemplateEntry = {
        id: globalId,
        name,
        offset,
        isFolder: true,
        rgbTag: [0, 0, 0],
        states: [],
      };
      entries.push(folderEntry);
      byName.set(name, folderEntry);
      byName.set(name.toLowerCase(), folderEntry);
      continue;
    }

    const tr = new BinaryReader(buf, offset);
    const stateCount = tr.u32();
    const states: ObjectStateAnim[] = [];
    const rgbTag: [number, number, number] = [0, 0, 0];

    for (let s = 0; s < stateCount && !tr.eof(); s++) {
      const stateName = tr.str32CP950();
      if (s === 0 && stateName.length >= 7) {
        const m = /\((\d)(\d)(\d)\)$/.exec(stateName);
        if (m) {
          rgbTag[0] = Number(m[1]);
          rgbTag[1] = Number(m[2]);
          rgbTag[2] = Number(m[3]);
        }
      }
      const isUpDir = stateName.length >= 3 && stateName.charCodeAt(2) === 85; // 'U'
      const imagePath = tr.str32CP950().replace(/\\/g, "/");
      const frameCount = tr.u32();
      const frames: AnimationFrame[] = [];
      let totalTicks = 0;
      for (let f = 0; f < frameCount && !tr.eof(); f++) {
        const frameIndex = tr.i32();
        const delayTicks = tr.i32();
        frames.push({ frameIndex, delayTicks });
        if (delayTicks > 0) totalTicks += delayTicks;
      }
      states.push({ stateName, imagePath, isUpDir, frames, totalTicks });
    }

    const entry: ObjectTemplateEntry = {
      id: globalId,
      name,
      offset,
      isFolder: false,
      rgbTag,
      states,
    };
    entries.push(entry);
    byName.set(name, entry);
    byName.set(name.toLowerCase(), entry);
  }

  return { entries, byName };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = clean.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

/**
 * Exact port of CMapObjToTileInfo::sub_5C7B73 + sub_5C7AC3 + sub_4E1E69..sub_4E1F5D.
 * Parses TileInfo/TileInfoList (u32 xmlLen + XML <Tile Name="..." Data="104-hex-chars"/>).
 */
export function parseTileInfoList(buf: Uint8Array): Map<string, TileInfoDesc> {
  const r = new BinaryReader(buf);
  const xmlLen = r.u32();
  const xmlBytes = buf.subarray(4, Math.min(buf.byteLength, 4 + xmlLen));
  const xmlText = new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);

  const map = new Map<string, TileInfoDesc>();
  const tileRegex = /<Tile\s+Name="([^"]+)"\s+Data="([0-9a-fA-F]+)"\s*\/>/g;
  let match: RegExpExecArray | null;

  while ((match = tileRegex.exec(xmlText)) !== null) {
    const name = match[1]!.replace(/\\/g, "/");
    const rawBytes = hexToBytes(match[2]!);
    if (rawBytes.byteLength < 52) continue;

    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, 52);
    const category = view.getInt32(0, true);
    const d1 = view.getInt32(4, true);
    const d2 = view.getInt32(8, true);
    const d3 = view.getInt32(12, true);
    const d6 = view.getInt32(24, true);
    const specialU16 = view.getUint16(42, true);

    // sub_4E1EFE & sub_4E1F1A: spanCols & spanRows
    const spanCols = category >= 0 && category < 2 ? Math.max(1, d1) : 1;
    const spanRows = category >= 0 && category < 2 ? Math.max(1, d2) : 1;

    // sub_4E1E69: solid check
    const isSolid = category === 1 || category === 2 || (category === 0 && d6 !== 0);

    // sub_4E1E85: indestructible check
    let isIndestructible = true;
    switch (category) {
      case 0:
        isIndestructible = false;
        break;
      case 1:
        isIndestructible = d3 !== 0;
        break;
      case 2:
        isIndestructible = false;
        break;
      case 3:
        isIndestructible = d6 !== 0;
        break;
    }

    // Pushable check:
    // - category === 2: d2 !== 0 (e.g. BoxGray has d2=1, BoxOrange has d2=0!)
    // - category === 1: directional push bytes[20..23] (sub_4E1EA4)
    const pushDirs: [boolean, boolean, boolean, boolean] =
      category === 1
        ? [rawBytes[20] !== 0, rawBytes[21] !== 0, rawBytes[22] !== 0, rawBytes[23] !== 0]
        : category === 2 && d2 !== 0
          ? [true, true, true, true]
          : [false, false, false, false];
    const isPushable = pushDirs[0] || pushDirs[1] || pushDirs[2] || pushDirs[3];

    // Bush / hiding check (Tile14_Bush/* or sub_4E1EE1 category===0 && u16[21]>=10000 or name includes Bush)
    const lowerName = name.toLowerCase();
    const isBush =
      lowerName.includes("bush") ||
      lowerName.includes("hide") ||
      (category === 0 && specialU16 >= 10000 && !lowerName.includes("ice"));

    const friction = lowerName.includes("ice") ? 1 : lowerName.includes("sand") || lowerName.includes("swamp") ? 2 : 0;

    const desc: TileInfoDesc = {
      name,
      rawBytes,
      category,
      spanCols,
      spanRows,
      isSolid,
      isIndestructible,
      isPushable,
      pushDirs,
      isBush,
      specialCode: specialU16,
      friction,
    };
    map.set(name, desc);
    map.set(lowerName, desc);
  }

  return map;
}
