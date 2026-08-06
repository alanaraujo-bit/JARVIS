/**
 * Histórico de terminais (Ctrl+Shift+H).
 *
 * Lista as sessões que o backend gravou em disco e reproduz o conteúdo de
 * cada uma. A reprodução acontece num xterm de verdade, e não num `<pre>`:
 * o que está gravado são os bytes crus do PTY, com as sequências ANSI
 * intactas. Jogá-los num terminal devolve cor, alinhamento e o desenho das
 * caixas que um agente de IA imprime; num `<pre>` viraria uma sopa de
 * `\x1b[38;5;` — que é justamente o que torna a conversa ilegível.
 *
 * O terminal de reprodução não recebe entrada e não fala com o backend:
 * a sessão daquele conteúdo já morreu, e um cursor piscando ali sugeriria
 * que dá para digitar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";

import {
  agentResumeProbe,
  b64ToBytes,
  transcriptClear,
  transcriptDelete,
  transcriptList,
  transcriptRead,
  type AgentResume,
  type TranscriptMeta,
} from "../lib/ipc";
import { explicaRetomada } from "../lib/agentResume";
import {
  filterTranscripts,
  formatBytes,
  formatTime,
  groupByDay,
  programName,
  sessionDuration,
  sessionLabel,
  shortenPath,
} from "../lib/transcripts";
import { theme } from "../lib/theme";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Abre um terminal novo na mesma pasta/shell da sessão gravada. Com
   * `resume`, ele nasce dentro da conversa de IA que estava rolando ali;
   * sem, nasce limpo.
   */
  onReopen: (m: TranscriptMeta, resume?: AgentResume | null) => void;
}

export function HistoryPanel({ open, onClose, onReopen }: Props) {
  const [lista, setLista] = useState<TranscriptMeta[]>([]);
  const [busca, setBusca] = useState("");
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [confirmandoLimpeza, setConfirmandoLimpeza] = useState(false);
  const [retomada, setRetomada] = useState<AgentResume | null>(null);
  const [procurandoConversa, setProcurandoConversa] = useState(false);

  const caixaRef = useRef<HTMLDivElement | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const l = await transcriptList();
      setLista(l);
      setErro(null);
      // Só escolhe sozinho quando não há escolha: repor a seleção a cada
      // recarga tiraria o usuário de onde ele estava lendo.
      setSelecionada((atual) => (atual && l.some((m) => m.id === atual) ? atual : l[0]?.id ?? null));
    } catch (e) {
      setErro(String(e));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setConfirmandoLimpeza(false);
    void carregar();
    caixaRef.current?.focus();
  }, [open, carregar]);

  /**
   * Procura, do lado do agente, a conversa que aconteceu naquela sessão.
   *
   * Roda a cada sessão escolhida em vez de uma vez para a lista inteira: a
   * busca pode custar uma consulta a uma CLI externa (o `opencode` responde
   * pelo próprio banco), e fazer isso para as 120 gravações do histórico
   * seria uma tempestade de processos para responder a uma pergunta que o
   * usuário fez sobre uma delas.
   */
  useEffect(() => {
    if (!open || !selecionada) {
      setRetomada(null);
      return;
    }
    let descartado = false;
    setRetomada(null);
    setProcurandoConversa(true);
    void agentResumeProbe(selecionada)
      .then((r) => {
        if (!descartado) setRetomada(r);
      })
      // Silêncio proposital: não achar como retomar é o caso comum (um
      // terminal sem agente nenhum), e não vale uma faixa de erro. O botão
      // de reabrir continua ali.
      .catch(() => {})
      .finally(() => {
        if (!descartado) setProcurandoConversa(false);
      });
    return () => {
      descartado = true;
    };
  }, [open, selecionada]);

  const filtrada = useMemo(() => filterTranscripts(lista, busca), [lista, busca]);
  const grupos = useMemo(() => groupByDay(filtrada), [filtrada]);
  const atual = useMemo(
    () => lista.find((m) => m.id === selecionada) ?? null,
    [lista, selecionada],
  );

  /**
   * A sessão ainda está rodando nesta execução do app.
   *
   * `endedAt` só fica em aberto enquanto o PTY vive: as pendências deixadas
   * por uma queda são fechadas na abertura seguinte (ver
   * `TranscriptStore::close_dangling`). Vale a distinção porque retomar uma
   * conversa que já está aberta noutra aba poria dois agentes na mesma
   * sessão, cada um gravando por cima do outro — o jeito de "voltar" para
   * ela é a aba que já existe.
   */
  const aindaAberta = atual?.endedAt === null;
  const podeRetomar = retomada !== null && !aindaAberta;

  const apagar = useCallback(
    async (id: string) => {
      try {
        await transcriptDelete(id);
        setLista((prev) => {
          const next = prev.filter((m) => m.id !== id);
          setSelecionada((sel) => (sel === id ? next[0]?.id ?? null : sel));
          return next;
        });
      } catch (e) {
        setErro(String(e));
      }
    },
    [],
  );

  const limparTudo = useCallback(async () => {
    try {
      await transcriptClear();
      setLista([]);
      setSelecionada(null);
    } catch (e) {
      setErro(String(e));
    } finally {
      setConfirmandoLimpeza(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div className="stats-backdrop history-backdrop" onMouseDown={onClose}>
      <div
        className="history"
        role="dialog"
        aria-modal="true"
        aria-label="Histórico de terminais"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header history-header">
          <span>
            Histórico de terminais
            <span className="history-header-sub">
              {lista.length > 0 ? `${lista.length} sessões gravadas` : "nada gravado ainda"}
            </span>
          </span>
          <div className="history-header-actions">
            {lista.length > 0 &&
              (confirmandoLimpeza ? (
                <>
                  <button className="chip danger" onClick={() => void limparTudo()}>
                    Apagar tudo mesmo
                  </button>
                  <button className="chip subtle" onClick={() => setConfirmandoLimpeza(false)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  className="chip subtle"
                  onClick={() => setConfirmandoLimpeza(true)}
                  title="Apagar todo o histórico gravado"
                >
                  <Icon name="trash" size={13} />
                  Limpar
                </button>
              ))}
            <button
              className="stats-close"
              onClick={onClose}
              title="Fechar (Esc)"
              aria-label="Fechar histórico"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>

        {erro && <div className="history-erro">{erro}</div>}

        <div className="history-body">
          <div className="history-list">
            <div className="history-search">
              <Icon name="search" size={13} />
              <input
                autoFocus
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por pasta, projeto ou comando..."
                aria-label="Buscar no histórico"
              />
            </div>

            {carregando && lista.length === 0 && (
              <p className="stats-empty">Lendo o histórico...</p>
            )}

            {!carregando && lista.length === 0 && (
              <p className="stats-empty">
                Nada gravado ainda. A partir de agora, tudo que passar por um terminal do JARVIS
                fica salvo aqui — inclusive as conversas com agentes.
              </p>
            )}

            {lista.length > 0 && filtrada.length === 0 && (
              <p className="stats-empty">Nenhuma sessão casa com “{busca}”.</p>
            )}

            {grupos.map((g) => (
              <div key={g.label} className="history-group">
                <div className="history-group-label">{g.label}</div>
                {g.items.map((m) => (
                  <button
                    key={m.id}
                    className={`history-item ${m.id === selecionada ? "active" : ""}`}
                    onClick={() => setSelecionada(m.id)}
                    title={m.cwd}
                  >
                    <span className="history-item-top">
                      <span className="history-item-title">{sessionLabel(m)}</span>
                      <span className="history-item-time">{formatTime(m.startedAt)}</span>
                    </span>
                    <span className="history-item-sub">
                      {m.workspaceName ? `${m.workspaceName} · ` : ""}
                      {programName(m.program)}
                      {m.autoCommand ? ` · ${m.autoCommand}` : ""}
                      {" · "}
                      {formatBytes(m.bytes)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="history-preview">
            {atual ? (
              <>
                <div className="history-preview-header">
                  <div className="history-preview-meta">
                    <span className="history-preview-title" title={atual.cwd}>
                      {shortenPath(atual.cwd)}
                    </span>
                    <span className="history-preview-sub">
                      {formatTime(atual.startedAt)}
                      {sessionDuration(atual) ? ` · ${sessionDuration(atual)}` : " · em aberto"}
                      {atual.exitCode !== null ? ` · saiu com ${atual.exitCode}` : ""}
                      {" · "}
                      {formatBytes(atual.bytes)}
                    </span>
                    {procurandoConversa && (
                      <span className="history-retomada procurando">
                        Procurando a conversa do agente...
                      </span>
                    )}
                    {retomada && (
                      <span
                        className={`history-retomada ${retomada.exact ? "exata" : ""}`}
                        title={
                          aindaAberta
                            ? "Esta conversa continua rodando numa aba aberta."
                            : explicaRetomada(retomada)
                        }
                      >
                        <Icon name="agent" size={12} />
                        {retomada.label}
                        {retomada.title ? ` · ${retomada.title}` : ""}
                        {aindaAberta
                          ? " · ainda aberta numa aba"
                          : !retomada.exact && " · pela pasta e horário"}
                      </span>
                    )}
                  </div>
                  <div className="history-preview-actions">
                    {podeRetomar ? (
                      <>
                        <button
                          className="chip primary"
                          onClick={() => onReopen(atual, retomada)}
                          title={explicaRetomada(retomada)}
                        >
                          <Icon name="terminal" size={13} />
                          Continuar conversa
                        </button>
                        <button
                          className="chip subtle"
                          onClick={() => onReopen(atual, null)}
                          title="Abrir um terminal novo na mesma pasta, sem retomar a conversa"
                        >
                          Abrir limpo
                        </button>
                      </>
                    ) : (
                      <button
                        className="chip"
                        onClick={() => onReopen(atual)}
                        title="Abrir um terminal novo na mesma pasta, com o mesmo shell e comando"
                      >
                        <Icon name="terminal" size={13} />
                        Reabrir terminal
                      </button>
                    )}
                    <button
                      className="chip subtle"
                      onClick={() => void apagar(atual.id)}
                      title="Apagar esta gravação"
                      aria-label="Apagar esta gravação"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
                <TranscriptReplay id={atual.id} />
              </>
            ) : (
              <p className="stats-empty">Escolha uma sessão à esquerda para reler.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- reprodução do conteúdo ----------------------- */

/**
 * Reescreve os bytes gravados num xterm somente-leitura.
 *
 * Recriado a cada sessão escolhida em vez de reaproveitado com `clear()`: o
 * `clear` do xterm apaga o texto mas não devolve o terminal ao estado
 * inicial — modos de cursor, região de rolagem e cores de fundo deixados por
 * uma TUI da sessão anterior vazariam para a próxima reprodução.
 */
function TranscriptReplay({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [falha, setFalha] = useState<string | null>(null);
  const [buscaTermo, setBuscaTermo] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let descartado = false;
    setAviso(null);
    setFalha(null);
    setBuscaTermo("");

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      // Sem cursor nem entrada: esta sessão acabou, e um cursor piscando
      // convidaria a digitar num terminal que não tem ninguém do outro lado.
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      allowProposedApi: true,
      // Bem mais fundo que o do terminal ao vivo: aqui o ponto é justamente
      // poder rolar de volta até o começo da conversa.
      scrollback: 100_000,
      theme: theme.xterm,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    const ajusta = () => {
      if (descartado || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      const proposto = fit.proposeDimensions();
      if (!proposto?.cols || !proposto?.rows) return;
      fit.fit();
    };

    void transcriptRead(id)
      .then((dados) => {
        if (descartado) return;
        ajusta();
        term.write(b64ToBytes(dados.b64), () => {
          if (descartado) return;
          // Depois de escrever tudo, o interessante é o fim — é lá que a
          // sessão parou.
          term.scrollToBottom();
        });
        if (dados.truncated) {
          setAviso(
            `Gravação longa (${formatBytes(dados.totalBytes)}): mostrando só o trecho final.`,
          );
        }
      })
      .catch((e) => {
        if (!descartado) setFalha(String(e));
      });

    const ro = new ResizeObserver(ajusta);
    ro.observe(host);

    return () => {
      descartado = true;
      ro.disconnect();
      searchRef.current = null;
      // Mesmo adiamento do `TerminalView`: o `Viewport` do xterm agenda um
      // `setTimeout` no próprio construtor e não guarda o handle; descartar
      // no mesmo tick faz esse timer acordar contra um terminal já zerado.
      setTimeout(() => term.dispose(), 0);
    };
  }, [id]);

  return (
    <div className="history-replay">
      <div className="history-replay-bar">
        <div className="history-search history-replay-search">
          <Icon name="search" size={13} />
          <input
            value={buscaTermo}
            placeholder="Buscar nesta conversa..."
            aria-label="Buscar no conteúdo da sessão"
            onChange={(e) => {
              setBuscaTermo(e.target.value);
              if (e.target.value) {
                searchRef.current?.findNext(e.target.value, { incremental: true });
              } else {
                searchRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !buscaTermo) return;
              e.preventDefault();
              if (e.shiftKey) searchRef.current?.findPrevious(buscaTermo);
              else searchRef.current?.findNext(buscaTermo);
            }}
          />
        </div>
        {aviso && <span className="history-replay-aviso">{aviso}</span>}
      </div>
      {falha && <div className="history-erro">Não consegui ler a gravação: {falha}</div>}
      <div className="history-replay-host" ref={hostRef} />
    </div>
  );
}
