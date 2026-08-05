/**
 * Painel de atualizações (paleta de comandos → "Procurar atualizações").
 *
 * Existe pelo caso que o aviso flutuante não cobre: quem quer saber em que
 * versão está, quem dispensou o aviso e mudou de ideia, e quem tentou
 * atualizar e falhou — para esses, um aviso que some sozinho não serve. Aqui
 * a checagem é sob demanda e o resultado fica na tela, inclusive quando o
 * resultado é "já está tudo em dia".
 */

import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import { useUpdateStore } from "../stores/updateStore";
import { linhasDeNotas, pctBaixado } from "../lib/updateRules";
import { formatBytes } from "../lib/stats";

const PAGINA_RELEASES = "github.com/alanaraujo-bit/JARVIS/releases/latest";

function dataLegivel(iso: string | null): string | null {
  if (!iso) return null;
  // O manifesto do Tauri usa RFC 3339 com deslocamento (`2026-08-05
  // 12:00:00.000 +00:00:00`), que o `Date` do JS não aceita direto; o que
  // interessa na tela é o dia, então basta a parte da frente.
  const dia = iso.slice(0, 10);
  const m = dia.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export function UpdatePanel() {
  const aberto = useUpdateStore((s) => s.painelAberto);
  const fechar = useUpdateStore((s) => s.fecharPainel);
  const fase = useUpdateStore((s) => s.fase);
  const update = useUpdateStore((s) => s.update);
  const erro = useUpdateStore((s) => s.erro);
  const versaoAtual = useUpdateStore((s) => s.versaoAtual);
  const baixado = useUpdateStore((s) => s.baixado);
  const total = useUpdateStore((s) => s.total);
  const checar = useUpdateStore((s) => s.checar);
  const instalar = useUpdateStore((s) => s.instalar);
  const reiniciar = useUpdateStore((s) => s.reiniciar);

  // Mesma razão do `StatsPanel`: sem foco na caixa, o Esc dependeria de o
  // foco não estar no terminal por baixo.
  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (aberto) caixaRef.current?.focus();
  }, [aberto]);

  if (!aberto) return null;

  const ocupado = fase === "checando" || fase === "baixando";
  const pct = pctBaixado(baixado, total);
  const notas = linhasDeNotas(update?.notes ?? null);
  const publicada = dataLegivel(update?.publishedAt ?? null);

  return (
    <div className="stats-backdrop" onMouseDown={fechar}>
      <div
        className="stats update-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Atualizações"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span>Atualizações</span>
          <button
            className="stats-close"
            onClick={fechar}
            title="Fechar (Esc)"
            aria-label="Fechar atualizações"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="update-panel-hero">
          <span className="update-panel-versao">
            {versaoAtual ? `Versão ${versaoAtual}` : "Versão instalada"}
          </span>
          <span className="update-panel-estado" role="status" aria-live="polite">
            {fase === "ocioso" && "Ainda não procurei atualizações nesta sessão."}
            {fase === "checando" && "Procurando atualizações…"}
            {fase === "atualizado" && "Você está na versão mais recente."}
            {fase === "disponivel" && `A versão ${update?.version} está disponível.`}
            {fase === "baixando" && "Baixando a atualização…"}
            {fase === "pronto" && "Instalada. Reinicie para começar a usar."}
            {fase === "erro" && "A última tentativa não deu certo."}
            {fase === "indisponivel" &&
              "A atualização automática só funciona no aplicativo instalado."}
          </span>
        </div>

        {fase === "erro" && erro && (
          <div className="update-panel-erro">
            <Icon name="warning" size={15} />
            <div>
              <p>{erro}</p>
              <p className="update-panel-erro-saida">
                Se continuar falhando, baixe o instalador em <code>{PAGINA_RELEASES}</code> — a
                instalação por cima preserva seus workspaces e configurações.
              </p>
            </div>
          </div>
        )}

        {fase === "baixando" && (
          <div className="update-panel-progresso">
            <div className={`update-banner-bar ${pct === null ? "indeterminada" : ""}`}>
              <div
                className="update-banner-fill"
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <span>
              {pct === null
                ? baixado > 0
                  ? `${formatBytes(baixado)} baixados`
                  : "Preparando o download"
                : `${formatBytes(baixado)} de ${formatBytes(total ?? 0)} · ${pct}%`}
            </span>
          </div>
        )}

        {(fase === "disponivel" || fase === "baixando" || fase === "pronto") && update && (
          <div className="stats-section">
            <h3>
              Novidades da {update.version}
              {publicada && <span className="update-panel-data"> · {publicada}</span>}
            </h3>
            {notas.length === 0 ? (
              <p className="stats-empty">Esta versão foi publicada sem notas.</p>
            ) : (
              <ul className="update-panel-notas">
                {notas.map((linha, i) => (
                  <li key={i}>{linha}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="update-panel-acoes">
          {fase === "disponivel" && (
            <button className="chip" onClick={() => void instalar()}>
              <Icon name="refresh" size={13} />
              Baixar e instalar
            </button>
          )}
          {fase === "pronto" && (
            <button className="chip" onClick={() => void reiniciar()}>
              <Icon name="refresh" size={13} />
              Reiniciar agora
            </button>
          )}
          <button
            className={`chip ${fase === "disponivel" || fase === "pronto" ? "subtle" : ""}`}
            disabled={ocupado}
            onClick={() => void checar(true)}
          >
            <Icon name="search" size={13} />
            {fase === "checando" ? "Procurando…" : "Procurar atualizações"}
          </button>
        </div>

        <p className="stats-note">
          O JARVIS procura versões novas sozinho, algumas vezes por dia. Cada pacote é conferido
          contra a assinatura do projeto antes de instalar — um instalador que não seja o oficial é
          recusado.
        </p>
      </div>
    </div>
  );
}
