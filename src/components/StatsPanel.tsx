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
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
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
  const maiorUso = stats.byShell[0]?.sessions ?? 0;

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
                  style={{ width: `${maiorUso ? (g.sessions / maiorUso) * 100 : 0}%` }}
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
