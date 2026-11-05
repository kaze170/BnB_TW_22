import { PACK_IDD_CONST } from "./constants.ts";
import { decodeCP950, encodeCP950 } from "./cp950.ts";

/**
 * Exact port of CPackSysMan::sub_673110 (.idx CBC XOR decryption).
 * Fx.idx uses key = 0x719CAB30; CharTE.idx & EmoTE.idx use key = 0x05B201FC.
 */
export function decryptIdx(raw: Uint8Array, key: number): Uint8Array {
  const len = raw.byteLength;
  const out = new Uint8Array(len);
  const srcView = new DataView(raw.buffer, raw.byteOffset, len);
  const dstView = new DataView(out.buffer, out.byteOffset, len);

  const dwordCount = len >>> 2;
  let prev = key >>> 0;
  for (let i = 0; i < dwordCount; i++) {
    const srcVal = srcView.getUint32(i * 4, true);
    prev = (prev ^ srcVal) >>> 0;
    dstView.setUint32(i * 4, prev, true);
  }

  const tailOffset = dwordCount * 4;
  const rem = len & 3;
  for (let b = 0; b < rem; b++) {
    out[tailOffset + b] = raw[tailOffset + b]! ^ ((prev >>> (b * 8)) & 0xff);
  }
  return out;
}

/**
 * Exact port of CPackSysMan::sub_6731A0 (.idd entry decryption).
 * Uses Math.imul for exact 32-bit unsigned modular arithmetic on
 * i * i * (i + 966) * (i + 2020) without IEEE-754 float overflow on large files.
 */
export function decryptIdd(raw: Uint8Array, mask: number): Uint8Array {
  // CA.exe CData::sub_674590 (L533852): MaskId === 0 means unencrypted raw entry!
  if ((mask >>> 0) === 0) {
    return raw;
  }

  const len = raw.byteLength;
  const out = new Uint8Array(len);
  const srcView = new DataView(raw.buffer, raw.byteOffset, len);
  const dstView = new DataView(out.buffer, out.byteOffset, len);

  const dwordCount = len >>> 2;
  let prev = mask >>> 0;
  for (let i = 0; i < dwordCount; i++) {
    const srcVal = srcView.getUint32(i * 4, true);
    let val: number;
    if (i === 0) {
      val = (mask ^ srcVal ^ PACK_IDD_CONST) >>> 0;
    } else {
      const i2 = Math.imul(i, i);
      const p2 = Math.imul((i + 966) | 0, (i + 2020) | 0);
      const poly = Math.imul(i2, p2) >>> 0;
      val = (prev ^ srcVal ^ poly ^ PACK_IDD_CONST) >>> 0;
    }
    dstView.setUint32(i * 4, val, true);
    prev = val;
  }

  const tailOffset = dwordCount * 4;
  const rem = len & 3;
  // sub_6731A0: MaskId_1 = a2[v4 - 1]; tail bytes XOR with (MaskId_1 >>> (b * 8)) & 0xFF
  for (let b = 0; b < rem; b++) {
    out[tailOffset + b] = raw[tailOffset + b]! ^ ((prev >>> (b * 8)) & 0xff);
  }
  return out;
}

/**
 * Checks whether a buffer starts with the CISmartStream "ssi1" header (sub_699410 + sub_6991E0).
 * Exact 18-byte header layout:
 *   0..3  : "ssi1"
 *   4..7  : u32 crc32
 *   8     : u8 headerVer (0x18)
 *   9..12 : u32 compressedSize
 *   13    : u8 isCompressed (1 = zlib stream at offset 18, 0 = raw at offset 14)
 *   14..17: u32 uncompressedSize (present when isCompressed !== 0)
 *   18..  : RFC-1950 zlib stream (0x78 0xDA / 0x78 0x9C)
 */
export function isSmartStream(buf: Uint8Array): boolean {
  return (
    buf.byteLength >= 18 &&
    buf[0] === 0x73 &&
    buf[1] === 0x73 &&
    buf[2] === 0x69 &&
    buf[3] === 0x31
  );
}

/**
 * Browser + Bun universal async decompression of CISmartStream ("ssi1").
 * Uses Web Standard DecompressionStream("deflate") which handles RFC-1950 zlib streams natively.
 */
export async function decompressSmartStreamAsync(buf: Uint8Array): Promise<Uint8Array> {
  if (!isSmartStream(buf)) return buf;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const compSize = view.getUint32(9, true);
  const isCompressed = buf[13]!;
  if (isCompressed === 0) {
    return buf.subarray(14, Math.min(buf.byteLength, 14 + compSize));
  }
  const uncompSize = view.getUint32(14, true);
  const payload = buf.subarray(18, Math.min(buf.byteLength, 18 + compSize));

  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  void writer.write(copy);
  void writer.close();

  const resp = new Response(ds.readable);
  const ab = await resp.arrayBuffer();
  const out = new Uint8Array(ab);
  return uncompSize > 0 && out.byteLength > uncompSize ? out.subarray(0, uncompSize) : out;
}

/**
 * Binary reader matching CISmartStream & CInPacket little-endian / network-endian primitives.
 */
export class BinaryReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  public offset = 0;

  constructor(buf: Uint8Array, offset = 0) {
    this.bytes = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.offset = offset;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return Math.max(0, this.bytes.byteLength - this.offset);
  }

  eof(): boolean {
    return this.offset >= this.bytes.byteLength;
  }

  seek(pos: number): void {
    this.offset = pos;
  }

  skip(count: number): void {
    this.offset += count;
  }

  u8(): number {
    if (this.offset >= this.bytes.byteLength) return 0;
    return this.bytes[this.offset++]!;
  }

  i8(): number {
    if (this.offset >= this.bytes.byteLength) return 0;
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    if (this.offset + 2 > this.bytes.byteLength) return 0;
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    if (this.offset + 2 > this.bytes.byteLength) return 0;
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u16BE(): number {
    if (this.offset + 2 > this.bytes.byteLength) return 0;
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  i16BE(): number {
    if (this.offset + 2 > this.bytes.byteLength) return 0;
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  u32(): number {
    if (this.offset + 4 > this.bytes.byteLength) return 0;
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    if (this.offset + 4 > this.bytes.byteLength) return 0;
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u32BE(): number {
    if (this.offset + 4 > this.bytes.byteLength) return 0;
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  f32(): number {
    if (this.offset + 4 > this.bytes.byteLength) return 0;
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    if (this.offset + 8 > this.bytes.byteLength) return 0;
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  slice(len: number): Uint8Array {
    const end = Math.min(this.bytes.byteLength, this.offset + len);
    const out = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return out;
  }

  /** Reads u32 length + CP950 bytes (used in .idx, ObjectTable, MapGroup, Map, BomberAttr) */
  str32CP950(): string {
    const len = this.u32();
    if (len === 0 || len > 0x100000) return "";
    return decodeCP950(this.slice(len));
  }

  /** Reads u16 length + UTF-8 bytes (used in modern WebSocket string fields alongside CP950) */
  str16UTF8(): string {
    const len = this.u16();
    if (len === 0) return "";
    return new TextDecoder().decode(this.slice(len));
  }

  /** Reads NUL-terminated CP950 C-string */
  cstrCP950(): string {
    let end = this.offset;
    while (end < this.bytes.byteLength && this.bytes[end] !== 0) {
      end++;
    }
    const s = decodeCP950(this.bytes.subarray(this.offset, end));
    this.offset = Math.min(this.bytes.byteLength, end + 1);
    return s;
  }

  /** Reads UTF-16LE length-prefixed string (u32 char count or byte count) */
  wstr32(): string {
    const charCount = this.u32();
    if (charCount === 0 || charCount > 0x40000) return "";
    const byteLen = charCount * 2;
    const slice = this.slice(byteLen);
    return new TextDecoder("utf-16le").decode(slice).replace(/\0+$/, "");
  }
}

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  public length = 0;

  constructor(initialCapacity = 128) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.byteLength) return;
    let next = this.buf.byteLength * 2;
    while (next < this.length + extra) next *= 2;
    const nb = new Uint8Array(next);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.length, v);
    this.length += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.length, v, true);
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v | 0, true);
    this.length += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
    return this;
  }

  bytes(arr: Uint8Array): this {
    this.ensure(arr.byteLength);
    this.buf.set(arr, this.length);
    this.length += arr.byteLength;
    return this;
  }

  str16UTF8(s: string): this {
    const enc = new TextEncoder().encode(s);
    this.u16(enc.byteLength);
    this.bytes(enc);
    return this;
  }

  str16CP950(s: string): this {
    const enc = encodeCP950(s);
    this.u16(enc.byteLength);
    this.bytes(enc);
    return this;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * Exact port of CA.exe CPacketSocket stream cipher & 5-byte frame header:
 *   sub_699A30(102, 192, 231) + sub_699A50(40, 40, 3, 3) + sub_6965C0(mode=2)
 * Frame layout:
 *   [0] tagByte : ((seq + c231) & 0xFF) ^ ((dirKey + k40) & 0xFF)
 *   [1] seqByte : seq & 0xFF
 *   [2..3] len  : u16BE payload length
 *   [4] csum    : rolling XOR checksum of encrypted payload
 *   [5..] body  : XOR-streamed packet body starting with u16LE opcode
 */
export class PacketCipher {
  private readonly kRecv = 102;
  private readonly kSend = 192;
  private readonly kBase = 231;
  private readonly dOff = 40;
  private sendSeq = 1;
  private recvSeq = 1;

  framePacket(opcode: number, payload: Uint8Array, isServerToClient: boolean): Uint8Array {
    const seq = this.sendSeq & 0xff;
    this.sendSeq = (this.sendSeq + 1) & 0xff;

    const dirKey = isServerToClient ? this.kRecv : this.kSend;
    const tag = ((seq + this.kBase) & 0xff) ^ ((dirKey + this.dOff) & 0xff);
    const bodyLen = 2 + payload.byteLength;

    const out = new Uint8Array(5 + bodyLen);
    out[0] = tag;
    out[1] = seq;
    out[2] = (bodyLen >>> 8) & 0xff;
    out[3] = bodyLen & 0xff;

    // Write opcode (u16LE) + payload, XOR with rolling key derived from tag & index
    const rawBody = new Uint8Array(bodyLen);
    rawBody[0] = opcode & 0xff;
    rawBody[1] = (opcode >>> 8) & 0xff;
    rawBody.set(payload, 2);

    let csum = tag ^ seq;
    for (let i = 0; i < bodyLen; i++) {
      const streamKey = (tag + Math.imul(i + 1, 0x2b) + seq) & 0xff;
      const enc = rawBody[i]! ^ streamKey;
      out[5 + i] = enc;
      csum ^= enc;
    }
    out[4] = csum & 0xff;
    return out;
  }

  unframePacket(
    frame: Uint8Array,
    expectServerToClient: boolean,
  ): { opcode: number; reader: BinaryReader; rawPayload: Uint8Array } | null {
    if (frame.byteLength < 7) return null;
    const tag = frame[0]!;
    const seq = frame[1]!;
    const bodyLen = (frame[2]! << 8) | frame[3]!;
    const expectedCsum = frame[4]!;
    if (frame.byteLength < 5 + bodyLen || bodyLen < 2) return null;

    const dirKey = expectServerToClient ? this.kRecv : this.kSend;
    const expectedTag = ((seq + this.kBase) & 0xff) ^ ((dirKey + this.dOff) & 0xff);
    if (tag !== expectedTag) return null;

    let csum = tag ^ seq;
    const rawBody = new Uint8Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) {
      const enc = frame[5 + i]!;
      csum ^= enc;
      const streamKey = (tag + Math.imul(i + 1, 0x2b) + seq) & 0xff;
      rawBody[i] = enc ^ streamKey;
    }
    if ((csum & 0xff) !== expectedCsum) return null;

    this.recvSeq = (seq + 1) & 0xff;
    const opcode = rawBody[0]! | (rawBody[1]! << 8);
    const rawPayload = rawBody.subarray(2);
    return {
      opcode,
      reader: new BinaryReader(rawPayload),
      rawPayload,
    };
  }
}
