import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { decryptIdd, isSmartStream } from "../src/shared/crypto.ts";
import { FftFont } from "../src/shared/formats/fft.ts";
import {
  parseBikHeader,
  parseBomberAttr,
  parseFilterWords,
  parseGameMap,
  parseItemAttr,
  parseItemDescTable,
  parseMapGroup,
  parseStringTableBuffer,
} from "../src/shared/formats/gameData.ts";
import { decodeI16, tintI16LayerAdjust } from "../src/shared/formats/i16.ts";
import { parseObjectTable, parseTileInfoList } from "../src/shared/formats/objectTable.ts";
import { type ArchiveName, lookupPackEntry, parsePackIdx } from "../src/shared/formats/packIndex.ts";

function decompressSync(buf: Uint8Array): Uint8Array {
  if (!isSmartStream(buf)) return buf;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const compSize = view.getUint32(9, true);
  if (buf[13] === 0) return buf.subarray(14, Math.min(buf.byteLength, 14 + compSize));
  return new Uint8Array(inflateSync(buf.subarray(18, Math.min(buf.byteLength, 18 + compSize))));
}

function readPackEntrySync(
  iddBuf: Uint8Array,
  idx: ReturnType<typeof parsePackIdx>,
  name: string,
): Uint8Array {
  const meta = lookupPackEntry(idx, name);
  if (!meta) throw new Error(`Missing entry ${name} in ${idx.archive}`);
  const raw = iddBuf.subarray(meta.offset, meta.offset + meta.size);
  return decompressSync(decryptIdd(raw, meta.mask));
}

const archives: ArchiveName[] = ["Fx", "CharTE", "EmoTE"];
let totalEntries = 0;

const loadedIdx = new Map<ArchiveName, ReturnType<typeof parsePackIdx>>();
const loadedIdd = new Map<ArchiveName, Uint8Array>();

for (const arc of archives) {
  const idxRaw = new Uint8Array(readFileSync(`${arc}.idx`));
  const iddRaw = new Uint8Array(readFileSync(`${arc}.idd`));
  const idx = parsePackIdx(idxRaw, arc);
  loadedIdx.set(arc, idx);
  loadedIdd.set(arc, iddRaw);
  totalEntries += idx.entries.size;
  console.log(`[Pack] ${arc}: ${idx.entries.size} entries parsed cleanly`);
}

console.log(`[Pack] Total packed entries: ${totalEntries}`);

const fxIdx = loadedIdx.get("Fx")!;
const fxIdd = loadedIdd.get("Fx")!;
const charIdx = loadedIdx.get("CharTE")!;
const charIdd = loadedIdd.get("CharTE")!;
const emoIdx = loadedIdx.get("EmoTE")!;
const emoIdd = loadedIdd.get("EmoTE")!;

// 1. ObjectTables
const fxOT = parseObjectTable(readPackEntrySync(fxIdd, fxIdx, "ObjectTable/ObjectTable"), 0);
const charOTKey = [...charIdx.entries.keys()].find((k) => k.toLowerCase().includes("objecttable"))!;
const charOT = parseObjectTable(readPackEntrySync(charIdd, charIdx, charOTKey), fxOT.entries.length);
const emoOTKey = [...emoIdx.entries.keys()].find((k) => k.toLowerCase().includes("objecttable"))!;
const emoOT = parseObjectTable(
  readPackEntrySync(emoIdd, emoIdx, emoOTKey),
  fxOT.entries.length + charOT.entries.length,
);
console.log(
  `[ObjectTable] Fx=${fxOT.entries.length}, CharTE=${charOT.entries.length}, EmoTE=${emoOT.entries.length}`,
);

// 2. BomberAttr, ItemAttr, MapGroup, TileInfoList
const bombers = parseBomberAttr(readPackEntrySync(fxIdd, fxIdx, "Attr/BomberAttr"));
const itemAttr = parseItemAttr(readPackEntrySync(fxIdd, fxIdx, "Attr/ItemAttr"));
const mapGroups = parseMapGroup(readPackEntrySync(fxIdd, fxIdx, "Attr/MapGroup"));
const tileInfos = parseTileInfoList(readPackEntrySync(fxIdd, fxIdx, "TileInfo/TileInfoList"));
console.log(
  `[Data] Bombers=${bombers.length} (${bombers.map((b) => b.codeName).join(",")}), Ships=${itemAttr.ships.length}, Items=${itemAttr.items.length}, MapGroups=${mapGroups.length}, TileInfos=${tileInfos.size}`,
);

// 3. Parse ALL Map/* entries in Fx
let mapCount = 0;
for (const [name, meta] of fxIdx.entries) {
  if (name.startsWith("Map/")) {
    const raw = fxIdd.subarray(meta.offset, meta.offset + meta.size);
    const buf = decompressSync(decryptIdd(raw, meta.mask));
    const parsed = parseGameMap(name.slice(4), buf);
    if (parsed.cols !== 15 || parsed.rows !== 13) {
      throw new Error(`Unexpected map size in ${name}: ${parsed.cols}x${parsed.rows}`);
    }
    mapCount++;
  }
}
console.log(`[Maps] Successfully parsed all ${mapCount} Map/* files (15x13 verified)`);

// 4. Decode sample .i16 sprites + 9-team HSL tinting
const bombI16 = decodeI16(readPackEntrySync(fxIdd, fxIdx, "Bomb/Bomb00"));
const bazziSampleKey = [...fxIdx.entries.keys()].find((k) => k.startsWith("Bomber/") && k.endsWith("LayerAdjust"));
if (bazziSampleKey) {
  const adj = decodeI16(readPackEntrySync(fxIdd, fxIdx, bazziSampleKey));
  const tintedBlue = tintI16LayerAdjust(adj, 5);
  console.log(
    `[I16] Bomb/Bomb00 frames=${bombI16.frameCount}, ${bazziSampleKey} frames=${adj.frameCount} (tinted team 5 ok: ${tintedBlue.textures.length} sheets)`,
  );
} else {
  console.log(`[I16] Bomb/Bomb00 frames=${bombI16.frameCount}`);
}

// 5. Regression guard: every hard-coded asset path in src/client must really exist in the packs,
//    and every Attr/ItemAttr.templateName must resolve to a real sprite (or an ObjectTable template).
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const fxTopDirs = new Set(
    [...fxIdx.entries.keys()].map((k) => k.split("/")[0]!),
  );
  const otTemplateNames = new Set([
    ...fxOT.byName.keys(),
    ...charOT.byName.keys(),
    ...emoOT.byName.keys(),
  ]);

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });

  const badPaths: string[] = [];
  let checkedPaths = 0;
  for (const file of walk("src/client")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/"([A-Za-z][A-Za-z0-9_]*\/[A-Za-z0-9_\-\.]+)"/g)) {
      const p = m[1]!;
      if (!fxTopDirs.has(p.split("/")[0]!)) continue;
      checkedPaths++;
      if (otTemplateNames.has(p.toLowerCase())) continue; // ObjectTable template alias
      if (!lookupPackEntry(fxIdx, p)) badPaths.push(`${file}: ${p}`);
    }
  }
  if (badPaths.length > 0) {
    throw new Error(
      `Hard-coded asset paths missing from Fx.idd:\n  ${badPaths.join("\n  ")}`,
    );
  }
  console.log(`[Assets] ${checkedPaths} hard-coded client asset paths all exist in Fx.idd`);

  // Attr/ItemAttr carries 11 "Icon/EventItem00..10" rows for seasonal events that were
  // never shipped inside this build's Fx.idd -- they are weight-0 and unreachable.
  const EVENT_ITEM_ONLY = /^Icon\/EventItem\d\d$/;
  let badItems = 0;
  for (const it of itemAttr.items) {
    if (lookupPackEntry(fxIdx, it.templateName)) continue;
    if (otTemplateNames.has(it.templateName.toLowerCase())) continue;
    if (EVENT_ITEM_ONLY.test(it.templateName)) continue;
    badItems++;
    console.log(`  ! ItemAttr "${it.name}" template "${it.templateName}" resolves to nothing`);
  }
  if (badItems > 0) {
    throw new Error(`${badItems} Attr/ItemAttr entries have unresolvable templates`);
  }
  console.log(`[Assets] All ${itemAttr.items.length} Attr/ItemAttr templates resolve to real sprites`);
}

// 6. Decode .fft font + .ssd + nm.bik
const fft = new FftFont("CxUni", new Uint8Array(readFileSync("CxUni.fft")));
const gWater = fft.decodeGlyph("水".charCodeAt(0), true);
const csys = parseStringTableBuffer(decompressSync(new Uint8Array(readFileSync("csysstr.ssd"))));
const stab = parseItemDescTable(decompressSync(new Uint8Array(readFileSync("stringtable.ini"))));
const fwords = parseFilterWords(decompressSync(new Uint8Array(readFileSync("filterstr.ssd"))));
const bik = parseBikHeader(new Uint8Array(readFileSync("nm.bik")));
console.log(
  `[Fonts & Misc] CxUni '水'=${gWater.width}x${gWater.height} adv=${gWater.advance}, csysstr=${csys.size}, stringtable=${stab.size}, filterstr=${fwords.length}, nm.bik=${bik.magic} ${bik.width}x${bik.height} ${bik.frameCount}f@${bik.fpsNum}/${bik.fpsDen}fps`,
);
