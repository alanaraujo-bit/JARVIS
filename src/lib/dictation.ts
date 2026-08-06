/**
 * Diferença entre o texto anterior e o atual da barra de ditado, traduzida
 * em teclas para o shell.
 *
 * A barra de ditado é um `<textarea>` de verdade — o único alvo que as
 * ferramentas de transcrição de voz (Wispr Flow, etc.) reconhecem como campo
 * de texto. Cada mudança no campo é repassada ao PTY em tempo real para o
 * texto aparecer no terminal como se tivesse sido digitado no cursor:
 *
 * - texto novo vira os caracteres digitados;
 * - remoção vira Backspace (`\x7f`, o DEL que o readline interpreta como
 *   apagar o caractere anterior).
 *
 * Função pura de propósito: o comportamento é testado isolado, sem montar
 * terminal nenhum.
 */
export function diffTexto(anterior: string, atual: string): string {
  if (atual === anterior) return "";
  // Apagou só o fim (o caso da ferramenta de ditado corrigindo uma palavra):
  // manda os Backspaces de volta, um por caractere removido.
  if (atual.length < anterior.length && anterior.startsWith(atual)) {
    return "\x7f".repeat(anterior.length - atual.length);
  }
  // Inseriu no fim (ou colou um bloco): só o trecho novo vai para o shell.
  const comum = prefixoComum(anterior, atual);
  return atual.slice(comum);
}

export function prefixoComum(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
