/**
 * Perfil — a janela para o próprio app e para a máquina em que ele roda.
 *
 * Não há conta de usuário no JARVIS; o \"perfil\" é o contexto real em que o
 * app vive: sistema operacional, pasta pessoal, shells disponíveis, versão
 * instalada e o uso desta execução. É o lugar para responder \"o que é este
 * app aqui?\" sem abrir o Gerenciador de Tarefas.
 */

import { useEffect, useMemo, useRef } from "react";

import { Icon, shellIcon } from "./Icon";
import { useUpdateStore } from "../stores/updateStore";
import { useAccountStore } from "../stores/accountStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { computeStats, formatBytes } from "../lib/stats";
import type { SessionInfo, ShellProfile } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
  home: string;
  profiles: ShellProfile[];
  sessions: SessionInfo[];
}

function nomeDoSistemaOperacional(): string {
  const ua = navigator.userAgent ?? "";
  if (/Windows NT 10/.test(ua)) return "Windows 10/11";
  if (/Windows NT 6/.test(ua)) return "Windows 7/8";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return ua.split(")")[0]?.split("(").pop()?.trim() || "Desconhecido";
}

export function ProfileScreen({ open, onClose, home, profiles, sessions }: Props) {
  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) caixaRef.current?.focus();
  }, [open]);

  const versao = useUpdateStore((s) => s.versaoAtual);
  const contas = useAccountStore((s) => s.contas);
  const padraoId = useAccountStore((s) => s.padraoId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const stats = useMemo(() => computeStats(sessions, Date.now()), [sessions]);

  if (!open) return null;

  const contaPadrao = contas.find((c) => c.id === padraoId);

  return (
    <div className="stats-backdrop" onMouseDown={onClose}>
      <div
        className="stats profile-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Perfil"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span>Perfil</span>
          <button
            className="stats-close"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar perfil"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="profile-hero">
          <span className="profile-avatar">
            <Icon name="logo" size={30} />
          </span>
          <div className="profile-hero-text">
            <span className="profile-title">JARVIS</span>
            <span className="profile-sub">
              {versao ? `v${versao}` : "versão desconhecida"} · {nomeDoSistemaOperacional()}
            </span>
          </div>
        </div>

        <div className="profile-cards">
          <div className="profile-card">
            <span className="profile-card-label">Sistema</span>
            <span className="profile-card-value">{nomeDoSistemaOperacional()}</span>
            <span className="profile-card-sub" title={home}>
              {home || "pasta pessoal não encontrada"}
            </span>
          </div>
          <div className="profile-card">
            <span className="profile-card-label">Shells disponíveis</span>
            <span className="profile-card-value">
              {profiles.length > 0 ? (
                <span className="profile-shells">
                  {profiles.map((p) => (
                    <span key={p.id} className="profile-shell" title={p.program}>
                      <Icon name={shellIcon(p.icon)} size={13} />
                      {p.name}
                    </span>
                  ))}
                </span>
              ) : (
                "detectando…"
              )}
            </span>
            <span className="profile-card-sub">
              {profiles.find((p) => p.recommended)?.name ?? ""} é o shell recomendado
            </span>
          </div>
          <div className="profile-card">
            <span className="profile-card-label">Nesta execução</span>
            <span className="profile-card-value">
              {stats.aliveSessions} terminal(is) · {formatBytes(stats.bytesOut)}
            </span>
            <span className="profile-card-sub">
              {stats.totalSessions} sessões ao todo
            </span>
          </div>
          <div className="profile-card">
            <span className="profile-card-label">Claude Code</span>
            <span className="profile-card-value">
              {contas.length === 0 ? "sem contas" : `${contas.length} conta(s)`}
            </span>
            <span className="profile-card-sub">
              {contaPadrao ? `padrão: ${contaPadrao.name}` : "login normal de ~/.claude"}
            </span>
          </div>
          <div className="profile-card">
            <span className="profile-card-label">Workspaces</span>
            <span className="profile-card-value">
              {workspaces.length === 0 ? "nenhum" : `${workspaces.length} projeto(s)`}
            </span>
            <span className="profile-card-sub">
              {workspaces.slice(0, 3).map((w) => w.name).join(" · ")}
            </span>
          </div>
        </div>

        <p className="stats-note">
          Os contadores de uso valem para esta execução do JARVIS — eles zeram quando o
          aplicativo é fechado.
        </p>
      </div>
    </div>
  );
}
