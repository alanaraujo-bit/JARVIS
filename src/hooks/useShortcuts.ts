import { useEffect, useRef } from "react";

export interface ShortcutActions {
  newTab: () => void;
  closePane: () => void;
  nextTab: () => void;
  prevTab: () => void;
  gotoTab: (index: number) => void;
  splitRight: () => void;
  splitDown: () => void;
  focusPaneDirection: (dir: "left" | "right" | "up" | "down") => void;
  // Workspaces + IA
  openFolder: () => void;
  toggleWorkspaceSidebar: () => void;
  toggleAiPanel: () => void;
  clearAiChat: () => void;
  // Paleta + estatísticas
  togglePalette: () => void;
  toggleStats: () => void;
}

/**
 * Atalhos globais do app, interceptados ANTES do xterm ver a tecla.
 *
 * O listener vai no `window`, em fase de captura: a captura desce
 * window → ... → o elemento focado, então rodamos antes de qualquer
 * listener que o xterm tenha no próprio textarea (que está em fase de
 * bolha, ou mesmo em captura no próprio elemento — de qualquer forma mais
 * fundo na árvore). `stopPropagation` interrompe a descida ali mesmo, então
 * a tecla nunca chega ao terminal quando é um atalho nosso.
 *
 * As combinações foram escolhidas para não colidir com bindings de shell já
 * consagrados: Ctrl+T (transpose-chars no bash), Ctrl+W (apaga a palavra
 * anterior no readline) e Alt+Seta (mover por palavra em muitos shells)
 * ficam de fora de propósito. Preferimos Ctrl+Shift+* e Ctrl+Alt+Seta, que
 * nenhum shell padrão reivindica.
 */
export function useShortcuts(actions: ShortcutActions) {
  // As funções de `actions` costumam ser recriadas a cada render do
  // chamador (fecham sobre estado atual). Guardar numa ref e registrar o
  // listener uma única vez evita remover/religar o listener do `window` a
  // cada render — o handler sempre lê a versão mais recente via `.current`.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const actions = actionsRef.current;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (digitandoEmCampo()) return;

      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        consume(e);
        actions.newTab();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        consume(e);
        actions.closePane();
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && e.key === "Tab") {
        consume(e);
        actions.nextTab();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key === "Tab") {
        consume(e);
        actions.prevTab();
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        consume(e);
        actions.gotoTab(Number(e.key) - 1);
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
        consume(e);
        actions.splitRight();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        consume(e);
        actions.splitDown();
        return;
      }
      if (ctrl && e.altKey && !e.shiftKey && e.key.startsWith("Arrow")) {
        consume(e);
        const dir = e.key.slice(5).toLowerCase() as "left" | "right" | "up" | "down";
        actions.focusPaneDirection(dir);
        return;
      }
      // Etapa 3 — workspaces + IA
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        consume(e);
        actions.openFolder();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        consume(e);
        actions.toggleWorkspaceSidebar();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        consume(e);
        actions.toggleAiPanel();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        consume(e);
        actions.clearAiChat();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        consume(e);
        actions.togglePalette();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        consume(e);
        actions.toggleStats();
        return;
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}

function consume(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * O foco está num campo de texto da própria interface (renomear aba, caixa
 * de pergunta da IA, campos de configuração)?
 *
 * A checagem exclui o `<textarea>` escondido do xterm de propósito: ele é
 * tecnicamente um campo de texto, mas representa o terminal — se ele contasse
 * como "digitando", nenhum atalho funcionaria com o terminal focado, que é
 * justamente onde eles precisam funcionar.
 */
function digitandoEmCampo(): boolean {
  const alvo = document.activeElement;
  if (!(alvo instanceof HTMLElement)) return false;
  if (alvo.closest(".xterm")) return false;
  return (
    alvo instanceof HTMLInputElement ||
    alvo instanceof HTMLTextAreaElement ||
    alvo.isContentEditable
  );
}
