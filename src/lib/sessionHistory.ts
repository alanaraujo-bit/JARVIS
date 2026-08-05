/**
 * Histórico leve de sessões de terminal.
 *
 * As sessões de PTY vivem só enquanto o processo do app estiver de pé — um
 * Alt+F4, uma queda de energia ou "Encerrar tarefa" as mata todas sem passar
 * por `pty_close`. Isso por si só é inevitável (não dá pra sobreviver ao
 * processo pai morrer), mas o CONTEXTO do que estava aberto (workspace,
 * pasta, comando) pode e deve sobreviver, pra próxima vez que o app abrir
 * a pessoa não precise lembrar de cabeça o que tinha em aberto.
 */

export interface HistoryEntry {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  cwd: string;
  program: string;
  args: string[];
  profileId: string | null;
  title: string;
  autoCommand: string | null;
  startedAt: number;
  /** `null` = ainda aberta (ou o app fechou sem passar pelo close). */
  endedAt: number | null;
}

/** Quantas entradas guardar no máximo — só o suficiente pra cobrir a última sessão de uso. */
const MAX_ENTRIES = 40;

export function pruneHistory(entries: HistoryEntry[]): HistoryEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  // Mantém as mais recentes: as antigas fechadas não têm mais valor de recuperação.
  return [...entries]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_ENTRIES);
}

/** Entradas que ficaram "penduradas" (nunca marcadas como encerradas) e não estão mais vivas. */
export function findOrphans(entries: HistoryEntry[], aliveIds: Set<string>): HistoryEntry[] {
  return entries.filter((e) => e.endedAt === null && !aliveIds.has(e.id));
}

export function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.cwd !== "string" || typeof e.startedAt !== "number") {
      continue;
    }
    out.push({
      id: e.id,
      workspaceId: typeof e.workspaceId === "string" ? e.workspaceId : null,
      workspaceName: typeof e.workspaceName === "string" ? e.workspaceName : null,
      cwd: e.cwd,
      program: typeof e.program === "string" ? e.program : "",
      args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [],
      profileId: typeof e.profileId === "string" ? e.profileId : null,
      title: typeof e.title === "string" ? e.title : e.cwd,
      autoCommand: typeof e.autoCommand === "string" ? e.autoCommand : null,
      startedAt: e.startedAt,
      endedAt: typeof e.endedAt === "number" ? e.endedAt : null,
    });
  }
  return out;
}
