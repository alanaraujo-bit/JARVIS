/**
 * Apoio à retomada de conversas com agentes de IA.
 *
 * A descoberta de qual conversa é qual mora no backend (`src-tauri/src/agents.rs`);
 * aqui ficam só as decisões que a interface precisa tomar em cima do resultado —
 * qual conta usar e o que escrever no botão.
 */

import type { AgentResume } from "./ipc";

/**
 * Descobre a conta do Claude Code em que a conversa foi gravada.
 *
 * Cada conta tem uma pasta cujo último trecho é o id dela
 * (`.../claude-accounts/acc-xyz`), e é isso que o backend devolve ao achar a
 * conversa. Reabrir na conta errada abriria um `--resume` de uma sessão que
 * não existe naquele `CLAUDE_CONFIG_DIR` — o agente subiria com erro, e o
 * usuário veria "continuar" virar uma tela vermelha.
 *
 * `null` = a conversa está na instalação padrão da CLI (ou a conta sumiu do
 * config), e o terminal novo deve nascer com a precedência normal de conta.
 */
export function contaDoConfigDir(
  configDir: string | null | undefined,
  contas: { id: string }[],
): string | null {
  if (!configDir) return null;
  const ultimo = configDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (!ultimo) return null;
  return contas.find((c) => c.id === ultimo)?.id ?? null;
}

/**
 * Frase que explica o que o botão vai fazer.
 *
 * A diferença entre `exact` e não-`exact` é dita em voz alta de propósito:
 * quando o JARVIS subiu o agente, ele sabe exatamente qual conversa era a
 * daquela aba; quando o usuário digitou `claude` na mão, o que existe é a
 * conversa daquela pasta ativa naquele horário — quase sempre a mesma coisa,
 * mas não é honesto afirmar que é.
 */
export function explicaRetomada(r: AgentResume): string {
  const conversa = r.title ? `“${r.title}”` : "a conversa";
  return r.exact
    ? `Continua ${conversa} no ${r.label}, de onde parou.`
    : `Continua ${conversa} — a conversa do ${r.label} que estava aberta nesta pasta neste horário.`;
}
