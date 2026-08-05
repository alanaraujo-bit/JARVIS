/** Tipos e funções puras para o sistema de workspaces.
 *
 * Um workspace vincula terminais a uma pasta de projeto e agrupa
 * abas/sessões sob um contexto visual unificado.
 */

export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** Cor da barra lateral e indicador de aba (hex). */
  color: string;
  /** Perfil de shell preferido ao abrir terminais neste workspace. */
  defaultProfileId: string | null;
  /**
   * Comando digitado automaticamente assim que um terminal deste workspace
   * termina de abrir (ex.: "claude"). `null`/vazio desliga o auto-início.
   */
  autoCommand: string | null;
  /**
   * Conta do Claude Code usada pelos terminais deste projeto. `null` = a
   * conta padrão do app. É o que permite ter o cliente A numa conta e o
   * projeto pessoal em outra sem escolher nada na hora de abrir.
   */
  claudeAccountId: string | null;
  /** Epoch em ms. */
  createdAt: number;
}

/** Paleta de cores padrão para workspaces novos (ciclada automaticamente). */
export const WORKSPACE_COLORS = [
  "#5eead4", // teal (accent padrão do JARVIS)
  "#818cf8", // indigo
  "#fb923c", // laranja
  "#f472b6", // rosa
  "#a3e635", // lima
  "#38bdf8", // cyan
  "#e879f9", // fúcsia
  "#fbbf24", // âmbar
] as const;

let counter = 0;

export function nextWorkspaceId(): string {
  return `ws-${Date.now()}-${counter++}`;
}

/** Escolhe a próxima cor da paleta baseada no total de workspaces existentes. */
export function nextColor(existingCount: number): string {
  return WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length];
}

/** Cria um workspace novo a partir do caminho absoluto de uma pasta. */
export function createWorkspace(
  path: string,
  existingCount: number,
  name?: string,
): Workspace {
  return {
    id: nextWorkspaceId(),
    name: name ?? folderName(path),
    path,
    color: nextColor(existingCount),
    defaultProfileId: null,
    autoCommand: null,
    claudeAccountId: null,
    createdAt: Date.now(),
  };
}

/** Extrai o nome da pasta a partir do caminho completo. */
export function folderName(fullPath: string): string {
  // Funciona tanto com separadores Windows (\) quanto Unix (/)
  const parts = fullPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? fullPath;
}
