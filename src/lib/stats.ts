/**
 * Agregação das estatísticas de uso mostradas no dashboard.
 *
 * Os números vêm dos contadores que o motor de PTY já mantém no caminho
 * quente (`bytesOut`/`bytesIn` por sessão) — nada é medido de novo aqui.
 */

import type { SessionInfo } from "./ipc";

export interface ShellUsage {
  /** Rótulo do perfil, ou o programa quando a sessão não tem perfil. */
  label: string;
  sessions: number;
  bytesOut: number;
}

export interface Stats {
  totalSessions: number;
  aliveSessions: number;
  bytesOut: number;
  bytesIn: number;
  /** Sessão viva mais antiga, em milissegundos. `0` se não há nenhuma. */
  longestUptimeMs: number;
  /** Uso por shell, do mais usado para o menos. */
  byShell: ShellUsage[];
}

/**
 * `agora` entra por parâmetro em vez de `Date.now()` para o cálculo de tempo
 * ativo ser determinístico nos testes.
 */
export function computeStats(sessions: SessionInfo[], agora: number = Date.now()): Stats {
  const porShell = new Map<string, ShellUsage>();
  let bytesOut = 0;
  let bytesIn = 0;
  let longestUptimeMs = 0;
  let aliveSessions = 0;

  for (const s of sessions) {
    bytesOut += s.bytesOut;
    bytesIn += s.bytesIn;

    if (s.alive) {
      aliveSessions++;
      // `startedAt` no futuro (relógio ajustado durante a sessão) viraria um
      // tempo ativo negativo; o piso em zero evita mostrar "-3min".
      longestUptimeMs = Math.max(longestUptimeMs, Math.max(0, agora - s.startedAt));
    }

    const label = s.profileId || basename(s.program) || "desconhecido";
    const atual = porShell.get(label) ?? { label, sessions: 0, bytesOut: 0 };
    atual.sessions++;
    atual.bytesOut += s.bytesOut;
    porShell.set(label, atual);
  }

  return {
    totalSessions: sessions.length,
    aliveSessions,
    bytesOut,
    bytesIn,
    longestUptimeMs,
    byShell: [...porShell.values()].sort(
      (a, b) => b.sessions - a.sessions || b.bytesOut - a.bytesOut,
    ),
  };
}

function basename(caminho: string): string {
  const partes = caminho.replace(/\\/g, "/").split("/");
  return partes[partes.length - 1] ?? caminho;
}

/** Formata bytes na maior unidade que ainda deixe o número legível. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const unidades = ["KB", "MB", "GB", "TB"];
  let valor = bytes / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${valor.toFixed(valor < 10 ? 1 : 0)} ${unidades[i]}`;
}

/** Duração curta e legível: "2h 14min", "45s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (h > 0) return min > 0 ? `${h}h ${min}min` : `${h}h`;
  if (min > 0) return `${min}min`;
  return `${s}s`;
}

/* ------------------------- cota do Claude Code ------------------------- */

/** Limite a partir do qual a cota da Anthropic é tratada como "quase no limite". */
export const COTA_ALERTA_PCT = 80;

/**
 * "3h 24min" até um timestamp futuro de reset. Janelas já vencidas (a API
 * pode devolver um `resetsAt` no passado entre duas consultas) viram
 * "agora".
 */
export function formatCountdown(resetsAtMs: number, agora: number = Date.now()): string {
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= 0) return "agora";
  const falta = resetsAtMs - agora;
  if (falta <= 0) return "agora";
  const min = Math.ceil(falta / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

/**
 * Tom visual de uma cota: normal, atenção (a partir de 60%) ou alerta
 * (a partir de `COTA_ALERTA_PCT`).
 */
export function tomCota(pct: number): "ok" | "atencao" | "alta" {
  if (pct >= COTA_ALERTA_PCT) return "alta";
  if (pct >= 60) return "atencao";
  return "ok";
}
