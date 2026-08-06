/**
 * Dashboard de uso (Ctrl+Shift+S).
 *
 * Os números saem dos contadores que o motor de PTY já mantém — nada é
 * instrumentado a mais para esta tela existir.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";

import {
  claudeUsageByAccount,
  claudeUsageSummary,
  type ClaudeAccountUsage,
  type ClaudeUsageSummary,
  type SessionInfo,
} from "../lib/ipc";
import { useAccountStore } from "../stores/accountStore";
import { computeStats, formatBytes, formatDuration } from "../lib/stats";
import { ClaudeConfigForm } from "./ClaudeConfigForm";

/** Câmbio aproximado só pra dar uma ordem de grandeza em reais — não é cotação ao vivo. */
const USD_TO_BRL_APROX = 5.4;

function formatUsd(v: number): string {
  return `US$ ${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatBrl(v: number): string {
  return `R$ ${(v * USD_TO_BRL_APROX).toFixed(v < 1 ? 3 : 2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  open: boolean;
  sessions: SessionInfo[];
  onClose: () => void;
}

export function StatsPanel({ open, sessions, onClose }: Props) {
  // O tempo ativo precisa andar sozinho; sem este tique o painel mostraria
  // o mesmo "3min" enquanto estivesse aberto.
  // O componente fica montado o tempo todo (só o `open` controla a
  // renderização); sem realinhar no instante da abertura, `agora` ficava
  // travado no valor da primeira montagem do app até o primeiro tique do
  // intervalo — o painel abria mostrando até 1s de tempo defasado, às vezes
  // arredondando um terminal recém-aberto para "0s" incorretamente cedo.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setAgora(Date.now());
    const t = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // Recebe o foco ao abrir, senão o Esc dependeria do foco estar em algum
  // lugar que não fosse o terminal por baixo.
  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) caixaRef.current?.focus();
  }, [open]);

  const stats = useMemo(() => computeStats(sessions, agora), [sessions, agora]);

  /* --------------------------- uso do Claude Code ------------------------ */
  const [claude, setClaude] = useState<ClaudeUsageSummary | null>(null);
  const [claudeErro, setClaudeErro] = useState<string | null>(null);

  // Ignora uma resposta que chegue depois de outra mais nova (painel fechado
  // e reaberto rápido o bastante pra dois `claudeUsageSummary()` se
  // sobreporem) — sem isto a resposta velha podia sobrescrever o formulário
  // com valores desatualizados por cima do que o usuário já estava vendo.
  const requisicaoRef = useRef(0);

  /**
   * Uso por conta. Com contas cadastradas, o total de "uma conta só" não
   * significa nada — o que a pessoa precisa saber, antes de trocar, é qual
   * das contas ainda tem folga na janela de 5h.
   */
  const contas = useAccountStore((s) => s.contas);
  const statusContas = useAccountStore((s) => s.status);
  const [porConta, setPorConta] = useState<ClaudeAccountUsage[]>([]);

  /**
   * Qual pasta de configuração o formulário de modelo/esforço lê e escreve.
   * Com contas, a conta padrão; sem elas, `undefined` = o `~/.claude` de
   * sempre. Escrever sempre no principal faria o ajuste "não pegar" nos
   * terminais que rodam numa conta — sem nenhum sinal de que foi ignorado.
   */
  const padraoId = useAccountStore((s) => s.padraoId);
  const dirDoFormulario = padraoId ? statusContas[padraoId]?.configDir : undefined;

  const carregarClaude = useCallback(() => {
    const minha = ++requisicaoRef.current;

    const pares = contas
      .map((c) => [c.id, statusContas[c.id]?.configDir] as const)
      .filter((p): p is readonly [string, string] => !!p[1]);
    if (pares.length > 0) {
      void claudeUsageByAccount(pares.map(([id, dir]) => [id, dir]))
        .then((lista) => {
          if (requisicaoRef.current === minha) setPorConta(lista);
        })
        .catch(() => {});
    } else {
      setPorConta([]);
    }

    void claudeUsageSummary(dirDoFormulario)
      .then((s) => {
        if (requisicaoRef.current !== minha) return;
        setClaude(s);
        setClaudeErro(null);
      })
      .catch((e) => {
        if (requisicaoRef.current !== minha) return;
        setClaudeErro(String(e));
      });
  }, [contas, statusContas, dirDoFormulario]);

  useEffect(() => {
    if (open) carregarClaude();
  }, [open, carregarClaude]);
  // A barra tem que medir a mesma coisa que o número ao lado dela (bytes),
  // não a contagem de sessões: com uma sessão por shell — o caso comum —
  // `sessions / maiorUso` dava 100% para todo mundo, e a barra virava um
  // enfeite sem relação com o "1.2 KB" escrito do lado.
  const maiorUso = Math.max(0, ...stats.byShell.map((g) => g.bytesOut));

  if (!open) return null;

  return (
    <div className="stats-backdrop" onMouseDown={onClose}>
      <div
        className="stats"
        role="dialog"
        aria-modal="true"
        aria-label="Estatísticas de uso"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>(".stats-close")?.focus();
        }}
      >
        <div className="stats-header">
          <span>Estatísticas de uso</span>
          <button
            className="stats-close"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar estatísticas"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="stats-grid">
          <Cartao rotulo="Terminais abertos" valor={String(stats.aliveSessions)} />
          <Cartao
            rotulo="Terminais encerrados"
            valor={String(stats.totalSessions - stats.aliveSessions)}
          />
          <Cartao rotulo="Recebido dos shells" valor={formatBytes(stats.bytesOut)} />
          <Cartao rotulo="Digitado por você" valor={formatBytes(stats.bytesIn)} />
          <Cartao rotulo="Aberto há mais tempo" valor={formatDuration(stats.longestUptimeMs)} />
        </div>

        <div className="stats-section">
          <h3>Uso por shell</h3>
          {stats.byShell.length === 0 && (
            <p className="stats-empty">Nenhum terminal aberto ainda.</p>
          )}
          {stats.byShell.map((g) => (
            <div key={g.label} className="stats-bar-row">
              <span className="stats-bar-label" title={g.label}>
                {g.label}
              </span>
              <div className="stats-bar-track">
                <div
                  className="stats-bar-fill"
                  style={{ width: `${maiorUso ? (g.bytesOut / maiorUso) * 100 : 0}%` }}
                />
              </div>
              <span className="stats-bar-value">
                {g.sessions}× · {formatBytes(g.bytesOut)}
              </span>
            </div>
          ))}
        </div>

        {porConta.length > 0 && (
          <div className="stats-section">
            <h3>Uso por conta do Claude Code</h3>
            <div className="stats-contas">
              {porConta.map((u) => {
                const conta = contas.find((c) => c.id === u.accountId);
                if (!conta) return null;
                return (
                  <div key={u.accountId} className="stats-conta">
                    <span className="stats-conta-nome">
                      <span className="accounts-dot" style={{ background: conta.color }} />
                      {conta.name}
                    </span>
                    {u.summary.noData ? (
                      <span className="stats-conta-vazia">sem uso registrado</span>
                    ) : (
                      <>
                        <span className="stats-conta-valor">
                          {formatTokens(u.summary.tokensLast5h)}
                          <small>tokens em 5h</small>
                        </span>
                        <span className="stats-conta-valor">
                          {formatTokens(u.summary.tokensLast24h)}
                          <small>em 24h</small>
                        </span>
                        <span className="stats-conta-valor">
                          {formatUsd(u.summary.costLast5hUsd)}
                          <small>custo em 5h</small>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="stats-note stats-note-tight">
              A janela de 5h é a aproximação mais próxima do limite da Anthropic que dá para
              calcular só com o que fica gravado no disco — não é o contador oficial, e sim o
              volume que cada conta consumiu no período.
            </p>
          </div>
        )}

        <div className="stats-section">
          <h3>{porConta.length > 0 ? "Configuração do Claude Code" : "Claude Code"}</h3>

          {claudeErro && <p className="stats-empty">Não foi possível ler o uso local: {claudeErro}</p>}

          {!claudeErro && claude?.noData && (
            <p className="stats-empty">
              Nenhum histórico do Claude Code encontrado em <code>~/.claude/projects</code>.
            </p>
          )}

          {!claudeErro && claude && !claude.noData && (
            <>
              <div className="stats-grid">
                <Cartao rotulo="Tokens (últimas 5h)" valor={formatTokens(claude.tokensLast5h)} />
                <Cartao rotulo="Tokens (24h)" valor={formatTokens(claude.tokensLast24h)} />
                <Cartao rotulo="Custo estimado (5h)" valor={formatUsd(claude.costLast5hUsd)} />
                <Cartao
                  rotulo="Custo estimado (total)"
                  valor={`${formatUsd(claude.costTotalUsd)} · ${formatBrl(claude.costTotalUsd)}`}
                />
              </div>

              {claude.byModel.length > 0 && (
                <div className="stats-claude-models">
                  {claude.byModel.map((m) => (
                    <div key={m.model} className="stats-bar-row">
                      <span className="stats-bar-label" title={m.model}>
                        {m.model}
                      </span>
                      <span className="stats-bar-value">
                        {formatTokens(m.inputTokens + m.outputTokens)} tok · {formatUsd(m.costUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p className="stats-note stats-note-tight">
                Custo é uma ESTIMATIVA nossa (tokens × tabela de preço pública por modelo) — não é
                um extrato oficial da Anthropic, e o câmbio em reais é aproximado.
              </p>
            </>
          )}

          <ClaudeConfigForm configDir={dirDoFormulario} onSaved={carregarClaude} />
          <p className="stats-note stats-note-tight">
            Grava direto em <code>~/.claude/settings.json</code> — vale para a próxima vez que a
            CLI <code>claude</code> for iniciada num terminal.
          </p>
        </div>

        <p className="stats-note">
          Os contadores valem para esta execução do JARVIS — eles zeram quando o aplicativo
          é fechado.
        </p>
      </div>
    </div>
  );
}

function Cartao({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="stats-card">
      <span className="stats-card-value">{valor}</span>
      <span className="stats-card-label">{rotulo}</span>
    </div>
  );
}
