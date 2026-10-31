import { defineConfig } from '@playwright/test';

const chrome = process.env.PW_CHROME_PATH; // optional: use a system Chrome instead of `npx playwright install chromium`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1280, height: 860 } },
  projects: [
    { name: 'server', testMatch: /server\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:5199' } },
    { name: 'browser-only', testMatch: /browser\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4199' } },
  ],
  webServer: [
    {
      command: 'cd ../backend && LIVE_SIM_STEP_MS=80 ${PYTHON:-python3} -m uvicorn app.main:app --port 8765',
      url: 'http://127.0.0.1:8765/health', reuseExistingServer: !process.env.CI, timeout: 60_000,
    },
    { command: 'LIVE_BACKEND_URL=http://127.0.0.1:8765 npx vite --port 5199 --strictPort', url: 'http://127.0.0.1:5199', reuseExistingServer: !process.env.CI },
    {
      // No backend reachable at this base → app falls back to the in-browser SimulatedProvider.
      command: 'VITE_API_BASE=/no-backend npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4199 --strictPort',
      url: 'http://127.0.0.1:4199', reuseExistingServer: !process.env.CI, timeout: 120_000,
    },
  ],
});
