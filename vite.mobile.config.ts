import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * O build do app do celular — separado do build do desktop de propósito.
 *
 * São dois produtos com restrições opostas. O do desktop roda dentro do
 * WebView2, com o Tauri disponível e a máquina inteira do outro lado do IPC;
 * o do celular roda num navegador qualquer, atrás de um túnel, e não pode
 * importar nada do Tauri porque ali não existe Tauri nenhum. Um build só, com
 * duas entradas, deixaria essa fronteira valendo por convenção — e a primeira
 * importação errada só apareceria como tela branca no celular de alguém.
 *
 * A saída vai para `src-tauri/webapp/`, de onde o Rust a embute no executável
 * com `include_bytes!` (ver `collab/webapp.rs`). Os nomes são fixos, e não
 * hasheados: quem resolve cache aqui é o `ETag` do servidor, e o nome estável
 * é o que deixa o service worker guardar sempre os mesmos caminhos.
 */
export default defineConfig({
  plugins: [react()],
  root: "mobile",
  publicDir: "public",
  base: "/",
  build: {
    outDir: "../src-tauri/webapp",
    emptyOutDir: true,
    // O alvo é o celular real, não o mais recente: um iPhone que a pessoa não
    // troca há três anos ainda é o aparelho que ela vai usar para isto.
    target: ["es2020", "safari14", "chrome87"],
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
        // Um arquivo só. Cada pedaço a mais é mais uma ida ao túnel antes da
        // primeira linha de terminal aparecer.
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // Para testar no celular durante o desenvolvimento sem passar pelo Tauri.
    host: true,
  },
});
