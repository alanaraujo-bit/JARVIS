/**
 * Regras das contas do Claude Code que não dependem do backend.
 *
 * O mecanismo é simples: a CLI `claude` guarda login, preferências e
 * histórico num único diretório e obedece `CLAUDE_CONFIG_DIR`. Uma "conta"
 * do JARVIS é um desses diretórios com um nome bonito. O que este arquivo
 * decide é *qual* conta um terminal novo herda, e como descrever o estado de
 * cada uma — a parte com casos de borda de verdade.
 */

import type { ClaudeAccountPayload, ClaudeAccountStatus } from "./ipc";

/** Nome da variável que a CLI lê. Uma constante para não errar de digitação. */
export const ENV_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/**
 * Ids são componentes de caminho no disco — o backend recusa qualquer coisa
 * fora de `[A-Za-z0-9_-]`. Gerar aqui em vez de derivar do nome digitado
 * evita dois problemas de uma vez: acentos e espaços no nome ("Conta do
 * João") e renomear a conta mudando a pasta dela de lugar.
 */
export function novoIdDeConta(): string {
  const aleatorio = Math.random().toString(36).slice(2, 8);
  return `acc-${Date.now().toString(36)}${aleatorio}`;
}

/**
 * Qual conta um terminal deve usar.
 *
 * Precedência: o que o usuário escolheu na hora > a conta do workspace > a
 * conta padrão do app. Um id que não existe mais (conta apagada) cai para o
 * próximo nível em vez de virar erro — apagar uma conta não pode deixar
 * workspaces inutilizáveis nem terminais sem abrir.
 */
export function resolveConta(
  contas: ClaudeAccountPayload[],
  opts: {
    escolhidaNaHora?: string | null;
    doWorkspace?: string | null;
    padrao?: string | null;
  },
): ClaudeAccountPayload | null {
  const existe = (id: string | null | undefined) =>
    id ? (contas.find((c) => c.id === id) ?? null) : null;

  return (
    existe(opts.escolhidaNaHora) ?? existe(opts.doWorkspace) ?? existe(opts.padrao) ?? null
  );
}

/**
 * Variáveis de ambiente do terminal daquela conta.
 *
 * Sem conta (ou sem pasta preparada) devolve lista vazia — e é isso que faz
 * o terminal cair no `~/.claude` de sempre. Ou seja: quem nunca cadastrar
 * conta nenhuma continua com o comportamento que já tinha, sem saber que
 * este código existe.
 */
export function envDaConta(configDir: string | null | undefined): [string, string][] {
  if (!configDir) return [];
  return [[ENV_CONFIG_DIR, configDir]];
}

/** Texto curto do estado da conta, para a lista e para os seletores. */
export function rotuloDeStatus(st: ClaudeAccountStatus | null | undefined): string {
  if (!st || !st.prepared) return "não preparada";
  if (!st.loggedIn) return "sem login";
  const plano = st.subscriptionType ? st.subscriptionType.toUpperCase() : "logada";
  return plano;
}

/**
 * `true` quando o token de acesso já passou da validade.
 *
 * Não é motivo para alarme na interface: a CLI renova sozinha usando o
 * refresh token, que dura muito mais. Serve só para explicar por que uma
 * conta pode pedir login de novo — por isso o texto que acompanha fala em
 * "renovar", e não em "expirada".
 */
export function tokenVencido(st: ClaudeAccountStatus | null | undefined, agora: number): boolean {
  if (!st?.loggedIn || !st.expiresAt) return false;
  return st.expiresAt <= agora;
}

/**
 * Nome livre de duplicata, para a lista não virar três "Conta" iguais e
 * indistinguíveis. Acrescenta um sufixo numérico quando precisa.
 */
export function nomeUnico(desejado: string, existentes: string[]): string {
  const base = desejado.trim() || "Conta";
  if (!existentes.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const tentativa = `${base} ${i}`;
    if (!existentes.includes(tentativa)) return tentativa;
  }
  return `${base} ${Date.now()}`;
}

/** Paleta das contas — cores distintas das de workspace, para não confundir os pontos. */
export const CORES_DE_CONTA = [
  "#a78bfa",
  "#f472b6",
  "#fbbf24",
  "#34d399",
  "#60a5fa",
  "#fb923c",
] as const;

/** Próxima cor livre, ou a primeira repetida quando todas já foram usadas. */
export function proximaCor(usadas: string[]): string {
  return CORES_DE_CONTA.find((c) => !usadas.includes(c)) ?? CORES_DE_CONTA[usadas.length % CORES_DE_CONTA.length];
}
