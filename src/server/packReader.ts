import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { decryptIdd, isSmartStream } from "../shared/crypto.ts";
import {
  type BomberCharacterAttr,
  type ItemAttrEntry,
  type MapGroupEntry,
  type ParsedGameMap,
  type ShipAttr,
  parseBomberAttr,
  parseFilterWords,
  parseGameMap,
  parseItemAttr,
  parseItemDescTable,
  parseMapGroup,
  parseStringTableBuffer,
} from "../shared/formats/gameData.ts";
import {
  type ObjectTemplateEntry,
  type TileInfoDesc,
  parseObjectTable,
  parseTileInfoList,
} from "../shared/formats/objectTable.ts";
import {
  type ArchiveName,
  type ParsedPackIndex,
  lookupPackEntry,
  parsePackIdx,
} from "../shared/formats/packIndex.ts";
import type { StaticMapData } from "../shared/sim/world.ts";

export function decompressSsi1Sync(buf: Uint8Array): Uint8Array {
  if (!isSmartStream(buf)) return buf;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const compSize = view.getUint32(9, true);
  if (buf[13] === 0) {
    return buf.subarray(14, Math.min(buf.byteLength, 14 + compSize));
  }
  return new Uint8Array(
    inflateSync(buf.subarray(18, Math.min(buf.byteLength, 18 + compSize))),
  );
}

export class ServerPackManager {
  public readonly rawIdx = new Map<ArchiveName, Uint8Array>();
  public readonly rawIdd = new Map<ArchiveName, Uint8Array>();
  public readonly parsedIdx = new Map<ArchiveName, ParsedPackIndex>();

  public readonly fxTemplates: ObjectTemplateEntry[] = [];
  public readonly charTemplates: ObjectTemplateEntry[] = [];
  public readonly emoTemplates: ObjectTemplateEntry[] = [];

  public readonly bombers: BomberCharacterAttr[] = [];
  public readonly ships: ShipAttr[] = [];
  public readonly itemsByName = new Map<string, ItemAttrEntry>();
  public readonly mapGroups: MapGroupEntry[] = [];
  public readonly tileInfos = new Map<string, TileInfoDesc>();
  public readonly maps = new Map<string, ParsedGameMap>();
  public readonly mapNames: string[] = [];

  public readonly sysStrings = new Map<string, string>();
  public readonly itemDescriptions = new Map<number, string>();
  public readonly filterWords: string[] = [];
  public readonly rawStandaloneFiles = new Map<string, Uint8Array>();

  public readonly staticMapData: StaticMapData;

  constructor(rootDir = ".") {
    const archives: ArchiveName[] = ["Fx", "CharTE", "EmoTE"];
    for (const arc of archives) {
      const idxBytes = new Uint8Array(readFileSync(`${rootDir}/${arc}.idx`));
      const iddBytes = new Uint8Array(readFileSync(`${rootDir}/${arc}.idd`));
      this.rawIdx.set(arc, idxBytes);
      this.rawIdd.set(arc, iddBytes);
      this.parsedIdx.set(arc, parsePackIdx(idxBytes, arc));
    }

    // ObjectTables
    const fxOT = parseObjectTable(this.readEntry("Fx", "ObjectTable/ObjectTable")!, 0);
    this.fxTemplates = fxOT.entries;

    const charIdx = this.parsedIdx.get("CharTE")!;
    const charOTKey = [...charIdx.entries.keys()].find((k) =>
      k.toLowerCase().includes("objecttable"),
    )!;
    const charOT = parseObjectTable(
      this.readEntry("CharTE", charOTKey)!,
      this.fxTemplates.length,
    );
    this.charTemplates = charOT.entries;

    const emoIdx = this.parsedIdx.get("EmoTE")!;
    const emoOTKey = [...emoIdx.entries.keys()].find((k) =>
      k.toLowerCase().includes("objecttable"),
    )!;
    const emoOT = parseObjectTable(
      this.readEntry("EmoTE", emoOTKey)!,
      this.fxTemplates.length + this.charTemplates.length,
    );
    this.emoTemplates = emoOT.entries;

    // Attributes & TileInfo
    this.bombers = parseBomberAttr(this.readEntry("Fx", "Attr/BomberAttr")!);
    const itemAttr = parseItemAttr(this.readEntry("Fx", "Attr/ItemAttr")!);
    this.ships = itemAttr.ships;
    for (const it of itemAttr.items) {
      this.itemsByName.set(it.name, it);
      this.itemsByName.set(it.name.toLowerCase(), it);
    }
    this.mapGroups = parseMapGroup(this.readEntry("Fx", "Attr/MapGroup")!);
    this.tileInfos = parseTileInfoList(this.readEntry("Fx", "TileInfo/TileInfoList")!);

    // Parse all 319 Map/* entries from Fx.idd
    const fxIdx = this.parsedIdx.get("Fx")!;
    for (const [normKey, meta] of fxIdx.entries) {
      if (normKey.toLowerCase().startsWith("map/")) {
        const raw = this.readEntry("Fx", meta.name);
        if (!raw) continue;
        try {
          const shortName = meta.name.slice(4); // strip "Map/"
          const parsed = parseGameMap(shortName, raw);
          this.maps.set(shortName, parsed);
          this.maps.set(shortName.toLowerCase(), parsed);
          this.mapNames.push(shortName);
        } catch {
          // ignore non-map metadata if any
        }
      }
    }
    this.mapNames.sort();

    // Standalone fonts, string tables & intro video
    const standaloneList = [
      "CxDefault.fft",
      "CxUni.fft",
      "CxUniBold.fft",
      "CxUniGulim.fft",
      "CxUniGulimBold.fft",
      "csysstr.ssd",
      "stringtable.ini",
      "filterstr.ssd",
      "fxdynimginfo.ssd",
      "CATW.ini",
      "nm.bik",
    ];
    for (const fname of standaloneList) {
      try {
        const bytes = new Uint8Array(readFileSync(`${rootDir}/${fname}`));
        this.rawStandaloneFiles.set(fname, bytes);
        this.rawStandaloneFiles.set(fname.toLowerCase(), bytes);
      } catch {
        // optional
      }
    }

    const csysRaw = this.rawStandaloneFiles.get("csysstr.ssd");
    if (csysRaw) {
      this.sysStrings = parseStringTableBuffer(decompressSsi1Sync(csysRaw));
    }
    const stabRaw = this.rawStandaloneFiles.get("stringtable.ini");
    if (stabRaw) {
      this.itemDescriptions = parseItemDescTable(decompressSsi1Sync(stabRaw));
    }
    const filterRaw = this.rawStandaloneFiles.get("filterstr.ssd");
    if (filterRaw) {
      this.filterWords = parseFilterWords(decompressSsi1Sync(filterRaw));
    }

    this.staticMapData = {
      bombers: this.bombers,
      items: this.itemsByName,
      ships: this.ships,
      fxTemplates: this.fxTemplates,
      tileInfos: this.tileInfos,
    };
  }

  /** Reads, decrypts, and ssi1-decompresses a packed entry directly from memory-mapped .idd bytes */
  public readEntry(archive: ArchiveName, path: string): Uint8Array | null {
    const idx = this.parsedIdx.get(archive);
    const idd = this.rawIdd.get(archive);
    if (!idx || !idd) return null;
    const meta = lookupPackEntry(idx, path);
    if (!meta) return null;
    const slice = idd.subarray(meta.offset, meta.offset + meta.size);
    return decompressSsi1Sync(decryptIdd(slice, meta.mask));
  }

  /** Returns the raw encrypted slice in .idd (if client wishes to decrypt locally) */
  public readRawEncryptedSlice(archive: ArchiveName, path: string): { bytes: Uint8Array; mask: number } | null {
    const idx = this.parsedIdx.get(archive);
    const idd = this.rawIdd.get(archive);
    if (!idx || !idd) return null;
    const meta = lookupPackEntry(idx, path);
    if (!meta) return null;
    return {
      bytes: idd.subarray(meta.offset, meta.offset + meta.size),
      mask: meta.mask,
    };
  }

  public getMapOrFallback(mapName: string): ParsedGameMap {
    const exact =
      this.maps.get(mapName) ??
      this.maps.get(mapName.toLowerCase());
    if (exact) return exact;
    // Prefer classic Village_00 / Pirate_00 / Camp_00 if present
    for (const candidate of this.mapNames) {
      if (candidate.toLowerCase().includes("village") || candidate.toLowerCase().includes("patrit") || candidate.toLowerCase().includes("camp")) {
        const m = this.maps.get(candidate);
        if (m) return m;
      }
    }
    return this.maps.get(this.mapNames[0]!)!;
  }
}
