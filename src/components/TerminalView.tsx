import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  readClipboardText,
  writeClipboardText,
  saveClipboardImage,
  readClipboardImage,
  planejarColagem,
  planejarColagemDeEvento,
  type PlanoDeColagem,
} from "../lib/clipboard";
import { diffTexto } from "../lib/dictation";
import { resolverCaminhoDaImagem } from "../lib/imagePreview";
import { findPathMatches } from "../lib/pathLinks";
import { revealPath } from "../lib/ipc";
import { recordActivity } from "../lib/activityWatcher";
import { registerTerminal, unregisterTerminal } from "../lib/terminalRegistry";
import { localTransport, type TermTransport } from "../lib/termTransport";
import { theme } from "../lib/theme";
import { Icon } from "./Icon";

interface Props {
  sessionId: string;
  /** Sobe o foco do teclado quando o painel passa a ser o ativo. */
  focused?: boolean;
  /** Ctrl+F dentro do terminal pede a barra de busca ao painel. */
  onOpenSearch?: () => void;
  /**
   * De onde vêm os bytes. O padrão é a sessão local desta máquina; o modo
   * convidado passa o transporte remoto e ganha o mesmo terminal, com busca,
   * ditado e copiar/colar idênticos.
   */
  transport?: TermTransport;
  /**
   * Bloqueia a digitação. É conforto, não segurança — quem decide de fato é
   * o anfitrião, a cada tecla que chega (ver `collab/server.rs`). Aqui serve
   * para a pessoa não digitar num terminal que não vai reagir.
   */
  readOnly?: boolean;
}

// Tipos do link customizado extraídos de `Terminal.registerLinkProvider` em
// vez de importados por nome: `ILink`/`ILinkProvider` são API proposta e o
// `.d.ts` do xterm não os exporta (só o método público que os usa). Extrair
// via `Parameters`/`NonNullable` dá o mesmo tipo, sem depender de um nome que
// a lib não deixa importar.
type ProvedorDeLinks = Parameters<Terminal["registerLinkProvider"]>[0];
type LinkDeImagem = NonNullable<
  Parameters<Parameters<ProvedorDeLinks["provideLinks"]>[1]>[0]
>[number];

/** Estado do preview que aparece ao passar o mouse (ou clicar) num
 *  "[Image #N]" do terminal. `x`/`y` são coordenadas de tela (viewport). */
interface PreviewImagem {
  x: number;
  y: number;
  /** `null` quando não foi possível achar a qual colagem o placeholder se refere. */
  caminho: string | null;
  dataUrl: string | null;
  estado: "carregando" | "pronta" | "indisponivel";
  /** Fixado por clique: sobrevive ao mouse saindo, só fecha por × ou clique fora. */
  fixado: boolean;
}

/** Onde desenhar o painel, com uma folga para não estourar a tela — o
 *  preview nasce perto do cursor, então perto da borda ele precisa virar
 *  para o outro lado em vez de ser cortado. */
function posicaoDoPreview(x: number, y: number): { left: number; top: number } {
  const LARGURA_MAX = 320;
  const ALTURA_MAX = 280;
  const margem = 12;
  const estourouDireita = x + LARGURA_MAX + margem > window.innerWidth;
  const estourouBaixo = y + ALTURA_MAX + margem > window.innerHeight;
  return {
    left: Math.max(margem, estourouDireita ? x - LARGURA_MAX - 28 : x),
    top: Math.max(margem, estourouBaixo ? y - ALTURA_MAX - 28 : y),
  };
}

let viewSeq = 0;

/** Fallback só para ambientes sem `crypto.randomUUID` (não deveria ocorrer no WebView2). */
function makeViewId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `view-${Date.now()}-${++viewSeq}`;
}

/**
 * Um `<TerminalView>` = um painel exibindo uma sessão de PTY. O componente é
 * deliberadamente burro: não guarda estado de aba, só liga o xterm ao canal.
 */
export function TerminalView({
  sessionId,
  focused = true,
  onOpenSearch,
  transport,
  readOnly = false,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // O transporte fica numa ref, e não nas dependências do efeito: entrar nelas
  // faria o xterm ser destruído e recriado — perdendo scrollback, seleção e
  // contexto WebGL — se quem renderiza passasse um objeto novo. Um painel é
  // local ou remoto pela vida inteira, então a ref é sempre o que vale.
  const canal = useMemo(() => transport ?? localTransport(sessionId), [transport, sessionId]);
  const canalRef = useRef(canal);
  canalRef.current = canal;
  // Mesmo motivo: a permissão muda em pleno voo (o anfitrião troca para "só
  // ver"), e isso não pode remontar o terminal.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const termRef = useRef<Terminal | null>(null);
  // Identidade estável do painel, para o backend saber de quem é cada resize.
  // `useState` com inicializador preguiçoso: ao contrário do argumento de
  // `useRef`, que é avaliado (e descartado) em TODO render, o inicializador
  // de `useState` só roda uma vez. Isso importa de verdade: gerar o id a
  // partir de um contador global incrementado a cada render tornava os ids
  // não determinísticos entre recargas, o que escondia — em vez de evitar —
  // colisões de painel fantasma depois de um F5.
  const [viewId] = useState(makeViewId);
  const searchRef = useRef<SearchAddon | null>(null);
  const [busca, setBusca] = useState<string | null>(null);
  // Barra de ditado: um campo de texto de verdade para a ferramenta de
  // transcrição digitar, porque canvas não é alvo que ela reconheça.
  // `dictadoAnteriorRef` guarda o valor anterior do campo para o diff
  // mandar para o shell só o que mudou.
  const [dictando, setDictando] = useState(false);
  const [dictado, setDictado] = useState("");
  const dictadoAnteriorRef = useRef("");
  // Preview de imagem ao passar o mouse (ou clicar) num "[Image #N]" do
  // terminal — ver a seção "preview de imagem" dentro do efeito principal.
  // `previewElRef` é só para o clique-fora saber se o clique foi dentro do
  // próprio painel (senão ele se fecharia ao clicar nele mesmo).
  const [preview, setPreview] = useState<PreviewImagem | null>(null);
  const previewElRef = useRef<HTMLDivElement | null>(null);

  const fechaDitado = () => {
    dictadoAnteriorRef.current = "";
    setDictado("");
    setDictando(false);
    termRef.current?.focus();
  };
  // O handler de teclado do xterm é registrado uma vez só, no efeito de
  // montagem; guardar o callback numa ref evita ter que recriar o terminal
  // inteiro para trocá-lo.
  const onOpenSearchRef = useRef(onOpenSearch);
  onOpenSearchRef.current = onOpenSearch;

  // Só `sessionId` entra aqui. Qualquer outra dependência faria o xterm ser
  // destruído e recriado — perdendo scrollback, seleção e contexto WebGL — a
  // cada troca de aba.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 10_000,
      theme: theme.xterm,
      rightClickSelectsWord: true,
      // Já no construtor: um painel que nasce só de leitura não deve aceitar
      // a primeira tecla e só então descobrir a permissão pelo efeito.
      disableStdin: readOnlyRef.current,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.loadAddon(new WebLinksAddon());
    // Caminhos de arquivo/pasta que um agente imprime (ex.: "Está aqui:
    // C:\...\app-icon.png") viram links do mesmo jeito que uma URL: o xterm
    // já exige Ctrl+clique para ativar qualquer link registrado, então não
    // há nada a mais a fazer aqui para reproduzir esse gesto.
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line?.translateToString(false);
        if (!text) {
          callback(undefined);
          return;
        }
        const matches = findPathMatches(text);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          matches.map((m) => ({
            text: m.text,
            range: {
              start: { x: m.start + 1, y: bufferLineNumber },
              end: { x: m.end, y: bufferLineNumber },
            },
            activate: (_event, caminho) => {
              void revealPath(caminho).catch(() => {});
            },
          })),
        );
      },
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.open(host);

    // O painel de IA precisa das últimas linhas deste terminal para montar
    // o contexto; o buffer só existe aqui dentro.
    registerTerminal(sessionId, term);

    // WebGL acelera muito a rolagem, mas quebra em drivers antigos.
    // Perder o contexto e não tratar deixa a tela preta, então caímos
    // de volta para o renderizador DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      // O atlas de glifos vive numa textura de GPU e é reciclado sob pressão
      // (diff colorido, spinner de agente, muita cor/glifo diferente por
      // segundo — exatamente a saída de um `git diff` com um agente rodando
      // do lado). Quando o atlas troca, células que não foram redesenhadas
      // NESTE frame continuam apontando pro glifo antigo daquele pedaço de
      // textura — que pode ser lixo de qualquer coisa que passou por ali
      // antes, sem relação nenhuma com o que o PTY realmente mandou. Isso é
      // o "texto aleatório aparece do nada" que só um resize consertava
      // (porque o resize é o único gatilho que já força um refresh — ver
      // `syncSize` abaixo). Aqui cobrimos o gatilho de verdade: refresh total
      // toda vez que o atlas muda.
      // O `refresh` síncrono aqui dispara ANTES do frame que efetivamente
      // usa o atlas novo (o evento chega no meio do desenho do glifo que
      // causou a troca). Isso deixa uma corrida: o repaint forçado ainda
      // enxerga coordenadas de textura da geração anterior, então o lixo
      // sobrevive até o próximo repaint por acaso. Marcamos "pendente" e
      // forçamos o refresh de novo no primeiro `onRender` seguinte, que só
      // dispara depois que o frame com o atlas novo já foi para a tela.
      let atlasTrocouPendente = false;
      const forcarRefreshPosAtlas = () => {
        atlasTrocouPendente = true;
        term.refresh(0, term.rows - 1);
      };
      webgl.onChangeTextureAtlas(forcarRefreshPosAtlas);
      webgl.onAddTextureAtlasCanvas(forcarRefreshPosAtlas);
      term.onRender(() => {
        if (!atlasTrocouPendente) return;
        atlasTrocouPendente = false;
        term.refresh(0, term.rows - 1);
      });
      term.loadAddon(webgl);
    } catch {
      /* renderizador DOM é o fallback silencioso */
    }

    // Rede de segurança: qualquer resize que *não* passe pelos pontos já
    // tratados em `syncSize` (ex.: o próprio xterm ajustando cols/rows por
    // conta própria) também limpa o lixo de textura de um frame anterior.
    const resizeRefreshSub = term.onResize(() => term.refresh(0, term.rows - 1));

    /* ----------------------------- tamanho ---------------------------- */

    let resizeTimer: number | undefined;
    let lastSent = "";

    const syncSize = () => {
      if (disposed) return;
      // Painel escondido (`display:none`) mede zero. Sem esta guarda, o
      // `fit` não faz nada, `term.cols/rows` ficam nos padrões 80×24 e nós
      // encolheríamos o PTY de uma aba que está apenas em segundo plano —
      // refluindo todo o conteúdo dela e quebrando qualquer TUI aberto.
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      const proposed = fit.proposeDimensions();
      if (!proposed || !proposed.cols || !proposed.rows) return;

      fit.fit();
      const key = `${term.cols}x${term.rows}`;
      if (key === lastSent) return;
      lastSent = key;
      // `fit()` já reflui o xterm localmente, antes de o backend confirmar
      // nada — é aqui, alargando, que aparecem células novas que o WebGL
      // pode preencher com lixo de um frame anterior em vez de deixar em
      // branco. Ver o comentário no `refresh` de baixo para o resto da
      // história.
      term.refresh(0, term.rows - 1);
      void canalRef.current
        .resize(viewId, term.cols, term.rows)
        .then((agreed) => {
          if (disposed || !agreed) return;
          // O tamanho aplicado pode não ser o pedido: com splits, outro painel
          // exibindo a mesma sessão pode ter pedido menos; no modo convidado,
          // quem manda é o terminal do anfitrião. Sem realinhar aqui, o xterm
          // continuaria desenhando em 200 colunas enquanto o shell emite
          // pensando que a tela tem 80.
          if (agreed.cols !== term.cols || agreed.rows !== term.rows) {
            term.resize(agreed.cols, agreed.rows);
            lastSent = `${agreed.cols}x${agreed.rows}`;
            // As células que o alargamento expõe às vezes chegam com lixo do
            // renderizador WebGL — sobras de um frame anterior, não
            // conteúdo real do PTY. `refresh` força repintar tudo de novo,
            // o que basta pra sumir; sem isto, o lixo só desaparecia quando
            // outro resize (normalmente estreitar) provocava um repaint por
            // acidente — daí parecer "só bug visual" e ir embora sozinho.
            term.refresh(0, term.rows - 1);
          }
        })
        .catch(() => {});
    };

    /**
     * O tamanho mudou por decisão de fora deste painel — o anfitrião
     * redimensionou a janela dele. Aplicar direto, sem passar pelo `fit`: o
     * que vale é o tamanho do outro lado, não o espaço disponível aqui.
     */
    const pararSize = canalRef.current.onSizeChange?.((cols, rows) => {
      if (disposed) return;
      term.resize(cols, rows);
      lastSent = `${cols}x${rows}`;
      term.refresh(0, term.rows - 1);
    });

    const scheduleSync = () => {
      // Arrastar a borda da janela dispara dezenas de eventos por segundo e
      // cada resize de ConPTY reflui o buffer inteiro do conhost.
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(syncSize, 50);
    };

    /* -------------------- histórico + fluxo ao vivo -------------------- */

    // A ordem importa. O ouvinte entra primeiro e os eventos ficam na fila;
    // só então pedimos o instantâneo. Sem isso, tudo que o processo produzir
    // entre a captura do histórico e o registro do ouvinte some para sempre —
    // e o que chegar antes do instantâneo ser escrito apareceria duplicado.
    let applied = false;
    let fila: { bytes: Uint8Array; seq: number }[] = [];

    void canalRef.current
      .onData((bytes, seq) => {
        if (disposed) return;
        // Alimenta o detector de "rajada de saída seguida de silêncio" que
        // decide se vale mandar uma notificação — mesmo em segundo plano,
        // pois é justamente aí que a pessoa não está vendo o texto chegar.
        recordActivity(sessionId, bytes.length);
        if (!applied) {
          fila.push({ bytes, seq });
          return;
        }
        term.write(bytes);
      })
      .then(async (fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        await sincroniza();
      })
      .catch(() => {});

    /**
     * Casa o instantâneo com o fluxo ao vivo. Isolado numa função porque a
     * reconexão do modo convidado precisa refazer exatamente isto: o que
     * passou durante a queda não volta, e escrever o presente por cima do
     * passado deixaria um buraco silencioso no meio da tela.
     */
    async function sincroniza() {
      const snap = await canalRef.current.snapshot();
      if (disposed) return;

      let corte = 0;
      if (snap) {
        term.write(snap.bytes);
        corte = snap.seq;
      }

      // `seq` é o total acumulado de bytes da sessão: dá para cortar com
      // precisão de byte a parte de cada lote que o instantâneo já cobria.
      for (const item of fila) {
        const inicio = item.seq - item.bytes.length;
        if (item.seq <= corte) continue;
        term.write(inicio >= corte ? item.bytes : item.bytes.subarray(corte - inicio));
      }
      fila = [];
      applied = true;
      syncSize();
    }

    // A conexão voltou. `reset` limpa o buffer inteiro em vez de só a tela:
    // manter o scrollback de antes da queda colado no de depois criaria um
    // histórico que nunca existiu em nenhuma das duas máquinas.
    const pararResync = canalRef.current.onResync?.(() => {
      if (disposed) return;
      applied = false;
      fila = [];
      term.reset();
      void sincroniza();
    });

    /* ------------------------------ entrada --------------------------- */

    const dataSub = term.onData((data) => {
      if (readOnlyRef.current) return;
      canalRef.current.write(data);
    });

    /* --------------------- copiar, colar e buscar --------------------- */

    // Política explícita, no estilo do Windows Terminal:
    //
    // - Ctrl+C / Ctrl+Shift+C com seleção copiam (e limpam a seleção); sem
    //   seleção, o Ctrl+C puro segue sendo o SIGINT de sempre. Copiar com
    //   seleção ativa é o comportamento que o usuário espera no Windows;
    //   para interromper depois de selecionar, é só pressionar Ctrl+C de
    //   novo — o primeiro copia, o segundo interrompe.
    // - Ctrl+V / Ctrl+Shift+V / Shift+Insert colam. O Shift+Insert é o
    //   atalho que as ferramentas de ditado (Wispr Flow etc.) usam para
    //   colar em terminais no Windows — sem ele, o texto transcrito nunca
    //   chegava ao shell.
    // - Ctrl+Shift+G abre/fecha a barra de ditado (o D já pertence ao
    //   "dividir ao lado" do app).
    //
    // O clipboard é lido/escrito pelo plugin oficial do Tauri: o
    // `navigator.clipboard` do WebView2 falha em silêncio, e era isso que
    // deixava o copiar/colar "quase funcionando".
    // Colar imagem: o terminal só transporta texto, então o bitmap do
    // clipboard vira um PNG em disco e o que entra no shell é o *caminho* —
    // que é justamente o que os agentes de IA sabem abrir.
    const colarImagem = () => {
      void saveClipboardImage(sessionId).then((caminho) => {
        if (disposed || !caminho) return;
        imagensColadas.push(caminho);
        // Teto de segurança: uma sessão de dias a fio não deve acumular
        // milhares de entradas só para um hover eventual no preview.
        if (imagensColadas.length > 500) imagensColadas.shift();
        term.paste(caminho);
      });
    };

    const executarPlano = (plano: PlanoDeColagem) => {
      // A leitura é assíncrona: se o painel fechou enquanto o clipboard era
      // lido, o terminal já está descartado — pastar nele seria operar um
      // xterm morto.
      if (disposed) return;
      if (plano.tipo === "texto") term.paste(plano.texto);
      else if (plano.tipo === "imagem") colarImagem();
    };

    const colar = (opcoes?: { forcarImagem?: boolean }) => {
      if (opcoes?.forcarImagem) {
        executarPlano(planejarColagem("", opcoes));
        return;
      }
      void readClipboardText().then((texto) => {
        executarPlano(planejarColagem(texto, opcoes));
      });
    };

    /* --------------- preview de imagem ao passar o mouse --------------- */
    //
    // O agente (Claude Code e companhia) mostra "[Image #N]" no lugar do
    // caminho que colamos — é texto que ELE desenha no terminal, e uma vez
    // recolhido o caminho de verdade não fica em lugar nenhum do buffer para
    // a gente ler de volta. O que dá para explorar é a ORDEM: cada
    // "[Image #N]" que aparece na tela, da mais antiga para a mais nova, é
    // exatamente a N-ésima colagem que ESTE painel fez, na mesma ordem — não
    // importa como o agente numera por dentro (ele reinicia a contagem a
    // cada mensagem enviada; aqui não precisamos acompanhar isso, só a
    // ordem de aparição basta). Por segurança contra scrollback podado ou
    // `cls`, o casamento é feito **a partir do fim**: a última ocorrência na
    // tela é sempre a última colagem, a penúltima é a penúltima, e por aí
    // vai — assim uma colagem antiga que saiu do buffer não desalinha as
    // mais recentes, que são o caso que de fato importa (conferir a imagem
    // antes de mandar pro agente).
    const imagensColadas: string[] = [];
    const cachePreview = new Map<string, string>();

    /** Lê o buffer inteiro como texto, linha a linha — a única parte impura
     *  do casamento; o resto mora em `imagePreview.ts`, puro e testável. */
    const linhasDoBuffer = (): string[] => {
      const buffer = term.buffer.active;
      const linhas: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        linhas.push(buffer.getLine(i)?.translateToString(true) ?? "");
      }
      return linhas;
    };

    const resolverCaminho = (y: number, x: number): string | undefined =>
      resolverCaminhoDaImagem(linhasDoBuffer(), { linha: y - 1, coluna: x }, imagensColadas);

    // Nasce perto do cursor (não embaixo dele) para não tampar o próprio
    // texto que a pessoa está mirando.
    const MARGEM_PREVIEW = 18;

    /** `fixar`: hover de passagem (false) só aparece se nada estiver fixado
     *  ainda; clique (true) sempre mostra e fixa, mesmo trocando de imagem. */
    const mostrarPreview = (event: MouseEvent, y: number, x: number, fixar: boolean) => {
      const pos = { x: event.clientX + MARGEM_PREVIEW, y: event.clientY + MARGEM_PREVIEW };
      const caminho = resolverCaminho(y, x);
      setPreview((atual) => {
        if (!fixar && atual?.fixado) return atual; // hover não perturba o que já está fixado
        if (!caminho) {
          return { ...pos, caminho: null, dataUrl: null, estado: "indisponivel", fixado: fixar };
        }
        const emCache = cachePreview.get(caminho);
        return {
          ...pos,
          caminho,
          dataUrl: emCache ?? null,
          estado: emCache ? "pronta" : "carregando",
          fixado: fixar,
        };
      });
      if (!caminho || cachePreview.has(caminho)) return;
      void readClipboardImage(caminho).then((dataUrl) => {
        if (dataUrl) cachePreview.set(caminho, dataUrl);
        // Se o mouse já foi para outra imagem (ou saiu) enquanto isto
        // carregava, `atual.caminho` não bate mais e a resposta é descartada
        // — sem isso, uma leitura lenta poderia pintar por cima do preview
        // de uma imagem diferente que a pessoa já está olhando agora.
        setPreview((atual) =>
          !atual || atual.caminho !== caminho
            ? atual
            : { ...atual, dataUrl, estado: dataUrl ? "pronta" : "indisponivel" },
        );
      });
    };

    const esconderPreview = () => {
      setPreview((atual) => (atual?.fixado ? atual : null));
    };

    const linkProvider: ProvedorDeLinks = {
      provideLinks(bufferLineNumber, callback) {
        const linha = term.buffer.active.getLine(bufferLineNumber - 1);
        const texto = linha?.translateToString(true) ?? "";
        if (!texto.includes("[Image #")) {
          callback(undefined);
          return;
        }
        const encontrados: LinkDeImagem[] = [];
        for (const m of texto.matchAll(/\[Image #\d+\]/g)) {
          const x = m.index ?? 0;
          encontrados.push({
            range: {
              start: { x: x + 1, y: bufferLineNumber },
              end: { x: x + m[0].length, y: bufferLineNumber },
            },
            text: m[0],
            decorations: { pointerCursor: true, underline: true },
            activate: (ev) => mostrarPreview(ev, bufferLineNumber, x, true),
            hover: (ev) => mostrarPreview(ev, bufferLineNumber, x, false),
            leave: () => esconderPreview(),
          });
        }
        callback(encontrados.length ? encontrados : undefined);
      },
    };
    const linkProviderSub = term.registerLinkProvider(linkProvider);

    // Clicar fora fecha um preview fixado — sem isto ele ficaria preso na
    // tela, cobrindo o terminal, até a próxima imagem ser clicada.
    const onMouseDownFora = (e: MouseEvent) => {
      const alvo = e.target as Node;
      setPreview((atual) => {
        if (!atual?.fixado) return atual;
        if (previewElRef.current?.contains(alvo)) return atual;
        return null;
      });
    };
    document.addEventListener("mousedown", onMouseDownFora, true);

    const copiarSelecao = () => {
      const selecao = term.getSelection();
      if (!selecao) return;
      void writeClipboardText(selecao);
      term.clearSelection();
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey || e.metaKey;
      const tecla = e.key.toLowerCase();

      if (ctrl && e.shiftKey && !e.altKey && tecla === "g") {
        setDictando((aberto) => !aberto);
        return false;
      }

      // Ctrl+Alt+V cola a imagem do clipboard ignorando o texto. Sem ele não
      // dá para colar um print copiado do navegador ou do Excel, que sempre
      // vêm acompanhados de texto e por isso nunca chegariam na imagem. O
      // Ctrl+Shift+I, que seria o atalho óbvio, já é a barra de IA — e no
      // WebView2 ele também é o DevTools.
      if (ctrl && e.altKey && !e.shiftKey && tecla === "v") {
        e.preventDefault();
        colar({ forcarImagem: true });
        return false;
      }

      // Colar: Ctrl+V, Ctrl+Shift+V e Shift+Insert. `preventDefault` bloqueia
      // a ação nativa do navegador — senão ela dispararia também um evento
      // `paste` e o texto entraria duas vezes.
      if ((ctrl && tecla === "v") || (e.shiftKey && e.key === "Insert")) {
        e.preventDefault();
        colar();
        return false;
      }

      if (ctrl && tecla === "c") {
        if (term.hasSelection()) {
          copiarSelecao();
          return false;
        }
        // Ctrl+Shift+C sem seleção não é o SIGINT (que é o Ctrl+C puro);
        // sem o que copiar, a combinação é consumida e não vira ETX.
        return e.shiftKey ? false : true;
      }

      if (ctrl && !e.shiftKey && tecla === "f") {
        setBusca((atual) => atual ?? "");
        onOpenSearchRef.current?.();
        return false;
      }
      return true;
    });

    // Colagem que chega como evento nativo do navegador (o sistema entrega
    // o clipboard ao elemento focado) também precisa ir para o shell. O
    // ouvinte aqui em cima, na fase de captura, pega o texto antes do xterm
    // e o repassa com `term.paste` — que respeita o modo de colagem com
    // marcadores dos shells que o pedem (vim, nano, agentes de IA).
    const onPasteHost = (e: ClipboardEvent) => {
      const plano = planejarColagemDeEvento(e.clipboardData);
      if (plano.tipo === "nada") return;
      e.preventDefault();
      e.stopPropagation();
      executarPlano(plano);
    };
    host.addEventListener("paste", onPasteHost, true);

    // Alguns modos de reporte de mouse saem por `onBinary`, não por `onData`;
    // sem isso, a entrada de mouse de certos TUIs simplesmente some.
    const binarySub = term.onBinary((data) => {
      if (readOnlyRef.current) return;
      canalRef.current.writeBinary(data);
    });

    const ro = new ResizeObserver(scheduleSync);
    ro.observe(host);
    syncSize();

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      resizeRefreshSub.dispose();
      linkProviderSub.dispose();
      pararSize?.();
      pararResync?.();
      host.removeEventListener("paste", onPasteHost, true);
      document.removeEventListener("mousedown", onMouseDownFora, true);
      // A sessão está trocando (ou o painel está fechando): um preview preso
      // à sessão anterior não deve sobreviver para o próximo terminal.
      setPreview(null);
      unlisten?.();
      searchRef.current = null;
      unregisterTerminal(sessionId, term);
      termRef.current = null;

      // O descarte espera um macrotask de propósito. O `Viewport` do xterm
      // agenda um `setTimeout(() => this.syncScrollArea())` no próprio
      // construtor e não guarda o handle para cancelar; se o terminal for
      // descartado antes desse timer disparar, ele acorda com o serviço de
      // renderização já zerado e lança `Cannot read properties of undefined
      // (reading 'dimensions')`. Acontece de verdade: o StrictMode monta e
      // desmonta no mesmo tick, e o usuário provoca o mesmo ao fechar um
      // painel recém-aberto. Adiar um tick deixa o timer pendente rodar
      // contra um terminal ainda íntegro — timers de mesmo atraso disparam
      // na ordem em que foram agendados, e o do xterm veio primeiro.
      setTimeout(() => term.dispose(), 0);
      // O painel sumiu: o tamanho dele não deve mais limitar a sessão.
      canalRef.current.detach(viewId);
    };
  }, [sessionId]);

  /**
   * Permissão só de leitura. Efeito separado, e sem tocar no terminal em si:
   * `disableStdin` impede a digitação mas preserva seleção, rolagem e cópia —
   * que é exatamente o que "acompanhar" significa.
   */
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = readOnly;
  }, [readOnly]);

  // Foco é um efeito separado justamente para não recriar o terminal. Com a
  // barra de ditado aberta o foco é dela — reconquistar o foco do terminal
  // aqui roubaria da ferramenta de transcrição o campo onde ela digita.
  useEffect(() => {
    if (focused && !dictando) termRef.current?.focus();
  }, [focused, dictando]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={hostRef} />
      {preview && (
        <div
          className={`term-image-preview${preview.fixado ? " fixado" : ""}`}
          style={posicaoDoPreview(preview.x, preview.y)}
          ref={previewElRef}
        >
          {preview.estado === "carregando" && (
            <div className="term-image-preview-status">
              <span className="term-image-preview-spinner" />
              Carregando…
            </div>
          )}
          {preview.estado === "indisponivel" && (
            <div className="term-image-preview-status term-image-preview-erro">
              <Icon name="warning" size={14} />
              Imagem indisponível — pode ter sido colada há mais de 24h
            </div>
          )}
          {preview.estado === "pronta" && preview.dataUrl && (
            <>
              <img
                className="term-image-preview-img"
                src={preview.dataUrl}
                alt="Prévia da imagem colada no terminal"
              />
              <div className="term-image-preview-caption">
                <span className="term-image-preview-name" title={preview.caminho ?? undefined}>
                  {preview.caminho?.split(/[\\/]/).pop()}
                </span>
                {preview.fixado && (
                  <button
                    className="term-image-preview-close"
                    onClick={() => setPreview(null)}
                    title="Fechar"
                    aria-label="Fechar prévia da imagem"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {busca !== null && (
        <SearchBar
          valor={busca}
          onChange={(v) => {
            setBusca(v);
            // `findNext` a partir da posição atual dá o comportamento de
            // busca incremental, igual ao de um editor.
            if (v) searchRef.current?.findNext(v, { incremental: true });
          }}
          onNext={() => busca && searchRef.current?.findNext(busca)}
          onPrev={() => busca && searchRef.current?.findPrevious(busca)}
          onClose={() => {
            setBusca(null);
            searchRef.current?.clearDecorations();
            termRef.current?.focus();
          }}
        />
      )}
      {dictando && (
        <div className="term-dictation">
          <Icon name="mic" size={15} title="Ditado ativo" />
          <textarea
            className="term-dictation-textarea"
            autoFocus
            rows={1}
            placeholder="Fale ou cole — o texto vai digitando no shell…"
            aria-label="Modo ditado: fale ou cole para digitar no terminal"
            value={dictado}
            onChange={(e) => {
              const valor = e.target.value;
              const delta = diffTexto(dictadoAnteriorRef.current, valor);
              dictadoAnteriorRef.current = valor;
              setDictado(valor);
              if (delta && !readOnly) canal.write(delta);
            }}
            onKeyDown={(e) => {
              // Não deixa a tecla vazar para o terminal por baixo.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!readOnly) canal.write("\r");
                dictadoAnteriorRef.current = "";
                setDictado("");
              } else if (e.key === "Escape") {
                e.preventDefault();
                fechaDitado();
              }
            }}
          />
          <span className="term-dictation-hint">Enter envia · Esc fecha</span>
          <button
            className="term-dictation-close"
            onClick={fechaDitado}
            title="Fechar (Esc)"
            aria-label="Fechar modo ditado"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <button
        className={`term-dictation-toggle${dictando ? " active" : ""}`}
        onClick={() => {
          if (dictando) fechaDitado();
          else setDictando(true);
        }}
        title={
          dictando
            ? "Fechar modo ditado (Ctrl+Shift+G)"
            : "Modo ditado: campo de texto de verdade para a transcrição de voz (Ctrl+Shift+G)"
        }
        aria-label={dictando ? "Fechar modo ditado" : "Abrir modo ditado"}
      >
        <Icon name="mic" size={16} />
      </button>
    </div>
  );
}

/* ------------------------- barra de busca ------------------------------ */

interface SearchBarProps {
  valor: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

function SearchBar({ valor, onChange, onNext, onPrev, onClose }: SearchBarProps) {
  return (
    <div className="term-search">
      <input
        className="term-search-input"
        autoFocus
        placeholder="Buscar no histórico..."
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Não deixa a tecla vazar para o terminal por baixo.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button
        className="term-search-btn"
        onClick={onPrev}
        title="Anterior (Shift+Enter)"
        aria-label="Ocorrência anterior"
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        className="term-search-btn"
        onClick={onNext}
        title="Próxima (Enter)"
        aria-label="Próxima ocorrência"
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <button
        className="term-search-btn"
        onClick={onClose}
        title="Fechar (Esc)"
        aria-label="Fechar busca"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
