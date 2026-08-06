/**
 * De onde um painel de terminal tira os bytes que desenha, e para onde manda
 * o que é digitado.
 *
 * Existe para que `TerminalView` não precise saber se a sessão está nesta
 * máquina ou na de outra pessoa. O ganho não é arquitetural por esporte: a
 * busca com `Ctrl+F`, o modo ditado, a política de copiar/colar do Windows e
 * o acerto de tamanho contra o PTY foram todos resolvidos uma vez naquele
 * componente. Um segundo componente "igual, mas remoto" nasceria com metade
 * disso e envelheceria diferente do original.
 *
 * As duas implementações diferem em um ponto que vale destacar: **o convidado
 * não negocia tamanho**. O `resize` local registra o painel no motor de PTY e
 * recebe de volta o tamanho de consenso; o remoto ignora o que o painel pediu
 * e devolve o tamanho que o anfitrião está usando. É o que mantém as duas
 * telas idênticas caractere a caractere, em vez de a janela do convidado
 * encolher o terminal de quem está trabalhando.
 */

import {
  onPtyData,
  ptyDetachView,
  ptyResize,
  ptySnapshot,
  ptyWrite,
  ptyWriteBinary,
  b64ToBytes,
} from "./ipc";
import { collabClient } from "./collabClient";

export interface TermTransport {
  readonly kind: "local" | "remote";
  /** Fluxo ao vivo. Devolve como cancelar a assinatura. */
  onData(cb: (bytes: Uint8Array, seq: number) => void): Promise<() => void>;
  /** Estado atual da tela, para o painel nascer com conteúdo. */
  snapshot(): Promise<{ bytes: Uint8Array; seq: number } | null>;
  write(text: string): void;
  /** Relatos de mouse do xterm, onde cada caractere já é um byte. */
  writeBinary(latin1: string): void;
  /** `null` quando não há tamanho a acertar (sessão morta, sala caiu). */
  resize(viewId: string, cols: number, rows: number): Promise<{ cols: number; rows: number } | null>;
  detach(viewId: string): void;
  /** O tamanho mudou por decisão de fora deste painel. */
  onSizeChange?(cb: (cols: number, rows: number) => void): () => void;
  /** A conexão voltou: limpe a tela e peça o estado de novo. */
  onResync?(cb: () => void): () => void;
}

const encoder = new TextEncoder();

/* ------------------------------- local ---------------------------------- */

function criaLocal(sessionId: string): TermTransport {
  return {
    kind: "local",
    onData: (cb) => onPtyData(sessionId, cb),
    snapshot: async () => {
      const snap = await ptySnapshot(sessionId).catch(() => null);
      return snap ? { bytes: b64ToBytes(snap.b64), seq: snap.seq } : null;
    },
    write: (text) => void ptyWrite(sessionId, text).catch(() => {}),
    writeBinary: (data) => void ptyWriteBinary(sessionId, data).catch(() => {}),
    resize: (viewId, cols, rows) =>
      ptyResize(sessionId, viewId, cols, rows).catch(() => null),
    detach: (viewId) => void ptyDetachView(sessionId, viewId).catch(() => {}),
  };
}

/* ------------------------------- remoto --------------------------------- */

function criaRemoto(sessionId: string): TermTransport {
  return {
    kind: "remote",
    onData: async (cb) => collabClient.onData(sessionId, cb),
    snapshot: () => collabClient.requestSnapshot(sessionId),
    write: (text) => collabClient.sendInput(sessionId, encoder.encode(text)),
    writeBinary: (data) => {
      // `onBinary` do xterm entrega uma string em que cada caractere é um
      // byte; `TextEncoder` a transformaria em UTF-8 e corromperia o relato.
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      collabClient.sendInput(sessionId, bytes);
    },
    // O painel do convidado se ajusta ao anfitrião, nunca o contrário.
    resize: async () => {
      const t = collabClient
        .snapshotState()
        .terminals.find((x) => x.sessionId === sessionId);
      return t ? { cols: t.cols, rows: t.rows } : null;
    },
    detach: () => {},
    onSizeChange: (cb) => collabClient.onSize(sessionId, cb),
    onResync: (cb) => collabClient.onResync(cb),
  };
}

/* ------------------------------ fábricas -------------------------------- */

// Memorizados por sessão: `TerminalView` guarda o transporte numa ref e não
// o recria a cada render, mas quem o passa como prop chamaria a fábrica em
// todo render. Uma identidade estável evita que uma futura dependência de
// efeito destrua e recrie o xterm — perdendo scrollback e contexto WebGL —
// por causa de um objeto novo.
const locais = new Map<string, TermTransport>();
const remotos = new Map<string, TermTransport>();

export function localTransport(sessionId: string): TermTransport {
  let t = locais.get(sessionId);
  if (!t) {
    t = criaLocal(sessionId);
    locais.set(sessionId, t);
  }
  return t;
}

export function remoteTransport(sessionId: string): TermTransport {
  let t = remotos.get(sessionId);
  if (!t) {
    t = criaRemoto(sessionId);
    remotos.set(sessionId, t);
  }
  return t;
}

/** Solta os transportes de uma sessão que não existe mais. */
export function forgetTransport(sessionId: string) {
  locais.delete(sessionId);
  remotos.delete(sessionId);
}
