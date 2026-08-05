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
    baseURL: "http://localhost:5199",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  /**
   * Porta própria, nunca a 5173 do `npm run dev`, e `reuseExistingServer`
   * desligado.
   *
   * Com a porta de desenvolvimento e o reuso ligado, qualquer outro projeto
   * que já estivesse servindo na 5173 era adotado como se fosse o JARVIS: a
   * suíte rodava inteira contra o app errado. `strictPort` garante que o
   * Vite falhe alto em vez de escorregar para a porta seguinte e testar o
   * nada.
   */
  webServer: {
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
