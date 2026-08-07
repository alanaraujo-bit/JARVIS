/**
 * As duas coisas que um app de terminal no celular precisa saber sobre a tela:
 * quanto dela sobrou depois do teclado, e quando o app voltou do bolso.
 */

import { useEffect } from "react";

import { collabClient } from "../src/lib/collabClient";

/**
 * Mantém `--altura` valendo a altura realmente visível.
 *
 * Um `height: 100vh` mede a janela inteira, teclado incluído: a barra de
 * teclas ficaria desenhada atrás do teclado, e as últimas linhas do terminal
 * também. O `dvh` resolve no Android (com `interactive-widget=resizes-content`
 * no `<meta>`), mas não no iOS, onde o teclado não encolhe o layout — ele
 * desloca a *viewport visual* por cima. `visualViewport.height` é a única
 * medida que descreve os dois casos, e é dela que sai `--altura`.
 *
 * O `scrollTo(0, 0)` no fim não é supersticioso: ao abrir o teclado, o iOS
 * rola a página para revelar o campo em foco. Com o layout já dimensionado
 * para o espaço certo, essa rolagem só empurra o topo do app para fora da
 * tela, e o que ela revelaria já estava visível.
 */
export function useAlturaVisivel() {
  useEffect(() => {
    const vv = window.visualViewport;

    const aplicar = () => {
      const altura = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty("--altura", `${Math.round(altura)}px`);
      if (vv && vv.offsetTop !== 0) window.scrollTo(0, 0);
    };

    aplicar();
    vv?.addEventListener("resize", aplicar);
    vv?.addEventListener("scroll", aplicar);
    window.addEventListener("orientationchange", aplicar);
    return () => {
      vv?.removeEventListener("resize", aplicar);
      vv?.removeEventListener("scroll", aplicar);
      window.removeEventListener("orientationchange", aplicar);
    };
  }, []);
}

/**
 * Reconecta assim que o app volta ao primeiro plano.
 *
 * Sem isto, desbloquear o celular mostraria o terminal congelado no instante
 * em que a tela apagou, com a reconexão chegando só no próximo passo do
 * backoff — até oito segundos olhando para uma tela que mente.
 */
export function useAcordar() {
  useEffect(() => {
    const acordou = () => {
      if (document.visibilityState === "visible") collabClient.ensureAlive();
    };
    document.addEventListener("visibilitychange", acordou);
    window.addEventListener("pageshow", acordou);
    window.addEventListener("online", acordou);
    return () => {
      document.removeEventListener("visibilitychange", acordou);
      window.removeEventListener("pageshow", acordou);
      window.removeEventListener("online", acordou);
    };
  }, []);
}
