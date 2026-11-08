#!/usr/bin/env python3
"""Extract + decrypt original BnB TW v22 gameplay tables from the pack archives.

Outputs committed JSON under data/original/ and decrypted binaries under build/.
All formats are recovered from CA.exe.c (see docs/REVERSE_ENGINEERING.md).
"""
import json
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decrypt as d

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'original'
BUILD = ROOT / 'build' / 'decrypted'
OUT.mkdir(parents=True, exist_ok=True)
BUILD.mkdir(parents=True, exist_ok=True)


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def read_str(b, o):
    n = u32(b, o)
    s = b[o + 4:o + 4 + n].rstrip(b'\0').decode('big5')
    return s, o + 4 + n


def decrypt_all():
    """Decrypt every masked entry, verify the original CRC, cache to build/."""
    verified = 0
    for arch in ('Fx', 'CharTE', 'EmoTE'):
        idd = (ROOT / f'{arch}.idd').read_bytes()
        for e in d.load_idx(arch):
            if not e['mask']:
                continue
            raw = idd[e['offset']:e['offset'] + e['size']]
            dec = d.entry_decrypt(raw, e['mask'])
            crc = d.checksum(dec, e['mask'])
            if e['checksum'] not in (0, 1) and crc != e['checksum']:
                raise ValueError(f"CRC mismatch {arch}/{e['name']}: {crc:08x} != {e['checksum']:08x}")
            p = BUILD / arch / (e['name'] + '.bin')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(dec)
            verified += 1
    print(f'decrypted + CRC-verified {verified} entries')


def parse_object_table(arch, name):
    b = d.read_entry(arch, name)
    n = u32(b, 0)
    o = 4
    ents = []
    for _ in range(n):
        ln = u32(b, o); o += 4
        nm = b[o:o + ln].decode('big5'); o += ln
        val = u32(b, o); o += 4
        ents.append({'name': nm, 'offset': val})
    return ents


def parse_object_animations():
    """Parse CGameObjectTemplate descriptions from ObjectTable/ObjectTable.

    Recovered from CA.exe sub_4625B7: after the name/offset directory, each
    offset points to [u32 groupCount] then groups:
      [u32 nameLen][name][u32 assetLen][asset][u32 frameCount]
      [i32 logicalImageIndex, i32 durationTicks] * frameCount
    Duration is in the original 30 ms fixed-step domain; -1 means hold.
    Category rows have offset 0xffffffff and no description.
    """
    b = d.read_entry('Fx', 'ObjectTable/ObjectTable')
    out = {}
    for ent in parse_object_table('Fx', 'ObjectTable/ObjectTable'):
        off = ent['offset']
        if off == 0xffffffff:
            continue
        p = off
        count = u32(b, p); p += 4
        if count > 10000:
            raise ValueError(f"bad animation group count {ent['name']}: {count}")
        groups = []
        for _ in range(count):
            ln = u32(b, p); p += 4
            if ln > 256:
                raise ValueError(f"bad animation group name len {ent['name']}: {ln}")
            name = b[p:p + ln].decode('big5'); p += ln
            alen = u32(b, p); p += 4
            if alen >= 0x80:
                raise ValueError(f"bad animation asset len {ent['name']}: {alen}")
            asset = b[p:p + alen].decode('big5'); p += alen
            fc = u32(b, p); p += 4
            if fc > 10000:
                raise ValueError(f"bad animation frame count {ent['name']}: {fc}")
            frames = []
            for _ in range(fc):
                idx, duration = struct.unpack_from('<ii', b, p); p += 8
                frames.append([idx, duration])
            groups.append({'name': name, 'asset': asset, 'frames': frames})
        out[ent['name']] = groups
    return out


def parse_bomber_attr():
    b = d.read_entry('Fx', 'Attr/BomberAttr')
    o = 0
    chars = []
    while o < len(b):
        name, o = read_str(b, o)
        stats = list(struct.unpack_from('<10I', b, o)); o += 40
        chars.append({'name': name, 'stats': stats})
    return chars


def parse_item_attr():
    b = d.read_entry('Fx', 'Attr/ItemAttr')
    o = 0
    header = list(struct.unpack_from('<3I', b, o)); o += 12
    categories = []
    for _ in range(header[2]):
        cat_id = u32(b, o); o += 4
        name, o = read_str(b, o)
        fields = list(struct.unpack_from('<8I', b, o)); o += 32
        categories.append({'id': cat_id, 'name': name, 'fields': fields})
    items = []
    while o < len(b):
        name1, o = read_str(b, o)
        name2, o = read_str(b, o)
        fields = list(struct.unpack_from('<8I', b, o)); o += 32
        items.append({'name': name1, 'name2': name2, 'fields': fields})
    return {'header': header, 'categories': categories, 'items': items}


def parse_map_group():
    b = d.read_entry('Fx', 'Attr/MapGroup')
    o = 0
    n = u32(b, o); o += 4
    groups = []
    for _ in range(n):
        name, o = read_str(b, o)
        cnt = u32(b, o); o += 4
        maps = []
        for _ in range(cnt):
            m, o = read_str(b, o)
            maps.append(m)
        groups.append({'name': name, 'maps': maps})
    return groups


def parse_tile_info():
    b = d.read_entry('Fx', 'TileInfo/TileInfoList')
    n = u32(b, 0)
    xml = b[4:4 + n].decode('big5')
    root = ET.fromstring(xml)
    tiles = {}
    for t in root.iter('Tile'):
        name = t.get('Name')
        data = t.get('Data')
        raw = bytes(int(data[i:i + 2], 16) for i in range(0, len(data), 2))
        dw = struct.unpack('<13I', raw)
        tiles[name] = {
            'type': dw[0],          # 0 ground, 1 static, 2 box, 3 passable
            'width': dw[1], 'height': dw[2],
            'raw': raw.hex(),
        }
    return tiles


def parse_map(b, object_names):
    o = 0
    version = u32(b, o); o += 4
    if version >= 1000:
        f1, f2, width = struct.unpack_from('<3I', b, o); o += 12
    else:
        f1, f2, width = 8, 1, 232
    height = u32(b, o); o += 4
    spawn_count = u32(b, o); o += 4
    unknown = list(struct.unpack_from('<4I', b, o)); o += 16   # idx6..9
    field_a = u32(b, o); o += 4                                # idx10 -> map+0x6c
    o += 8                                                     # idx11..12 skipped
    misc = list(struct.unpack_from('<4I', b, o)); o += 16      # idx13..16
    o += 8                                                     # idx17..18 skipped
    spawns = []
    for _ in range(spawn_count):
        x, y = struct.unpack_from('<II', b, o); o += 8
        spawns.append([x, y])
    link_count = u32(b, o); o += 4
    links = []
    for _ in range(link_count):
        links.append(list(struct.unpack_from('<4I', b, o))); o += 16
    grid = []
    for _ in range(width * height):
        g, obj = struct.unpack_from('<ii', b, o); o += 8
        grid.append([g, obj])
    drops = []
    if o + 4 <= len(b):
        cnt = u32(b, o); o += 4
        # sanity: drop count should be small; otherwise tail is padding
        if 0 < cnt < 64:
            for _ in range(cnt):
                if o + 4 > len(b):
                    break
                name, o = read_str(b, o)
                weight = u32(b, o); o += 4
                drops.append({'name': name, 'weight': weight})
    return {
        'version': version, 'width': width, 'height': height,
        'f1': f1, 'f2': f2, 'unknown': unknown, 'fieldA': field_a, 'misc': misc,
        'spawns': spawns, 'links': links, 'grid': grid, 'drops': drops,
    }


def main():
    decrypt_all()
    object_names = [e['name'] for e in parse_object_table('Fx', 'ObjectTable/ObjectTable')]
    (OUT / 'objectTable.json').write_text(json.dumps(object_names, ensure_ascii=False))
    animations = parse_object_animations()
    (OUT / 'objectAnimations.json').write_text(json.dumps(animations, ensure_ascii=False))
    chars = parse_bomber_attr()
    (OUT / 'bomberAttr.json').write_text(json.dumps(chars, ensure_ascii=False, indent=1))
    items = parse_item_attr()
    (OUT / 'itemAttr.json').write_text(json.dumps(items, ensure_ascii=False))
    groups = parse_map_group()
    (OUT / 'mapGroup.json').write_text(json.dumps(groups, ensure_ascii=False, indent=1))
    tiles = parse_tile_info()
    (OUT / 'tileInfo.json').write_text(json.dumps(tiles, ensure_ascii=False))

    maps = {}
    fx = {e['name']: e for e in d.load_idx('Fx')}
    for name, e in fx.items():
        if not name.startswith('Map/'):
            continue
        b = d.read_entry('Fx', name)
        try:
            m = parse_map(b, object_names)
        except Exception as ex:
            print(f'  ! skip {name}: {ex}')
            continue
        maps[name[4:]] = m
    (OUT / 'maps.json').write_text(json.dumps(maps, ensure_ascii=False))
    print(f'characters={len(chars)} items={len(items["items"])} categories={len(items["categories"])} '
          f'mapGroups={len(groups)} tiles={len(tiles)} maps={len(maps)} objectNames={len(object_names)} '
          f'animatedObjects={len(animations)} animationGroups={sum(len(g) for g in animations.values())}')
    # quick summary of a canonical map
    v = maps.get('Village00')
    if v:
        print('Village00', v['width'], 'x', v['height'], 'spawns', v['spawns'], 'drops', v['drops'])


if __name__ == '__main__':
    main()
