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
  claudeUsageLive,
  claudeUsageLiveByAccount,
  claudeUsageSummary,
  type ClaudeAccountLiveUsage,
  type ClaudeAccountUsage,
  type ClaudeLiveUsage,
  type ClaudeUsageSummary,
  type ClaudeWindowUsage,
  type SessionInfo,
} from "../lib/ipc";
import { useAccountStore } from "../stores/accountStore";
import {
  computeStats,
  estadoCota,
  formatBytes,
  formatCountdown,
  formatDuration,
  formatFaltaSegundos,
  formatResetAbsoluto,
  pctDeUso,
  tomCota,
} from "../lib/stats";
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

function horaDe(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
  /** Consulta em andamento: gira o ícone de atualizar e segura o "atualizado às". */
  const [claudeCarregando, setClaudeCarregando] = useState(false);
  /** Quando a última consulta terminou, para o "atualizado às HH:MM:SS". */
  const [atualizadoEm, setAtualizadoEm] = useState<number | null>(null);

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
  /** Cota real (API da Anthropic) da configuração do formulário. */
  const [live, setLive] = useState<ClaudeLiveUsage | null>(null);
  /** Cota real por conta, alinhada a `porConta`. */
  const [livePorConta, setLivePorConta] = useState<ClaudeAccountLiveUsage[]>([]);

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
    setClaudeCarregando(true);

    // Cada consulta é independente e o `agora` do painel não depende delas;
    // o "carregando" e o "atualizado às" esperam a última terminar, seja
    // qual for. Sem a contagem, uma resposta rápida apagaria o carregando
    // enquanto a consulta lenta (a varredura local) ainda roda.
    let pendentes = 0;
    const abreUma = () => {
      pendentes++;
      return () => {
        pendentes--;
        if (pendentes === 0 && requisicaoRef.current === minha) {
          setClaudeCarregando(false);
          setAtualizadoEm(Date.now());
        }
      };
    };

    const pares = contas
      .map((c) => [c.id, statusContas[c.id]?.configDir] as const)
      .filter((p): p is readonly [string, string] => !!p[1]);
    if (pares.length > 0) {
      const fimA = abreUma();
      void claudeUsageByAccount(pares.map(([id, dir]) => [id, dir]))
        .then((lista) => {
          if (requisicaoRef.current === minha) setPorConta(lista);
        })
        .catch(() => {})
        .finally(fimA);
      // Cota real por conta: roda junto com a varredura local, com a mesma
      // proteção contra resposta fora de ordem.
      const fimB = abreUma();
      void claudeUsageLiveByAccount(pares.map(([id, dir]) => [id, dir]))
        .then((lista) => {
          if (requisicaoRef.current === minha) setLivePorConta(lista);
        })
        .catch(() => {})
        .finally(fimB);
    } else {
      setPorConta([]);
      setLivePorConta([]);
    }

    const fimC = abreUma();
    void claudeUsageSummary(dirDoFormulario)
      .then((s) => {
        if (requisicaoRef.current !== minha) return;
        setClaude(s);
        setClaudeErro(null);
      })
      .catch((e) => {
        if (requisicaoRef.current !== minha) return;
        setClaudeErro(String(e));
      })
      .finally(fimC);

    const fimD = abreUma();
    void claudeUsageLive(dirDoFormulario)
      .then((u) => {
        if (requisicaoRef.current === minha) setLive(u);
      })
      .catch(() => {})
      .finally(fimD);
  }, [contas, statusContas, dirDoFormulario]);

  useEffect(() => {
    if (open) carregarClaude();
  }, [open, carregarClaude]);
  // A barra tem que medir a mesma coisa que o número ao lado dela (bytes),
  // não a contagem de sessões: com uma sessão por shell — o caso comum —
  // `sessions / maiorUso` dava 100% para todo mundo, e a barra virava um
  // enfeite sem relação com o "1.2 KB" escrito do lado.
  const maiorUso = Math.max(0, ...stats.byShell.map((g) => g.bytesOut));

  // O estado da cota da janela de 5h comanda o cartão em destaque; calculado
  // uma vez em vez de duas dentro do JSX.
  const heroEstado = live?.fiveHour ? estadoCota(live.fiveHour.utilizationPct) : null;

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

        <div className="stats-section">
          <div className="stats-section-head">
            <h3>Uso do Claude Code</h3>
            <span
              className={`stats-live-badge ${live?.available ? "" : "sem-ao-vivo"}`}
              title={
                live?.available
                  ? "Percentuais consultados na Anthropic com o login local do Claude Code — a mesma fonte do /usage da CLI."
                  : "Sem cota ao vivo — mostrando a estimativa local do histórico."
              }
            >
              <span className="stats-live-dot" />
              {live?.available
                ? "Ao vivo"
                : // Antes da primeira resposta o badge não pode apostar em
                  // "Estimativa local" — a consulta à Anthropic ainda está no ar.
                  live === null && claudeCarregando
                  ? "Consultando…"
                  : "Estimativa local"}
            </span>
            {atualizadoEm && (
              <span className="stats-atualizado">atualizado às {horaDe(atualizadoEm)}</span>
            )}
            <button
              className="chip subtle stats-refresh"
              onClick={() => void carregarClaude()}
              disabled={claudeCarregando}
              title="Consultar a cota na Anthropic de novo"
              aria-label="Atualizar cota do Claude Code"
            >
              <Icon
                name="refresh"
                size={12}
                className={claudeCarregando ? "stats-refresh-spin" : undefined}
              />
              Atualizar
            </button>
          </div>

          {claudeCarregando && !live && !claude && (
            <p className="stats-empty">Consultando a cota na Anthropic…</p>
          )}

          {live?.available && (
            <div className="stats-hero">
              <div className="stats-hero-head">
                <span className="stats-hero-title">Sua cota</span>
                {heroEstado && (
                  <span className={`stats-chip-estado tom-${heroEstado.tom}`}>
                    {heroEstado.rotulo}
                  </span>
                )}
              </div>
              <JanelaGrande rotulo="Janela de 5 horas" janela={live.fiveHour} agora={agora} />
              <JanelaGrande rotulo="Janela de 7 dias" janela={live.sevenDay} agora={agora} />
              {live.extraUsage?.isEnabled && live.extraUsage.monthlyLimit ? (
                <div className="stats-creditos">
                  <div className="stats-creditos-top">
                    <span>Créditos extras · mês</span>
                    <span>
                      {formatUsd(live.extraUsage.usedCredits ?? 0)} de{" "}
                      {formatUsd(live.extraUsage.monthlyLimit)}
                    </span>
                  </div>
                  <div className="stats-janela-track">
                    <div
                      className="stats-janela-fill fill-atencao"
                      style={{
                        width: `${pctDeUso(live.extraUsage.usedCredits ?? 0, live.extraUsage.monthlyLimit)}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {live && !live.available && live.error && (
            <div className="stats-live-erro">
              <Icon name="warning" size={14} />
              <span>{live.error} — os números abaixo são a estimativa local.</span>
            </div>
          )}

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

        {porConta.length > 0 && (
          <div className="stats-section">
            <h3>Uso por conta do Claude Code</h3>
            <div className="stats-contas">
              {porConta.map((u) => {
                const conta = contas.find((c) => c.id === u.accountId);
                if (!conta) return null;
                const status = statusContas[u.accountId];
                const liveC = livePorConta.find((l) => l.accountId === u.accountId)?.usage ?? null;
                // O tom do cartão segue a pior das duas janelas: uma conta em
                // 40% na janela de 7 dias mas 95% na de 5h não pode parecer
                // tranquila.
                const pior = [liveC?.fiveHour, liveC?.sevenDay]
                  .filter((w): w is ClaudeWindowUsage => !!w)
                  .reduce<ClaudeWindowUsage | null>(
                    (a, b) => (b.utilizationPct > (a?.utilizationPct ?? -1) ? b : a),
                    null,
                  );
                const tom = pior ? tomCota(pior.utilizationPct) : null;
                // Sem resposta ainda (liveC nulo) o cartão não aposta em
                // "Sessão expirada": falta de dado não é falha.
                const pill =
                  liveC === null
                    ? null
                    : !status?.loggedIn
                      ? { cls: "muted", txt: "Sem login" }
                      : liveC.available
                        ? { cls: "ok", txt: "Ao vivo" }
                        : { cls: "danger", txt: "Sessão expirada" };
                return (
                  <div
                    key={u.accountId}
                    className={`stats-conta ${tom === "alta" ? "stats-conta-alta" : ""}`}
                  >
                    <div className="stats-conta-top">
                      <span className="stats-conta-nome">
                        <span className="accounts-dot" style={{ background: conta.color }} />
                        {conta.name}
                      </span>
                      {status?.subscriptionType && (
                        <span className="stats-conta-plano">{status.subscriptionType}</span>
                      )}
                      {pill && (
                        <span className={`stats-pill stats-pill-${pill.cls}`}>{pill.txt}</span>
                      )}
                    </div>

                    {liveC?.available && (
                      <div className="stats-conta-cota">
                        <MiniJanela rotulo="Janela de 5h" janela={liveC.fiveHour} agora={agora} />
                        <MiniJanela rotulo="Janela de 7 dias" janela={liveC.sevenDay} agora={agora} />
                      </div>
                    )}
                    {liveC && !liveC.available && liveC.error && (
                      <span className="stats-conta-vazia" title={liveC.error}>
                        cota ao vivo indisponível —{" "}
                        {status?.loggedIn
                          ? "sessão expirada (rode /login nesta conta)"
                          : "sem login salvo"}
                      </span>
                    )}

                    {u.summary.noData ? (
                      <span className="stats-conta-vazia">sem uso registrado</span>
                    ) : (
                      <div className="stats-conta-metricas">
                        <span className="stats-conta-metrica">
                          {formatTokens(u.summary.tokensLast5h)}
                          <small>tokens · 5h</small>
                        </span>
                        <span className="stats-conta-metrica">
                          {formatTokens(u.summary.tokensLast24h)}
                          <small>tokens · 24h</small>
                        </span>
                        <span className="stats-conta-metrica">
                          {formatUsd(u.summary.costLast5hUsd)}
                          <small>custo · 5h (est.)</small>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="stats-note stats-note-tight">
              Com login, o percentual acima vem da própria Anthropic — a mesma fonte do{" "}
              <code>/usage</code> da CLI. Tokens e custo continuam sendo estimados do histórico
              local e não são o contador oficial.
            </p>
          </div>
        )}

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

/**
 * Janela de cota em destaque, com contagem regressiva em segundos: o relógio
 * anda enquanto o painel está aberto. O horário absoluto do reset fica ao
 * lado do countdown — um diz quanto falta, o outro diz quando.
 */
function JanelaGrande({
  rotulo,
  janela,
  agora,
}: {
  rotulo: string;
  janela: ClaudeWindowUsage | null;
  agora: number;
}) {
  if (!janela) return null;
  const est = estadoCota(janela.utilizationPct);
  const pctCls = est.tom === "alta" ? "pct-alta" : est.tom === "atencao" ? "pct-atencao" : "";
  return (
    <div className="stats-janela">
      <div className="stats-janela-top">
        <span className="stats-janela-rotulo">{rotulo}</span>
        <span className={`stats-janela-pct ${pctCls}`}>{janela.utilizationPct.toFixed(0)}%</span>
      </div>
      <div className="stats-janela-track">
        <div
          className={`stats-janela-fill ${
            est.tom === "alta" ? "fill-alta" : est.tom === "atencao" ? "fill-atencao" : ""
          }`}
          style={{ width: `${Math.min(100, janela.utilizationPct)}%` }}
        />
      </div>
      <span className="stats-janela-reset">
        reseta em <strong>{formatFaltaSegundos(janela.resetsAtMs, agora)}</strong>
        <span className="stats-janela-reset-abs">
          {" "}
          · {formatResetAbsoluto(janela.resetsAtMs, agora)}
        </span>
      </span>
    </div>
  );
}

/**
 * Janela compacta para os cartões de conta: a mesma informação do hero, no
 * espaço de meia linha.
 */
function MiniJanela({
  rotulo,
  janela,
  agora,
}: {
  rotulo: string;
  janela: ClaudeWindowUsage | null;
  agora: number;
}) {
  if (!janela) return null;
  const tom = tomCota(janela.utilizationPct);
  const pctCls = tom === "alta" ? "pct-alta" : tom === "atencao" ? "pct-atencao" : "";
  return (
    <div className="stats-mini-janela">
      <div className="stats-mini-top">
        <span>{rotulo}</span>
        <span className={pctCls}>{janela.utilizationPct.toFixed(0)}%</span>
      </div>
      <div className="stats-janela-track">
        <div
          className={`stats-janela-fill ${
            tom === "alta" ? "fill-alta" : tom === "atencao" ? "fill-atencao" : ""
          }`}
          style={{ width: `${Math.min(100, janela.utilizationPct)}%` }}
        />
      </div>
      <span className="stats-mini-reset">
        {formatCountdown(janela.resetsAtMs, agora)} · {formatResetAbsoluto(janela.resetsAtMs, agora)}
      </span>
    </div>
  );
}
