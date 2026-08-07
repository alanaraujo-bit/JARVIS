/**
 * O terminal do computador, desenhado no celular.
 *
 * O caminho quente é o motivo de este componente existir separado: os bytes do
 * PTY chegam ~125 vezes por segundo e vão do WebSocket direto para
 * `xterm.write`, sem passar por estado do React. Um `setState` por lote
 * reconciliaria a árvore a cada 8 ms — é exatamente o tipo de coisa que se
 * sente como "atraso na digitação" sem que a rede tenha culpa nenhuma.
 *
 * O React aqui cuida só do que é raro: montar, desmontar, trocar de terminal e
 * mudar o tamanho da letra.
 */

import { useEffect, useRef } from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import { collabClient } from "../src/lib/collabClient";
import type { SharedTerminal } from "../src/lib/collabProtocol";

const codificador = new TextEncoder();

/** Mesmos limites que o anfitrião impõe (`FIT_COLS`/`FIT_ROWS` no Rust). */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

export interface Props {
  info: SharedTerminal;
  /** Encolher o terminal para caber na tela do celular. */
  ajustado: boolean;
  fonte: number;
  /** Ligado pela barra de teclas: a próxima tecla vira um controle. */
  ctrlArmado: React.RefObject<boolean>;
  onCtrlConsumido: () => void;
  /** Entrega o terminal montado para quem precisa focar ou escrever nele. */
  onPronto: (t: Terminal | null) => void;
}

/**
 * `Ctrl` + tecla, na tabela ASCII: as letras e alguns símbolos viram os
 * códigos de 0 a 31. É o mesmo mapeamento que qualquer terminal faz com a
 * tecla física — aqui ele existe porque o teclado do celular não tem `Ctrl`.
 */
function comCtrl(texto: string): string {
  if (texto.length !== 1) return texto;
  const c = texto.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  // `Ctrl+Espaço` é o NUL, e vale a pena: é como se manda um `^@`.
  if (texto === " ") return "\0";
  return texto;
}

export function TerminalRemoto({
  info,
  ajustado,
  fonte,
  ctrlArmado,
  onCtrlConsumido,
  onPronto,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Último tamanho pedido ao anfitrião, para não repetir o mesmo pedido. */
  const pedidoRef = useRef<{ cols: number; rows: number } | null>(null);

  // Lidos de dentro de callbacks que não são recriados a cada render: uma
  // dependência a mais aqui recriaria o terminal inteiro quando a pessoa
  // apenas trocasse o tamanho da letra.
  const ajustadoRef = useRef(ajustado);
  ajustadoRef.current = ajustado;
  const infoRef = useRef(info);
  infoRef.current = info;

  const { sessionId, mode } = info;

  /* --------------------------- vida do terminal -------------------------- */

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // O convidado recebe o estado da tela pronto do anfitrião; este
      // histórico é só o que rolar daqui para frente.
      scrollback: 2000,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: fonte,
      lineHeight: 1.2,
      // Quem não pode escrever também não deve receber o teclado do sistema na
      // cara ao tocar na tela.
      disableStdin: mode !== "rw",
      theme: {
        background: "#0b0f14",
        foreground: "#e6edf3",
        cursor: "#5eead4",
        selectionBackground: "#2c4f5e",
        black: "#161b22",
        brightBlack: "#485460",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(area);

    // WebGL primeiro; se o aparelho recusar o contexto, o canvas desenha
    // igual, só mais devagar. Sem o `try` o app inteiro morreria numa tela
    // preta em celulares que limitam contextos WebGL por aba.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try {
          term.loadAddon(new CanvasAddon());
        } catch {
          /* sobra o renderizador de DOM do próprio xterm */
        }
      });
      term.loadAddon(webgl);
    } catch {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        /* idem */
      }
    }

    termRef.current = term;
    fitRef.current = fit;
    onPronto(term);

    /* ---- do celular para o computador ---- */

    const mandar = (dados: string) => {
      if (infoRef.current.mode !== "rw") return;
      let saida = dados;
      if (ctrlArmado.current) {
        saida = comCtrl(dados);
        onCtrlConsumido();
      }
      collabClient.sendInput(sessionId, codificador.encode(saida));
    };

    const soltaDados = term.onData(mandar);
    const soltaBin = term.onBinary((s) => {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      collabClient.sendInput(sessionId, bytes);
    });

    /* ---- do computador para o celular ---- */

    const soltaSaida = collabClient.onData(sessionId, (bytes) => term.write(bytes));

    const soltaTamanho = collabClient.onSize(sessionId, (cols, rows) => {
      // O anfitrião é quem manda no tamanho: o PTY é um só, e ele fica do
      // tamanho do menor painel aberto. Se outra tela é mais estreita que a
      // nossa, o que vale é a dela — desenhar no tamanho que *pedimos*
      // quebraria as linhas num lugar onde o shell não quebrou.
      //
      // A exceção é um aviso **maior** do que o que pedimos, e ele não é
      // teórico: o anfitrião responde ao pedido de tela com o tamanho que
      // valia naquele instante, que pode ter sido medido antes de o nosso
      // ajuste chegar. Aceitá-lo desfaria o ajuste e o terminal voltaria a 80
      // colunas na mão da pessoa. Reafirmar converge numa ida e volta.
      const pedido = pedidoRef.current;
      if (pedido && (cols > pedido.cols || rows > pedido.rows)) {
        collabClient.fit(sessionId, pedido.cols, pedido.rows);
        return;
      }
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    });

    const pedirTela = () => {
      void collabClient.requestSnapshot(sessionId).then((snap) => {
        if (!snap || termRef.current !== term) return;
        term.reset();
        term.write(snap.bytes);
      });
    };
    // Um passo depois, e não agora: o efeito que mede a tela e manda o ajuste
    // roda logo em seguida a este, ainda no mesmo commit. Pedir a tela antes
    // disso garante que a resposta traga o tamanho de *antes* do ajuste.
    const primeiraTela = window.setTimeout(pedirTela, 0);

    // Depois de uma queda, o que se perdeu não volta. Continuar escrevendo por
    // cima deixaria um buraco silencioso no meio da tela — pedir tudo de novo
    // é mais rápido e é a única coisa honesta.
    const soltaResync = collabClient.onResync(pedirTela);

    return () => {
      window.clearTimeout(primeiraTela);
      soltaDados.dispose();
      soltaBin.dispose();
      soltaSaida();
      soltaTamanho();
      soltaResync();
      if (pedidoRef.current) collabClient.unfit(sessionId);
      pedidoRef.current = null;
      onPronto(null);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // `fonte` de propósito fora: ela é aplicada pelo efeito de baixo, sem
    // remontar o terminal (o que perderia a tela e pediria tudo de novo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mode]);

  /* ------------------------------ tamanho -------------------------------- */

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const area = areaRef.current;
    if (!term || !fit || !area) return;

    const aplicar = () => {
      const t = termRef.current;
      const f = fitRef.current;
      if (!t || !f) return;

      if (!ajustadoRef.current) {
        // Modo "tela cheia do computador": o celular mostra exatamente as
        // mesmas colunas que o anfitrião, custe o tamanho de letra que
        // custar. Nada é pedido ao outro lado — a tela dele não muda porque
        // alguém abriu o celular.
        if (pedidoRef.current) {
          collabClient.unfit(sessionId);
          pedidoRef.current = null;
        }
        const { cols, rows } = infoRef.current;

        // Encolhe a letra até as colunas do anfitrião caberem na largura.
        // A largura da célula é praticamente linear no tamanho da fonte,
        // então cada passada erra pouco e três convergem de sobra; a
        // alternativa (rolagem horizontal) obrigaria a arrastar a tela para
        // ler o fim de cada linha.
        let tamanho = fonte;
        for (let i = 0; i < 3; i++) {
          t.options.fontSize = tamanho;
          const p = f.proposeDimensions();
          if (!p || !Number.isFinite(p.cols) || p.cols <= 0 || p.cols >= cols) break;
          const menor = Math.floor((tamanho * p.cols) / cols);
          if (menor >= tamanho) break;
          tamanho = Math.max(5, menor);
        }
        if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
        return;
      }

      t.options.fontSize = fonte;
      const proposto = f.proposeDimensions();
      if (!proposto || !Number.isFinite(proposto.cols) || !Number.isFinite(proposto.rows)) return;
      const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, proposto.cols));
      const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, proposto.rows));

      const anterior = pedidoRef.current;
      if (anterior && anterior.cols === cols && anterior.rows === rows) return;
      pedidoRef.current = { cols, rows };
      collabClient.fit(sessionId, cols, rows);
      // Redesenha já, sem esperar a confirmação: o anfitrião responde com o
      // tamanho acordado em seguida e corrige, se for o caso.
      t.resize(cols, rows);
    };

    aplicar();

    // O teclado abrindo muda a altura da área; a rotação muda as duas
    // dimensões. Um observador cobre os dois sem `resize` de janela, que no
    // iOS não dispara quando o teclado aparece.
    const observador = new ResizeObserver(() => aplicar());
    observador.observe(area);

    // Mudança de densidade da tela: o zoom do navegador e o ajuste de
    // "tamanho da tela" do Android mexem no `devicePixelRatio` sem mexer em
    // um único pixel de layout — nada disso chega pelo `ResizeObserver`. O
    // xterm redesenha com a densidade nova, e a medida da célula muda junto;
    // sem remedir aqui, o número de colunas continuaria o da densidade
    // antiga e o texto passaria a ser cortado na largura.
    const densidade = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const mudouDensidade = () => {
      term.clearTextureAtlas();
      aplicar();
    };
    densidade.addEventListener("change", mudouDensidade);

    return () => {
      observador.disconnect();
      densidade.removeEventListener("change", mudouDensidade);
    };
  }, [ajustado, fonte, sessionId, info.cols, info.rows]);

  return (
    <div
      className={`terminal-area ${ajustado ? "ajustado" : "real"}`}
      ref={areaRef}
      // O terminal já é uma área de rolagem própria; deixar a página rolar
      // junto faria o app inteiro balançar a cada arrasto.
      onTouchMove={(e) => e.stopPropagation()}
    />
  );
}
