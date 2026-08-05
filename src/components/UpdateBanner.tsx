/**
 * Aviso de versão nova.
 *
 * Flutua sobre a interface em vez de ocupar uma linha da grade do `.app`:
 * a grade tem altura fixa por linha e um aviso que aparece do nada
 * empurraria a topbar e reflowaria todo terminal aberto — cada xterm
 * recalcula colunas quando o container muda de tamanho, e um TUI aberto
 * (vim, htop) se embaralha com isso. Sobrepor não custa nada a quem está
 * trabalhando.
 */

import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { checkForUpdate, relaunchApp, type UpdateInfo } from "../lib/updater";

type Fase = "oculto" | "oferecendo" | "baixando" | "pronto" | "falhou";

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [fase, setFase] = useState<Fase>("oculto");
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    let vivo = true;
    // Um atraso curto tira a checagem do caminho crítico da abertura: o
    // primeiro terminal aparece antes de qualquer coisa tocar a rede.
    const t = setTimeout(() => {
      void checkForUpdate().then((u) => {
        if (!vivo || !u) return;
        setUpdate(u);
        setFase("oferecendo");
      });
    }, 3000);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, []);

  if (fase === "oculto" || !update) return null;

  async function instala() {
    if (!update) return;
    setFase("baixando");
    setPct(null);
    try {
      await update.install((baixado, total) => {
        // Sem `content-length` não dá para mostrar porcentagem honesta; a
        // barra vira indeterminada em vez de inventar um número.
        setPct(total ? Math.min(100, Math.round((baixado / total) * 100)) : null);
      });
      setFase("pronto");
      await relaunchApp();
    } catch {
      setFase("falhou");
    }
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-icon">
        <Icon name="spark" size={15} />
      </span>

      <div className="update-banner-text">
        {fase === "oferecendo" && (
          <>
            <strong>Versão {update.version} disponível</strong>
            <span>Você está na {update.currentVersion}.</span>
          </>
        )}
        {fase === "baixando" && (
          <>
            <strong>Baixando a {update.version}…</strong>
            <span>{pct === null ? "Preparando" : `${pct}%`}</span>
          </>
        )}
        {fase === "pronto" && (
          <>
            <strong>Atualização instalada</strong>
            <span>Reiniciando o JARVIS…</span>
          </>
        )}
        {fase === "falhou" && (
          <>
            <strong>Não consegui atualizar</strong>
            <span>Tente de novo mais tarde ou baixe do site.</span>
          </>
        )}
      </div>

      {fase === "baixando" && (
        <div className={`update-banner-bar ${pct === null ? "indeterminada" : ""}`}>
          <div className="update-banner-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}

      {(fase === "oferecendo" || fase === "falhou") && (
        <>
          <button className="chip update-banner-cta" onClick={() => void instala()}>
            <Icon name="refresh" size={13} />
            {fase === "falhou" ? "Tentar de novo" : "Atualizar"}
          </button>
          <button
            className="topbar-btn"
            onClick={() => setFase("oculto")}
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
