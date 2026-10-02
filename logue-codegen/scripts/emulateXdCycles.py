# Rough Cortex-M4F cycle estimate: runs a built minilogue xd unit's real hooks in unicorn and
# weights each executed instruction (M4 TRM timings, simplified). An ESTIMATE for comparing
# builds, not a hardware measurement: about 1.4x the older hand counts in CLAUDE.md. The firmware
# note->Hz LUT is faked as equal temperament. Needs `pip install unicorn capstone pyelftools`.
# Usage (param = the OSC_PARAM index, 6/7 = shape/shift-shape, 0..1023):
#   python3 emulateXdCycles.py <staged>/build/osc.elf <note> <samples> [param=value ...]
#   PROFILE=1 ... also prints the cost per osc.cpp source line
import sys, struct, math, subprocess
from unicorn import *
from unicorn.arm_const import *
from capstone import *
elf, note, total = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
params = [tuple(map(int, a.split('='))) for a in sys.argv[4:]]
syms = {}
for line in subprocess.run(['/opt/homebrew/bin/arm-none-eabi-nm', elf], capture_output=True, text=True).stdout.splitlines():
    p = line.split()
    if len(p) == 3: syms[p[2]] = int(p[0], 16)
from elftools.elf.elffile import ELFFile
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
mu.mem_map(0x20000000, 0x40000)          # unit SRAM + our stack/buffers
mu.mem_map(0x08000000, 0x100000)         # firmware (LUTs)
lut = b''.join(struct.pack('<f', 440.0 * 2 ** ((i - 69) / 12)) for i in range(152))
mu.mem_write(0x0800f100, lut)
with open(elf, 'rb') as f:
    e = ELFFile(f)
    for seg in e.iter_segments():
        if seg['p_type'] == 'PT_LOAD': mu.mem_write(seg['p_vaddr'], seg.data())
# enable FPU (CPACR) -- unicorn M-class needs it
mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
STOP = 0x2003f000
mu.mem_write(STOP, b'\x00\xbf\x00\xbf')
PARAMS, OUT = 0x20030000, 0x20031000
cs = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
cache = {}
hist = {}
state = {'cyc': 0, 'last': None, 'on': False}
def weight(m, ops):
    if m.startswith('vdiv') or m.startswith('vsqrt'): return 14
    if m in ('vpush', 'vpop') or m.startswith('stm') or m.startswith('ldm') or m in ('push', 'pop'):
        return 1 + ops.count(',') + 1 + (ops.count('-') * 3)
    if m.startswith('vldr') or m.startswith('ldr'): return 2
    if m.startswith('vstr') or m.startswith('str'): return 1
    if m.startswith('vldm') or m.startswith('vstm'): return 1 + ops.count(',')
    if m.startswith(('vfma', 'vfms', 'vfnm', 'vmla', 'vmls', 'vnmla')): return 3
    if m.startswith(('sdiv', 'udiv')): return 6
    if m.startswith(('bl', 'blx')): return 3
    return 1
def hook(uc, addr, size, _):
    if not state['on']: return
    if state['last'] is not None:
        la, ls, isb = state['last']
        if isb and addr != la + ls: state['cyc'] += 2   # taken branch refill
    key = addr
    if key not in cache:
        code = bytes(uc.mem_read(addr, size))
        ins = next(cs.disasm(code, addr), None)
        m = ins.mnemonic.split('.')[0] if ins else ''
        cache[key] = (weight(m, ins.op_str if ins else ''), m.startswith('b') or m.startswith('cb') or m == 'pop' or m.startswith('ldm') or m == 'bx')
    w, isb = cache[key]
    state['cyc'] += w
    hist[addr] = hist.get(addr, 0) + w
    state['last'] = (addr, size, isb)
mu.hook_add(UC_HOOK_CODE, hook)
def call(fn, *args):
    mu.reg_write(UC_ARM_REG_SP, 0x2002f000)
    mu.reg_write(UC_ARM_REG_LR, STOP | 1)
    for r, v in zip([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3], args): mu.reg_write(r, v)
    state['last'] = None
    mu.emu_start(syms[fn] | 1, STOP)
call('_hook_init', 0, 0)
for i, v in params: call('_hook_param', i, v)
# user_osc_param_t: int32 shape_lfo, uint16 pitch, cutoff, resonance, reserved[3]
mu.mem_write(PARAMS, struct.pack('<iHHH3H', 0, note << 8, 0, 0, 0, 0, 0))
call('_hook_on', PARAMS)
FR = 64; warm = 48000 // 8; done = 0; cyc = 0; sq = 0.0; n = 0
while done < warm + total:
    state['on'] = done >= warm; state['cyc'] = 0
    call('_hook_cycle', PARAMS, OUT, FR)
    if state['on']:
        cyc += state['cyc']
        for (s,) in struct.iter_unpack('<i', bytes(mu.mem_read(OUT, FR * 4))): sq += (s / 2147483648.0) ** 2; n += 1
    done += FR
print(f"{elf.split('/')[-3]:28s} cycles/sample={cyc / total:6.0f}  rms={math.sqrt(sq / max(n,1)):.3f}")

import os
if os.environ.get('PROFILE'):
    addrs = sorted(hist)
    out = subprocess.run(['/opt/homebrew/bin/arm-none-eabi-addr2line', '-e', elf, '-i'] + [hex(a) for a in addrs], capture_output=True, text=True).stdout
    # -i prints inline chains; take the first (innermost) line per address by re-running without -i
    out = subprocess.run(['/opt/homebrew/bin/arm-none-eabi-addr2line', '-e', elf] + [hex(a) for a in addrs], capture_output=True, text=True).stdout.splitlines()
    by = {}
    for a, l in zip(addrs, out):
        l = l.split('/')[-1].split(' ')[0]
        by[l] = by.get(l, 0) + hist[a]
    tot = sum(by.values())
    src = open(os.path.join(os.path.dirname(os.path.dirname(elf)), 'osc.cpp')).read().splitlines()
    for l, c in sorted(by.items(), key=lambda x: -x[1])[:40]:
        try: ln = int(l.split(':')[1]); txt = src[ln-1].strip()[:110]
        except Exception: txt = ''
        print(f"{c / total :7.1f}  {l:14s} {txt}")
