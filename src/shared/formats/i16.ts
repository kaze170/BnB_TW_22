import { TEAM_HUE_DEG, TEAM_LIGHTNESS_DELTA, TEAM_SATURATION_DELTA } from "../constants.ts";
import { BinaryReader } from "../crypto.ts";

export interface I16FrameMeta {
  index: number;
  pivotX: number;
  pivotY: number;
  unk8: number;
  texIndex: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface I16TextureSheet {
  width: number;
  height: number;
  /** Decoded RGBA8888 pixels (width * height * 4 bytes) */
  rgba: Uint8Array;
}

export interface DecodedI16 {
  frameCount: number;
  version: number;
  texCount: number;
  flags: number;
  frames: I16FrameMeta[];
  textures: I16TextureSheet[];
}

export type I16DecodeMode = "normal" | "shadow" | "alpha";

/**
 * Exact R5G6B5 -> RGB888 bit-replication expansion from CA.exe sub_6780F0 / sub_690340:
 *   r = (b1 & 0xF8); r += r >> 5;
 *   g = ((u16 >> 3) & 0xFC); g += g >> 6;
 *   b = ((u16 << 3) & 0xF8); b += b >> 5;
 */
export function expandR5G6B5(u16: number): [number, number, number] {
  let r = (u16 >>> 8) & 0xf8;
  let g = (u16 >>> 3) & 0xfc;
  let b = (u16 << 3) & 0xf8;
  r += r >>> 5;
  g += g >>> 6;
  b += b >>> 5;
  return [r, g, b];
}

/**
 * Decodes a single RLE texture stream inside a CDataI16 / CDataI16Alpha / CDataI16Shadow file
 * strictly following CA.exe sub_66C8F0 + sub_66FFD0 + sub_66E5C0 + sub_6700E0.
 */
function decodeRleTexture(
  chunk: Uint8Array,
  width: number,
  height: number,
  mode: I16DecodeMode,
): Uint8Array {
  const totalPixels = width * height;
  const rgba = new Uint8Array(totalPixels * 4);
  if (chunk.byteLength === 0 || totalPixels === 0) return rgba;

  let pos = 0;
  const firstByte = chunk[0]!;
  const is24Bit = (firstByte & 0xc0) === 0xc0;
  if (is24Bit) {
    pos = 1;
  }

  let runRemaining = 0;
  let runToken = 0;
  let repR = 0;
  let repG = 0;
  let repB = 0;

  const readPixelRGB = (): [number, number, number] => {
    if (is24Bit) {
      if (pos + 3 > chunk.byteLength) return [0, 0, 0];
      const b = chunk[pos]!;
      const g = chunk[pos + 1]!;
      const r = chunk[pos + 2]!;
      pos += 3;
      return [r, g, b];
    } else {
      if (pos + 2 > chunk.byteLength) return [0, 0, 0];
      const u16 = chunk[pos]! | (chunk[pos + 1]! << 8);
      pos += 2;
      return expandR5G6B5(u16);
    }
  };

  for (let px = 0; px < totalPixels; px++) {
    if (runRemaining < 1) {
      if (pos >= chunk.byteLength) break;
      runToken = chunk[pos++]!;
      runRemaining = runToken & 0x3f;
      if ((runToken & 0x40) !== 0) {
        const [r, g, b] = readPixelRGB();
        repR = r;
        repG = g;
        repB = b;
      }
    }

    runRemaining--;
    const dst = px * 4;

    if ((runToken & 0x80) !== 0) {
      // Transparent skip run (colorkey 255, 0, 255, alpha 0)
      rgba[dst] = 0;
      rgba[dst + 1] = 0;
      rgba[dst + 2] = 0;
      rgba[dst + 3] = 0;
    } else {
      let r: number;
      let g: number;
      let b: number;
      if ((runToken & 0x40) !== 0) {
        r = repR;
        g = repG;
        b = repB;
      } else {
        [r, g, b] = readPixelRGB();
      }

      // Colorkey check (magenta 255, 0, 255 in R5G6B5 / BGR24)
      if (r === 255 && g === 0 && b === 255) {
        rgba[dst] = 0;
        rgba[dst + 1] = 0;
        rgba[dst + 2] = 0;
        rgba[dst + 3] = 0;
      } else if (mode === "shadow") {
        // CDataI16Shadow: dark shadow using pixel channel intensity as alpha
        const lum = Math.max(r, g, b);
        rgba[dst] = 0;
        rgba[dst + 1] = 0;
        rgba[dst + 2] = 0;
        rgba[dst + 3] = lum > 0 ? Math.min(255, lum) : 112;
      } else if (mode === "alpha") {
        // CDataI16Alpha (sub_6700E0): channel intensity stored as alpha
        const lum = Math.max(r, g, b);
        rgba[dst] = 255;
        rgba[dst + 1] = 255;
        rgba[dst + 2] = 255;
        rgba[dst + 3] = lum;
      } else {
        rgba[dst] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = 255;
      }
    }
  }

  return rgba;
}

/**
 * Exact port of CDataI16::sub_678590 / CDataI16Alpha::sub_599344.
 * Note the texture size order in CA.exe: (height: u32, width: u32)!
 */
export function decodeI16(buf: Uint8Array, mode: I16DecodeMode = "normal"): DecodedI16 {
  const r = new BinaryReader(buf);
  const frameCount = r.u32();
  const version = r.u32();
  const texCount = r.u32();
  const flags = r.u32();

  if (version !== 2 || frameCount > 65536 || texCount > 4096) {
    throw new Error(`Invalid .i16 header: frames=${frameCount}, ver=${version}, tex=${texCount}`);
  }

  // Texture dimensions: height = src[0], width = src[1] (CA.exe sub_678590 L537421)
  const texDims: { width: number; height: number }[] = [];
  for (let i = 0; i < texCount; i++) {
    const height = r.u32();
    const width = r.u32();
    texDims.push({ width, height });
  }

  // Frame descriptors: 48 bytes each (sub_599242..sub_59929E)
  const frames: I16FrameMeta[] = [];
  for (let i = 0; i < frameCount; i++) {
    const base = r.offset;
    const pivotX = r.i32();
    const pivotY = r.i32();
    const unk8 = r.i32();
    const texIndex = r.i32();
    const left = r.i32();
    const top = r.i32();
    const right = r.i32();
    const bottom = r.i32();
    r.seek(base + 48);
    frames.push({
      index: i,
      pivotX,
      pivotY,
      unk8,
      texIndex,
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    });
  }

  // Texture RLE payloads: each prefixed by u32 byteSize
  const textures: I16TextureSheet[] = [];
  for (let k = 0; k < texCount; k++) {
    const { width, height } = texDims[k]!;
    if (r.eof()) {
      textures.push({ width, height, rgba: new Uint8Array(width * height * 4) });
      continue;
    }
    const chunkSize = r.u32();
    if (chunkSize > 0 && width > 0 && height > 0) {
      const chunk = r.slice(chunkSize);
      const rgba = decodeRleTexture(chunk, width, height, mode);
      textures.push({ width, height, rgba });
    } else {
      if (chunkSize > 0) r.skip(chunkSize);
      textures.push({ width, height, rgba: new Uint8Array(width * height * 4) });
    }
  }

  return { frameCount, version, texCount, flags, frames, textures };
}

/**
 * Merges a color .i16 sheet with a companion *Alpha .i16 sheet (used by fxdynimginfo.ssd / Bubble / Effect).
 */
export function applyAlphaI16(color: DecodedI16, alphaSheet: DecodedI16): DecodedI16 {
  const count = Math.min(color.textures.length, alphaSheet.textures.length);
  const mergedTextures: I16TextureSheet[] = color.textures.map((t, idx) => {
    if (idx >= count) return t;
    const aTex = alphaSheet.textures[idx]!;
    if (aTex.width !== t.width || aTex.height !== t.height) return t;
    const out = new Uint8Array(t.rgba.length);
    out.set(t.rgba);
    for (let i = 0; i < out.length; i += 4) {
      out[i + 3] = Math.min(out[i + 3]!, aTex.rgba[i + 3]!);
    }
    return { width: t.width, height: t.height, rgba: out };
  });
  return { ...color, textures: mergedTextures };
}

/**
 * Exact port of CA.exe sub_692150 -> sub_691B60 -> sub_691E10 (RGB <-> HLS delta tinting)
 * using the 9 planar team color constants at 0x91C6D0..0x91C7A8.
 * Used for *LayerAdjust character/item sprites across teams 0..8.
 */
export function rgbToHls(rByte: number, gByte: number, bByte: number): [number, number, number] {
  const r = rByte / 255.0;
  const g = gByte / 255.0;
  const b = bByte / 255.0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;

  if (max === min) {
    return [0.0, l, 0.0];
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2.0 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = ((g - b) / d) * 60.0;
  } else if (max === g) {
    h = (2.0 + (b - r) / d) * 60.0;
  } else {
    h = (4.0 + (r - g) / d) * 60.0;
  }
  if (h < 0.0) h += 360.0;
  return [h, l, s];
}

function hueToChannel(m1: number, m2: number, hDeg: number): number {
  let h = hDeg;
  if (h > 360.0) h -= 360.0;
  else if (h < 0.0) h += 360.0;

  let v: number;
  if (h < 60.0) v = m1 + ((m2 - m1) * h) / 60.0;
  else if (h < 180.0) v = m2;
  else if (h < 240.0) v = m1 + ((m2 - m1) * (240.0 - h)) / 60.0;
  else v = m1;
  return Math.max(0, Math.min(255, Math.trunc(v * 255.0)));
}

export function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0.0) {
    const v = Math.max(0, Math.min(255, Math.trunc(l * 255.0)));
    return [v, v, v];
  }
  const m2 = l > 0.5 ? l + s - l * s : l + l * s;
  const m1 = 2.0 * l - m2;
  return [
    hueToChannel(m1, m2, h + 120.0),
    hueToChannel(m1, m2, h),
    hueToChannel(m1, m2, h - 120.0),
  ];
}

export function tintI16LayerAdjust(base: DecodedI16, teamIndex: number): DecodedI16 {
  const team = Math.max(0, Math.min(8, teamIndex));
  const dH = TEAM_HUE_DEG[team] ?? 0;
  const dL = TEAM_LIGHTNESS_DELTA[team] ?? 0;
  const dS = TEAM_SATURATION_DELTA[team] ?? 0;
  if (dH === 0 && dL === 0 && dS === 0) return base;

  const tintedTextures: I16TextureSheet[] = base.textures.map((tex) => {
    const out = new Uint8Array(tex.rgba.length);
    const src = tex.rgba;
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3]!;
      if (a === 0) continue;
      let [h, l, s] = rgbToHls(src[i]!, src[i + 1]!, src[i + 2]!);
      h += dH;
      if (h < 0.0) h += 360.0;
      else if (h > 360.0) h -= 360.0;
      l = Math.max(0.0, Math.min(1.0, l + dL));
      s = Math.max(0.0, Math.min(1.0, s + dS));
      const [nr, ng, nb] = hlsToRgb(h, l, s);
      out[i] = nr;
      out[i + 1] = ng;
      out[i + 2] = nb;
      out[i + 3] = a;
    }
    return { width: tex.width, height: tex.height, rgba: out };
  });

  return {
    ...base,
    textures: tintedTextures,
  };
}
