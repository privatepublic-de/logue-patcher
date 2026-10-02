#!/usr/bin/env python3
# Turns dump_slots' raw per-slot captures into a restorable backup folder:
#   <module>-<NN>-<name>.body.bin   the exact stored USER SLOT DATA body (the restore input)
#   <module>-<NN>-<name>.<ext>      a rebuilt unit package, written ONLY if re-encoding its
#                                   manifest+payload reproduces body.bin byte-for-byte
#   index.json                      what was found per slot, and every check's result
# The minilogue xd's USB MIDI output inserts stray F7 bytes into long SysEx (PROTOCOL.md), so the
# raw stream -- not a parsed message -- is the input, and every F7 but the last is dropped.
#   usage: backup_from_dump.py <raw-dir> <out-dir>
import io, json, struct, sys, zipfile, zlib
from pathlib import Path

MODULES = {1: 'modfx', 2: 'delfx', 3: 'revfx', 4: 'osc'}
PLATFORMS = {1: ('prologue', '.prlgunit'), 2: ('minilogue-xd', '.mnlgxdunit'), 3: ('nutekt-digital', '.ntkdigunit')}
PARAM_UNITS = {0: '%', 1: '%', 2: ''}


def unpack7(b):
    out = bytearray()
    for i in range(0, len(b), 8):
        g = b[i:i + 8]
        out += bytes(x | (0x80 if (g[0] >> j) & 1 else 0) for j, x in enumerate(g[1:]))
    return bytes(out)


def semver(v):
    return f'{v >> 16}.{(v >> 8) & 0xff}-{v & 0xff}'


def cstr(b):
    return b.split(b'\0', 1)[0].decode('ascii', 'replace')


def rebuild(manifest, payload, platform_id, module_id):
    # Mirrors minilogueXdUnitBody.ts / encode_upload.py, generalized to the header's own platform.
    h = manifest['header']
    hdr = bytearray(1024)
    hdr[0], hdr[1] = module_id, platform_id
    pack = lambda s: (lambda a, b: (int(a[0]) << 16) | (int(a[1]) << 8) | int(b))(*[s.split('-')[0].split('.'), s.split('-')[1]])
    struct.pack_into('<IIII', hdr, 2, pack(h['api']), h['dev_id'], h['prg_id'], pack(h['version']))
    n = h['name'].encode('ascii')[:13]
    hdr[0x12:0x12 + len(n)] = n
    struct.pack_into('<I', hdr, 0x20, h['num_param'])
    for i, (pn, mn, mx, unit) in enumerate(h['params']):
        o = 0x24 + i * 16
        struct.pack_into('<bbB', hdr, o, mn, mx, (1 if mn < 0 else 0) if unit == '%' else 2)
        pb = pn.encode('ascii')[:13]
        hdr[o + 3:o + 3 + len(pb)] = pb
    struct.pack_into('<I', hdr, 1020, len(payload))
    return bytes(hdr) + payload + bytes(132)


raw_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
index = []
for raw_path in sorted(raw_dir.glob('module*-slot*.raw'), key=lambda p: [int(x) for x in p.stem.replace('module', '').split('-slot')]):
    module_id, slot = [int(x) for x in raw_path.stem.replace('module', '').split('-slot')]
    raw = raw_path.read_bytes()
    entry = {'module': MODULES[module_id], 'slot': slot}
    clean = bytes(b for i, b in enumerate(raw) if b != 0xF7 or i == len(raw) - 1)
    entry['strayF7'] = len(raw) - len(clean)
    if len(clean) <= 10:
        entry['empty'] = True
        index.append(entry)
        continue
    d = unpack7(clean[10:-1])
    size, crc = struct.unpack_from('<II', d, 0)
    body = d[8:8 + size]
    entry.update(size=size, complete=len(body) == size, deviceCrc=f'{crc:08x}', zlibCrc=f'{zlib.crc32(body):08x}')
    if len(body) != size:
        entry['error'] = f'incomplete: {len(body)}/{size} bytes'
        index.append(entry)
        continue
    name = cstr(body[0x12:0x20])
    platform_id = body[1]
    plat, ext = PLATFORMS.get(platform_id, (f'platform-{platform_id}', '.unit'))
    stem = f"{MODULES[module_id]}-{slot + 1:02d}-{''.join(c if c.isalnum() or c in '-_' else '_' for c in name) or 'unnamed'}"
    (out_dir / f'{stem}.body.bin').write_bytes(body)
    num_param = struct.unpack_from('<I', body, 0x20)[0]
    payload_len = struct.unpack_from('<I', body, 1020)[0]
    params = []
    for i in range(num_param):
        mn, mx, t = struct.unpack_from('<bbB', body, 0x24 + i * 16)
        params.append([cstr(body[0x24 + i * 16 + 3:0x24 + i * 16 + 16]), mn, mx, PARAM_UNITS.get(t, '?')])
    manifest = {'header': {
        'platform': plat, 'module': MODULES[module_id],
        'api': semver(struct.unpack_from('<I', body, 2)[0]),
        'dev_id': struct.unpack_from('<I', body, 6)[0], 'prg_id': struct.unpack_from('<I', body, 10)[0],
        'version': semver(struct.unpack_from('<I', body, 14)[0]),
        'name': name, 'num_param': num_param, 'params': params}}
    payload = body[1024:1024 + payload_len]
    trailer_zero = not any(body[1024 + payload_len:])
    entry.update(name=name, platform=plat, payloadBytes=payload_len, trailerAllZero=trailer_zero, body=f'{stem}.body.bin')
    if rebuild(manifest, payload, platform_id, module_id) == body:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{MODULES[module_id]}/manifest.json", json.dumps(manifest, indent=4) + '\n')
            z.writestr(f"{MODULES[module_id]}/payload.bin", payload)
        (out_dir / f'{stem}{ext}').write_bytes(buf.getvalue())
        entry['unitFile'] = f'{stem}{ext}'
    else:
        entry['unitFile'] = None
        entry['note'] = 'manifest round-trip did not reproduce the body exactly; restore from body.bin'
    index.append(entry)

# Same index format the app's own backup writes (logue-codegen/src/sysex/unitBackup.ts), so the
# app's Restore can read a backup made here; the extra per-slot diagnostics are ignored there.
import datetime
for e in index:
    e.setdefault('empty', False)
    if not e['empty']:
        e.setdefault('unitFile', None)
(out_dir / 'index.json').write_text(json.dumps({
    'format': 'logue-patcher-device-backup/1', 'device': 'minilogue xd',
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'slots': index}, indent=2) + '\n')
for e in index:
    if e.get('empty'):
        print(f"{e['module']:5} {e['slot'] + 1:2}  (empty)")
    else:
        print(f"{e['module']:5} {e['slot'] + 1:2}  {e.get('name', '?'):14} {e.get('platform', ''):13} "
              f"size {e.get('size')} complete={e.get('complete')} strayF7={e['strayF7']} "
              f"unitFile={'yes' if e.get('unitFile') else 'NO'} deviceCrc==zlib:{e.get('deviceCrc') == e.get('zlibCrc')}"
              + (f"  ERROR {e['error']}" if 'error' in e else ''))
