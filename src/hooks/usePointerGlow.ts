/**
 * Luz que acompanha o ponteiro dentro de uma lista.
 *
 * É a assinatura de movimento do app: em vez de cada item acender um
 * retângulo sólido no `:hover` — que liga e desliga em degrau, e com o
 * mouse atravessando uma lista longa vira um estroboscópio — existe uma
 * única mancha suave por trás de todos os itens, que se desloca com o
 * ponteiro. O item ainda muda de fundo ao passar o mouse; a luz é a camada
 * que dá continuidade entre um item e o seguinte.
 *
 * Três decisões que fazem isso sair barato:
 *
 * 1. **Duas variáveis CSS, nenhum estado do React.** Escrever `--mx`/`--my`
 *    direto no nó não dispara render nenhum. Um `useState` aqui
 *    reconciliaria a lista inteira a cada pixel de movimento do mouse.
 *
 * 2. **Uma amostra por quadro.** O navegador emite `mousemove` bem mais
 *    rápido que 60Hz; sem o `requestAnimationFrame` o estilo seria
 *    recalculado várias vezes entre dois quadros, todas menos a última
 *    jogadas fora.
 *
 * 3. **Nada quando o usuário pede menos movimento.** Uma luz perseguindo o
 *    cursor é exatamente o tipo de animação que `prefers-reduced-motion`
 *    existe para desligar, e ela é contínua — não dá para "encurtar".
 */

import { useCallback, useRef } from "react";

/**
 * Devolve uma *callback ref*, e não um `useRef`.
 *
 * Um `useEffect` com dependências vazias roda uma vez, na montagem — e a
 * paleta de comandos renderiza `null` enquanto fechada, então nesse momento
 * o nó ainda não existe e os ouvintes nunca chegariam a entrar. A callback
 * ref é chamada pelo React toda vez que o elemento aparece ou some, que é
 * exatamente quando os ouvintes precisam entrar e sair.
 */
export function usePointerGlow<T extends HTMLElement>() {
  const limpaRef = useRef<(() => void) | null>(null);

  return useCallback((el: T | null) => {
    // Desmontagem (ou troca de nó): solta o que estava preso ao anterior.
    limpaRef.current?.();
    limpaRef.current = null;
    if (!el) return;

    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let frame = 0;
    let x = 0;
    let y = 0;

    const aplica = () => {
      frame = 0;
      el.style.setProperty("--mx", `${x}px`);
      el.style.setProperty("--my", `${y}px`);
    };

    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      // Coordenadas relativas à caixa do elemento. Não somamos
      // `scrollTop`: quem rola é o contêiner de fora, e o retângulo
      // devolvido por `getBoundingClientRect` já se move junto com o
      // conteúdo — a luz fica presa aos itens sem correção nenhuma.
      x = e.clientX - r.left;
      y = e.clientY - r.top;
      if (!frame) frame = requestAnimationFrame(aplica);
    };

    const entra = () => el.style.setProperty("--glow", "1");
    const sai = () => el.style.setProperty("--glow", "0");

    el.addEventListener("mousemove", move);
    el.addEventListener("mouseenter", entra);
    el.addEventListener("mouseleave", sai);

    limpaRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseenter", entra);
      el.removeEventListener("mouseleave", sai);
    };
  }, []);
}
