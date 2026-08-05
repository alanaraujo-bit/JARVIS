/**
 * Regras de visibilidade e ordem das abas.
 *
 * Uma aba minimizada continua existindo por inteiro — a sessão de PTY roda,
 * o painel segue montado e recebendo saída — ela só sai da barra e vai para
 * a bandeja. Isso é diferente de fechar, que mata o processo, e diferente de
 * apenas não estar ativa, que já acontece com toda aba de fundo.
 *
 * O que está aqui é a parte com regra de verdade: quem fica visível, quem
 * assume o foco quando a aba ativa some da barra, e como reordenar uma lista
 * cujos índices na tela não batem com os índices reais. Fica separado do
 * componente para poder ser testado sem montar React.
 */

/** O mínimo que estas funções precisam saber sobre uma aba. */
export interface AbaVisivel {
  id: string;
  minimized?: boolean;
}

export function visibleTabs<T extends AbaVisivel>(tabs: T[]): T[] {
  return tabs.filter((t) => !t.minimized);
}

export function minimizedTabs<T extends AbaVisivel>(tabs: T[]): T[] {
  return tabs.filter((t) => t.minimized);
}

/**
 * Qual aba assume o foco quando `saindoId` deixa a barra (por minimizar ou
 * por fechar).
 *
 * Devolve `ativaAtual` intacta quando não era ela que saiu — minimizar uma
 * aba de fundo não pode roubar o foco de quem está trabalhando na frente.
 * Quando era ela, o foco vai para a vizinha da mesma posição, e não para a
 * primeira da lista: o dedo já está naquela região da barra.
 *
 * `tabs` é a lista ANTES da mudança; `saindoId` é quem está saindo.
 */
export function nextActiveAfterHiding<T extends AbaVisivel>(
  tabs: T[],
  saindoId: string,
  ativaAtual: string | null,
): string | null {
  if (ativaAtual !== saindoId) return ativaAtual;

  const visiveis = visibleTabs(tabs);
  const idx = visiveis.findIndex((t) => t.id === saindoId);
  if (idx < 0) return ativaAtual;

  const restantes = visiveis.filter((t) => t.id !== saindoId);
  if (restantes.length === 0) return null;
  return restantes[Math.min(idx, restantes.length - 1)].id;
}

/**
 * Move `fromId` para a posição de `toId`.
 *
 * Trabalha por id, e não por índice, de propósito: a barra mostra só as abas
 * visíveis, então o "terceiro item da tela" pode ser o quinto da lista real.
 * Passar os índices da tela para cá reordenaria a aba errada assim que
 * houvesse qualquer minimizada antes dela.
 */
export function moveTab<T extends AbaVisivel>(tabs: T[], fromId: string, toId: string): T[] {
  const from = tabs.findIndex((t) => t.id === fromId);
  const to = tabs.findIndex((t) => t.id === toId);
  if (from < 0 || to < 0 || from === to) return tabs;
  const next = [...tabs];
  const [movida] = next.splice(from, 1);
  next.splice(to, 0, movida);
  return next;
}
