/**
 * Comandos do trabalho compartilhado, lado anfitrião.
 *
 * Fica separado de `ipc.ts` porque é a fronteira de uma funcionalidade
 * inteira, e não mais um punhado de comandos: quem lê `ipc.ts` procurando
 * como um terminal nasce não deveria esbarrar em salas e túneis pelo caminho.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AiEvent, ChatMessage, Mode, Participant, SharedTerminal } from "./collabProtocol";

export type TunnelState =
  | { status: "off" }
  | { status: "missing" }
  | { status: "downloading"; percent: number }
  | { status: "starting" }
  | { status: "up"; url: string }
  | { status: "error"; message: string };

export interface PendingJoin {
  id: string;
  name: string;
  at: number;
}

export interface HostRoom {
  name: string;
  hostName: string;
  code: string;
  port: number;
  /** `ws://ip:porta` desta máquina na rede local, se houver uma. */
  lanUrl: string | null;
  /** Endereço público, quando o túnel está no ar. */
  publicUrl: string | null;
  tunnel: TunnelState;
  requireApproval: boolean;
  terminals: SharedTerminal[];
  participants: Participant[];
  pending: PendingJoin[];
  chat: ChatMessage[];
  startedAt: number;
}

export interface HostState {
  active: boolean;
  room: HostRoom | null;
}

export interface StartOptions {
  name?: string;
  hostName?: string;
  /** `0` deixa o sistema escolher uma porta livre. */
  port?: number;
  requireApproval?: boolean;
  public?: boolean;
}

/** Estado da sala mudou (alguém entrou, o túnel subiu, um terminal saiu). */
const EV_COLLAB = "collab:state";
/** Um convidado perguntou algo à IA; quem responde é a tela do anfitrião. */
const EV_COLLAB_AI = "collab:ai-ask";

export const collabStart = (opts: StartOptions) =>
  invoke<HostState>("collab_start", { opts });

export const collabStop = () => invoke<HostState>("collab_stop");

export const collabState = () => invoke<HostState>("collab_state");

export const collabShare = (id: string, mode: Mode, title?: string) =>
  invoke<HostState>("collab_share", { id, mode, title });

export const collabUnshare = (id: string) => invoke<HostState>("collab_unshare", { id });

export const collabSetApproval = (require: boolean) =>
  invoke<HostState>("collab_set_approval", { require });

export const collabDecide = (id: string, approve: boolean) =>
  invoke<HostState>("collab_decide", { id, approve });

export const collabKick = (id: string) => invoke<HostState>("collab_kick", { id });

export const collabChat = (text: string) => invoke<HostState>("collab_chat", { text });

/** Espelha na sala uma pergunta feita pelo próprio anfitrião. */
export const collabAiAsk = (text: string) => invoke<void>("collab_ai_ask", { text });

export const collabAiRelay = (event: AiEvent) => invoke<void>("collab_ai_relay", { event });

export const collabTunnelAvailable = () => invoke<boolean>("collab_tunnel_available");

export const collabTunnelDownload = () => invoke<boolean>("collab_tunnel_download");

export const collabTunnelStart = () => invoke<HostState>("collab_tunnel_start");

export const collabTunnelStop = () => invoke<HostState>("collab_tunnel_stop");

export const onCollabState = (cb: (s: HostState) => void): Promise<UnlistenFn> =>
  listen<HostState>(EV_COLLAB, (e) => cb(e.payload));

export const onCollabAiAsk = (cb: (e: AiEvent) => void): Promise<UnlistenFn> =>
  listen<AiEvent>(EV_COLLAB_AI, (e) => cb(e.payload));
