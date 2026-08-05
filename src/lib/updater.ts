/**
 * Atualização automática pelo próprio app.
 *
 * O manifesto (`latest.json`) e o instalador assinado vivem na release do
 * GitHub; o plugin baixa, confere a assinatura contra a chave pública de
 * `tauri.conf.json` e instala. Um pacote não assinado pela chave certa é
 * recusado — é isso que impede alguém de servir um "update" forjado.
 *
 * Nada aqui roda fora do app nativo: no navegador (dev e testes e2e) as
 * funções devolvem "sem atualização" em vez de estourar.
 */

/** O que a interface precisa saber sobre uma atualização disponível. */
export interface UpdateInfo {
  /** Versão nova, como `0.3.0`. */
  version: string;
  /** Versão instalada agora. */
  currentVersion: string;
  /** Notas da release, quando existirem. */
  notes: string | null;
  /** Executa o download e a instalação. Resolve quando está pronto. */
  install: (onProgress?: (baixado: number, total: number | null) => void) => Promise<void>;
}

/**
 * Mesma guarda de `onWindowCloseFlush`: o backend simulado instala
 * `__TAURI_INTERNALS__` para interceptar `invoke`, mas não tem janela. Testar
 * a chave raiz deixaria o `import` do plugin passar e falhar lá dentro.
 */
function noAppNativo(): boolean {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: unknown } } })
    .__TAURI_INTERNALS__;
  return !!internals?.metadata?.currentWindow;
}

/**
 * Procura uma versão nova. Devolve `null` quando já está atualizado — e
 * também quando a checagem falha.
 *
 * Falha de rede aqui não é erro do app: quem abriu o terminal sem internet
 * não pode ver um alerta vermelho por causa disso. O silêncio é intencional;
 * a próxima abertura tenta de novo.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!noAppNativo()) return null;

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? null,
      install: async (onProgress) => {
        let baixado = 0;
        let total: number | null = null;
        await update.downloadAndInstall((e) => {
          if (e.event === "Started") {
            total = e.data.contentLength ?? null;
          } else if (e.event === "Progress") {
            baixado += e.data.chunkLength;
            onProgress?.(baixado, total);
          }
        });
      },
    };
  } catch {
    return null;
  }
}

/**
 * Reabre o app na versão nova. O instalador do NSIS roda em modo `passive`,
 * então ele já fechou este processo quando chega aqui — a chamada é a rede
 * de segurança para o caso de ele devolver o controle antes de encerrar.
 */
export async function relaunchApp(): Promise<void> {
  if (!noAppNativo()) return;
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // Se o relaunch falhar, a atualização já está instalada no disco: a
    // próxima abertura manual já vem na versão nova.
  }
}
