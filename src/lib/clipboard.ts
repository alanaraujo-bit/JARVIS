/**
 * Leitura e escrita do clipboard via plugin oficial do Tauri.
 *
 * O `navigator.clipboard` dentro do WebView2 é traiçoeiro: a leitura pede uma
 * permissão que o Tauri não concede por padrão, e a chamada falha em silêncio
 * (`NotAllowedError` engolido por um `.catch`). Foi isso que fez o copiar e o
 * colar do terminal \"quase funcionarem\": o código lia o clipboard por uma API
 * que não podia ler.
 *
 * O plugin faz a operação no Rust (arboard), sem depender da política de
 * permissões do webview. O `navigator.clipboard` fica só como último recurso
 * para quando o front roda num navegador comum sem o mock (dev puro).
 */
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function readClipboardText(): Promise<string> {
  try {
    return await readText();
  } catch {
    // Sem o plugin (navegador comum, mock que falhou): a API do navegador.
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  try {
    await writeText(text);
    return;
  } catch {
    // cai no fallback abaixo
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Melhor falhar em silêncio do que derrubar o fluxo de copiar.
  }
}

/**
 * Grava a imagem do clipboard num PNG e devolve o caminho absoluto.
 *
 * Um terminal só transporta texto: o bitmap do clipboard não desce pelo PTY.
 * Os agentes de IA, porém, abrem arquivos por caminho — então colar o caminho
 * do PNG é o que faz "colar um print no Claude Code" funcionar. Quem grava é
 * o Rust (`clipboard_save_image`), para os bytes da imagem não atravessarem
 * o IPC.
 *
 * `sessionId` diz de qual terminal veio a colagem: o PNG é gravado dentro do
 * diretório daquela sessão, porque um agente de IA trata a pasta de trabalho
 * como fronteira de permissão — um caminho fora dela faz ele parar e pedir
 * aprovação em vez de abrir a imagem.
 *
 * `null` quer dizer "não havia imagem no clipboard", que é o caso comum e não
 * é erro.
 */
export async function saveClipboardImage(sessionId?: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("clipboard_save_image", { sessionId })) ?? null;
  } catch {
    // Sem backend nativo (navegador puro, mock) não há o que gravar.
    return null;
  }
}

/**
 * Lê de volta um PNG colado, como *data URL* pronta para um `<img src>`.
 *
 * É o que alimenta o preview de hover: o terminal mostra "[Image #N]" no
 * lugar do caminho que colamos, e para "ver a imagem antes de mandar para o
 * agente" é preciso os bytes de volta — só que agora sob demanda, e não a
 * cada colagem. `null` cobre tanto a ausência de backend nativo quanto o
 * caso comum de o PNG ter sumido (limpeza de 24h, usuário apagou a pasta).
 */
export async function readClipboardImage(path: string): Promise<string | null> {
  try {
    return await invoke<string>("clipboard_read_image", { path });
  } catch {
    return null;
  }
}

/** O que uma colagem deve fazer, dado o que existe no clipboard. */
export type PlanoDeColagem =
  | { tipo: "texto"; texto: string }
  | { tipo: "imagem" }
  | { tipo: "nada" };

/**
 * Decide entre colar o texto e colar o caminho da imagem.
 *
 * O texto vem primeiro de propósito. Excel, Word e a maioria dos editores
 * põem *os dois* no clipboard — um bitmap da seleção junto com o texto dela.
 * Preferir a imagem faria "copiar umas células e colar" virar um caminho de
 * PNG, que não é o que ninguém espera.
 *
 * `forcarImagem` é a saída para o caso inverso: copiar uma imagem do
 * navegador também traz texto junto (a URL, o `alt`), e aí a colagem normal
 * nunca chegaria na imagem. O atalho dedicado pula o texto.
 */
export function planejarColagem(
  texto: string,
  opcoes?: { forcarImagem?: boolean },
): PlanoDeColagem {
  if (opcoes?.forcarImagem) return { tipo: "imagem" };
  if (texto) return { tipo: "texto", texto };
  return { tipo: "imagem" };
}

/**
 * Extrai a colagem de um evento nativo do navegador (menu de contexto,
 * ferramentas de ditado). O evento já traz os dados prontos; se houver
 * imagem sem texto, o clipboard do sistema também tem — e é de lá que o
 * Rust vai ler.
 */
export function planejarColagemDeEvento(dados: DataTransfer | null): PlanoDeColagem {
  if (!dados) return { tipo: "nada" };
  const texto = dados.getData("text/plain");
  if (texto) return { tipo: "texto", texto };
  const temImagem = Array.from(dados.items ?? []).some((i) =>
    i.type.startsWith("image/"),
  );
  return temImagem ? { tipo: "imagem" } : { tipo: "nada" };
}
