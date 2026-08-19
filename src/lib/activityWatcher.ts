/**
 * Detecta quando uma sessão "termina uma rajada" de saída — um agente que
 * parou de imprimir depois de trabalhar, seja porque terminou, seja porque
 * parou para perguntar algo.
 *
 * Sem entender o protocolo de cada agente (Claude Code, um shell puro, etc.)
 * não dá para saber com certeza *por que* ele calou; o que dá para observar
 * de fora, olhando só para os bytes que chegam do PTY, é o silêncio depois
 * de atividade real. Isso já é o suficiente para o gatilho de notificação:
 * o app só precisa saber "aconteceu algo, vale olhar" — o resto o próprio
 * terminal mostra quando a pessoa voltar.
 *
 * Só a regra pura fica aqui, sem tocar em Tauri nem React, para dar para
 * testar com `Date.now()` controlado.
 */

interface SessionActivity {
  lastAt: number;
  burstStart: number;
  burstBytes: number;
  notified: boolean;
}

const activity = new Map<string, SessionActivity>();

/** Quanto tempo sem bytes novos conta como "parou". */
const IDLE_MS = 1500;
/** Rajadas mais curtas que isto são ruído (um prompt, um eco de tecla). */
const MIN_BURST_MS = 800;
/** Rajadas menores que isto em bytes também são ruído. */
const MIN_BURST_BYTES = 24;

export function recordActivity(sessionId: string, byteLen: number, now = Date.now()): void {
  let a = activity.get(sessionId);
  if (!a || now - a.lastAt > IDLE_MS) {
    a = { lastAt: now, burstStart: now, burstBytes: 0, notified: false };
    activity.set(sessionId, a);
  }
  a.lastAt = now;
  a.burstBytes += byteLen;
}

/**
 * Chamada periodicamente (ex.: a cada 500ms). Devolve os ids de sessão que
 * acabaram de cruzar de "rajada em andamento" para "ficou quieta", desde que
 * a rajada tenha sido grande o bastante para valer a pena avisar.
 *
 * Cada transição só é devolvida uma vez — a próxima só volta a valer depois
 * de uma rajada nova.
 */
export function pollIdleTransitions(now = Date.now()): string[] {
  const out: string[] = [];
  for (const [sessionId, a] of activity) {
    if (a.notified) continue;
    if (now - a.lastAt < IDLE_MS) continue;
    a.notified = true;
    if (a.lastAt - a.burstStart < MIN_BURST_MS) continue;
    if (a.burstBytes < MIN_BURST_BYTES) continue;
    out.push(sessionId);
  }
  return out;
}

/** Sessão fechada: para de ocupar memória e não gera uma notificação tardia. */
export function forgetSession(sessionId: string): void {
  activity.delete(sessionId);
}

/** Só para os testes: começa do zero. */
export function resetActivity(): void {
  activity.clear();
}
