import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// StrictMode ligado de propósito: a montagem dupla em desenvolvimento é
// exatamente o que expõe corrida entre instantâneo e fluxo ao vivo e vazamento
// de ouvinte no painel de terminal. Abrir PTY é ação de clique do usuário, não
// de montagem, então nada é duplicado por causa disto.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
