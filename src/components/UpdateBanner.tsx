/**
 * Aviso de versão nova.
 *
 * Flutua sobre a interface em vez de ocupar uma linha da grade do `.app`:
 * a grade tem altura fixa por linha e um aviso que aparece do nada
 * empurraria a topbar e reflowaria todo terminal aberto — cada xterm
 * recalcula colunas quando o container muda de tamanho, e um TUI aberto
 * (vim, htop) se embaralha com isso. Sobrepor não custa nada a quem está
 * trabalhando.
 *
 * É a versão resumida do `UpdatePanel`: o que ele mostra em detalhe (notas,
 * versão instalada, tamanho baixado), aqui vira uma linha e dois botões.
 * Todo o estado vem do `updateStore`, então os dois nunca se contradizem.
 */

import { Icon } from "./Icon";
import { useUpdateStore } from "../stores/updateStore";
import { pctBaixado } from "../lib/updateRules";
import { formatBytes } from "../lib/stats";

export function UpdateBanner() {
  const fase = useUpdateStore((s) => s.fase);
  const update = useUpdateStore((s) => s.update);
  const visivel = useUpdateStore((s) => s.avisoVisivel);
  const baixado = useUpdateStore((s) => s.baixado);
  const total = useUpdateStore((s) => s.total);
  const instalar = useUpdateStore((s) => s.instalar);
  const dispensar = useUpdateStore((s) => s.dispensarAviso);
  const abrirPainel = useUpdateStore((s) => s.abrirPainel);

  if (!visivel) return null;

  const pct = pctBaixado(baixado, total);
  const mostraAcoes = fase === "disponivel" || fase === "erro";

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-icon">
        <Icon name="spark" size={15} />
      </span>

      <div className="update-banner-text">
        {fase === "disponivel" && update && (
          <>
            <strong>Versão {update.version} disponível</strong>
            <span>Você está na {update.currentVersion}.</span>
          </>
        )}
        {fase === "baixando" && (
          <>
            <strong>Baixando a {update?.version}…</strong>
            <span>
              {pct === null
                ? baixado > 0
                  ? `${formatBytes(baixado)} baixados`
                  : "Preparando"
                : `${formatBytes(baixado)} de ${formatBytes(total ?? 0)} · ${pct}%`}
            </span>
          </>
        )}
        {fase === "pronto" && (
          <>
            <strong>Atualização instalada</strong>
            <span>Reiniciando o JARVIS…</span>
          </>
        )}
        {fase === "erro" && (
          <>
            <strong>Não consegui atualizar</strong>
            <span>Abra os detalhes para ver o motivo.</span>
          </>
        )}
      </div>

      {fase === "baixando" && (
        <div className={`update-banner-bar ${pct === null ? "indeterminada" : ""}`}>
          <div className="update-banner-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}

      {mostraAcoes && (
        <>
          {fase === "disponivel" && (
            <button className="chip update-banner-cta" onClick={() => void instalar()}>
              <Icon name="refresh" size={13} />
              Atualizar
            </button>
          )}
          <button
            className={`chip subtle ${fase === "erro" ? "update-banner-cta" : ""}`}
            onClick={abrirPainel}
          >
            Detalhes
          </button>
          <button
            className="topbar-btn"
            onClick={dispensar}
            title="Agora não"
            aria-label="Dispensar aviso de atualização"
          >
            <Icon name="close" size={14} />
          </button>
        </>
      )}
    </div>
  );
}
