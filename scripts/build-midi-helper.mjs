// Compiles native/logue-midi-helper (Swift, CoreMIDI) into resources/bin/ as a universal binary.
// resources/** is asarUnpacked, so electron-builder ships it executable next to app.asar. Skips the
// compile when the binary is already newer than its source, so `npm run build` stays fast.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const src = 'native/logue-midi-helper/main.swift'
const outDir = 'resources/bin'
const out = join(outDir, 'logue-midi-helper')

if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) {
  console.log(`${out} is up to date`)
  process.exit(0)
}
mkdirSync(outDir, { recursive: true })
const slices = ['arm64', 'x86_64'].map((arch) => {
  const slice = `${out}-${arch}`
  execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos12`, src, '-o', slice], {
    stdio: 'inherit'
  })
  return slice
})
execFileSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' })
slices.forEach((s) => rmSync(s))
console.log(`built ${out} (universal)`)
