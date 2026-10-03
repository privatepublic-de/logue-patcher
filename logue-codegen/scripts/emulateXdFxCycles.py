# Rough Cortex-M4F cycle estimate for a built minilogue xd EFFECT unit (delfx/revfx: in-place
# stereo; modfx: separate main and sub-timbre buffers, told apart by the staged fx.cpp's header),
# after emulateXdCycles.py (the oscillator one): runs the unit's real hooks in unicorn and weights
# each executed instruction (M4 TRM timings, simplified), plus SDRAM_PENALTY extra cycles per
# load/store into SDRAM -- the effects MCU (STM32F446) has no data cache, and what its FMC
# SDRAM really costs per access isn't known here, so run it at a few penalties to bracket the
# answer. The firmware's fx_get_bpmf is answered with 120 BPM. An ESTIMATE, not a measurement.
# Needs `pip install unicorn capstone pyelftools`.
# Usage (param = the knob index, 0 = Time, 1 = Depth, 3 = Shift+Depth; value 0..1; PROFILE=1
# also prints the cost per fx.cpp source line):
#   SDRAM_PENALTY=8 python3 emulateXdFxCycles.py <staged>/build/fx.elf <samples> [0=0.3 1=0.75 ...]
import os, sys, struct, math, random, subprocess
from unicorn import *
from unicorn.arm_const import *
from capstone import *
from elftools.elf.elffile import ELFFile

elf, total = sys.argv[1], int(sys.argv[2])
params = [(int(a.split('=')[0]), float(a.split('=')[1])) for a in sys.argv[3:]]
penalty = int(os.environ.get('SDRAM_PENALTY', '0'))
syms = {}
for line in subprocess.run(['/opt/homebrew/bin/arm-none-eabi-nm', elf], capture_output=True, text=True).stdout.splitlines():
    p = line.split()
    if len(p) == 3: syms[p[2]] = int(p[0], 16)

mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
mu.mem_map(0x20000000, 0x40000)          # unit SRAM + our stack/buffers
mu.mem_map(0x08000000, 0x100000)         # firmware (the fx API lives here)
SDRAM_BASE, SDRAM_SIZE = 0xC0000000, 0x01000000
mu.mem_map(SDRAM_BASE, SDRAM_SIZE)
with open(elf, 'rb') as f:
    for seg in ELFFile(f).iter_segments():
        if seg['p_type'] == 'PT_LOAD' and seg['p_filesz'] > 0 and seg['p_vaddr'] < SDRAM_BASE:
            mu.mem_write(seg['p_vaddr'], seg.data())
mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
STOP = 0x2003f000
mu.mem_write(STOP, b'\x00\xbf\x00\xbf')
BUF = 0x20030000

# fx_get_bpmf (main_api.syms): return 120.f in s0.
BPMF = 0x0807ca8c
def bpmf(uc, addr, size, _):
    uc.reg_write(UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', 120.0))[0])
    uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
mu.hook_add(UC_HOOK_CODE, bpmf, begin=BPMF, end=BPMF)

cs = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
cache = {}
state = {'cyc': 0, 'last': None, 'on': False, 'sdram': 0}
hist = {}
sdhist = {}
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
    if addr not in cache:
        ins = next(cs.disasm(bytes(uc.mem_read(addr, size)), addr), None)
        m = ins.mnemonic.split('.')[0] if ins else ''
        cache[addr] = (weight(m, ins.op_str if ins else ''), m.startswith('b') or m.startswith('cb') or m == 'pop' or m.startswith('ldm') or m == 'bx')
    w, isb = cache[addr]
    state['cyc'] += w
    hist[addr] = hist.get(addr, 0) + w
    state['last'] = (addr, size, isb)
mu.hook_add(UC_HOOK_CODE, hook)
def mem(uc, access, addr, size, value, _):
    if state['on']:
        state['cyc'] += penalty
        state['sdram'] += 1
        pc = uc.reg_read(UC_ARM_REG_PC)
        sdhist[pc] = sdhist.get(pc, 0) + 1
mu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, mem, begin=SDRAM_BASE, end=SDRAM_BASE + SDRAM_SIZE - 1)

def call(fn, *args):
    mu.reg_write(UC_ARM_REG_SP, 0x2002f000)
    mu.reg_write(UC_ARM_REG_LR, STOP | 1)
    for r, v in zip([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3], args): mu.reg_write(r, v)
    # AAPCS: a fifth argument and beyond go on the stack.
    for k, v in enumerate(args[4:]): mu.mem_write(0x2002f000 + 4 * k, struct.pack('<I', v))
    state['last'] = None
    mu.emu_start(syms[fn] | 1, STOP)

modfx = 'usermodfx.h' in open(os.path.join(os.path.dirname(os.path.dirname(elf)), 'fx.cpp')).read()
OUT_BUF = BUF + 0x1000 if modfx else BUF
SUB_IN, SUB_OUT = BUF + 0x2000, BUF + 0x3000

call('_entry', 0, 0)
for i, v in params: call('_hook_param', i, min(0x7fffffff, int(v * 0x7fffffff)))
rng = random.Random(1)
FR = 64; warm = 48000 // 2; done = 0; cyc = 0; sq = 0.0; n = 0; accesses = 0
while done < warm + total:
    frames = [rng.uniform(-0.3, 0.3) for _ in range(FR)]
    mu.mem_write(BUF, b''.join(struct.pack('<ff', x, x) for x in frames))
    state['on'] = done >= warm; state['cyc'] = 0; state['sdram'] = 0
    if modfx:
        mu.mem_write(SUB_IN, b''.join(struct.pack('<ff', x, x) for x in frames))
        call('_hook_process', BUF, OUT_BUF, SUB_IN, SUB_OUT, FR)
    else:
        call('_hook_process', BUF, FR)
    if state['on']:
        cyc += state['cyc']; accesses += state['sdram']
        for (s,) in struct.iter_unpack('<f', bytes(mu.mem_read(OUT_BUF, FR * 8))): sq += s * s; n += 1
    done += FR
print(f"{elf.split('/')[-3]:24s} penalty={penalty:2d}  cycles/sample={cyc / total:6.0f}  "
      f"sdram accesses/sample={accesses / total:5.1f}  rms={math.sqrt(sq / max(n, 1)):.3f}")

# PROFILE=1: the cost per fx.cpp source line (innermost, after inlining), heaviest first, with
# the line's SDRAM accesses per sample; PROFILE_LINES lines (default 30, 0 = all).
if os.environ.get('PROFILE'):
    addrs = sorted(set(hist) | set(sdhist))
    out = subprocess.run(['/opt/homebrew/bin/arm-none-eabi-addr2line', '-e', elf] + [hex(a) for a in addrs], capture_output=True, text=True).stdout.splitlines()
    by, sd = {}, {}
    for a, l in zip(addrs, out):
        l = l.split('/')[-1].split(' ')[0]
        by[l] = by.get(l, 0) + hist.get(a, 0)
        sd[l] = sd.get(l, 0) + sdhist.get(a, 0)
    src = open(os.path.join(os.path.dirname(os.path.dirname(elf)), 'fx.cpp')).read().splitlines()
    limit = int(os.environ.get('PROFILE_LINES', '30')) or None
    for l, c in sorted(by.items(), key=lambda x: -x[1])[:limit]:
        try: ln = int(l.split(':')[1]); txt = src[ln - 1].strip()[:110]
        except Exception: txt = ''
        print(f"{c / total:7.1f} {sd[l] / total:5.2f}  {l:14s} {txt}")
