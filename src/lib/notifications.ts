/**
 * Notificações nativas do Windows: avisam quando um terminal produz saída
 * relevante e para (ver `activityWatcher.ts`) enquanto o JARVIS não está em
 * primeiro plano — a pessoa saiu para outra janela e um agente terminou ou
 * parou para perguntar algo.
 *
 * Falha em qualquer etapa (sem Tauri, permissão negada, plugin ausente no
 * ambiente de teste) é silenciosa: uma notificação é um extra, nunca algo
 * que pode travar o app ou poluir o console.
 */

let permissaoOk: boolean | null = null;

async function garantirPermissao(): Promise<boolean> {
  if (permissaoOk !== null) return permissaoOk;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let ok = await isPermissionGranted();
    if (!ok) {
      const resposta = await requestPermission();
      ok = resposta === "granted";
    }
    permissaoOk = ok;
    return ok;
  } catch {
    permissaoOk = false;
    return false;
  }
}

/**
 * `false` fora do app nativo (browser de dev, `devMock`) — mesma checagem
 * usada em `ipc.ts` para saber se há uma janela Tauri de verdade por trás.
 */
function temJanelaTauri(): boolean {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: unknown } } })
    .__TAURI_INTERNALS__;
  return Boolean(internals?.metadata?.currentWindow);
}

/**
 * A janela principal está em primeiro plano *e* visível? Cobre os dois
 * jeitos de "a pessoa não está olhando": perdeu o foco para outro app, ou
 * está minimizada (que no Windows não necessariamente tira o foco de uma
 * janela que já não aparece na tela).
 */
export async function janelaEmPrimeiroPlano(): Promise<boolean> {
  if (!temJanelaTauri()) return true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [focada, minimizada] = await Promise.all([win.isFocused(), win.isMinimized()]);
    return focada && !minimizada;
  } catch {
    return true;
  }
}

export interface NotificacaoDeTerminal {
  /** Nome do projeto/aba, para identificar de qual terminal veio. */
  titulo: string;
  /** Prévia curta do que apareceu na tela — o resumo "de bater o olho". */
  corpo: string;
}

/**
 * Dispara a notificação nativa. Não verifica foco — quem decide *quando*
 * vale a pena chamar isto é o chamador (`App.tsx`, olhando
 * `janelaEmPrimeiroPlano`); esta função só sabe emitir.
 */
export async function notificarTerminal({ titulo, corpo }: NotificacaoDeTerminal): Promise<void> {
  if (!temJanelaTauri()) return;
  const ok = await garantirPermissao();
  if (!ok) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({
      title: `JARVIS — ${titulo}`,
      body: corpo,
    });
  } catch {
    // Notificação é um extra; nunca deve virar erro visível.
  }
}
