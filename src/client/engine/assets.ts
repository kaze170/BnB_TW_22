/**
 * Asset loader. Reads the manifest produced by tools/asset-pipeline.ts and
 * resolves original CA.exe logical names (e.g. "LoginStage/LO_BtLogOk") to
 * decoded sprites. Images are loaded as ImageBitmap for both render backends.
 */
import type { Rect } from "./types.ts";

export interface SpriteEntry {
  kind: "sprite";
  url: string;
  w: number;
  h: number;
  frames: Rect[];
}
export interface MediaEntry {
  kind: "image" | "audio" | "data";
  url: string;
}
export type ManifestEntry = SpriteEntry | MediaEntry;
export type Manifest = Record<string, ManifestEntry>;

/** A resolved sprite: metadata + decoded bitmap, ready to draw. */
export interface Sprite {
  name: string;
  url: string;
  w: number;
  h: number;
  frames: Rect[];
  bitmap: ImageBitmap;
}

export class Assets {
  manifest: Manifest = {};
  private bitmaps = new Map<string, Promise<ImageBitmap>>();
  private sprites = new Map<string, Sprite>();

  async loadManifest(base = ""): Promise<void> {
    const res = await fetch(`${base}/manifest.json`);
    this.manifest = (await res.json()) as Manifest;
  }

  /** Resolve an exe-style logical name to a manifest key. */
  resolveKey(name: string): string | undefined {
    if (this.manifest[name]) return name;
    for (const prefix of ["Fx/", "CharTE/", "EmoTE/"]) {
      const k = prefix + name;
      if (this.manifest[k]) return k;
    }
    return undefined;
  }

  entry(name: string): ManifestEntry | undefined {
    const k = this.resolveKey(name);
    return k ? this.manifest[k] : undefined;
  }

  private loadBitmap(url: string): Promise<ImageBitmap> {
    let p = this.bitmaps.get(url);
    if (!p) {
      p = (async () => {
        const res = await fetch(url);
        const blob = await res.blob();
        return createImageBitmap(blob);
      })();
      this.bitmaps.set(url, p);
    }
    return p;
  }

  /** Load (and cache) a sprite by logical name. Returns undefined if missing. */
  async sprite(name: string): Promise<Sprite | undefined> {
    const cached = this.sprites.get(name);
    if (cached) return cached;
    const key = this.resolveKey(name);
    if (!key) return undefined;
    const e = this.manifest[key]!;
    let url: string, w: number, h: number, frames: Rect[];
    if (e.kind === "sprite") {
      url = e.url; w = e.w; h = e.h; frames = e.frames;
    } else if (e.kind === "image") {
      url = e.url; w = 0; h = 0; frames = [];
    } else {
      return undefined;
    }
    const bitmap = await this.loadBitmap(url);
    if (e.kind === "image") {
      w = bitmap.width; h = bitmap.height;
      frames = [{ x: 0, y: 0, w, h }];
    }
    const spr: Sprite = { name, url, w, h, frames, bitmap };
    this.sprites.set(name, spr);
    return spr;
  }

  /** Preload a list of sprites (e.g. everything a stage needs). */
  async preload(names: string[]): Promise<void> {
    await Promise.all(names.map((n) => this.sprite(n)));
  }

  getCached(name: string): Sprite | undefined {
    return this.sprites.get(name);
  }
}