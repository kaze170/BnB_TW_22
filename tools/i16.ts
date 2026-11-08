/**
 * I16 image decoder — faithful port of CA.exe CDataI16::sub_678590 (0x678590)
 * and the RLE pixel decoder sub_66F050 (0x66F050).
 *
 * Container (version==2):
 *   +0 u32 nImages, +4 u32 version(=2), +8 u32 nFrames, +12 u32 flags
 *   +16 frame table: nFrames × (u32 a, u32 b)  -> decode width=b, height=a
 *   then nImages × 48-byte image headers
 *   then per frame: u32 compressedSize + RLE bytes
 *
 * RLE command byte: run = cmd & 0x3F
 *   cmd & 0x80 -> transparent run; cmd & 0x40 -> solid run (1 pixel repeated);
 *   else literal run (run pixels). Leading (b & 0xC0)==0xC0 marks 24-bit BGR.
 *   Otherwise pixels are 16-bit RGB565.
 */

export interface I16Frame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Logical image header (48 bytes) from CDataI16::sub_678590.
 * The exe draws logical images, not raw decoded frames: several logical images
 * can share one packed frame, with their own source rect and draw offset. */
export interface I16ImageInfo {
  dx: number;
  dy: number;
  /** header dword 2: per-image delay/colour key (-1 for most UI) */
  delay: number;
  frame: number;
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  w: number;
  h: number;
  pivotX: number;
  pivotY: number;
}

export interface I16Image {
  frames: I16Frame[];
  images: I16ImageInfo[];
}

export function isI16Image(d: Uint8Array): boolean {
  if (d.length < 16) return false;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return dv.getUint32(4, true) === 2 && dv.getUint32(0, true) > 0 && dv.getUint32(8, true) > 0;
}

export function decodeI16(d: Uint8Array): I16Image {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const nImages = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const nFrames = dv.getUint32(8, true);
  if (version !== 2) throw new Error(`I16 version ${version} unsupported`);
  let off = 16;
  const frames: Array<[number, number]> = [];
  for (let i = 0; i < nFrames; i++) {
    const a = dv.getUint32(off, true);
    const b = dv.getUint32(off + 4, true);
    off += 8;
    frames.push([a, b]);
  }
  // image headers: nImages × 48 bytes. Keep the layout metadata; the original
  // renderer addresses these logical images (button states, packed glyph cells,
  // animation phases), while `frames` are only the decoded texture pages.
  const images: I16ImageInfo[] = [];
  for (let i = 0; i < nImages; i++) {
    const base = off + i * 48;
    images.push({
      dx: dv.getInt32(base, true),
      dy: dv.getInt32(base + 4, true),
      delay: dv.getInt32(base + 8, true),
      frame: dv.getInt32(base + 12, true),
      sx: dv.getInt32(base + 16, true),
      sy: dv.getInt32(base + 20, true),
      ex: dv.getInt32(base + 24, true),
      ey: dv.getInt32(base + 28, true),
      w: dv.getInt32(base + 32, true),
      h: dv.getInt32(base + 36, true),
      pivotX: dv.getInt32(base + 40, true),
      pivotY: dv.getInt32(base + 44, true),
    });
  }
  off += nImages * 48;
  const out: I16Frame[] = [];
  for (let k = 0; k < nFrames; k++) {
    const csize = dv.getUint32(off, true);
    off += 4;
    const block = d.subarray(off, off + csize);
    off += csize;
    const [a, b] = frames[k]!;
    const width = b;
    const height = a;
    out.push({ width, height, rgba: decodeRLE(block, width * height) });
  }
  return { frames: out, images };
}

function decodeRLE(block: Uint8Array, total: number): Uint8Array {
  let pos = 0;
  const is24 = (block[0]! & 0xc0) === 0xc0;
  if (is24) pos = 1;
  const out = new Uint8Array(total * 4);
  let oi = 0;
  let remaining = 0;
  let cmd = 0;
  let fr = 0, fg = 0, fb = 0;

  const readSolid = () => {
    if (is24) {
      fb = block[pos]!;
      fg = block[pos + 1]!;
      fr = block[pos + 2]!;
      pos += 3;
    } else {
      const v = block[pos]! | (block[pos + 1]! << 8);
      pos += 2;
      fr = ((v >> 11) & 0x1f) * 255 / 31;
      fg = ((v >> 5) & 0x3f) * 255 / 63;
      fb = (v & 0x1f) * 255 / 31;
    }
  };

  let count = 0;
  while (count < total) {
    if (remaining < 1) {
      cmd = block[pos++]!;
      remaining = cmd & 0x3f;
      if (cmd & 0x40) readSolid();
    }
    remaining--;
    if ((cmd & 0x80) === 0) {
      if (cmd & 0x40) {
        out[oi] = fr; out[oi + 1] = fg; out[oi + 2] = fb; out[oi + 3] = 255;
      } else {
        if (is24) {
          out[oi] = block[pos + 2]!; out[oi + 1] = block[pos + 1]!; out[oi + 2] = block[pos]!; out[oi + 3] = 255;
          pos += 3;
        } else {
          const v = block[pos]! | (block[pos + 1]! << 8);
          pos += 2;
          out[oi] = ((v >> 11) & 0x1f) * 255 / 31;
          out[oi + 1] = ((v >> 5) & 0x3f) * 255 / 63;
          out[oi + 2] = (v & 0x1f) * 255 / 31;
          out[oi + 3] = 255;
        }
      }
    } else {
      out[oi + 3] = 0; // transparent
    }
    oi += 4;
    count++;
  }
  return out;
}