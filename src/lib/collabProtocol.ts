/**
 * Espelho de `src-tauri/src/collab/protocol.rs`. Os dois lados mudam juntos.
 *
 * A divisão entre quadro binário e mensagem JSON não é estética: a saída do
 * terminal chega ~125 vezes por segundo por sessão ativa, e passá-la por
 * base64 dentro de um JSON custaria um terço a mais de banda e uma decodagem
 * de string no caminho quente da renderização. O que é raro (alguém entrou,
 * alguém falou) continua em JSON, onde a clareza vale mais que os bytes.
 */

export const PROTOCOL_VERSION = 1;

export const OP_DATA = 0x01;
export const OP_INPUT = 0x02;
export const OP_SNAPSHOT = 0x03;

export type Mode = "ro" | "rw";
export type Role = "host" | "guest";

export interface SharedTerminal {
  sessionId: string;
  title: string;
  mode: Mode;
  cols: number;
  rows: number;
  alive: boolean;
  folder: string | null;
}

export interface Participant {
  id: string;
  name: string;
  color: string;
  role: Role;
  online: boolean;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  at: number;
}

export interface RoomInfo {
  name: string;
  hostName: string;
  revision: number;
}

export type AiEvent =
  | { k: "ask"; requestId: string; authorName: string; authorColor: string; text: string }
  | { k: "chunk"; requestId: string; text: string }
  | { k: "done"; requestId: string }
  | { k: "error"; requestId: string; error: string };

export type ServerMsg =
  | {
      t: "welcome";
      you: Participant;
      room: RoomInfo;
      terminals: SharedTerminal[];
      participants: Participant[];
      chat: ChatMessage[];
      resumeToken: string;
    }
  | { t: "pending"; roomName: string; hostName: string }
  | { t: "denied"; reason: string }
  | { t: "terminals"; terminals: SharedTerminal[]; revision: number }
  | { t: "participants"; participants: Participant[]; revision: number }
  | { t: "chat"; message: ChatMessage }
  | { t: "exit"; sessionId: string; exitCode: number }
  | { t: "size"; sessionId: string; cols: number; rows: number }
  | { t: "ai"; event: AiEvent }
  | { t: "pong"; t0: number }
  | { t: "bye"; reason: string };

export type ClientMsg =
  | { t: "hello"; version: number; code: string; name: string; resumeToken?: string | null }
  | { t: "chat"; text: string }
  | { t: "ai"; text: string }
  | { t: "snapshot"; sessionId: string }
  | { t: "ping"; t0: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Monta `[op][tamanho do id][id][conteúdo]` para a entrada do convidado. */
export function encodeInput(sessionId: string, payload: Uint8Array): Uint8Array {
  const id = encoder.encode(sessionId);
  const out = new Uint8Array(2 + id.length + payload.length);
  out[0] = OP_INPUT;
  out[1] = id.length;
  out.set(id, 2);
  out.set(payload, 2 + id.length);
  return out;
}

export interface BinaryFrame {
  op: number;
  sessionId: string;
  seq: number;
  payload: Uint8Array;
}

/**
 * Lê `[op][tamanho do id][id][seq de 8 bytes][conteúdo]`.
 *
 * Devolve `null` para qualquer coisa truncada em vez de lançar: um quadro
 * malformado é motivo para ignorar aquele quadro, nunca para derrubar a
 * conexão inteira e perder o terminal da tela.
 */
export function decodeFrame(buf: ArrayBuffer): BinaryFrame | null {
  const view = new Uint8Array(buf);
  if (view.length < 2) return null;
  const idLen = view[1];
  const fimId = 2 + idLen;
  if (view.length < fimId + 8) return null;
  const sessionId = decoder.decode(view.subarray(2, fimId));
  // `getBigUint64` e não dois `getUint32`: o contador é o total acumulado de
  // bytes da sessão e passa de 4 GB num `npm run dev` que ficou dias no ar.
  const seq = Number(new DataView(buf).getBigUint64(fimId));
  return { op: view[0], sessionId, seq, payload: view.subarray(fimId + 8) };
}

/**
 * Aceita o endereço como a pessoa cola e devolve algo que o `WebSocket`
 * entende.
 *
 * Isso existe porque o anfitrião tem dois endereços de natureza diferente: o
 * da rede local já é `ws://ip:porta`, e o do túnel é um `https://…` que a
 * pessoa copia do navegador ou recebe por mensagem. Exigir que ela saiba
 * converter um no outro seria transferir um detalhe de protocolo para quem só
 * quer entrar numa sala.
 */
export function normalizeAddress(bruto: string): string | null {
  const s = bruto.trim();
  if (!s) return null;
  if (s.startsWith("ws://") || s.startsWith("wss://")) return s;
  if (s.startsWith("https://")) return "wss://" + s.slice("https://".length);
  if (s.startsWith("http://")) return "ws://" + s.slice("http://".length);
  // Sem esquema: `192.168.0.10:7391` vira `ws://`, e um domínio vira `wss://`
  // — um endereço com nome quase sempre vem de um túnel, que é TLS.
  const pareceIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s);
  const pareceLocal = s.startsWith("localhost");
  return `${pareceIp || pareceLocal ? "ws" : "wss"}://${s}`;
}

/** Mesma normalização do backend: aceita minúsculo, sem hífen, com espaços. */
export function normalizeCode(bruto: string): string {
  const limpo = bruto.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return limpo.length === 8 ? `${limpo.slice(0, 4)}-${limpo.slice(4)}` : limpo;
}
