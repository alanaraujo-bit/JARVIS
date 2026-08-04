import { defineConfig, devices } from "@playwright/test";

/**
 * Testes de ponta a ponta da interface, rodando no Chromium contra o
 * servidor de desenvolvimento do Vite. O backend é o simulado de
 * `src/lib/devMock.ts`, que entra sozinho quando o Tauri não está presente —
 * então estes testes exercitam a interface de verdade (xterm, streaming,
 * atalhos) sem precisar compilar o Rust.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
