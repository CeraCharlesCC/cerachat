import { defineConfig } from '@playwright/test'
import { env } from 'node:process'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
    channel: 'chrome',
    launchOptions: {
      chromiumSandbox: true,
      ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    // Only the test server seeds the deterministic SQLite fixtures. Never reuse
    // an unrelated dev server which may be using an unseeded database.
    env: { VITE_CERACHAT_TEST_FIXTURES: 'true' },
    reuseExistingServer: false,
  },
})
