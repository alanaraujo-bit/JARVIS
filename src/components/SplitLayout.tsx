import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { SessionInfo } from "../lib/ipc";
import type { PaneNode } from "../lib/layout";
import { TerminalView } from "./TerminalView";

interface Props {
  node: PaneNode;
  activePaneId: string;
  sessions: Readonly<Record<string, SessionInfo>>;
  paneCount: number;
  onFocusPane: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onClosePane: (paneId: string) => void;
  onRestartPane: (paneId: string) => void;
}

const MIN_FRACTION = 0.08;

/**
 * Desenha a árvore de painéis recursivamente.
 *
 * O que preserva o xterm entre renders é o efeito de montagem do
 * `<TerminalView>` depender só de `sessionId`: arrastar um divisor ou
 * reordenar irmãos na mesma divisão não recria terminal nenhum. A `key` dos
 * nós é o `paneId`, que é o que identifica a posição na árvore.
 */
export function SplitLayout({
  node,
  activePaneId,
  sessions,
  paneCount,
  onFocusPane,
  onResize,
  onClosePane,
  onRestartPane,
}: Props) {
  if (node.type === "leaf") {
    const info = sessions[node.sessionId];
    // Sessão ainda não chegou no mapa (spawn em voo): trata como viva, para
    // não piscar o overlay de "encerrado" no instante em que o painel nasce.
    const dead = info ? !info.alive : false;
    const unjobbed = info ? !info.jobbed : false;

    return (
      <div
        className={`split-leaf ${node.id === activePaneId ? "focused" : ""}`}
        onMouseDown={() => onFocusPane(node.id)}
      >
        <TerminalView sessionId={node.sessionId} focused={node.id === activePaneId} />
        {unjobbed && !dead && (
          <span
            className="pane-warn"
            title="Não foi possível conter esta sessão num Job Object: processos filhos podem sobreviver ao fechamento deste painel."
          >
            ⚠
          </span>
        )}
        {paneCount > 1 && (
          <button className="pane-close" title="Fechar painel" onClick={() => onClosePane(node.id)}>
            ×
          </button>
        )}
        {dead && (
          <div className="pane-overlay">
            <span>Processo encerrado{info?.exitCode != null ? ` (código ${info.exitCode})` : ""}</span>
            <div className="pane-overlay-actions">
              <button onClick={() => onRestartPane(node.id)}>Reiniciar</button>
              <button onClick={() => onClosePane(node.id)}>Fechar</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <SplitBranch
      node={node}
      activePaneId={activePaneId}
      sessions={sessions}
      paneCount={paneCount}
      onFocusPane={onFocusPane}
      onResize={onResize}
      onClosePane={onClosePane}
      onRestartPane={onRestartPane}
    />
  );
}

function SplitBranch({
  node,
  activePaneId,
  sessions,
  paneCount,
  onFocusPane,
  onResize,
  onClosePane,
  onRestartPane,
}: Props & { node: Extract<PaneNode, { type: "split" }> }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ index: number; startPos: number; startSizes: number[] } | null>(null);
  /** Solta os ouvintes de arraste caso o painel desmonte no meio dele. */
  const soltaDrag = useRef<(() => void) | null>(null);

  useEffect(() => () => soltaDrag.current?.(), []);

  const beginDrag = useCallback(
    (index: number, e: ReactMouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      dragState.current = {
        index,
        startPos: node.direction === "row" ? e.clientX : e.clientY,
        startSizes: node.sizes,
      };

      const onMove = (ev: MouseEvent) => {
        const drag = dragState.current;
        if (!drag) return;
        const rect = el.getBoundingClientRect();
        const total = node.direction === "row" ? rect.width : rect.height;
        if (total <= 0) return;
        const pos = node.direction === "row" ? ev.clientX : ev.clientY;
        const delta = (pos - drag.startPos) / total;

        const sizes = [...drag.startSizes];
        const i = drag.index;
        // Move a fronteira entre os painéis i e i+1; o resto da linha não muda.
        let a = sizes[i] + delta;
        let b = sizes[i + 1] - delta;
        if (a < MIN_FRACTION) {
          b -= MIN_FRACTION - a;
          a = MIN_FRACTION;
        }
        if (b < MIN_FRACTION) {
          a -= MIN_FRACTION - b;
          b = MIN_FRACTION;
        }
        sizes[i] = Math.max(MIN_FRACTION, a);
        sizes[i + 1] = Math.max(MIN_FRACTION, b);
        onResize(node.id, sizes);
      };

      const onUp = () => {
        dragState.current = null;
        soltaDrag.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      // Se o painel sumir no meio do arraste (fechado por atalho, aba
      // fechada), estes ouvintes ficariam pendurados no `window` chamando
      // `onResize` sobre uma divisão que não existe mais.
      soltaDrag.current = onUp;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [node.direction, node.id, node.sizes, onResize],
  );

  return (
    <div className={`split-branch ${node.direction}`} ref={containerRef}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split-slot"
            style={{ flexGrow: node.sizes[i], flexBasis: 0 }}
          >
            <SplitLayout
              node={child}
              activePaneId={activePaneId}
              sessions={sessions}
              paneCount={paneCount}
              onFocusPane={onFocusPane}
              onResize={onResize}
              onClosePane={onClosePane}
              onRestartPane={onRestartPane}
            />
          </div>
          {i < node.children.length - 1 && (
            // Irmão do slot, não filho dele: como divisor de fluxo (`flex:
            // none`) fora do `flexGrow` das folhas, o arraste não rouba
            // espaço de nenhum painel além do necessário para o próprio
            // traço fino do divisor.
            <div
              className={`split-divider ${node.direction}`}
              onMouseDown={(e) => {
                e.preventDefault();
                beginDrag(i, e);
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
