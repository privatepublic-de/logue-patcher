import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@logue-codegen': resolve('logue-codegen/src')
    }
  },
  test: {
    include: ['test/**/*.spec.ts']
  }
})
