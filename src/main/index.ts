import { app, shell, screen, BrowserWindow, Menu } from 'electron'
import type { Rectangle, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerSystemIpc } from './ipc/system'
import { registerClipboardIpc } from './ipc/clipboard'
import { registerSettingsIpc } from './ipc/settings'
import { registerPatchFileIpc } from './ipc/patchFile'
import { registerLogueExportIpc } from './ipc/logueExport'
import { registerLogueBuildIpc } from './ipc/logueBuild'
import { registerLogueDeviceIpc } from './ipc/logueDevice'
import { registerLogueMidiIpc } from './ipc/logueMidi'
import { registerSubpatchLibraryIpc } from './ipc/subpatchLibrary'
import { registerSampleFileIpc } from './ipc/sampleFile'
import { registerQuitGuardIpc, guardWindowClose } from './quitGuard'
import { IPC_EVENT_CHANNELS } from '../shared/ipc/contract'
import { loadAppSettings, updateAppSettings } from './config/appSettings'
import { appHomeDir } from './config/appHome'

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const BOUNDS_SAVE_DEBOUNCE_MS = 500

/** True if `bounds` overlaps some connected display's work area -- guards against restoring a window at coordinates from a since-disconnected external monitor. */
function isBoundsOnScreen(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
}

/**
 * A file opened via Finder/Dock or the native "Open Recent" menu (role: 'recentDocuments')
 * arrives through this event, not a normal IPC call -- must be registered before 'ready'
 * per Electron's docs. If no window exists yet (cold launch by double-clicking a .loguepatch/.loguesub
 * file), the path is queued and flushed once the first window is ready to show.
 */
let pendingOpenFilePath: string | null = null

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send(IPC_EVENT_CHANNELS['menu.openRecentFile'], filePath)
  } else {
    pendingOpenFilePath = filePath
  }
})

function sendToFocusedWindow(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(channel, ...args)
}

function buildAppMenu(): void {
  const send =
    (channel: string, ...args: unknown[]): (() => void) =>
    () =>
      sendToFocusedWindow(channel, ...args)
  // The usual macOS order: app, File, Edit, View, the app's own menus, Window, Help.
  const template: MenuItemConstructorOptions[] = [
    {
      // Electron's `role: 'appMenu'` template, with its `role: 'about'` item swapped for a
      // custom click handler -- the native About panel (app.setAboutPanelOptions, above) can't
      // show a library/license list, so this opens AboutModal.tsx instead.
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: send(IPC_EVENT_CHANNELS['menu.openAbout']) },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: send(IPC_EVENT_CHANNELS['menu.openSettings'])
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Oscillator',
          accelerator: 'CmdOrCtrl+N',
          click: send(IPC_EVENT_CHANNELS['menu.newLogueOsc'])
        },
        {
          label: 'New Effect',
          submenu: (
            [
              ['Mod', 'modfx'],
              ['Delay', 'delfx'],
              ['Reverb', 'revfx']
            ] as const
          ).map(([label, module]) => ({
            label,
            click: send(IPC_EVENT_CHANNELS['menu.newLogueEffect'], module)
          }))
        },
        {
          label: 'New Subpatch',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: send(IPC_EVENT_CHANNELS['menu.newSubpatch'])
        },
        { type: 'separator' },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: send(IPC_EVENT_CHANNELS['menu.openPatch'])
        },
        {
          role: 'recentDocuments',
          submenu: [{ role: 'clearRecentDocuments' }]
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: send(IPC_EVENT_CHANNELS['menu.savePatch'])
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: send(IPC_EVENT_CHANNELS['menu.savePatchAs'])
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      // Electron's `editMenu` role, with Undo/Redo sent to the renderer: there a focused text
      // field gets its native undo and anything else the patch's own. On macOS the page sees
      // the keystroke first, so ⌘Z on the canvas (handled and preventDefault'ed there) never
      // reaches these items -- they fire for a text field's ⌘Z and for clicks.
      label: 'Edit',
      submenu: [
        {
          id: 'edit-undo',
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: send(IPC_EVENT_CHANNELS['menu.undo'])
        },
        {
          id: 'edit-redo',
          label: 'Redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          click: send(IPC_EVENT_CHANNELS['menu.redo'])
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      // The canvas's view plus Electron's page zoom (⌘+/⌘−/⌘0 scale the whole interface, and
      // Chromium remembers the level across restarts -- needed for reading, keep it). Reload
      // throws away unsaved patches without asking, so it and the developer tools are left to
      // development builds.
      label: 'View',
      submenu: [
        {
          id: 'view-zoom-to-fit',
          label: 'Zoom to Fit',
          accelerator: 'CmdOrCtrl+Alt+0',
          click: send(IPC_EVENT_CHANNELS['menu.zoomToFit'])
        },
        { type: 'separator' },
        {
          id: 'arrange-by-flow',
          label: 'Arrange by Signal Flow',
          accelerator: 'CmdOrCtrl+Alt+A',
          click: send(IPC_EVENT_CHANNELS['menu.arrangeByFlow'])
        },
        {
          id: 'arrange-spread-out',
          label: 'Spread Out Overlapping Nodes',
          click: send(IPC_EVENT_CHANNELS['menu.spreadOutNodes'])
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(is.dev
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' }
            ] as MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: 'Build',
      submenu: [
        {
          id: 'build-export-source',
          label: 'Export Unit Source',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: send(IPC_EVENT_CHANNELS['menu.exportUnitSource'])
        },
        {
          id: 'build-unit',
          label: 'Build Unit',
          accelerator: 'CmdOrCtrl+B',
          click: send(IPC_EVENT_CHANNELS['menu.buildUnit'])
        },
        {
          id: 'build-and-upload-unit',
          label: 'Build and Upload',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: send(IPC_EVENT_CHANNELS['menu.buildAndUploadUnit'])
        }
      ]
    },
    {
      // Everything about the synth itself: its controls, and what's stored on it.
      label: 'Device',
      submenu: [
        {
          id: 'build-param-matrix',
          label: 'Device Param Matrix…',
          click: send(IPC_EVENT_CHANNELS['menu.openParamMatrix'])
        },
        { type: 'separator' },
        {
          id: 'backup-device',
          label: 'Back Up Device…',
          click: send(IPC_EVENT_CHANNELS['menu.deviceBackup'])
        },
        {
          id: 'backup-restore',
          label: 'Restore Device…',
          click: send(IPC_EVENT_CHANNELS['menu.deviceRestore'])
        }
      ]
    },
    { role: 'windowMenu' },
    {
      // `role: 'help'` makes it macOS's Help menu, which adds the menu search field.
      role: 'help',
      submenu: [
        {
          label: `${app.name} Help`,
          accelerator: 'CmdOrCtrl+Shift+/',
          click: send(IPC_EVENT_CHANNELS['menu.openHelp'])
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const homeDir = appHomeDir()
  const savedBounds = loadAppSettings(homeDir).windowBounds
  const bounds = savedBounds && isBoundsOnScreen(savedBounds) ? savedBounds : undefined

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_WIDTH,
    height: bounds?.height ?? DEFAULT_HEIGHT,
    x: bounds?.x,
    y: bounds?.y,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  let saveBoundsTimer: NodeJS.Timeout | null = null
  const persistBounds = (): void => {
    updateAppSettings(homeDir, { windowBounds: mainWindow.getBounds() })
  }
  const schedulePersistBounds = (): void => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
    saveBoundsTimer = setTimeout(persistBounds, BOUNDS_SAVE_DEBOUNCE_MS)
  }
  mainWindow.on('resize', schedulePersistBounds)
  mainWindow.on('move', schedulePersistBounds)
  mainWindow.on('close', persistBounds)
  guardWindowClose(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (pendingOpenFilePath) {
      mainWindow.webContents.send(IPC_EVENT_CHANNELS['menu.openRecentFile'], pendingOpenFilePath)
      pendingOpenFilePath = null
    }
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // package.json's `name` (npm-safe, lowercase-kebab) is what Electron's `app.name` falls back to
  // in dev (`npm run dev`/the run-desktop driver, neither of which go through electron-builder's
  // packaging step) -- set explicitly so the About menu label/panel and dev launches agree with
  // electron-builder.yml's `productName` a packaged build gets instead.
  app.setName('Logue Patcher')

  // Set app user model id for windows
  electronApp.setAppUserModelId('de.privatepublic.logue-patcher')

  // Without this, macOS's native "About Logue Patcher" menu item (from `role: 'appMenu'` below)
  // falls back to the launching Electron binary's own bundle Info.plist in dev (`npm run dev`/
  // the run-desktop driver both launch the generic Electron.app wrapper) -- showing "Electron"'s
  // own name/version/copyright, not this app's. electron-builder.yml's `copyright` covers the
  // packaged build's Info.plist; this covers dev the same way.
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Peter Witzel'
  })

  // A packaged .app gets its dock icon from build/icon.icns (electron-builder's own
  // buildResources convention) automatically -- this only matters for `npm run dev`/the
  // run-desktop skill's driver, both of which launch the generic Electron.app wrapper, which
  // would otherwise show Electron's own default icon in the dock.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerSystemIpc()
  registerQuitGuardIpc()
  registerClipboardIpc()
  registerSettingsIpc()
  registerPatchFileIpc()
  registerLogueExportIpc()
  registerLogueBuildIpc()
  registerLogueDeviceIpc()
  registerLogueMidiIpc()
  registerSubpatchLibraryIpc()
  registerSampleFileIpc()

  buildAppMenu()
  createWindow()
})

// Quit on the last window closing, including on macOS -- unlike the electron-vite default,
// this app has no reason to keep running windowless (no menu-bar-only/background use case),
// so it skips the usual macOS dock-stays-open convention.
app.on('window-all-closed', () => {
  app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
