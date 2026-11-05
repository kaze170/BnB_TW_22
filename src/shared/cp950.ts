// CP950 / Big5 <-> UTF-8/UTF-16 codec compatible with both Bun 1.4.4 and Web browsers.
// Uses native TextDecoder("big5") to decode and lazily builds a deterministic reverse
// lookup table over the full Big5/CP950 lead/trail byte range (0x81..0xFE, 0x40..0x7E & 0xA1..0xFE).

const big5Decoder = new TextDecoder("big5", { fatal: false });
let reverseBig5Map: Map<number, number> | null = null;

function getReverseBig5Map(): Map<number, number> {
  if (reverseBig5Map !== null) return reverseBig5Map;
  const map = new Map<number, number>();
  const buf = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    buf[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f || (trail > 0x7e && trail < 0xa1)) continue;
      buf[1] = trail;
      const decoded = big5Decoder.decode(buf);
      if (decoded.length === 1) {
        const cp = decoded.charCodeAt(0);
        if (cp !== 0xfffd && !map.has(cp)) {
          map.set(cp, (lead << 8) | trail);
        }
      }
    }
  }
  reverseBig5Map = map;
  return map;
}

export function decodeCP950(bytes: Uint8Array): string {
  // Trim trailing NUL bytes if present
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end--;
  }
  if (end === 0) return "";
  return big5Decoder.decode(bytes.subarray(0, end));
}

export function encodeCP950(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  const map = getReverseBig5Map();
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else {
      const pair = map.get(code);
      if (pair !== undefined) {
        out.push((pair >> 8) & 0xff, pair & 0xff);
      } else {
        // Fallback "?" for unmapped BMP characters
        out.push(0x3f);
      }
    }
  }
  return new Uint8Array(out);
}
