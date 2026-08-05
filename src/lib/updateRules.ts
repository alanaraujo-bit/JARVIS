/**
 * Regras da atualização que não dependem do Tauri.
 *
 * Ficam fora de `updater.ts` de propósito: lá tudo passa por `import()`
 * dinâmico de plugin nativo e é intestável no vitest. Aqui mora a parte que
 * decide *se* incomodar o usuário e *como* descrever o que está acontecendo —
 * que é justamente a parte com casos de borda.
 */

/**
 * Compara duas versões no estilo semver simplificado.
 *
 * Devolve -1, 0 ou 1 (`a` menor, igual, maior). Sufixos de pré-lançamento
 * (`0.3.0-beta.1`) são ignorados na comparação numérica e desempatam por
 * ordem alfabética, com a versão sem sufixo ganhando de qualquer pré-release
 * — `0.3.0` é mais nova que `0.3.0-rc.1`, como manda o semver.
 *
 * Segmentos ausentes valem zero: `0.3` e `0.3.0` são a mesma coisa.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parte = (v: string) => {
    const [nums, pre = ""] = v.trim().replace(/^v/i, "").split("-", 2) as [string, string?];
    return {
      nums: nums.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre,
    };
  };

  const pa = parte(a);
  const pb = parte(b);

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }

  // Números iguais: quem não tem sufixo é a versão final, e ela vence.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/**
 * Decide se o aviso flutuante deve aparecer para esta versão.
 *
 * "Agora não" não é "nunca mais": ele silencia **aquela** versão, e uma
 * versão posterior volta a avisar. Sem isso, ou o usuário é incomodado a cada
 * abertura pela mesma versão que já recusou, ou ele perde todas as versões
 * seguintes por ter clicado uma vez no X.
 */
export function deveAvisar(nova: string, dispensada: string | null): boolean {
  if (!dispensada) return true;
  return compareVersions(nova, dispensada) > 0;
}

/**
 * Porcentagem baixada, ou `null` quando o servidor não mandou
 * `content-length`.
 *
 * `null` não é erro — é a diferença entre uma barra honesta e uma barra
 * inventada. A interface usa isso para escolher entre progresso real e
 * animação indeterminada.
 */
export function pctBaixado(baixado: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((baixado / total) * 100)));
}

/**
 * Notas da release em linhas limpas, prontas para virar `<li>`.
 *
 * O corpo vem do GitHub em markdown; renderizar markdown de verdade aqui
 * exigiria uma dependência inteira para exibir três bullets. Em vez disso as
 * marcas de lista somem e o resto vira texto — o que cobre o formato que as
 * notas do JARVIS de fato usam.
 *
 * Títulos (`## Novidades`) são descartados, não convertidos em item: o painel
 * já escreve "Novidades da 0.3.0" em cima da lista, e um título virando
 * bullet aparecia como uma novidade chamada "Novidades". Limitado a 12
 * linhas: o painel não é um changelog completo, e para isso existe a página
 * da release.
 */
export function linhasDeNotas(body: string | null): string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 12);
}

/** Quanto tempo esperar antes de reperguntar ao servidor, num app que fica dias aberto. */
export const INTERVALO_CHECAGEM_MS = 6 * 60 * 60 * 1000;

/**
 * Uma checagem automática só vale se a última foi há mais de
 * `INTERVALO_CHECAGEM_MS`. A checagem manual não passa por aqui — clicar em
 * "Procurar atualizações" tem que consultar o servidor de verdade, senão o
 * botão mente.
 */
export function podeChecarDeNovo(ultimaChecagem: number | null, agora: number): boolean {
  if (ultimaChecagem === null) return true;
  return agora - ultimaChecagem >= INTERVALO_CHECAGEM_MS;
}
