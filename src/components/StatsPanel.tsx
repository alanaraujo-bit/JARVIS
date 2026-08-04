/**
 * Dashboard de uso (Ctrl+Shift+S).
 *
 * Os números saem dos contadores que o motor de PTY já mantém — nada é
 * instrumentado a mais para esta tela existir.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionInfo } from "../lib/ipc";
import { computeStats, formatBytes, formatDuration } from "../lib/stats";

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
          <button className="stats-close" onClick={onClose} title="Fechar (Esc)">
            ×
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
