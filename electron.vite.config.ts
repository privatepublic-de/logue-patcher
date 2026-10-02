import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@logue-codegen': resolve('logue-codegen/src')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // No externalizeDepsPlugin here: sandboxed preload scripts (webPreferences.sandbox: true)
    // can't `require()` arbitrary node_modules at runtime -- the preload bundle must be
    // fully self-contained. Only main (unsandboxed) externalizes deps.
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@logue-codegen': resolve('logue-codegen/src')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@logue-codegen': resolve('logue-codegen/src')
      }
    },
    plugins: [react()]
  }
})
