#!/usr/bin/env python3
"""Decrypt BnB TW v22 pack archives (.idx/.idd), verified against CA.exe.

References (CA.exe.c):
  idx cipher   sub_673110  (key = first raw dword when plaintext header type == 0)
  entry cipher sub_6731A0  (per-entry MaskId; 0 => stored plaintext)
  idx loader   sub_6749C0  (header + entry layout)
  data loader  CData::sub_674590 (decrypt, optional zlib for names containing off_7AECB0)

Version-15 idx entry layout (after the 12-byte header [type=0, ver=15, count]):
  [u32 nameLen][name bytes][u32 relOffset][u32 size][u32 mask][u32 checksum]
CDataFile copies this into a 144-byte record: name[128], absOffset, size, mask, checksum.
NOTE: the last dword is a CHECKSUM, not the mask. The supplied extracted/ Attr files
were XORed with that checksum by the extraction tool; use the .idd + mask below instead.
"""
import struct, sys, json, zlib
from pathlib import Path

M32 = 0xFFFFFFFF
ROOT = Path(__file__).resolve().parent.parent


def idx_decrypt(data: bytes, key: int | None = None) -> bytes:
    """sub_673110: out[0]=key^in[0]; out[i]=out[i-1]^in[i]; tail XOR last dword."""
    if key is None:
        # All shipped archives use header type 0, whose plaintext first dword is 0,
        # so the stream key equals the first raw dword.
        key = struct.unpack_from('<I', data, 0)[0]
    n = len(data) // 4
    out = bytearray(len(data))
    prev = key
    if n:
        prev = (key ^ struct.unpack_from('<I', data, 0)[0]) & M32
        struct.pack_into('<I', out, 0, prev)
        for i in range(1, n):
            prev = (prev ^ struct.unpack_from('<I', data, i * 4)[0]) & M32
            struct.pack_into('<I', out, i * 4, prev)
    for j in range(n * 4, len(data)):
        out[j] = data[j] ^ ((prev >> (8 * (j - n * 4))) & 0xFF)
    return bytes(out)


def entry_decrypt(data: bytes, mask: int, C: int = 0x9C6C95CE) -> bytes:
    """sub_6731A0. mask==0 means the entry is stored plaintext."""
    if mask == 0:
        return data
    n = len(data) // 4
    out = bytearray(len(data))
    prev = (mask ^ struct.unpack_from('<I', data, 0)[0] ^ C) & M32
    struct.pack_into('<I', out, 0, prev)
    for i in range(1, n):
        poly = (i * i * (i + 966) * (i + 2020)) & M32
        prev = (prev ^ struct.unpack_from('<I', data, i * 4)[0] ^ poly ^ C) & M32
        struct.pack_into('<I', out, i * 4, prev)
    for j in range(n * 4, len(data)):
        out[j] = data[j] ^ ((prev >> (8 * (j - n * 4))) & 0xFF)
    return bytes(out)


def parse_idx(dec: bytes):
    typ, ver = struct.unpack_from('<II', dec, 0)
    if typ == 0 and ver == 15:
        count = struct.unpack_from('<I', dec, 8)[0]
        off = 12
        has_mask = True
    else:
        count = typ
        off = 4
        has_mask = False
    entries = []
    for _ in range(count):
        nameLen = struct.unpack_from('<I', dec, off)[0]
        if not (0 < nameLen < 0x80):
            raise ValueError(f'bad nameLen {nameLen} at {off}')
        name = dec[off + 4:off + 4 + nameLen].decode('big5')
        p = off + 4 + nameLen
        rel = struct.unpack_from('<I', dec, p)[0]
        size = struct.unpack_from('<I', dec, p + 4)[0]
        if has_mask:
            mask, checksum = struct.unpack_from('<II', dec, p + 8)
            p += 16
        else:
            mask, checksum = 0, 0
            p += 8
        entries.append({'name': name, 'offset': rel, 'size': size,
                        'mask': mask, 'checksum': checksum})
        off = p
    return entries


def _crc_table():
    t = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) & M32 if c & 0x80000000 else (c << 1) & M32
        t.append(c)
    return t


_CRC_TABLE = _crc_table()


def checksum(data: bytes, init: int) -> int:
    """sub_668E80 + sub_668DE0: CRC-32/MPEG-2 style, poly 0x04C11DB7, no final xor.
    The loader runs this over the DECRYPTED bytes with init=mask and compares to
    the idx checksum dword (0 => check skipped)."""
    c = init
    for b in data:
        c = ((c << 8) & M32) ^ _CRC_TABLE[(b ^ (c >> 24)) & 0xFF]
    return c


def load_idx(arch: str):
    raw = (ROOT / f'{arch}.idx').read_bytes()
    return parse_idx(idx_decrypt(raw))


def read_entry(arch: str, name: str) -> bytes:
    ents = {e['name']: e for e in load_idx(arch)}
    e = ents[name]
    idd = (ROOT / f'{arch}.idd').read_bytes()
    raw = idd[e['offset']:e['offset'] + e['size']]
    if len(raw) != e['size']:
        raise ValueError(f'{name}: truncated idd slice')
    return entry_decrypt(raw, e['mask'])


if __name__ == '__main__':
    arch = sys.argv[1] if len(sys.argv) > 1 else 'Fx'
    ents = load_idx(arch)
    print(f'=== {arch}.idx: {len(ents)} entries ===')
    for e in ents:
        if e['name'].startswith('Attr/') or e['name'] in ('TileInfo/TileInfoList', 'XML/init'):
            print(f"  {e['name']:28s} off={e['offset']:8d} size={e['size']:7d} "
                  f"mask=0x{e['mask']:08X} checksum=0x{e['checksum']:08X}")
    out = ROOT / 'build' / f'{arch}_idx.json'
    out.parent.mkdir(exist_ok=True)
    json.dump(ents, open(out, 'w'), ensure_ascii=False, indent=1)
    print(f'saved {out}')
