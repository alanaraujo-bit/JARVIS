import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { SessionInfo } from "../lib/ipc";
import type { PaneNode } from "../lib/layout";
import { useAccountStore } from "../stores/accountStore";
import { TerminalView } from "./TerminalView";
import { Icon } from "./Icon";

interface Props {
  node: PaneNode;
  activePaneId: string;
  sessions: Readonly<Record<string, SessionInfo>>;
  paneCount: number;
  /** Conta do Claude Code usada por cada sessão viva, para colorir o seletor. */
  contaDaSessao: Readonly<Record<string, string>>;
  onFocusPane: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onClosePane: (paneId: string) => void;
  onRestartPane: (paneId: string) => void;
  /** Troca a conta do painel sem fechar a aba — reinicia o shell dele e, se
   * havia uma conversa de IA rodando ali, retoma ela na conta nova. */
  onSwitchAccount: (paneId: string, accountId: string) => void;
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
  contaDaSessao,
  onFocusPane,
  onResize,
  onClosePane,
  onRestartPane,
  onSwitchAccount,
}: Props) {
  if (node.type === "leaf") {
    const info = sessions[node.sessionId];
    // Sessão ainda não chegou no mapa (spawn em voo): trata como viva, para
    // não piscar o overlay de "encerrado" no instante em que o painel nasce.
    const dead = info ? !info.alive : false;
    const unjobbed = info ? !info.jobbed : false;

    return (
      <div
        // `multi` acende o anel de foco só quando há painel com quem
        // disputar: numa aba de painel único a moldura não responde
        // pergunta nenhuma e vira a coisa mais chamativa da tela.
        className={`split-leaf ${node.id === activePaneId ? "focused" : ""} ${
          paneCount > 1 ? "multi" : ""
        }`}
        onMouseDown={() => onFocusPane(node.id)}
      >
        <TerminalView sessionId={node.sessionId} focused={node.id === activePaneId} />
        {info && (
          // Etiqueta discreta da pasta onde o terminal foi aberto. Só o nome
          // final (o "projeto"), com o caminho inteiro no tooltip — é o que
          // permite achar, num monte de painéis, em qual pasta cada um vive.
          <span
            className="pane-cwd"
            title={info.cwd}
            aria-label={`Pasta de trabalho: ${info.cwd}`}
          >
            <Icon name="folder" size={12} />
            <span className="pane-cwd-label">{folderLabel(info.cwd)}</span>
          </span>
        )}
        {info && !dead && (
          <PaneAccountSwitch
            contaId={contaDaSessao[node.sessionId]}
            onSwitch={(accountId) => onSwitchAccount(node.id, accountId)}
          />
        )}
        {unjobbed && !dead && (
          <span
            className="pane-warn"
            title="Não foi possível conter esta sessão num Job Object: processos filhos podem sobreviver ao fechamento deste painel."
          >
            <Icon name="warning" size={14} />
          </span>
        )}
        {paneCount > 1 && (
          <button
            className="pane-close"
            title="Fechar painel"
            aria-label="Fechar painel"
            onClick={() => onClosePane(node.id)}
          >
            <Icon name="close" size={13} />
          </button>
        )}
        {dead && (
          // Véu translúcido + cartão opaco, e não uma laje sólida sobre o
          // painel inteiro: a última saída do processo é justamente o que
          // se quer ler quando ele cai sozinho, e cobri-la apagava a única
          // pista do motivo. O cartão dá ao texto e aos botões o contraste
          // de qualquer painel do app sem esconder o terminal atrás.
          <div className="pane-overlay">
            <div className="pane-overlay-card">
              <span className="pane-overlay-title">
                Processo encerrado{info?.exitCode != null ? ` (código ${info.exitCode})` : ""}
              </span>
              <div className="pane-overlay-actions">
                <button onClick={() => onRestartPane(node.id)}>
                  <Icon name="refresh" size={13} />
                  Reiniciar
                </button>
                <button onClick={() => onClosePane(node.id)}>Fechar</button>
              </div>
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
      contaDaSessao={contaDaSessao}
      onFocusPane={onFocusPane}
      onResize={onResize}
      onClosePane={onClosePane}
      onRestartPane={onRestartPane}
      onSwitchAccount={onSwitchAccount}
    />
  );
}

/** Só a última pasta de um caminho — "C:\Users\X\Projetos\JARVIS" → "JARVIS". */
function folderLabel(cwd: string): string {
  const semBarra = cwd.replace(/[\\/]+$/, "");
  const separador = Math.max(semBarra.lastIndexOf("\\"), semBarra.lastIndexOf("/"));
  const nome = separador >= 0 ? semBarra.slice(separador + 1) : semBarra;
  // Raiz ("C:\", "/") não tem nome de pasta: devolve o caminho inteiro.
  return nome || semBarra;
}

function SplitBranch({
  node,
  activePaneId,
  sessions,
  paneCount,
  contaDaSessao,
  onFocusPane,
  onResize,
  onClosePane,
  onRestartPane,
  onSwitchAccount,
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
              contaDaSessao={contaDaSessao}
              onFocusPane={onFocusPane}
              onResize={onResize}
              onClosePane={onClosePane}
              onRestartPane={onRestartPane}
              onSwitchAccount={onSwitchAccount}
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

/**
 * Bolinha discreta no canto do painel, na cor da conta em uso. Clicar abre a
 * lista de contas cadastradas; escolher uma diferente aciona `onSwitch`.
 *
 * Não existe forma de trocar a variável de ambiente de um processo já vivo —
 * quem chama `onSwitch` é responsável por reiniciar o shell na conta nova
 * (e, quando dá, retomar a conversa de IA que estava rodando ali). Este
 * componente só escolhe a conta; não sabe nada sobre reiniciar painel.
 */
function PaneAccountSwitch({
  contaId,
  onSwitch,
}: {
  contaId: string | undefined;
  onSwitch: (accountId: string) => void;
}) {
  const contas = useAccountStore((s) => s.contas);
  const [aberto, setAberto] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!aberto) return;
    // Clique fora fecha — o menu não tem um botão "cancelar" próprio.
    const onDocDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [aberto]);

  // Sem conta cadastrada não há o que trocar — nem vale ocupar o canto do
  // painel com um botão que não faz nada.
  if (contas.length === 0) return null;

  const atual = contas.find((c) => c.id === contaId);

  return (
    <div className="pane-account" ref={boxRef}>
      <button
        className={`pane-account-btn ${aberto ? "open" : ""}`}
        style={atual ? { borderColor: atual.color } : undefined}
        title={
          atual
            ? `Conta do Claude Code: ${atual.name} — clique para trocar`
            : "Trocar a conta do Claude Code deste painel"
        }
        aria-label="Trocar conta do Claude Code"
        aria-haspopup="true"
        aria-expanded={aberto}
        onClick={(e) => {
          e.stopPropagation();
          setAberto((v) => !v);
        }}
      >
        <span
          className="pane-account-dot"
          style={{ background: atual?.color ?? "var(--text-muted)" }}
        />
      </button>
      {aberto && (
        <ul className="pane-account-menu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
          {contas.map((c) => (
            <li key={c.id} role="none">
              <button
                role="menuitem"
                className={`pane-account-item ${c.id === contaId ? "active" : ""}`}
                onClick={() => {
                  setAberto(false);
                  if (c.id !== contaId) onSwitch(c.id);
                }}
              >
                <span className="pane-account-dot" style={{ background: c.color }} />
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
