/**
 * Montagem do contexto que acompanha cada pergunta ao agente.
 *
 * O que dá utilidade real ao assistente é ele enxergar o que acabou de
 * acontecer no terminal: o erro do build, o stack trace, a saída do teste que
 * falhou. Essas linhas saem do buffer do xterm — que já entrega texto puro,
 * sem sequências ANSI, porque as escapes são consumidas ao desenhar.
 */

import type { BufferLike } from "./terminalRegistry";
import type { Workspace } from "./workspace";

/** Contexto serializado para envio ao backend Rust. */
export interface AiContext {
  workspacePath: string | null;
  shellName: string | null;
  os: string;
  /** Últimas linhas do terminal ativo, ou `null` se não houver nada. */
  terminalLines: string | null;
}

/** Mensagem individual no histórico de chat. */
export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Mensagem com metadados para exibição na interface. */
export interface AiChatMessage extends AiMessage {
  id: string;
  timestamp: number;
  /** `true` enquanto o streaming estiver em andamento. */
  streaming?: boolean;
  /** O usuário interrompeu esta resposta. */
  cancelled?: boolean;
  /**
   * Falha do provedor. Campo próprio, e não texto colado no conteúdo: o
   * erro precisa de destaque visual e de um botão de ação, coisas que uma
   * string dentro da resposta não permite.
   */
  error?: string;
  /**
   * Quem perguntou, quando a conversa é compartilhada com convidados. Ausente
   * na conversa de sempre — o app não passa a rotular "você" em toda pergunta
   * só porque a colaboração existe.
   */
  author?: { name: string; color: string };
}

/** Teto de caracteres do trecho de terminal enviado ao modelo. */
const MAX_CHARS = 6000;

/**
 * Últimas `maxLines` linhas do terminal, sem as vazias das pontas. Devolve
 * `null` quando não sobra nada — mandar string vazia faria o backend anunciar
 * "últimas linhas do terminal" seguido de nada, o que só confunde o modelo.
 */
export function captureTerminalLines(term: BufferLike, maxLines = 80): string | null {
  const buf = term.buffer.active;
  const linhas: string[] = [];
  const inicio = Math.max(0, buf.length - maxLines);
  for (let i = inicio; i < buf.length; i++) {
    // `translateToString(true)` já corta o preenchimento à direita.
    linhas.push(buf.getLine(i)?.translateToString(true) ?? "");
  }

  // Um terminal recém-aberto é quase todo linha vazia; sem cortar as pontas,
  // o modelo receberia dezenas de linhas em branco no lugar de contexto.
  while (linhas.length && linhas[linhas.length - 1].trim() === "") linhas.pop();
  while (linhas.length && linhas[0].trim() === "") linhas.shift();
  if (linhas.length === 0) return null;

  const texto = linhas.join("\n");
  // Corta pelo começo: o fim é o que acabou de acontecer, e é o que importa.
  return texto.length > MAX_CHARS ? texto.slice(texto.length - MAX_CHARS) : texto;
}

/**
 * Prompt de sistema base. O contexto de máquina (pasta, shell, terminal) é
 * anexado no backend a partir do `AiContext` — deixa um lugar só montando
 * essa parte, em vez de duas metades que podem divergir.
 */
export function buildSystemPrompt(): string {
  return [
    "Você é o JARVIS, um assistente de IA integrado ao terminal de um desenvolvedor no Windows.",
    "Responda de forma concisa e direta, em português.",
    "Ao sugerir um comando para executar, coloque-o sozinho num bloco de código com a linguagem marcada (```powershell, ```bash, ```cmd) — a interface oferece um botão de executar para esses blocos.",
    "Se o terminal mostrar um erro, comece pelo diagnóstico e só depois pela correção.",
  ].join("\n");
}

/** Monta o objeto `AiContext` para enviar ao backend. */
export function buildAiContext(
  workspace: Workspace | null,
  shellName: string | null,
  terminalLines: string | null,
): AiContext {
  return {
    workspacePath: workspace?.path ?? null,
    shellName,
    os: "Windows",
    terminalLines,
  };
}

let msgCounter = 0;

/** Cria uma nova mensagem de chat com id único e timestamp. */
export function createChatMessage(
  role: AiChatMessage["role"],
  content: string,
  streaming = false,
): AiChatMessage {
  return {
    id: `msg-${Date.now()}-${msgCounter++}`,
    role,
    content,
    timestamp: Date.now(),
    streaming,
  };
}
