/**
 * Contas do Claude Code (paleta → "Contas do Claude Code").
 *
 * Cada conta é uma pasta de configuração isolada; o terminal que a usa nasce
 * com `CLAUDE_CONFIG_DIR` apontando para lá. O painel existe para tornar isso
 * visível: qual conta está logada, em qual plano, e qual delas os terminais
 * novos vão usar — sem isso, "trocar de conta" seria uma configuração
 * invisível que ninguém consegue conferir.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { useAccountStore } from "../stores/accountStore";
import { rotuloDeStatus, tokenVencido } from "../lib/claudeAccounts";
import type { ClaudeAccountPayload } from "../lib/ipc";

interface Props {
  /** Abre um terminal já na conta, com `claude` rodando, para o `/login`. */
  onEntrar: (conta: ClaudeAccountPayload) => void;
}

export function AccountsPanel({ onEntrar }: Props) {
  const aberto = useAccountStore((s) => s.painelAberto);
  const fechar = useAccountStore((s) => s.fecharPainel);
  const contas = useAccountStore((s) => s.contas);
  const status = useAccountStore((s) => s.status);
  const padraoId = useAccountStore((s) => s.padraoId);
  const temLoginPadrao = useAccountStore((s) => s.temLoginPadrao);
  const carregando = useAccountStore((s) => s.carregando);
  const erro = useAccountStore((s) => s.erro);
  const criar = useAccountStore((s) => s.criar);
  const renomear = useAccountStore((s) => s.renomear);
  const definirPadrao = useAccountStore((s) => s.definirPadrao);
  const importar = useAccountStore((s) => s.importarLoginAtual);
  const sair = useAccountStore((s) => s.sair);
  const remover = useAccountStore((s) => s.remover);

  const [renomeandoId, setRenomeandoId] = useState<string | null>(null);
  /** Confirmação de remoção em dois passos, como na barra de workspaces. */
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);

  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (aberto) caixaRef.current?.focus();
  }, [aberto]);

  if (!aberto) return null;

  const agora = Date.now();

  return (
    <div className="stats-backdrop" onMouseDown={fechar}>
      <div
        className="stats accounts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Contas do Claude Code"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span>Contas do Claude Code</span>
          <button
            className="stats-close"
            onClick={fechar}
            title="Fechar (Esc)"
            aria-label="Fechar contas"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {erro && <div className="update-panel-erro accounts-erro">{erro}</div>}

        {contas.length === 0 && (
          <p className="stats-empty accounts-vazio">
            Nenhuma conta cadastrada. Os terminais usam o login normal do Claude Code
            (<code>~/.claude</code>). Crie uma conta para poder alternar entre logins sem
            precisar sair e entrar de novo a cada vez.
          </p>
        )}

        <ul className="accounts-lista">
          {contas.map((c) => {
            const st = status[c.id];
            const ehPadrao = c.id === padraoId;
            const logada = !!st?.loggedIn;
            const vencido = tokenVencido(st, agora);

            return (
              <li key={c.id} className="accounts-item">
                <span className="accounts-dot" style={{ background: c.color }} />

                <div className="accounts-info">
                  {renomeandoId === c.id ? (
                    <input
                      className="tab-rename accounts-rename"
                      autoFocus
                      defaultValue={c.name}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => {
                        renomear(c.id, e.currentTarget.value);
                        setRenomeandoId(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          renomear(c.id, e.currentTarget.value);
                          setRenomeandoId(null);
                        }
                        if (e.key === "Escape") setRenomeandoId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="accounts-nome"
                      onDoubleClick={() => setRenomeandoId(c.id)}
                      onClick={() => setRenomeandoId(c.id)}
                      title="Clique para renomear"
                    >
                      {c.name}
                      {ehPadrao && <span className="accounts-tag">padrão</span>}
                    </button>
                  )}

                  <span className={`accounts-estado ${logada ? "ok" : "pendente"}`}>
                    {rotuloDeStatus(st)}
                    {vencido && " · vai renovar no próximo uso"}
                  </span>
                </div>

                <div className="accounts-acoes">
                  {!logada && (
                    <>
                      <button className="chip" onClick={() => onEntrar(c)}>
                        <Icon name="terminal" size={13} />
                        Entrar
                      </button>
                      {temLoginPadrao && (
                        <button
                          className="chip subtle"
                          disabled={carregando}
                          onClick={() => void importar(c.id)}
                          title="Copia o login que já existe em ~/.claude para esta conta"
                        >
                          Usar o login atual
                        </button>
                      )}
                    </>
                  )}

                  {logada && !ehPadrao && (
                    <button className="chip subtle" onClick={() => definirPadrao(c.id)}>
                      Tornar padrão
                    </button>
                  )}

                  {logada && (
                    <button
                      className="chip subtle"
                      onClick={() => void sair(c.id)}
                      title="Apaga só as credenciais desta conta"
                    >
                      Sair
                    </button>
                  )}

                  {confirmandoId === c.id ? (
                    <>
                      <button className="chip danger" onClick={() => void remover(c.id)}>
                        Apagar mesmo
                      </button>
                      <button className="chip subtle" onClick={() => setConfirmandoId(null)}>
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <button
                      className="topbar-btn"
                      onClick={() => setConfirmandoId(c.id)}
                      title="Remover a conta e apagar a pasta dela"
                      aria-label={`Remover ${c.name}`}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="update-panel-acoes">
          <button className="chip" disabled={carregando} onClick={() => void criar()}>
            <Icon name="plus" size={13} />
            Nova conta
          </button>
        </div>

        <p className="stats-note">
          Cada conta tem sua própria pasta de configuração — login, preferências e histórico são
          separados. Terminais abertos continuam na conta em que nasceram; a troca vale para os
          próximos. Um projeto pode fixar sua conta pela paleta de comandos.
        </p>
      </div>
    </div>
  );
}
