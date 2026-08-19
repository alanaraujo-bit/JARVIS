/**
 * Reconhece caminhos de arquivo/pasta do Windows no texto que o terminal
 * imprime (ex.: quando um agente de IA cita `C:\Users\...\arquivo.png`) e
 * devolve os links prontos para o `registerLinkProvider` do xterm.
 *
 * Só a regra pura fica aqui — sem tocar em xterm ou Tauri — para poder ser
 * testada com strings soltas.
 */

/** Um trecho de `text` que parece um caminho, com sua posição (base 0). */
export interface PathMatch {
  text: string;
  start: number;
  end: number;
}

// Unidade + `:\` ou `:/`, seguido de qualquer coisa que não seja um
// caractere proibido em nomes de arquivo do Windows nem espaço — mas espaços
// *dentro* do caminho são comuns ("Alan Araujo"), então a regra real é: para
// no fim da linha ou num caractere que claramente não pertence a um caminho
// (`<>"|`, ou aspas). Barras invertidas e normais são aceitas porque agentes
// de IA às vezes imprimem caminhos com `/` mesmo no Windows.
const CAMINHO = /[A-Za-z]:[\\/][^\n\r<>"|]*/g;

// Pontuação que só está ali por causa da frase ao redor ("está aqui: C:\...")
// e não faz parte do caminho.
const LIXO_NO_FIM = /[.,;:!?)\]'"*]+$/;

export function findPathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  CAMINHO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CAMINHO.exec(text))) {
    let raw = m[0];
    // Uma frase inteira depois do caminho (comum em prosa de agente) vira
    // parte do match por causa dos espaços aceitos acima; corta no primeiro
    // grupo de 2+ espaços, que normalmente separa o caminho do resto.
    const espacoDuplo = raw.search(/ {2,}/);
    if (espacoDuplo >= 0) raw = raw.slice(0, espacoDuplo);
    raw = raw.replace(LIXO_NO_FIM, "");
    // `C:\` sozinho ou algo menor que isso não vale a pena virar link.
    if (raw.length < 4) continue;
    out.push({ text: raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}
