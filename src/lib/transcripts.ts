/**
 * Apoio à tela de histórico de terminais.
 *
 * Só funções puras: o que fala com o backend está em `ipc.ts` e o que
 * desenha está em `HistoryPanel.tsx`. Separado para a parte com regra de
 * verdade — busca, agrupamento por dia, rótulos — poder ser testada sem
 * montar componente nenhum.
 */

import type { TranscriptMeta } from "./ipc";

/** Nome curto do programa, sem caminho nem extensão. */
export function programName(program: string): string {
  const base = program.replace(/\\/g, "/").split("/").pop() ?? program;
  return base.replace(/\.exe$/i, "");
}

/**
 * Encurta um caminho para caber numa linha de lista.
 *
 * A home vira `~` porque `C:/Users/Fulano/` é o prefixo de quase tudo e não
 * distingue uma sessão da outra — justamente o que a lista precisa fazer.
 */
export function shortenPath(path: string): string {
  const normalizado = path.replace(/\\/g, "/");
  const home = normalizado.match(/^[A-Za-z]:\/Users\/[^/]+/)?.[0];
  const base =
    home && normalizado.startsWith(home) ? "~" + normalizado.slice(home.length) : normalizado;
  const partes = base.split("/").filter(Boolean);
  return partes.length > 3 ? ".../" + partes.slice(-2).join("/") : base;
}

/**
 * Rótulo da sessão na lista.
 *
 * A pasta vem antes do shell de propósito: o que identifica uma sessão
 * meses depois é onde ela rodou, não que ela era um PowerShell — como
 * quase todas as outras.
 */
export function sessionLabel(m: TranscriptMeta): string {
  const pasta = shortenPath(m.cwd).split("/").filter(Boolean).pop();
  // Um terminal aberto direto na home vira "~", que não distingue nada de
  // nada — nesse caso o shell é a informação mais útil que sobra.
  if (!pasta || pasta === "~") return m.title || programName(m.program);
  return pasta;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Duração de uma sessão gravada. `null` quando ela nunca foi encerrada. */
export function sessionDuration(m: TranscriptMeta): string | null {
  if (m.endedAt === null) return null;
  const ms = Math.max(0, m.endedAt - m.startedAt);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, "0")}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Rótulo do dia. "Hoje"/"Ontem" comparam a data no fuso local, e não uma
 * diferença de 24h: às 00h30, algo das 23h de ontem está a uma hora de
 * distância mas é outro dia — e é assim que a pessoa procura.
 */
export function dayLabel(ts: number, agora: number = Date.now()): string {
  const d = new Date(ts);
  const hoje = new Date(agora);
  const mesmoDia = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (mesmoDia(d, hoje)) return "Hoje";
  const ontem = new Date(hoje);
  ontem.setDate(ontem.getDate() - 1);
  if (mesmoDia(d, ontem)) return "Ontem";

  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: d.getFullYear() === hoje.getFullYear() ? undefined : "numeric",
  });
}

export interface DayGroup {
  label: string;
  items: TranscriptMeta[];
}

/**
 * Agrupa por dia preservando a ordem recebida — o backend já devolve do mais
 * recente para o mais antigo, e reordenar aqui só arriscaria discordar dele.
 */
export function groupByDay(list: TranscriptMeta[], agora: number = Date.now()): DayGroup[] {
  const out: DayGroup[] = [];
  for (const m of list) {
    const label = dayLabel(m.startedAt, agora);
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.label === label) ultimo.items.push(m);
    else out.push({ label, items: [m] });
  }
  return out;
}

/**
 * Busca por texto livre. Casa contra tudo que aparece na linha da lista mais
 * o caminho completo e o comando de auto-início: procurar por "claude" tem
 * que achar as sessões que subiram o agente, ainda que a palavra não esteja
 * escrita em lugar nenhum visível.
 */
export function filterTranscripts(list: TranscriptMeta[], query: string): TranscriptMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const termos = q.split(/\s+/);
  return list.filter((m) => {
    const alvo = [
      m.title,
      m.cwd,
      m.program,
      m.workspaceName ?? "",
      m.autoCommand ?? "",
      m.args.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    // Todos os termos precisam casar: digitar mais deve estreitar o
    // resultado, não alargá-lo.
    return termos.every((t) => alvo.includes(t));
  });
}
