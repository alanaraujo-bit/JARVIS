import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Fora do app nativo não existe backend, e a tela abriria vazia. Em
// desenvolvimento — e só lá — um backend simulado entra no lugar, o que
// permite mexer na interface no navegador com recarga instantânea e rodar os
// testes de ponta a ponta sem compilar o Rust. O `import()` dinâmico mantém
// o mock fora do pacote de produção.
async function bootstrap() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installDevMock } = await import("./lib/devMock");
    installDevMock();
  }

  // StrictMode ligado de propósito: a montagem dupla em desenvolvimento é
  // exatamente o que expõe corrida entre instantâneo e fluxo ao vivo e
  // vazamento de ouvinte no painel de terminal. Abrir PTY é ação de clique do
  // usuário, não de montagem, então nada é duplicado por causa disto.
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
