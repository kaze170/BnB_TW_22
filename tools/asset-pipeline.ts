/**
 * Asset pipeline: convert the original extracted/ assets into web-ready PNG
 * sprites + a manifest. Faithful to CA.exe asset naming.
 *
 * Output:
 *   public/assets/<Archive>/<relpath>.png   (decoded I16 images, vertical frame strip)
 *   public/assets/<Archive>/<relpath>.<ext> (jpg/mp3/wav copied verbatim)
 *   public/assets/data/<Archive>/<relpath>  (non-image .i16 data entries, verbatim)
 *   public/manifest.json                    (logical name -> sprite metadata)
 */
import { readdir, mkdir } from "node:fs/promises";
import { join, relative, dirname, extname } from "node:path";
import { decodeI16, isI16Image } from "./i16.ts";
import { encodePNG } from "./png.ts";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "extracted");
const OUT = join(ROOT, "build", "assets");

interface SpriteEntry {
  kind: "sprite";
  url: string;
  w: number;
  h: number;
  frames: Array<{ x: number; y: number; w: number; h: number }>;
}
interface MediaEntry {
  kind: "image" | "audio" | "data";
  url: string;
}
type Entry = SpriteEntry | MediaEntry;

const manifest: Record<string, Entry> = {};
let nSprite = 0, nMedia = 0, nData = 0, nFrames = 0;

async function walk(dir: string): Promise<string[]> {
  const ents = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else files.push(p);
  }
  return files;
}

async function emitSprite(logical: string, frames: Array<{ width: number; height: number; rgba: Uint8Array }>) {
  // vertical strip; frame widths may differ -> sheet width = max width
  const sheetW = Math.max(...frames.map((f) => f.width));
  const sheetH = frames.reduce((s, f) => s + f.height, 0);
  const sheet = new Uint8Array(sheetW * sheetH * 4);
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  let y = 0;
  for (const f of frames) {
    for (let row = 0; row < f.height; row++) {
      sheet.set(f.rgba.subarray(row * f.width * 4, (row + 1) * f.width * 4), ((y + row) * sheetW) * 4);
    }
    rects.push({ x: 0, y, w: f.width, h: f.height });
    y += f.height;
  }
  const url = `assets/${logical}.png`;
  await mkdir(dirname(join(OUT, "..", url)), { recursive: true });
  await Bun.write(join(OUT, "..", url), encodePNG(sheetW, sheetH, sheet));
  manifest[logical] = { kind: "sprite", url, w: sheetW, h: sheetH, frames: rects };
  nSprite++;
  nFrames += frames.length;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const files = await walk(SRC);
  files.sort();
  for (const path of files) {
    const rel = relative(SRC, path); // e.g. Fx/LoginStage/LO_BtLogOk.i16
    const ext = extname(rel).toLowerCase();
    const logical = rel.slice(0, rel.length - extname(rel).length);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());

    if (ext === ".i16") {
      if (isI16Image(bytes)) {
        try {
          const img = decodeI16(bytes);
          await emitSprite(logical, img.frames);
        } catch (e) {
          console.error(`  ! decode failed ${rel}: ${(e as Error).message}`);
        }
      } else {
        const url = `assets/data/${rel}`;
        await mkdir(dirname(join(OUT, "..", url)), { recursive: true });
        await Bun.write(join(OUT, "..", url), bytes);
        manifest[logical] = { kind: "data", url };
        nData++;
      }
    } else if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
      const url = `assets/${rel}`;
      await mkdir(dirname(join(OUT, "..", url)), { recursive: true });
      await Bun.write(join(OUT, "..", url), bytes);
      manifest[logical] = { kind: "image", url };
      nMedia++;
    } else if (ext === ".mp3" || ext === ".wav") {
      const url = `assets/${rel}`;
      await mkdir(dirname(join(OUT, "..", url)), { recursive: true });
      await Bun.write(join(OUT, "..", url), bytes);
      manifest[logical] = { kind: "audio", url };
      nMedia++;
    } else {
      const url = `assets/data/${rel}`;
      await mkdir(dirname(join(OUT, "..", url)), { recursive: true });
      await Bun.write(join(OUT, "..", url), bytes);
      manifest[logical] = { kind: "data", url };
      nData++;
    }
  }
  await Bun.write(join(ROOT, "build", "manifest.json"), JSON.stringify(manifest));
  console.log(`Done: ${nSprite} sprites (${nFrames} frames), ${nMedia} media, ${nData} data entries.`);
  console.log(`Manifest: build/manifest.json (${Object.keys(manifest).length} entries)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});