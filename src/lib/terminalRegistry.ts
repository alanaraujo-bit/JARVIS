/**
 * Registro dos terminais vivos, indexado por sessão.
 *
 * O painel de IA precisa das últimas linhas do terminal ativo para montar o
 * contexto, mas quem tem esse buffer é o `Terminal` do xterm, que vive dentro
 * de um `<TerminalView>`. Passar a instância para cima por props significaria
 * ou levantar o xterm para o estado do App (recriando-o a cada render) ou
 * encher a árvore de callbacks só para transportar uma referência.
 *
 * Este módulo é o meio-termo: cada painel se registra ao montar e se remove
 * ao desmontar; quem precisa do buffer pergunta por sessão.
 */

/** Só o que precisamos do `Terminal` — evita acoplar o registro ao xterm. */
export interface BufferLike {
  buffer: {
    active: {
      length: number;
      getLine(row: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

const terminais = new Map<string, BufferLike>();

export function registerTerminal(sessionId: string, term: BufferLike): void {
  terminais.set(sessionId, term);
}

/**
 * Só remove se o terminal registrado ainda for este. Durante um remonte do
 * React o painel novo pode se registrar antes do cleanup do antigo rodar;
 * uma remoção incondicional apagaria o registro do painel vivo.
 */
export function unregisterTerminal(sessionId: string, term: BufferLike): void {
  if (terminais.get(sessionId) === term) terminais.delete(sessionId);
}

export function getTerminal(sessionId: string): BufferLike | undefined {
  return terminais.get(sessionId);
}

/** Usado nos testes para começar de um estado limpo. */
export function clearTerminals(): void {
  terminais.clear();
}

/**
 * Texto visível de todos os terminais, concatenado.
 *
 * Existe para os testes de ponta a ponta: com o renderizador WebGL o xterm
 * desenha num canvas, e não há nó de texto no DOM para uma asserção olhar.
 * Só é exposto ao navegador pelo backend simulado, que nunca é carregado no
 * app nativo.
 */
export function snapshotAllText(): string {
  const partes: string[] = [];
  for (const term of terminais.values()) {
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      partes.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
  }
  return partes.join("\n");
}
