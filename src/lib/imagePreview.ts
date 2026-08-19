/**
 * Casamento entre o "[Image #N]" que o agente desenha no terminal e o
 * caminho do PNG que o JARVIS colou.
 *
 * O agente (Claude Code e companhia) recolhe o caminho que colamos num
 * placeholder curto assim que a linha é digitada — e uma vez recolhido, o
 * caminho de verdade não fica em lugar nenhum do buffer para ler de volta.
 * O que dá para explorar é a ORDEM: cada placeholder que aparece na tela, da
 * mais antiga para a mais nova, é exatamente a N-ésima colagem que ESTE
 * painel fez, na mesma ordem — não importa como o agente numera por dentro
 * (ele reinicia a contagem do "#N" a cada mensagem enviada; aqui não
 * precisamos acompanhar isso, só a ordem de aparição basta).
 *
 * O casamento é feito **a partir do fim**: a última ocorrência na tela é
 * sempre a última colagem, a penúltima é a penúltima, e por aí vai. Isso
 * sobrevive a scrollback podado ou a um `cls` no meio da sessão — uma
 * colagem antiga que saiu do buffer não desalinha as mais recentes, que são
 * o caso que de fato importa (conferir a imagem antes de mandar pro agente).
 *
 * Extraído de `TerminalView` para ser testável sem um xterm de verdade: a
 * parte impura (ler linhas do buffer) fica no componente, só o casamento
 * mora aqui.
 */

const PADRAO_IMAGEM = /\[Image #\d+\]/g;

/** Um placeholder "[Image #N]" encontrado nas linhas de texto do terminal. */
export interface OcorrenciaImagem {
  /** Índice da linha no array recebido (0-based, topo → base). */
  linha: number;
  /** Posição do `[` dentro do texto da linha (0-based). */
  coluna: number;
}

/** Acha todas as ocorrências de "[Image #N]", na ordem em que aparecem. */
export function acharOcorrenciasDeImagem(linhas: readonly string[]): OcorrenciaImagem[] {
  const encontradas: OcorrenciaImagem[] = [];
  linhas.forEach((texto, linha) => {
    if (!texto.includes("[Image #")) return;
    for (const m of texto.matchAll(PADRAO_IMAGEM)) {
      encontradas.push({ linha, coluna: m.index ?? 0 });
    }
  });
  return encontradas;
}

/**
 * Resolve a qual caminho colado um placeholder específico se refere.
 *
 * `historico` é a lista de caminhos colados nesta sessão, na ordem em que
 * foram colados. `undefined` quando o placeholder não está nas linhas dadas,
 * ou quando não sobra colagem correspondente no histórico.
 */
export function resolverCaminhoDaImagem(
  linhas: readonly string[],
  alvo: OcorrenciaImagem,
  historico: readonly string[],
): string | undefined {
  const ocorrencias = acharOcorrenciasDeImagem(linhas);
  const indiceAlvo = ocorrencias.findIndex(
    (o) => o.linha === alvo.linha && o.coluna === alvo.coluna,
  );
  if (indiceAlvo < 0) return undefined;
  const distanciaDoFim = ocorrencias.length - 1 - indiceAlvo;
  const indiceHistorico = historico.length - 1 - distanciaDoFim;
  return indiceHistorico >= 0 ? historico[indiceHistorico] : undefined;
}
