/**
 * Original decrypted game data (data/original/*.json), extracted + CRC-verified
 * from the pack archives by tools/extract_original_data.py. These are the exact
 * tables the CA.exe client loads (Attr/BomberAttr, Attr/ItemAttr, Map/*,
 * TileInfo/TileInfoList, ObjectTable/ObjectTable).
 */
import mapsJson from "../../data/original/maps.json";
import objectTableJson from "../../data/original/objectTable.json";
import tileInfoJson from "../../data/original/tileInfo.json";
import bomberAttrJson from "../../data/original/bomberAttr.json";
import itemAttrJson from "../../data/original/itemAttr.json";
import mapGroupJson from "../../data/original/mapGroup.json";
import { EXPLOSION_BASE_MS, PRACTICE_FUSE_MS } from "../shared/timing.ts";

export interface RawMap {
  version: number; width: number; height: number;
  spawns: number[][]; grid: number[][];
  drops: Array<{ name: string; weight: number }>;
}
export interface TileInfo { type: number; width: number; height: number; raw: string }
export interface CharAttr { name: string; stats: number[] }
export interface ItemAttr { name: string; name2: string; fields: number[] }

export const MAPS = mapsJson as unknown as Record<string, RawMap>;
export const OBJECT_NAMES = objectTableJson as string[];
export const TILE_INFO = tileInfoJson as unknown as Record<string, TileInfo>;
export const CHARACTERS = bomberAttrJson as CharAttr[];
export const ITEMS = (itemAttrJson as { items: ItemAttr[] }).items;
export const MAP_GROUPS = mapGroupJson as Array<{ name: string; maps: string[] }>;

export const TILE = 40; // CGOTile: 40px (verified)
/** Effect-scheduling base from sub_442FF7 (*a5 = 300). The vertical-slice
 * simulation currently also uses it as an interim fire-cell TTL; the exact
 * CGOFlame lifetime is animation-driven and still being recovered. */
export const EXPLOSION_MS = EXPLOSION_BASE_MS;
/** Fuse used by the exe's practice/local explosion path (sub_4E87D8 ...,2000).
 * Online play is server-authoritative; this is the faithful local reference. */
export const FUSE_MS = PRACTICE_FUSE_MS;

export const MAP_NAMES = Object.keys(MAPS).sort();

export function tileName(id: number): string | null {
  return id >= 0 && id < OBJECT_NAMES.length ? OBJECT_NAMES[id]! : null;
}
export function tileType(name: string | null): number {
  if (!name) return 0;
  return TILE_INFO[name]?.type ?? 0;
}

/** Character base stats — confirmed by CGOBomber debug dump (m_nSpeed /
 * m_nBombCount / m_nBombPower) and the item clamp routines:
 *   stat1=base speed (m_nSpeed),      stat2=max speed (sub_447936 cap)
 *   stat3=base bomb count,            stat4=max bombs (CBombOwner sub_4385BE)
 *   stat5=base bomb power,            stat6=max power (CBombOwner sub_4386BE)
 * C00 => speed 5 (cap 7), bombs 1 (cap 10), power 1 (cap 7). */
export function charStats(character: number) {
  const c = CHARACTERS[character] ?? CHARACTERS[0]!;
  const s = c.stats;
  return {
    speed: s[1]!, speedCap: s[2]!,
    bombCount: s[3]!, bombCap: s[4]!,
    power: s[5]!, powerCap: s[6]!,
  };
}

/** Weighted gameplay item drops (ItemAttr field0 = weight). */
export const DROP_ITEMS = ITEMS.filter((i) => i.fields[2] === 1 && i.fields[0]! > 0);
export function rollItem(rand: () => number, mapDrops: Array<{ name: string; weight: number }>): string | null {
  const pool = [
    ...DROP_ITEMS.map((i) => ({ name: i.name, weight: i.fields[0]! })),
    ...mapDrops,
  ];
  const total = pool.reduce((a, b) => a + b.weight, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p.name;
  }
  return pool[pool.length - 1]!.name;
}
export function itemType(name: string): number {
  return ITEMS.find((i) => i.name === name)?.fields[3] ?? 99;
}
