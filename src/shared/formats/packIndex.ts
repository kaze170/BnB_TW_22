import { PACK_KEY_CHAR_EMO, PACK_KEY_FX } from "../constants.ts";
import { BinaryReader, decryptIdx } from "../crypto.ts";

export type ArchiveName = "Fx" | "CharTE" | "EmoTE";

export interface PackEntryMeta {
  name: string;
  offset: number;
  size: number;
  mask: number;
  crc: number;
}

export interface ParsedPackIndex {
  archive: ArchiveName;
  version: number;
  entries: Map<string, PackEntryMeta>;
  lowerKeyMap: Map<string, string>;
}

export function getArchiveIdxKey(archive: ArchiveName): number {
  return archive === "Fx" ? PACK_KEY_FX : PACK_KEY_CHAR_EMO;
}

/**
 * Exact port of CPackSysMan .idx reader (sub_673110 + 12-byte header + Pascal CP950 strings).
 * Header:
 *   u32 zero = 0
 *   u32 version = 15
 *   u32 entryCount
 * Repeated entryCount times:
 *   u32 nameLen
 *   char name[nameLen]  (CP950, omits ".i16" extension for sprites/tables)
 *   u32 offset, u32 size, u32 mask, u32 crc
 */
export function parsePackIdx(rawIdx: Uint8Array, archive: ArchiveName): ParsedPackIndex {
  const key = getArchiveIdxKey(archive);
  const dec = decryptIdx(rawIdx, key);
  const r = new BinaryReader(dec);

  const zero = r.u32();
  const version = r.u32();
  const count = r.u32();
  if (zero !== 0 || version !== 15 || count > 100000) {
    throw new Error(`Invalid .idx header for ${archive}: zero=${zero}, ver=${version}, count=${count}`);
  }

  const entries = new Map<string, PackEntryMeta>();
  const lowerKeyMap = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    const rawName = r.str32CP950().replace(/\\/g, "/");
    const offset = r.u32();
    const size = r.u32();
    const mask = r.u32();
    const crc = r.u32();
    const meta: PackEntryMeta = { name: rawName, offset, size, mask, crc };
    entries.set(rawName, meta);
    lowerKeyMap.set(rawName.toLowerCase(), rawName);
  }

  return { archive, version, entries, lowerKeyMap };
}

export function lookupPackEntry(index: ParsedPackIndex, queryPath: string): PackEntryMeta | undefined {
  const norm = queryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const direct = index.entries.get(norm);
  if (direct !== undefined) return direct;

  const lower = norm.toLowerCase();
  const canonical = index.lowerKeyMap.get(lower);
  if (canonical !== undefined) return index.entries.get(canonical);

  // Strip .i16 suffix if caller passed e.g. "Map/factory_01.i16"
  if (lower.endsWith(".i16")) {
    const stripped = lower.slice(0, -4);
    const canon2 = index.lowerKeyMap.get(stripped);
    if (canon2 !== undefined) return index.entries.get(canon2);
  }
  return undefined;
}
