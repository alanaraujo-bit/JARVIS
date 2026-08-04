import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
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
import { registerTerminal, unregisterTerminal } from "../lib/terminalRegistry";
import { theme } from "../lib/theme";

interface Props {
  sessionId: string;
  /** Sobe o foco do teclado quando o painel passa a ser o ativo. */
  focused?: boolean;
  /** Ctrl+F dentro do terminal pede a barra de busca ao painel. */
  onOpenSearch?: () => void;
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
export function TerminalView({ sessionId, focused = true, onOpenSearch }: Props) {
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
  const searchRef = useRef<SearchAddon | null>(null);
  const [busca, setBusca] = useState<string | null>(null);
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
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.loadAddon(new WebLinksAddon());
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

    /* --------------------- copiar, colar e buscar --------------------- */

    // Sem uma política explícita, o comportamento é o que o WebView der de
    // brinde — e o padrão do Chromium faz Ctrl+C copiar quando há seleção,
    // o que rouba o único jeito de interromper um processo travado.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return true;

      // Ctrl+Shift+C / Ctrl+Shift+V: convenção de terminal no Windows e no
      // Linux, e não colide com nada que o shell reivindique.
      if (e.shiftKey && e.key.toLowerCase() === "c") {
        const selecao = term.getSelection();
        if (selecao) void navigator.clipboard.writeText(selecao).catch(() => {});
        return false;
      }
      if (e.shiftKey && e.key.toLowerCase() === "v") {
        void navigator.clipboard
          .readText()
          .then((texto) => {
            if (texto) void ptyWrite(sessionId, texto);
          })
          .catch(() => {});
        return false;
      }

      // Ctrl+C com seleção: limpa a seleção e deixa o SIGINT passar. Copiar
      // aqui deixaria o usuário sem forma de matar um processo travado logo
      // depois de ter selecionado algo para ler.
      if (!e.shiftKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
        term.clearSelection();
        return true;
      }

      if (!e.shiftKey && e.key.toLowerCase() === "f") {
        setBusca((atual) => atual ?? "");
        onOpenSearchRef.current?.();
        return false;
      }
      return true;
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
      void ptyDetachView(sessionId, viewId).catch(() => {});
    };
  }, [sessionId]);

  // Foco é um efeito separado justamente para não recriar o terminal.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={hostRef} />
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
      <button className="term-search-btn" onClick={onPrev} title="Anterior (Shift+Enter)">
        ↑
      </button>
      <button className="term-search-btn" onClick={onNext} title="Próxima (Enter)">
        ↓
      </button>
      <button className="term-search-btn" onClick={onClose} title="Fechar (Esc)">
        ×
      </button>
    </div>
  );
}
