import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite fica atrás do Tauri: porta fixa e sem tentar outra se ocupada,
// senão a janela nativa aponta para o lugar errado.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // Sem este recorte o vitest também coleta `e2e/`, que é do Playwright, e
    // `npm test` falha sempre com "Playwright Test did not expect test() to
    // be called here".
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
