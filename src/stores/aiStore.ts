/**
 * Estado do painel de chat com o agente.
 *
 * O ponto delicado aqui é a ordem de assinatura dos eventos. Os eventos de
 * streaming são nomeados por id de requisição; o id é gerado aqui, os
 * ouvintes entram, e só então o backend é acionado. Assinar depois do
 * `invoke` resolver — o caminho natural quando é o backend que devolve o id —
 * perde os primeiros tokens de um Ollama local e, numa resposta curta, perde
 * o próprio `done`, deixando o painel preso em "Pensando..." para sempre.
 */

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  aiCancel,
  aiChat,
  aiModels,
  configLoad,
  configSave,
  onAiChunk,
  onAiDone,
  onAiError,
  type AiConfigPayload,
} from "../lib/ipc";
import { createChatMessage, type AiChatMessage, type AiContext } from "../lib/aiContext";
import { collabAiRelay } from "../lib/collabIpc";
import type { AiEvent as CollabAiEvent } from "../lib/collabProtocol";

export type AiProvider = AiConfigPayload["provider"];
export type AiConfig = AiConfigPayload;

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "ollama",
  endpoint: "http://localhost:11434",
  apiKey: "",
  model: "llama3",
  temperature: 0.7,
  maxTokens: 2048,
};

/** Endpoints e modelos padrão por provedor. */
export const PROVIDER_DEFAULTS: Record<AiProvider, { endpoint: string; model: string }> = {
  ollama: { endpoint: "http://localhost:11434", model: "llama3" },
  openai: { endpoint: "https://api.openai.com", model: "gpt-4o-mini" },
  anthropic: { endpoint: "https://api.anthropic.com", model: "claude-opus-5" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
};

/** Quantas mensagens de histórico acompanham cada pergunta. */
const HISTORY_LIMIT = 20;

export interface AiStore {
  panelOpen: boolean;
  settingsOpen: boolean;
  messages: AiChatMessage[];
  streaming: boolean;
  activeRequestId: string | null;
  config: AiConfig;
  availableModels: string[];
  modelsError: string | null;

  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setConfig: (patch: Partial<AiConfig>) => void;
  sendMessage: (
    content: string,
    context: AiContext,
    systemPrompt: string,
    /**
     * Presente quando a pergunta veio de uma sala compartilhada. `relayId` é
     * o id que o anfitrião já anunciou aos convidados: reaproveitá-lo (em vez
     * de gerar outro) é o que faz os pedaços da resposta chegarem grudados na
     * pergunta certa na tela deles.
     */
    shared?: { author?: { name: string; color: string }; relayId?: string },
  ) => Promise<void>;
  cancelStream: () => Promise<void>;
  clearMessages: () => void;
  loadConfig: () => Promise<void>;
  fetchModels: (config?: AiConfig) => Promise<void>;
}

/**
 * Trava de concatenação por requisição. Fica fora do estado porque não é
 * algo que a interface desenhe — é só o canal entre `cancelStream` e os
 * ouvintes já registrados de um `sendMessage` em andamento.
 */
const cancelamentos = new Map<string, () => void>();

/**
 * Erros que chegam do `invoke` vêm como string do backend ou como `Error`
 * do JS. `String(e)` num `Error` produz "Error: ..." — prefixo em inglês
 * vazando para uma interface em português.
 */
function mensagemDeErro(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAiStore = create<AiStore>((set, get) => ({
  panelOpen: false,
  settingsOpen: false,
  messages: [],
  streaming: false,
  activeRequestId: null,
  config: { ...DEFAULT_AI_CONFIG },
  availableModels: [],
  modelsError: null,

  togglePanel: () => {
    set((s) => ({ panelOpen: !s.panelOpen }));
    void configSave({ ui: { aiPanelOpen: get().panelOpen } }).catch(() => {});
  },

  setPanelOpen: (open) => set({ panelOpen: open }),

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),

  setConfig: (patch) => {
    const config = { ...get().config, ...patch };
    set({ config });
    // Só a fatia da IA: o backend faz o merge, então isso não pisa nos
    // workspaces que a barra lateral pode estar salvando ao mesmo tempo.
    void configSave({ ai: config }).catch(() => {});
  },

  sendMessage: async (content, context, systemPrompt, shared) => {
    if (get().streaming) return;

    const { config, messages } = get();
    const userMsg = createChatMessage("user", content);
    if (shared?.author) userMsg.author = shared.author;
    const assistantMsg = createChatMessage("assistant", "", true);
    const requestId = newRequestId();

    set({
      messages: [...messages, userMsg, assistantMsg],
      streaming: true,
      activeRequestId: requestId,
    });

    const history = [...messages.slice(-HISTORY_LIMIT), userMsg]
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const assinaturas: UnlistenFn[] = [];
    let encerrado = false;
    let cancelado = false;

    // Registrado antes de qualquer `await`: o usuário pode clicar em "Parar"
    // no instante seguinte ao envio, e sem isto o clique não acharia a trava.
    cancelamentos.set(requestId, () => {
      cancelado = true;
    });

    /**
     * Retransmite para a sala. Chamado no mesmo ponto em que a tela local é
     * atualizada, para as duas verem a resposta nascer junto — e envolvido em
     * `catch` porque um convidado que caiu não pode interromper a resposta que
     * o anfitrião está lendo.
     */
    const espelha = (event: CollabAiEvent) => {
      if (!shared?.relayId) return;
      void collabAiRelay(event).catch(() => {});
    };

    /** Fecha o streaming uma vez só, venha `done` ou `error`. */
    const encerra = (patch?: (m: AiChatMessage) => AiChatMessage) => {
      if (encerrado) return;
      encerrado = true;
      cancelamentos.delete(requestId);
      for (const fn of assinaturas) fn();
      set((s) => ({
        streaming: false,
        activeRequestId: null,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...(patch ? patch(m) : m), streaming: false } : m,
        ),
      }));
    };

    try {
      // Ouvintes primeiro, disparo depois — a ordem é o ponto todo.
      assinaturas.push(
        await onAiChunk(requestId, (text) => {
          // Depois de pedir o cancelamento, os tokens que ainda estavam a
          // caminho não podem continuar sendo concatenados: a frase ficava
          // embaralhada em volta do aviso de cancelamento.
          if (cancelado) return;
          espelha({ k: "chunk", requestId: shared?.relayId ?? requestId, text });
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: m.content + text } : m,
            ),
          }));
        }),
      );
      assinaturas.push(
        await onAiDone(requestId, () => {
          espelha({ k: "done", requestId: shared?.relayId ?? requestId });
          encerra((m) =>
            // Um `done` sem nenhum chunk quase sempre é modelo inexistente
            // ou filtro do provedor; um balão vazio não diria nada disso.
            m.content || m.cancelled ? m : { ...m, content: "O provedor não retornou texto." },
          );
        }),
      );
      assinaturas.push(
        await onAiError(requestId, (error) => {
          espelha({ k: "error", requestId: shared?.relayId ?? requestId, error });
          encerra((m) => ({ ...m, error }));
        }),
      );

      await aiChat({ requestId, messages: history, context, systemPrompt, config });
    } catch (e) {
      const erro = mensagemDeErro(e);
      espelha({ k: "error", requestId: shared?.relayId ?? requestId, error: erro });
      encerra((m) => ({ ...m, error: erro }));
    }
  },

  cancelStream: async () => {
    const { activeRequestId } = get();
    if (!activeRequestId) return;

    // Trava a concatenação antes de avisar o backend: os tokens já em
    // trânsito chegariam depois do aviso e o texto ficaria remontado fora de
    // ordem, com o "cancelado" enterrado no meio da frase.
    cancelamentos.get(activeRequestId)?.();

    set((s) => ({
      messages: s.messages.map((m) => (m.streaming ? { ...m, cancelled: true } : m)),
    }));

    await aiCancel(activeRequestId).catch(() => {});
    // Não mexe em `streaming` aqui: o cancelamento faz o backend emitir
    // `done`, e é o `encerra` do `sendMessage` que solta as assinaturas.
    // Zerar o estado por fora deixaria os ouvintes pendurados.
  },

  clearMessages: () => {
    if (get().streaming) return;
    set({ messages: [] });
  },

  loadConfig: async () => {
    try {
      const cfg = await configLoad();
      set({
        config: { ...DEFAULT_AI_CONFIG, ...cfg.ai },
        panelOpen: cfg.ui?.aiPanelOpen ?? false,
      });
    } catch {
      // Sem config salva — segue nos padrões.
    }
  },

  fetchModels: async (config) => {
    try {
      const models = await aiModels(config ?? get().config);
      set({ availableModels: models, modelsError: null });
    } catch (e) {
      set({ availableModels: [], modelsError: String(e) });
    }
  },
}));
