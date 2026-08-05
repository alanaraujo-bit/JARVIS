/**
 * Atualização automática pelo próprio app.
 *
 * O manifesto (`latest.json`) e o instalador assinado vivem na release do
 * GitHub; o plugin baixa, confere a assinatura contra a chave pública de
 * `tauri.conf.json` e instala. Um pacote não assinado pela chave certa é
 * recusado — é isso que impede alguém de servir um "update" forjado.
 *
 * Nada aqui roda fora do app nativo: no navegador (dev e testes e2e) as
 * funções devolvem `indisponivel` em vez de estourar.
 *
 * A decisão de *quando* checar e *o que mostrar* não mora aqui — está no
 * `updateStore`, que orquestra, e no `updateRules`, que decide. Este arquivo
 * é só a ponte com o plugin nativo.
 */

/** O que a interface precisa saber sobre uma atualização disponível. */
export interface UpdateInfo {
  /** Versão nova, como `0.3.0`. */
  version: string;
  /** Versão instalada agora. */
  currentVersion: string;
  /** Notas da release, quando existirem. */
  notes: string | null;
  /** Data de publicação em ISO, quando o manifesto trouxer. */
  publishedAt: string | null;
  /** Executa o download e a instalação. Resolve quando está pronto. */
  install: (onProgress?: (baixado: number, total: number | null) => void) => Promise<void>;
}

/**
 * Resultado de uma checagem.
 *
 * Erro é um estado de primeira classe, e não um `null` disfarçado: quem
 * clicou em "Procurar atualizações" precisa saber a diferença entre "você
 * está na última versão" e "não consegui falar com o servidor". Foi
 * exatamente essa confusão que fez a versão anterior engolir toda falha em
 * silêncio.
 */
export type CheckResult =
  | { status: "disponivel"; update: UpdateInfo }
  | { status: "atualizado"; version: string }
  | { status: "erro"; message: string }
  /** Fora do app nativo (navegador, dev, e2e): não há o que checar. */
  | { status: "indisponivel" };

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
 * Versão instalada, lida do binário — não do `package.json`, que é o número
 * de quem compilou e não necessariamente o de quem está rodando.
 *
 * Devolve `null` fora do app nativo.
 */
export async function currentVersion(): Promise<string | null> {
  if (!noAppNativo()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * Consulta o endpoint de atualização.
 *
 * Nunca lança: toda falha vira `{ status: "erro" }` com a mensagem original,
 * porque a interface tem lugar para mostrá-la e um `throw` aqui derrubaria a
 * checagem de fundo que roda sozinha de tempos em tempos.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!noAppNativo()) return { status: "indisponivel" };

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (!update) {
      const versao = (await currentVersion()) ?? "";
      return { status: "atualizado", version: versao };
    }

    return {
      status: "disponivel",
      update: {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
        publishedAt: update.date ?? null,
        install: async (onProgress) => {
          let baixado = 0;
          let total: number | null = null;
          await update.downloadAndInstall((e) => {
            if (e.event === "Started") {
              total = e.data.contentLength ?? null;
              onProgress?.(0, total);
            } else if (e.event === "Progress") {
              baixado += e.data.chunkLength;
              onProgress?.(baixado, total);
            }
          });
        },
      },
    };
  } catch (e) {
    return { status: "erro", message: mensagemDeErro(e) };
  }
}

/**
 * Traduz a falha do plugin para algo que sirva na tela.
 *
 * As mensagens do plugin são em inglês e técnicas ("Network Error: error
 * sending request for url..."). Os casos que de fato acontecem na vida real
 * ganham um texto próprio; o resto passa cru, porque uma mensagem estranha
 * ainda é melhor que "erro desconhecido" quando alguém precisa reportar o
 * problema.
 */
function mensagemDeErro(e: unknown): string {
  const bruto = e instanceof Error ? e.message : String(e);

  if (/network|dns|connect|timeout|sending request/i.test(bruto)) {
    return "Não consegui falar com o servidor de atualizações. Verifique sua conexão.";
  }
  if (/signature|verif/i.test(bruto)) {
    return "A assinatura do pacote não confere — a atualização foi recusada por segurança.";
  }
  if (/404|not found/i.test(bruto)) {
    return "O servidor não tem um manifesto de atualização publicado no momento.";
  }
  return bruto;
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
