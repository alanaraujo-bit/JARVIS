/**
 * Ponto de entrada do app do celular.
 *
 * Este bundle é servido pelo próprio JARVIS, na mesma porta da sala (ver
 * `src-tauri/src/collab/webapp.rs`). A consequência prática é a melhor parte
 * do desenho: a página nasce sabendo o endereço do computador, porque ela
 * **veio dele**. Não há campo de endereço para preencher, nem descoberta de
 * rede, nem servidor intermediário — `location.origin` já é a resposta.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Depois do primeiro quadro: registrar o service worker é sobre a *próxima*
// abertura, e disputar largura de banda com o bundle que está pintando a tela
// agora atrasaria justamente a abertura que a pessoa está esperando.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Acontece de verdade e não é erro: pela rede local o endereço é
      // `http://`, e service worker exige origem segura. O app funciona
      // igual — só não fica instalável nem abre instantâneo.
    });
  });
}
