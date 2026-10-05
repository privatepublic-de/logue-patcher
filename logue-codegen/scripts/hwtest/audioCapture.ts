/**
 * Records the NTS-1 mkII's output from the audio interface with `sox` (Homebrew). Defaults: the
 * user's X18/XR18, inputs 17/18 -- the clean pair (1/2 go through a limiter, which would hide
 * exactly the dropouts and levels these tests measure). Override with HWTEST_AUDIO_DEVICE and
 * HWTEST_AUDIO_CHANNELS ("17,18"); the device's channel count is read from `system_profiler`
 * once, falling back to 18.
 */
import { execFile } from 'child_process'

export const SAMPLE_RATE = 48000
const DEVICE = process.env.HWTEST_AUDIO_DEVICE ?? 'X18/XR18'
const CHANNELS = (process.env.HWTEST_AUDIO_CHANNELS ?? '17,18').split(',').map(Number)
const DEVICE_CHANNELS = Number(process.env.HWTEST_AUDIO_DEVICE_CHANNELS ?? 18)

export interface Recording {
  left: Float32Array
  right: Float32Array
}

/** Records `seconds` of the two configured channels. */
export function record(seconds: number): Promise<Recording> {
  return new Promise((resolve, reject) => {
    execFile(
      'sox',
      [
        '-q',
        '-t',
        'coreaudio',
        DEVICE,
        '-c',
        String(DEVICE_CHANNELS),
        '-r',
        String(SAMPLE_RATE),
        // Without the output's own -c, sox writes the input's channel count back out.
        '-t',
        'f32',
        '-c',
        '2',
        '-',
        'remix',
        String(CHANNELS[0]),
        String(CHANNELS[1]),
        'trim',
        '0',
        String(seconds)
      ],
      { encoding: 'buffer', maxBuffer: 1 << 30 },
      (err, stdout) => {
        if (err) return reject(err)
        const all = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength >> 2)
        const n = all.length >> 1
        const left = new Float32Array(n)
        const right = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          left[i] = all[2 * i]
          right[i] = all[2 * i + 1]
        }
        resolve({ left, right })
      }
    )
  })
}
