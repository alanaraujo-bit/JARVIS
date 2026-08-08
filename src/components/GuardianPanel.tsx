/**
 * Painel do guardião 24/7 (menu lateral → "Guardião").
 *
 * É o espelho desktop do PWA do celular: mostra, para cada conta do Claude
 * Code, como está a janela de 5h/7d no guardião, quando ele vai agir e se os
 * pings estão funcionando — e dá os botões de administração que o celular
 * não tem: cadastrar a conta em um clique (as credenciais saem direto para o
 * guardião, criptografadas em repouso), pausar/retomar, pedir um ping na
 * hora e remover.
 *
 * O cadastro em um clique é o coração desta tela: sem ele, a pessoa teria
 * que abrir o terminal, copiar o `.credentials.json` e colar num curl. Aqui
 * o JARVIS lê a conta que ele mesmo administra e entrega ao guardião.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import {
  comparaContas,
  useGuardianStore,
  type GuardianConta,
} from "../stores/guardianStore";
import { useAccountStore } from "../stores/accountStore";
import type { ClaudeAccountPayload } from "../lib/ipc";

interface Props {
  /** Abre um terminal na conta, com `claude` rodando, para o `/login`. */
  onEntrar: (conta: ClaudeAccountPayload) => void;
}

/** "3h 04min", "42min", "agora" — o formato das contagens do painel. */
function formatarContagem(ms: number): string {
  if (ms <= 0) return "agora";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}min`;
}

/** "14:32" local. */
function formatarHora(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function GuardianPanel({ onEntrar }: Props) {
  const aberto = useGuardianStore((s) => s.painelAberto);
  const fechar = useGuardianStore((s) => s.fecharPainel);
  const configuracao = useGuardianStore((s) => s.configuracao);
  const status = useGuardianStore((s) => s.status);
  const carregando = useGuardianStore((s) => s.carregando);
  const erro = useGuardianStore((s) => s.erro);
  const salvarConfiguracao = useGuardianStore((s) => s.salvarConfiguracao);
  const atualizarStatus = useGuardianStore((s) => s.atualizarStatus);
  const registrarConta = useGuardianStore((s) => s.registrarConta);
  const removerConta = useGuardianStore((s) => s.removerConta);
  const alternarConta = useGuardianStore((s) => s.alternarConta);
  const pingarAgora = useGuardianStore((s) => s.pingarAgora);

  const contas = useAccountStore((s) => s.contas);
  const statusContas = useAccountStore((s) => s.status);

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  /** Marca o instante do último refresh para a legenda "atualizado às". */
  const [atualizadoEm, setAtualizadoEm] = useState<number | null>(null);
  const [agora, setAgora] = useState(() => Date.now());
  const caixaRef = useRef<HTMLDivElement | null>(null);

  // A cada segundo, o relógio interno anda — é ele que faz as contagens
  // ("reset em 42min") andarem sem precisar buscar status novo.
  useEffect(() => {
    if (!aberto) return;
    const t = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [aberto]);

  // Busca o status a cada 15s enquanto o painel está aberto: a janela de
  // 5h vive no servidor e muda por causa do próprio guardião (pings) e do
  // uso real das contas. O "atualizado às" anda junto com os dados.
  useEffect(() => {
    if (!aberto) return;
    const t = window.setInterval(() => {
      void atualizarStatus();
      setAtualizadoEm(Date.now());
    }, 15_000);
    return () => window.clearInterval(t);
  }, [aberto, atualizarStatus]);

  // Sincroniza os campos do formulário com o que está salvo.
  useEffect(() => {
    if (configuracao) {
      setUrl(configuracao.url);
      setToken(configuracao.token);
    }
  }, [configuracao, aberto]);

  useEffect(() => {
    if (aberto) caixaRef.current?.focus();
  }, [aberto]);

  if (!aberto) return null;

  const configurado = !!configuracao?.url && !!configuracao?.token;
  const porId = new Map(status?.contas.map((c) => [c.id, c]) ?? []);
  // Ordem inteligente (a mesma do celular): disponível agora primeiro,
  // liberando em seguida, travadas/pausadas por último.
  const contasOrdenadas = [...contas].sort((a, b) =>
    comparaContas(porId.get(a.id), porId.get(b.id)),
  );

  const salvar = async () => {
    const ok = await salvarConfiguracao({ url: url.trim(), token: token.trim() });
    if (ok) setAtualizadoEm(Date.now());
  };

  return (
    <div className="stats-backdrop" onMouseDown={fechar}>
      <div
        className="stats guardian-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Guardião — janelas de uso"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span className="guardian-titulo">
            <Icon name="shield" size={16} />
            Guardião · janelas de uso
          </span>
          <button
            className="stats-close"
            onClick={fechar}
            title="Fechar (Esc)"
            aria-label="Fechar o guardião"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {erro && <div className="update-panel-erro accounts-erro">{erro}</div>}

        {/* ------------------------- conexão ------------------------- */}
        <section className="guardian-secao">
          <div className="guardian-secao-head">
            <span className="guardian-secao-titulo">Conexão</span>
            {configurado && (
              <span className={`stats-chip-estado ${status ? "tom-ok" : ""}`}>
                {status ? "conectado" : "aguardando…"}
              </span>
            )}
          </div>

          <div className="guardian-form">
            <label className="guardian-campo">
              <span>URL do serviço</span>
              <input
                className="stats-claude-field guard-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://jarvis-guardian-production.up.railway.app"
                spellCheck={false}
              />
            </label>
            <label className="guardian-campo">
              <span>Token da API</span>
              <input
                className="stats-claude-field guard-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="cole o JARVIS_GUARDIAN_TOKEN"
                spellCheck={false}
              />
            </label>
            <div className="guardian-form-acoes">
              <button className="chip" disabled={carregando} onClick={() => void salvar()}>
                <Icon name="check" size={13} />
                Salvar e conectar
              </button>
              {configurado && (
                <button
                  className="chip subtle"
                  disabled={carregando}
                  onClick={() => {
                    void atualizarStatus();
                    setAtualizadoEm(Date.now());
                  }}
                  title="Buscar o estado mais recente das contas"
                >
                  <Icon name="refresh" size={13} />
                  Atualizar
                </button>
              )}
              {atualizadoEm && (
                <span className="guardian-atualizado">atualizado às {formatarHora(atualizadoEm)}</span>
              )}
            </div>
          </div>
        </section>

        {/* ------------------------- contas ------------------------- */}
        <section className="guardian-secao">
          <div className="guardian-secao-head">
            <span className="guardian-secao-titulo">Contas no guardião</span>
            {configurado && porId.size > 0 && (
              <span className="guardian-contagem">{porId.size} de {contas.length}</span>
            )}
          </div>

          {!configurado ? (
            <p className="guardian-vazio">
              Configure a URL e o token acima para ver as janelas de 5h/7d das
              contas e cadastrá-las no guardião. O token é o{" "}
              <code>JARVIS_GUARDIAN_TOKEN</code> do serviço.
            </p>
          ) : contas.length === 0 ? (
            <p className="guardian-vazio">
              Nenhuma conta do Claude Code cadastrada no JARVIS. Crie uma conta
              (menu Contas) e ela aparecerá aqui.
            </p>
          ) : (
            <ul className="guardian-lista">
              {contasOrdenadas.map((c) => {
                const g = porId.get(c.id);
                const st = statusContas[c.id];
                const logada = !!st?.loggedIn;
                return (
                  <li key={c.id} className="guardian-item">
                    <span className="guardian-item-cab">
                      <span className="accounts-dot" style={{ background: c.color }} />
                      <span className="guardian-item-nome">{c.name}</span>
                      {g && (
                        <span className="guardian-item-estado">{rotuloEstado(g, agora)}</span>
                      )}
                    </span>

                    {!g ? (
                      <div className="guardian-item-acoes">
                        <button
                          className="chip"
                          disabled={carregando || !logada}
                          onClick={() => void registrarConta(c.id, c.name)}
                          title={
                            logada
                              ? "Envia as credenciais da conta para o guardião"
                              : "Entre na conta primeiro (botão Entrar)"
                          }
                        >
                          <Icon name="plus" size={13} />
                          Cadastrar no guardião
                        </button>
                        {!logada && (
                          <button className="chip subtle" onClick={() => onEntrar(c)}>
                            <Icon name="terminal" size={13} />
                            Entrar
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="guardian-item-detalhes">
                          <Janela5h g={g} agora={agora} />
                          <Janela7d g={g} agora={agora} />
                          <span className="guardian-item-meta">
                            {metaDaConta(g, agora)}
                          </span>
                        </div>

                        <div className="guardian-item-acoes">
                          <button
                            className="chip subtle"
                            onClick={() => void alternarConta(c.id, !g.enabled)}
                            title={g.enabled ? "Pausa esta conta: o guardião para de pingar" : "Retoma os pings"}
                          >
                            <Icon name={g.enabled ? "stop" : "play"} size={12} />
                            {g.enabled ? "Pausar" : "Retomar"}
                          </button>
                          <button
                            className="chip subtle"
                            disabled={carregando}
                            onClick={() => void pingarAgora(c.id)}
                            title="Força um ping agora (útil para testar a conta)"
                          >
                            <Icon name="zap" size={13} />
                            Pingar agora
                          </button>
                          {confirmandoId === c.id ? (
                            <>
                              <button className="chip danger" onClick={() => void removerConta(c.id)}>
                                Remover mesmo
                              </button>
                              <button className="chip subtle" onClick={() => setConfirmandoId(null)}>
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <button
                              className="topbar-btn"
                              onClick={() => setConfirmandoId(c.id)}
                              title="Remove a conta do guardião (as credenciais dela são apagadas lá)"
                              aria-label={`Remover ${c.name} do guardião`}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="stats-note">
          O guardião mantém a janela de 5h de cada conta sempre rolando com pings de
          "oi" (modelo haiku, o mais barato) — assim, quando você for usar, já existe
          uso antigo prestes a expirar e a espera de reset cai de ~4h para minutos.
          Enquanto um terminal seu estiver aberto na conta, o JARVIS avisa o guardião
          e ele não interfere.
        </p>
      </div>
    </div>
  );
}

function rotuloEstado(g: GuardianConta, agora: number): string {
  const e = g.estado;
  if (e.leaseAtivo) return "em uso agora";
  if (!g.enabled) return "pausada";
  if (e.bloqueadaSemanal) return "travada no limite semanal";
  if (e.bloqueadaMensal) return "travada no limite mensal";
  const fh = e.cota?.fiveHour;
  if (!fh) return "classificando…";
  const pct = fh.utilization ?? 0;
  if (pct >= 100) return "janela 5h cheia";
  if (fh.resetsAtMs && fh.resetsAtMs > agora) {
    return "janela ativa · renova em " + formatarContagem(fh.resetsAtMs - agora);
  }
  return "janela vazia · pinga em breve";
}

function Janela5h({ g, agora }: { g: GuardianConta; agora: number }) {
  const fh = g.estado.cota?.fiveHour;
  if (!fh) return null;
  const pct = fh.utilization ?? 0;
  const cheia = pct >= 100;
  return (
    <span className={`guardian-metrica ${cheia ? "cheia" : pct >= 80 ? "atencao" : ""}`}>
      <span className="guardian-metrica-rotulo">5h</span>
      <span className="guardian-metrica-valor">{Math.round(pct)}%</span>
      <span className="guardian-metrica-sub">
        {cheia
          ? "cheia"
          : fh.resetsAtMs && fh.resetsAtMs > agora
            ? `reset ${formatarHora(fh.resetsAtMs)}`
            : "vazia"}
      </span>
    </span>
  );
}

function Janela7d({ g, agora }: { g: GuardianConta; agora: number }) {
  const sd = g.estado.cota?.sevenDay;
  if (!sd) return null;
  const pct = sd.utilization ?? 0;
  return (
    <span className={`guardian-metrica ${pct >= 100 ? "cheia" : pct >= 80 ? "atencao" : ""}`}>
      <span className="guardian-metrica-rotulo">7d</span>
      <span className="guardian-metrica-valor">{Math.round(pct)}%</span>
      <span className="guardian-metrica-sub">
        {pct >= 100 ? "no limite" : sd.resetsAtMs && sd.resetsAtMs > agora ? `reset ${formatarHora(sd.resetsAtMs)}` : ""}
      </span>
    </span>
  );
}

function metaDaConta(g: GuardianConta, agora: number): string {
  const e = g.estado;
  const partes: string[] = [];
  if (e.pingsOk + e.pingsFail > 0) {
    partes.push(`${e.pingsOk} ping${e.pingsOk === 1 ? "" : "s"} ok${e.pingsFail > 0 ? `, ${e.pingsFail} falha${e.pingsFail === 1 ? "" : "s"}` : ""}`);
  }
  if (e.ultimoPing) {
    partes.push(`último ping ${formatarHora(e.ultimoPing)}`);
  }
  if (e.ultimoPing && e.ultimoPingOk === false && e.ultimoPingErro) {
    partes.push(`erro: ${e.ultimoPingErro}`);
  }
  if (e.proximaAcaoEm) {
    if (e.proximaAcaoEm <= agora) partes.push("agindo agora…");
    else partes.push(`próxima ação às ${formatarHora(e.proximaAcaoEm)}`);
  }
  return partes.join(" · ");
}
