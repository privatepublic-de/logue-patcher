// REPL driver for logue-patcher. macOS-native (real display, no xvfb needed).
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '../../..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/axo-modern-shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null
// Set by `resize`: an explicit viewport the next `ss` must keep rather than re-sync.
let manualViewport = false

const electronBin = path.join(
  APP_DIR,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

// With the window zoomed (webContents zoom 1.2 on a 2x Retina display), a plain
// page.screenshot() captured a frame laid out at the wrong width: the Build panel, header
// buttons and minimap were missing although the DOM had them in place. Pinning the viewport to
// the window's real content size (in unzoomed px, which the zoom then scales down to the page's
// own innerWidth) makes the capture match the live layout. Deriving it from innerWidth instead
// shrinks the page by the zoom factor on every call.
async function syncViewport() {
  if (manualViewport) return
  const { width, height } = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds()
  )
  const current = page.viewportSize()
  if (current?.width !== width || current?.height !== height) {
    await page.setViewportSize({ width, height })
  }
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
      console.log('ERROR: no build output at out/main/index.js — run `npm run build` first')
      return
    }
    app = await electron.launch({
      executablePath: electronBin,
      args: [APP_DIR],
      timeout: 30_000
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()))
    page.on('pageerror', (err) => console.log('[pageerror]', err.message))
    await syncViewport()
    console.log('launched.', app.windows().length, 'window(s):')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await syncViewport()
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // Resizes the actual OS window (via CDP, not an OS-level Accessibility resize) -- on a
  // multi-monitor / mixed-DPI setup, an Accessibility-API resize (e.g. via `osascript`) can
  // leave a stale, never-repainted strip near the window's trailing edge that a later
  // `ss` silently captures as blank, even though the DOM at that position is completely
  // correct (getBoundingClientRect/elementFromPoint agree with the live layout). Going through
  // Playwright's own resize path avoids that.
  async resize(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [w, h] = arg.split(/\s+/).map(Number)
    await page.setViewportSize({ width: w, height: h })
    manualViewport = true
    console.log('resized to', w, h)
  },

  // Real, trusted mouse input via Playwright's page.mouse (CDP Input domain) -- for
  // interactions that depend on a genuine mousemove/click having reached the page (e.g. React
  // Flow's own "insert at last pointer position" shortcuts, which track position via a real
  // onMouseMove handler an untrusted page-context dispatchEvent won't reliably drive).
  async wheel(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [x, y, dx, dy] = arg.split(/\s+/).map(Number)
    await page.mouse.move(x, y)
    await page.mouse.wheel(dx, dy)
    console.log('wheeled at', x, y, 'delta', dx, dy)
  },

  async mouseclick(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [x, y] = arg.split(/\s+/).map(Number)
    await page.mouse.move(x, y)
    await page.mouse.click(x, y)
    console.log('mouseclicked', x, y)
  },

  // Real, trusted right-click (page.mouse with button: 'right') -- for context-menu handlers
  // wired via React's onContextMenu, which a page-context dispatchEvent('contextmenu') can miss.
  async rightclick(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [x, y] = arg.split(/\s+/).map(Number)
    await page.mouse.move(x, y)
    await page.mouse.click(x, y, { button: 'right' })
    console.log('rightclicked', x, y)
  },

  // Real mouse drag (down at x1,y1 -> several intermediate moves -> up at x2,y2) via
  // page.mouse -- for widgets (canvas knobs/sliders) that only commit on a genuine pointer
  // drag, which an untrusted page-context dispatchEvent won't reliably drive.
  async drag(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [x1, y1, x2, y2] = arg.split(/\s+/).map(Number)
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps)
    }
    await page.mouse.up()
    console.log('dragged', x1, y1, '->', x2, y2)
  },

  // Same as `drag`, but holds Shift for the duration -- React Flow's default `selectionKeyCode`
  // is 'Shift', so a plain `drag` on empty canvas just pans; this is the one that box-selects.
  async shiftdrag(arg) {
    if (!page) return console.log('ERROR: launch first')
    const [x1, y1, x2, y2] = arg.split(/\s+/).map(Number)
    await page.keyboard.down('Shift')
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps)
    }
    await page.mouse.up()
    await page.keyboard.up('Shift')
    console.log('shift-dragged', x1, y1, '->', x2, y2)
  },

  async dblclick(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, sel)
    if (!r) return console.log('dblclick', sel, '→ NOT_FOUND')
    await page.mouse.move(r.x, r.y)
    await page.mouse.dblclick(r.x, r.y)
    console.log('dblclicked', sel, 'at', r.x, r.y)
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, sel)
    console.log('click', sel, '→', r)
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')]
      const el =
        els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK: ' + el.tagName
    }, text)
    console.log('click-text', JSON.stringify(text), '→', r)
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first')
    try {
      await page.waitForSelector(sel, { timeout: 10_000 })
      console.log('found:', sel)
    } catch {
      console.log('TIMEOUT:', sel)
    }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(
      await page.evaluate(
        (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
        sel || null
      )
    )
  },

  // Real, trusted-enough key input via Playwright's own CDP-level dispatch (page.keyboard),
  // for cases a raw page.evaluate(() => el.dispatchEvent(new KeyboardEvent(...))) can't reach --
  // React's synthetic event delegation doesn't reliably fire from an untrusted, page-context
  // dispatchEvent for keyboard input (unlike mouse/input events, which do work that way). Key
  // names follow Playwright's own vocabulary (e.g. "Escape", "ArrowDown", "Shift+ArrowUp").
  async press(key) {
    if (!page) return console.log('ERROR: launch first')
    await page.keyboard.press(key)
    console.log('pressed', key)
  },

  // Types each character as a real keypress (Playwright's page.keyboard.type) -- for the same
  // reason `press` exists: filling a React-controlled input via a raw value-setter + dispatched
  // 'input' event works for onChange, but real per-keystroke behavior (e.g. this app's object
  // search overlay filtering as you type) is best exercised with real keystrokes.
  async type(text) {
    if (!page) return console.log('ERROR: launch first')
    await page.keyboard.type(text)
    console.log('typed', JSON.stringify(text))
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  // Clicks a native application-menu item by its exact label (e.g. "New Patch"), for actions
  // this app only exposes via the native menu (see CLAUDE.md: file actions moved off in-app
  // buttons onto the native menu). Runs in the Electron MAIN process context via
  // ElectronApplication.evaluate, not the renderer `page` -- Menu/MenuItem aren't reachable
  // from the renderer at all.
  async menuclick(label) {
    if (!app) return console.log('ERROR: launch first')
    const result = await app.evaluate(({ Menu, BrowserWindow }, itemLabel) => {
      const menu = Menu.getApplicationMenu()
      if (!menu) return 'NO_MENU'
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const stack = [...menu.items]
      while (stack.length) {
        const item = stack.pop()
        if (item.label === itemLabel) {
          item.click(undefined, win, win?.webContents)
          return 'OK'
        }
        if (item.submenu) stack.push(...item.submenu.items)
      }
      return 'NOT_FOUND'
    }, label)
    console.log(result)
  },

  // Opens a specific file the same way a real double-click in Finder/Dock would (main
  // process's app.on('open-file') -> IPC event to the renderer) -- there's no in-app "Open by
  // path" affordance reachable from the renderer/DOM (the real Open dialog is a native macOS
  // picker Playwright can't drive), so this replicates that exact IPC event via
  // ElectronApplication.evaluate (main-process context, not the renderer `page`).
  async openfile(filePath) {
    if (!app) return console.log('ERROR: launch first')
    const result = await app.evaluate(({ BrowserWindow }, path) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return 'NO_WINDOW'
      win.webContents.send('axoloti:event:menu.openRecentFile', path)
      return 'OK'
    }, filePath)
    console.log(result)
  },

  // Native pickers (dialog.showOpenDialog) can't be driven by Playwright; this makes the NEXT
  // ones resolve to `path` as if the user had chosen it. Main-process only, lasts until relaunch.
  async mockopendialog(path) {
    if (!app) return console.log('ERROR: launch first')
    const result = await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
      return 'OK'
    }, path)
    console.log(result)
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  }
}

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  if (!cmd) return rl.prompt()
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log('unknown:', cmd, '— try: help')
    return rl.prompt()
  }
  try {
    await fn(rest.join(' '))
  } catch (e) {
    console.log('ERROR:', e.message)
  }
  if (cmd === 'quit') {
    rl.close()
    process.exit(0)
  }
  rl.prompt()
})
rl.on('close', async () => {
  await COMMANDS.quit()
  process.exit(0)
})

console.log('logue-patcher driver — "help" for commands, "launch" to start')
rl.prompt()
