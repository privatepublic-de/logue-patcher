# reverse-wash (a stereo reverse delay from primitives)

Plan agreed 2026-10-01 (user: a new `util/reverse-tap`, a mono sum into one buffer, softening on
the sum). Status: phases 1 and 2 done (harness-, link- and emulator-checked); phase 3 (hardware
listening) open. A delfx: the incoming signal is cut into segments, each played backwards,
overlapped into a continuous swell, and spread across the stereo field by heads that move.
Everything but the playback head is existing primitives. Two documents:
`examples/effects/reverse-wash.loguepatch` (NTS-1 mkII; it builds for the xd too, but is too
heavy there) and `reverse-wash-xd.loguepatch` (the xd's lighter version).

## The one hard constraint: reading backwards at exact speed

No primitive played audio backwards. A `util/buffer-tap` can, if its delay grows by exactly
**2 samples per sample**: the write head moves +1, so the read point moves -1 (reverse at
the original pitch). Any slope error is a pitch error: speed = slope - 1.

**Primitive-only route** (rejected): a `lfo/ramp-up` into the tap's `time` with TIME 50, so the
ramp's +-1 sweeps the whole ring (`3 + 0..100 % * (mask - 4)` samples, span S = L - 5), at a
period of S/2 samples. Float32 simulation of `lfo_rate_from_percent` and the phase accumulator:

| Ring (LENGTH) | Segment | RATE needed | Error at that RATE | Error at the nearest integer RATE |
|---|---|---|---|---|
| 0.68 s | 0.34 s | 52.198 | -0.4 ct | -38 ct (52) |
| 1.4 s | 0.68 s | 40.934 | -0.2 ct | +15 ct (41) |
| 2.7 s | 1.37 s | 31.676 | -0.1 ct | +91 ct (32) |

In tune with a fractional RATE baked into the unit, but **the segment length couldn't be a
knob**: a device param arrives as an integer, and a knob would also have to scale the ramp's
span, through a cubic rate map on one side and a linear span on the other.

## `util/reverse-tap` (built)

| Ports | Params |
|---|---|
| in `buf` (buffer wire), `size` (additive, 50); out `a`, `b` (the two heads, each windowed), `phaseA`, `phaseB` (0..1 across each head's own segment, unipolar) | SIZE (40 ms .. half the ring, squared), WINDOW (0 = 5 ms fades, 100 = a full smoothstep crossfade) |

- Head a reads delay `2c + 1` at sample c of its segment: one int16 SDRAM read, no
  interpolation, exactly -1 speed at every SIZE.
- SIZE and WINDOW are read at a's midpoint for a's NEXT segment, which is also when b's next
  segment begins (it ends at that segment's midpoint). Both heads' lengths and fades stay
  matched while SIZE moves, and no read jumps mid-segment. Both heads are in ONE node because
  two instances couldn't stay locked.
- `phaseA`/`phaseB`, one per head: `1 - phaseA` jumps at a's seam, where b's window peaks.
- Dropped from the draft: a REVERSE (forward) switch. Not needed; easy to add.
- Harness (`runNts1FxHarness.ts`): every segment an exact reversal (16-bit) at a fixed and a
  swept SIZE (1920..13396 samples), b starting half a segment in, `a + b` constant within 3e-5
  at WINDOW 100, also while SIZE moves; dirty SDRAM gives silence. Links on both platforms
  (leaf only on the xd), ~1 KB code per instance on the xd.
- Listening point: two decorrelated heads crossfaded at constant AMPLITUDE dip ~3 dB in power
  at each crossing; an equal-power WINDOW end might suit a wash better.

## The patch

```
audio-in mono --> soften (duck VCA) --(+)--> tone (lowpass) --> buffer (2.7 s) ==> rev-1 (SIZE)        --a, b--> pans 1a, 1b --+
                                       ^                                       ==> rev-2 (SIZE x~1.31) --a, b--> pans 2a, 2b --+--> bus L/R
                                       |                                                                                    |
                                       |                       allpass x2 per side (diffusion) <----------------------------+
                                       |                                 |
                                       |                                 +--> width --> crossfader per side (MIX vs dry L/R) --> out
                                       +-- feedback vca (DEPTH) <-- soft-clip <-- highpass <-- L + R of the diffused wet
```

- **One buffer, two lines**: the mono sum (plus feedback, through TONE, so each pass gets
  darker) records into a 2.7 s buffer. `rev-1` and `rev-2` read it with SIZE from the TIME knob,
  `rev-2`'s ~1.31x `rev-1`'s (VCAs at 1.75x / 2x on the 0..1 control, 50 per unit on `size`;
  lengths go with SIZE squared). Not 1.5x, whose seams would coincide every 1.5 segments. The
  2.7 s ring lets `rev-2` reach half of it while `rev-1` is at 0.76 of that, so the two lines
  don't lock together at the top. At the bottom of TIME both reach the 40 ms minimum: the
  ratio climbs from 1 there to ~1.31 from the middle up.
- **Panning that moves**: each head's pan = its phase (-1..1, `util/unipolar-to-bipolar`) x
  SPREAD (`math/scale`; heads 1b and 2a inverted), so every reversed swell travels across the
  field as it plays, plus one of two slow sine LFOs (MOTION SPEED; the second runs 5 RATE
  points faster) x MOTION. Four `mix/pan` chained onto one bus, then `mix/width`.
- **Diffusion**: allpasses 13 / 29 ms (L) and 17 / 37 ms (R), GAIN 60 (DIFFUSE), inside the
  feedback path, so every pass gets denser. Each pass is reversed again (pass 2 forward, pass 3
  backward); with the diffusion that reads as a wash.
- **Feedback**: L + R of the diffused wet, `highpass-cheap` (CUTOFF 15, ~26 Hz), `soft-clip`,
  a VCA at DEPTH x 0.32 (four heads) / 0.65 (xd version, one line). At full DEPTH the loop gain
  is just under 1: L + R of equal-power pans depends on where the heads are, so the range was
  set where the NTS-1 mkII version still dies away with its menu at the worst (SPREAD and MOTION
  0, every head centred; TONE open): from 2 s after a burst, -27 dB over 7 s. At the defaults
  -40 dB takes ~4 s. 0.8 for both (the first value) held or grew; the xd version grew from 0.8.
  Harness: every second after the burst no louder than the one before, on both platforms.
- Level (harness, steady noise, fully wet): ~-8 dB vs the mono input, mostly TONE's lowpass on
  white noise; L/R correlation 0.14.

## Softening reversed plucks

A reversed pluck rises slowly and ends on its attack, the loudest point, then stops dead. The
segment window can't fix it: the attack falls anywhere inside a segment. In the patch:

1. **Duck attacks before the buffer** (SOFTEN): a fast `env/follower` (0.1 ms up, 46 ms down)
   minus 1.6x a slow one (100 ms up, 200 ms down), clamped 0..1, x SOFTEN, subtracted from 1:
   the gain of a VCA on the input. At an attack the gain dips and comes back within ~150 ms;
   reversed, the swell fades out before it stops. Held material isn't touched: the slow one's
   1.6x tops the fast one's ripple (simulation: steady noise and saws at gain 1.00). Harness, one
   head alone at an effect's input level: a reversed pluck's last 5 ms vs its loudest are
   0.1 dB without SOFTEN, -10.2 dB at 100 (the authored value; -4.6 at 80). The first version of
   the detector (both followers at 200 ms release, GAIN 40) clamped during plucks and ducked
   steady sound, see `docs/HISTORY.md`. A difference rather than a ratio (no divide primitive),
   so it depends somewhat on input level.
2. **Give the stop a tail**: the diffusion and the in-loop feedback, the "reverse reverb" remedy.
   In the full patch's output no abrupt stop was measurable at all.
3. **Darken**: TONE (`lowpass-cheap` before the buffer, 70 = ~3.2 kHz). A second lowpass ducked
   by the detector (only the attacks darkened) was not built.
4. **Overlap**: WINDOW 100 plus the second line, so another head's swell covers one head's stop.

Not built: a look-ahead `util/delay` on the audio path (2 KB SRAM, ~150 xd cycles). The first
fraction of a millisecond of each attack passes before the detector reacts.

## Device controls

| | NTS-1 mkII (reverse-wash) | minilogue xd (reverse-wash-xd) |
|---|---|---|
| TIME | segment length (both lines) | segment length |
| DEPTH | feedback | feedback |
| MIX (Shift+Depth on the xd) | dry/wet | dry/wet |
| Menu (all 8 free rows) | SPREAD, MOTION, MOTION SPEED, SOFTEN, DIFFUSE, TONE, WINDOW, WIDTH | none: authored values |

On the xd, DEPTH could also raise SPREAD along with feedback (several params may share a knob).
Left for listening.

## Measured

- **xd** (emulator, penalty 0 / 8, cycles per sample): the full patch 857 / 969, past the ~750
  that stayed clean beside the factory effects. Two generic primitive fixes on the way (from
  1232 / 1376): a wired `mix/pan` is control-rate with ramped gains, a static
  `filter/allpass` TIME is a block constant on an inlined whole-sample path (output-identical).
  `reverse-wash-xd`: one line (two heads), one allpass per side, +3 dB on the wet after the
  feedback tap (one line is 3 dB quieter): **606 / 670**. Variants measured: no allpasses 766,
  one per side 867, no motion -86, one line ~-200. SRAM: full 6464 B, xd version 4396 B of
  12 KB; only the tempo read below `process`. The RAM estimate: 6422 / 4642 B.
- **NTS-1 mkII**: 10.6 KB built (estimate 10589 B) of 24 KB; SDRAM: buffer 256 KB + 4 x 32 KB.
  Staged with the CPU probe on WIDTH's row: `lp-fx-revwash-cpu`.

## Phases

1. `util/reverse-tap` -- done (codegen, snapshots, code-size table, harness, link sweeps).
2. The patches through `writeEffectExamples.ts`, harness checks (`runNts1FxHarness.ts`,
   `runXdFxHarness.ts`), builds, xd emulator -- done.
3. Hardware listening on both devices: SOFTEN on plucks, the pan motion, the xd version beside
   the factory reverb, and the NTS-1 mkII's CPU with the probe. Open.
