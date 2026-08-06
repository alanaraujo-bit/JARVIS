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
