/**
 * Estado do trabalho compartilhado nas duas pontas.
 *
 * As duas convivem no mesmo store de propósito, e não por economia: quem
 * hospeda uma sala pode, na mesma sessão, entrar na sala de outra pessoa. Um
 * store por papel obrigaria a interface a decidir a qual perguntar antes de
 * conseguir desenhar qualquer coisa.
 *
 * A regra que mantém isso simples: **o anfitrião nunca é o dono do estado da
 * sala** — o dono é o backend, que empurra o estado inteiro a cada mudança
 * (`collab:state`). Este store espelha o que chega. Sem isso, uma entrada
 * aprovada e um terminal fechado no mesmo instante exigiriam reconciliação
 * aqui, e ela erraria em algum caso que ninguém testou.
 */

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  collabChat,
  collabDecide,
  collabKick,
  collabSetApproval,
  collabShare,
  collabStart,
  collabState,
  collabStop,
  collabTunnelDownload,
  collabTunnelStart,
  collabTunnelStop,
  collabUnshare,
  onCollabState,
  type HostState,
  type StartOptions,
} from "../lib/collabIpc";
import { collabClient, type GuestSnapshot } from "../lib/collabClient";
import type { AiEvent, Mode } from "../lib/collabProtocol";
import { forgetTransport } from "../lib/termTransport";

/** Uma fala da conversa com a IA, do jeito que o convidado a vê. */
export interface SharedAiMessage {
  requestId: string;
  authorName: string;
  authorColor: string;
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}

/** Qual das duas telas está em uso. */
export type CollabView = "host" | "guest";

/** Como o convidado se identifica. Guardado entre sessões. */
const CHAVE_NOME = "jarvis.collab.nome";
const CHAVE_ENDERECO = "jarvis.collab.endereco";

export interface CollabStore {
  view: CollabView;
  /** A tela de colaboração está aberta. */
  panelOpen: boolean;

  host: HostState;
  /** Falha da última ação do anfitrião, para a tela poder explicar. */
  hostError: string | null;
  starting: boolean;

  guest: GuestSnapshot;
  guestName: string;
  guestAddress: string;
  guestCode: string;
  /** Conversa com a IA vista pelo convidado. */
  sharedAi: SharedAiMessage[];

  setView: (v: CollabView) => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  /** Liga os ouvintes do backend. Devolve como desligá-los. */
  init: () => Promise<() => void>;

  start: (opts: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
  share: (sessionId: string, mode: Mode, title?: string) => Promise<void>;
  unshare: (sessionId: string) => Promise<void>;
  setApproval: (require: boolean) => Promise<void>;
  decide: (id: string, approve: boolean) => Promise<void>;
  kick: (id: string) => Promise<void>;
  sayAsHost: (text: string) => Promise<void>;
  tunnelUp: () => Promise<void>;
  tunnelDown: () => Promise<void>;
  downloadTunnel: () => Promise<void>;

  setGuestField: (patch: { name?: string; address?: string; code?: string }) => void;
  join: () => void;
  leave: () => void;
  sayAsGuest: (text: string) => void;
  askAiAsGuest: (text: string) => void;
}

function mensagemDeErro(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function leGuardado(chave: string, padrao = ""): string {
  try {
    return window.localStorage.getItem(chave) ?? padrao;
  } catch {
    return padrao;
  }
}

function guarda(chave: string, valor: string) {
  try {
    window.localStorage.setItem(chave, valor);
  } catch {
    /* modo privado, cota cheia — nada aqui vale uma exceção */
  }
}

const HOST_VAZIO: HostState = { active: false, room: null };

/**
 * Aplica um evento da IA à conversa compartilhada.
 *
 * Fora do store para ser testável sem React nem Tauri: a montagem de uma
 * resposta a partir de pedaços que chegam soltos é a parte com mais chance de
 * errar, e é justamente a que não se enxerga olhando a tela.
 */
export function aplicaAi(lista: SharedAiMessage[], e: AiEvent): SharedAiMessage[] {
  switch (e.k) {
    case "ask":
      return [
        ...lista,
        {
          requestId: e.requestId,
          authorName: e.authorName,
          authorColor: e.authorColor,
          question: e.text,
          answer: "",
          streaming: true,
        },
      ].slice(-100);
    case "chunk":
      return lista.map((m) =>
        m.requestId === e.requestId ? { ...m, answer: m.answer + e.text } : m,
      );
    case "done":
      return lista.map((m) =>
        m.requestId === e.requestId ? { ...m, streaming: false } : m,
      );
    case "error":
      return lista.map((m) =>
        m.requestId === e.requestId ? { ...m, streaming: false, error: e.error } : m,
      );
  }
}

export const useCollabStore = create<CollabStore>((set, get) => ({
  view: "host",
  panelOpen: false,

  host: HOST_VAZIO,
  hostError: null,
  starting: false,

  guest: collabClient.snapshotState(),
  guestName: leGuardado(CHAVE_NOME),
  guestAddress: leGuardado(CHAVE_ENDERECO),
  guestCode: "",
  sharedAi: [],

  setView: (v) => set({ view: v }),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  init: async () => {
    const desassinar: (UnlistenFn | (() => void))[] = [];

    desassinar.push(await onCollabState((s) => set({ host: s })));
    desassinar.push(collabClient.subscribe((g) => set({ guest: g })));
    desassinar.push(collabClient.onAi((e) => set((s) => ({ sharedAi: aplicaAi(s.sharedAi, e) }))));
    // Um terminal remoto que sumiu da sala não volta: soltar o transporte
    // dele evita segurar callbacks de um painel que nunca mais será montado.
    desassinar.push(
      collabClient.onExit((sessionId) => {
        forgetTransport(sessionId);
      }),
    );

    // O estado pode já existir quando esta tela monta (F5 com a sala aberta).
    await collabState()
      .then((s) => set({ host: s }))
      .catch(() => {});

    return () => {
      for (const fn of desassinar) fn();
    };
  },

  /* ------------------------------ anfitrião ---------------------------- */

  start: async (opts) => {
    if (get().starting) return;
    set({ starting: true, hostError: null });
    try {
      set({ host: await collabStart(opts) });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    } finally {
      set({ starting: false });
    }
  },

  stop: async () => {
    try {
      set({ host: await collabStop(), hostError: null });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  share: async (sessionId, mode, title) => {
    try {
      set({ host: await collabShare(sessionId, mode, title), hostError: null });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  unshare: async (sessionId) => {
    try {
      set({ host: await collabUnshare(sessionId), hostError: null });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  setApproval: async (require) => {
    try {
      set({ host: await collabSetApproval(require) });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  decide: async (id, approve) => {
    try {
      set({ host: await collabDecide(id, approve) });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  kick: async (id) => {
    try {
      set({ host: await collabKick(id) });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  sayAsHost: async (text) => {
    if (!text.trim()) return;
    try {
      set({ host: await collabChat(text) });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  tunnelUp: async () => {
    set({ hostError: null });
    try {
      set({ host: await collabTunnelStart() });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  tunnelDown: async () => {
    try {
      set({ host: await collabTunnelStop() });
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  downloadTunnel: async () => {
    set({ hostError: null });
    try {
      await collabTunnelDownload();
    } catch (e) {
      set({ hostError: mensagemDeErro(e) });
    }
  },

  /* ------------------------------ convidado ---------------------------- */

  setGuestField: (patch) => {
    if (patch.name !== undefined) {
      set({ guestName: patch.name });
      guarda(CHAVE_NOME, patch.name);
    }
    if (patch.address !== undefined) {
      set({ guestAddress: patch.address });
      guarda(CHAVE_ENDERECO, patch.address);
    }
    if (patch.code !== undefined) set({ guestCode: patch.code });
  },

  join: () => {
    const { guestAddress, guestCode, guestName } = get();
    set({ sharedAi: [] });
    collabClient.connect({
      address: guestAddress,
      code: guestCode,
      name: guestName || "Convidado",
    });
  },

  leave: () => {
    collabClient.reset();
    set({ sharedAi: [] });
  },

  sayAsGuest: (text) => {
    if (text.trim()) collabClient.sendChat(text);
  },

  askAiAsGuest: (text) => {
    if (text.trim()) collabClient.askAi(text);
  },
}));
