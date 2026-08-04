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
});
