---
name: run-desktop
description: Build, run, and drive the logue-patcher Electron desktop app. Use when asked to start the app, take a screenshot of it, or verify a UI change actually works.
---

logue-patcher is a macOS-only Electron app. Since this session runs on real macOS with a real display, there's no xvfb needed — the driver launches the actual packaged Electron binary via Playwright's `_electron`.

All paths are relative to the repo root (`logue-patcher/`).

## Build

```bash
npm install
npm run build   # typecheck + test + electron-vite build -> out/{main,preload,renderer}
```

The driver launches the **built** app (`out/main/index.js`), not `npm run dev`'s HMR server — rebuild after every change you want to verify.

## Run (agent path)

```bash
node .claude/skills/run-desktop/driver.mjs
```

Wrap in tmux for interactive use. macOS has no `timeout` command, so wait with a plain loop, and
wait for each step's own output before sending the next one -- a command sent before `launch`
finished (or before `openfile` printed `OK`) silently acts on the empty start screen:

```bash
wait_for() { for i in $(seq 1 100); do tmux capture-pane -t app -p -S -200 | grep -q "$1" && return 0; sleep 0.3; done; echo "TIMEOUT waiting for $1"; return 1; }
tmux new-session -d -s app -x 200 -y 50 'cd /Users/peter/Documents/GitHub/logue-patcher && node .claude/skills/run-desktop/driver.mjs'
wait_for "driver>"
tmux send-keys -t app 'launch' Enter; wait_for "launched"
tmux send-keys -t app 'openfile /abs/path/to/patch.loguepatch' Enter; wait_for "^OK"; sleep 1.5
tmux send-keys -t app 'ss landing' Enter; wait_for "landing.png"
tmux capture-pane -t app -p
```

Screenshots land in `/tmp/axo-modern-shots/` (the driver's default dir name is a leftover from before the fork; override with `SCREENSHOT_DIR`).

### Commands

| command | what it does |
|---|---|
| `launch` | launch the built app, wait for the window |
| `openfile <abs-path>` | open a `.loguepatch`/`.loguesub` as if double-clicked in Finder |
| `menuclick <label>` | click a native menu item by exact label (e.g. `Device Param Matrix…`) |
| `ss [name]` | screenshot → `/tmp/axo-modern-shots/<name>.png` (pins the viewport to the real window first, see Gotchas) |
| `click <css-sel>` | click element (via DOM, not coords) |
| `click-text <text>` | click button/link containing text |
| `wait <css-sel>` | wait for element, 10s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print innerText |
| `windows` | list open windows |
| `mockopendialog <path>` | make the next native Open dialog(s) resolve to `path` (main process, until relaunch) |
| `quit` | close app, exit |

## Run (human path)

```bash
npm run dev   # opens a window with HMR
```

## Gotchas

- **Screenshots and window zoom:** the app window runs at webContents zoom 1.2 (the user's own ⌘+ page zoom, which Chromium persists -- no code sets it) (`devicePixelRatio`
  2.4 on a 2x display). Without a pinned viewport, `page.screenshot()` captured a frame laid out at
  the wrong width -- Build panel, header buttons and minimap missing although the DOM had them.
  `launch` and `ss` therefore pin the viewport to the window's real content size (unzoomed px, via
  `getContentBounds`). Never derive it from `innerWidth` -- that is already zoomed, and the page
  shrinks by 1.2x on every call. An explicit `resize` wins until relaunch. If a screenshot still
  looks off, check the DOM (`eval` with `getBoundingClientRect`) before believing it.

- The driver launches `out/main/index.js` via the built app directory, not `npm run dev`'s dev server — always `npm run build` first or you'll launch stale output.
- Electron steals stdin; the driver reads `/dev/stdin` directly so the REPL keeps working.

## Troubleshooting

- **Launch timeout:** build output missing at `out/main/index.js` → run `npm run build`.
- **Blank window / no content:** check `windows` for the loaded URL, then `eval "document.body.innerHTML"` to see what actually rendered.
