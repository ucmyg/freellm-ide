import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The live-gateway test drives real models, which can be slow.
    testTimeout: 180_000,
  },
})
