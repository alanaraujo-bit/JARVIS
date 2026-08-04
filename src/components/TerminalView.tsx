import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  b64ToBytes,
  onPtyData,
  ptyDetachView,
  ptyResize,
  ptySnapshot,
  ptyWrite,
  ptyWriteBinary,
} from "../lib/ipc";
import { theme } from "../lib/theme";

interface Props {
  sessionId: string;
  /** Sobe o foco do teclado quando o painel passa a ser o ativo. */
  focused?: boolean;
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
export function TerminalView({ sessionId, focused = true }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Identidade estável do painel, para o backend saber de quem é cada resize.
  // `useState` com inicializador preguiçoso: ao contrário do argumento de
  // `useRef`, que é avaliado (e descartado) em TODO render, o inicializador
  // de `useState` só roda uma vez. Isso importa de verdade: gerar o id a
  // partir de um contador global incrementado a cada render tornava os ids
  // não determinísticos entre recargas, o que escondia — em vez de evitar —
  // colisões de painel fantasma depois de um F5.
  const [viewId] = useState(makeViewId);

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
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.open(host);

    // WebGL acelera muito a rolagem, mas quebra em drivers antigos.
    // Perder o contexto e não tratar deixa a tela preta, então caímos
    // de volta para o renderizador DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* renderizador DOM é o fallback silencioso */
    }

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
      void ptyResize(sessionId, viewId, term.cols, term.rows)
        .then((agreed) => {
          if (disposed) return;
          // Com splits, o tamanho aplicado pode ser menor do que o pedido
          // (outro painel exibindo a mesma sessão). Sem realinhar aqui, o
          // xterm continuaria desenhando em 200 colunas enquanto o shell
          // emite pensando que a tela tem 80.
          if (agreed.cols !== term.cols || agreed.rows !== term.rows) {
            term.resize(agreed.cols, agreed.rows);
            lastSent = `${agreed.cols}x${agreed.rows}`;
          }
        })
        .catch(() => {});
    };

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
    const fila: { bytes: Uint8Array; seq: number }[] = [];

    void onPtyData(sessionId, (bytes, seq) => {
      if (disposed) return;
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

        const snap = await ptySnapshot(sessionId).catch(() => null);
        if (disposed) return;

        let corte = 0;
        if (snap) {
          term.write(b64ToBytes(snap.b64));
          corte = snap.seq;
        }

        // `seq` é o total acumulado de bytes da sessão: dá para cortar com
        // precisão de byte a parte de cada lote que o instantâneo já cobria.
        for (const item of fila) {
          const inicio = item.seq - item.bytes.length;
          if (item.seq <= corte) continue;
          term.write(
            inicio >= corte ? item.bytes : item.bytes.subarray(corte - inicio),
          );
        }
        fila.length = 0;
        applied = true;
        syncSize();
      })
      .catch(() => {});

    /* ------------------------------ entrada --------------------------- */

    const dataSub = term.onData((data) => {
      void ptyWrite(sessionId, data).catch(() => {});
    });

    // Alguns modos de reporte de mouse saem por `onBinary`, não por `onData`;
    // sem isso, a entrada de mouse de certos TUIs simplesmente some.
    const binarySub = term.onBinary((data) => {
      void ptyWriteBinary(sessionId, data).catch(() => {});
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
      unlisten?.();
      termRef.current = null;
      term.dispose();
      // O painel sumiu: o tamanho dele não deve mais limitar a sessão.
      void ptyDetachView(sessionId, viewId).catch(() => {});
    };
  }, [sessionId]);

  // Foco é um efeito separado justamente para não recriar o terminal.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return <div className="term-host" ref={hostRef} />;
}
