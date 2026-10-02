#!/usr/bin/env python3
# Rebuilds a minilogue xd USER SLOT DATA (4A) upload from a .mnlgxdunit using only the rules
# in PROTOCOL.md, then diffs it against logue-cli's own captured bytes -- if this matches every
# fixture, PROTOCOL.md is complete enough to port to TypeScript.
#   usage: encode_upload.py <fixtures-dir>
import json, struct, sys, zipfile, zlib
from pathlib import Path

MODULES = {'modfx': 1, 'delfx': 2, 'revfx': 3, 'osc': 4}
PLATFORM_MINILOGUE_XD = 2


def pack7(data):
    out = bytearray()
    for i in range(0, len(data), 7):
        chunk = data[i:i + 7]
        out.append(sum(1 << j for j, b in enumerate(chunk) if b & 0x80))
        out += bytes(b & 0x7F for b in chunk)
    return bytes(out)


def semver_u32(s):
    major_minor, patch = s.split('-')
    major, minor = major_minor.split('.')
    return int(major) << 16 | int(minor) << 8 | int(patch)


def param_type(minimum, unit):
    if unit == '%':
        return 1 if minimum < 0 else 0
    return 2


def build_body(manifest, payload):
    h = manifest['header']
    hdr = bytearray(1024)
    hdr[0] = MODULES[h['module']]
    hdr[1] = PLATFORM_MINILOGUE_XD
    struct.pack_into('<IIII', hdr, 2, semver_u32(h['api']), h['dev_id'], h['prg_id'], semver_u32(h['version']))
    name = h['name'].encode('ascii')[:13]
    hdr[0x12:0x12 + len(name)] = name
    params = h['params']
    struct.pack_into('<I', hdr, 0x20, h['num_param'])
    for i, (pname, pmin, pmax, unit) in enumerate(params):
        off = 0x24 + i * 16
        struct.pack_into('<bbB', hdr, off, pmin, pmax, param_type(pmin, unit))
        pn = pname.encode('ascii')[:13]
        hdr[off + 3:off + 3 + len(pn)] = pn
    struct.pack_into('<I', hdr, 1020, len(payload))
    return bytes(hdr) + payload + bytes(132)


def build_upload(unit_path, slot):
    z = zipfile.ZipFile(unit_path)
    manifest = json.loads(z.read(next(n for n in z.namelist() if n.endswith('manifest.json'))))
    payload = z.read(next(n for n in z.namelist() if n.endswith('payload.bin')))
    body = build_body(manifest, payload)
    framed = struct.pack('<II', len(body), zlib.crc32(body)) + body + b'\x00'
    module = MODULES[manifest['header']['module']]
    return bytes([0xF0, 0x42, 0x30, 0x00, 0x01, 0x51, 0x4A, module, slot]) + pack7(framed) + b'\xF7'


fixtures = Path(sys.argv[1])
failed = 0
for syx in sorted(fixtures.glob('*.upload.syx')):
    captured = syx.read_bytes()
    unit = syx.with_name(syx.name.replace('.upload.syx', '.mnlgxdunit'))
    ours = build_upload(unit, slot=captured[8])
    if ours == captured:
        print(f'MATCH  {syx.name} ({len(captured)} bytes)')
    else:
        failed += 1
        first = next((i for i, (a, b) in enumerate(zip(ours, captured)) if a != b), min(len(ours), len(captured)))
        print(f'DIFF   {syx.name}: ours {len(ours)} vs captured {len(captured)}, first mismatch at byte {first}')
sys.exit(1 if failed else 0)
