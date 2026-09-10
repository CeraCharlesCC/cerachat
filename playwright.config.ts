import { defineConfig } from '@playwright/test'
import { env } from 'node:process'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
    launchOptions: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !env.CI,
  },
})
