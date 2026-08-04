/**
 * Busca da paleta de comandos.
 *
 * O casamento é por subsequência, não por substring: "nab" acha "Nova aba"
 * porque as letras aparecem nessa ordem, ainda que separadas. É o que
 * qualquer paleta de editor faz, e é o que faz digitar três letras valer a
 * pena em vez de digitar o nome inteiro.
 */

export interface Command {
  id: string;
  /** Rótulo exibido. */
  title: string;
  /** Agrupador exibido à esquerda ("Abas", "Workspaces", "IA"). */
  group: string;
  /** Atalho equivalente, se houver. */
  shortcut?: string;
  /** Termos extras que também devem casar (sinônimos, nome em inglês). */
  keywords?: string;
  run: () => void;
}

export interface Match {
  command: Command;
  score: number;
  /** Índices de `title` que casaram, para destacar na interface. */
  hits: number[];
}

/**
 * Casa `query` contra `texto` como subsequência e devolve uma pontuação.
 * Pontua melhor quando as letras caem em início de palavra e quando ficam
 * grudadas — assim "ab" prefere "Abrir pasta" a "Fechar aba".
 */
function pontua(texto: string, query: string): { score: number; hits: number[] } | null {
  const alvo = texto.toLowerCase();
  let score = 0;
  let cursor = 0;
  let anterior = -2;
  const hits: number[] = [];

  for (const ch of query) {
    const idx = alvo.indexOf(ch, cursor);
    if (idx === -1) return null;

    if (idx === anterior + 1) score += 8; // letras consecutivas
    if (idx === 0 || /[\s\-_/]/.test(alvo[idx - 1])) score += 12; // início de palavra
    // Casar lá no fim da string vale menos que casar no começo.
    score += Math.max(0, 6 - idx * 0.15);

    hits.push(idx);
    anterior = idx;
    cursor = idx + 1;
  }

  return { score, hits };
}

/**
 * Filtra e ordena os comandos. Com a busca vazia devolve tudo na ordem
 * original — a paleta recém-aberta deve mostrar o repertório, não um vazio.
 */
export function searchCommands(commands: Command[], query: string, limit = 50): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit).map((command) => ({ command, score: 0, hits: [] }));

  const achados: Match[] = [];
  for (const command of commands) {
    const noTitulo = pontua(command.title, q);
    if (noTitulo) {
      achados.push({ command, score: noTitulo.score + 20, hits: noTitulo.hits });
      continue;
    }
    // Palavras-chave e grupo casam, mas valem menos e não destacam nada —
    // destacar índices de um texto que não está na tela confundiria.
    const alternativo = pontua(`${command.group} ${command.keywords ?? ""}`, q);
    if (alternativo) achados.push({ command, score: alternativo.score, hits: [] });
  }

  return achados
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    .slice(0, limit);
}

/** Move o índice selecionado circularmente, tolerando lista vazia. */
export function moveSelection(atual: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (((atual + delta) % total) + total) % total;
}
