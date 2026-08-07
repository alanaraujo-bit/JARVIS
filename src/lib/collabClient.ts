/**
 * O lado do convidado: uma conexão WebSocket com a máquina do anfitrião.
 *
 * Tudo o que o convidado vê passa por aqui, e o arquivo tem três
 * responsabilidades que valem a pena separar mentalmente:
 *
 * 1. **Ciclo de vida da conexão** — entrar, esperar aprovação, cair, voltar.
 *    A reconexão é automática e guarda o `resumeToken`, então uma oscilação
 *    de Wi-Fi não custa uma nova aprovação do anfitrião nem uma identidade
 *    nova na lista de participantes.
 * 2. **Roteamento dos quadros binários** — a saída de cada terminal vai para
 *    o painel que a exibe, sem passar pelo React. Um `setState` por lote de
 *    PTY reconciliaria a árvore ~125 vezes por segundo por terminal; o
 *    caminho aqui é `WebSocket → callback → xterm.write`, e nada mais.
 * 3. **Estado que a interface desenha** — sala, participantes, chat, IA.
 *    Esse sim é raro e vai por um assinante comum.
 *
 * O que a tela do convidado *não* pode fazer está definido do outro lado (ver
 * `collab/server.rs`): não existe mensagem para abrir terminal, rodar
 * comando ou ler arquivo. Este cliente só sabe falar o que existe lá.
 */

import {
  decodeFrame,
  encodeInput,
  normalizeAddress,
  normalizeCode,
  OP_DATA,
  OP_SNAPSHOT,
  PROTOCOL_VERSION,
  type AiEvent,
  type ChatMessage,
  type ClientMsg,
  type Participant,
  type RoomInfo,
  type ServerMsg,
  type SharedTerminal,
} from "./collabProtocol";

export type Phase =
  | "idle"
  | "connecting"
  | "pending"
  | "joined"
  | "reconnecting"
  | "denied"
  | "closed";

export interface GuestSnapshot {
  phase: Phase;
  /** Preenchido quando a entrada foi recusada ou a sala encerrou. */
  message: string | null;
  room: RoomInfo | null;
  me: Participant | null;
  terminals: SharedTerminal[];
  participants: Participant[];
  chat: ChatMessage[];
  /** Ida e volta em milissegundos, `null` até o primeiro pong. */
  latency: number | null;
}

const VAZIO: GuestSnapshot = {
  phase: "idle",
  message: null,
  room: null,
  me: null,
  terminals: [],
  participants: [],
  chat: [],
  latency: null,
};

/** Intervalo do ping. Alimenta o indicador de latência da tela do convidado. */
const PING_MS = 3000;

/** Teto da espera entre tentativas de reconexão. */
const BACKOFF_MAX = 8000;

const SNAPSHOT_TIMEOUT = 8000;

type DataCb = (bytes: Uint8Array, seq: number) => void;

export interface Credenciais {
  address: string;
  code: string;
  name: string;
}

export class CollabClient {
  private ws: WebSocket | null = null;
  private cred: Credenciais | null = null;
  private resumeToken: string | null = null;
  private estado: GuestSnapshot = { ...VAZIO };

  private assinantes = new Set<(s: GuestSnapshot) => void>();
  private dataCbs = new Map<string, Set<DataCb>>();
  private aiCbs = new Set<(e: AiEvent) => void>();
  private exitCbs = new Set<(sessionId: string, exitCode: number) => void>();
  private sizeCbs = new Map<string, Set<(cols: number, rows: number) => void>>();
  private resyncCbs = new Set<() => void>();
  private snapshotPend = new Map<
    string,
    { resolve: (v: { bytes: Uint8Array; seq: number } | null) => void; timer: number }
  >();

  private pingTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private tentativa = 0;
  /** Encerramento pedido pela pessoa: não tenta reconectar. */
  private encerrado = false;

  /* ------------------------------ assinatura ---------------------------- */

  subscribe(fn: (s: GuestSnapshot) => void): () => void {
    this.assinantes.add(fn);
    fn(this.estado);
    return () => this.assinantes.delete(fn);
  }

  snapshotState(): GuestSnapshot {
    return this.estado;
  }

  private set(patch: Partial<GuestSnapshot>) {
    this.estado = { ...this.estado, ...patch };
    for (const fn of this.assinantes) fn(this.estado);
  }

  /** Saída de um terminal remoto. Fora do React de propósito. */
  onData(sessionId: string, cb: DataCb): () => void {
    let set = this.dataCbs.get(sessionId);
    if (!set) {
      set = new Set();
      this.dataCbs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.dataCbs.delete(sessionId);
    };
  }

  onSize(sessionId: string, cb: (cols: number, rows: number) => void): () => void {
    let set = this.sizeCbs.get(sessionId);
    if (!set) {
      set = new Set();
      this.sizeCbs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.sizeCbs.delete(sessionId);
    };
  }

  onAi(cb: (e: AiEvent) => void): () => void {
    this.aiCbs.add(cb);
    return () => this.aiCbs.delete(cb);
  }

  onExit(cb: (sessionId: string, exitCode: number) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  /**
   * A conexão voltou depois de uma queda. Quem exibe terminal precisa limpar
   * a tela e pedir o estado de novo: o que se perdeu no intervalo não volta,
   * e continuar escrevendo por cima deixaria a tela remontada com um buraco
   * silencioso no meio.
   */
  onResync(cb: () => void): () => void {
    this.resyncCbs.add(cb);
    return () => this.resyncCbs.delete(cb);
  }

  /* ------------------------------- conexão ------------------------------ */

  connect(cred: Credenciais) {
    this.disconnect();
    this.encerrado = false;
    this.tentativa = 0;
    this.resumeToken = null;
    this.cred = {
      address: cred.address.trim(),
      code: normalizeCode(cred.code),
      name: cred.name.trim(),
    };
    this.set({ ...VAZIO, phase: "connecting" });
    this.abrir();
  }

  private abrir() {
    const cred = this.cred;
    if (!cred) return;
    const url = normalizeAddress(cred.address);
    if (!url) {
      this.set({ phase: "denied", message: "Endereço inválido." });
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Um endereço sintaticamente impossível chega aqui; tentar de novo não
      // adiantaria, então é um "não" definitivo e não uma reconexão.
      this.set({ phase: "denied", message: `Não consegui usar o endereço ${url}.` });
      return;
    }
    // Sem isto, cada lote do PTY chegaria como `Blob` e exigiria um `await`
    // para virar bytes — atraso de um quadro inteiro no meio da digitação.
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.enviar({
        t: "hello",
        version: PROTOCOL_VERSION,
        code: cred.code,
        name: cred.name,
        resumeToken: this.resumeToken,
      });
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.tratarTexto(ev.data);
      else this.tratarBinario(ev.data as ArrayBuffer);
    };

    ws.onerror = () => {
      // O `close` sempre vem depois; tratar aqui duplicaria a reconexão.
    };

    ws.onclose = () => {
      this.pararPing();
      this.resolverPendentes();
      if (this.encerrado) {
        this.set({ phase: "closed" });
        return;
      }
      // Uma recusa explícita já definiu a fase e o motivo; reconectar por
      // cima disso trocaria a explicação por "reconectando…" e a pessoa nunca
      // leria por que não entrou.
      if (this.estado.phase === "denied") return;
      this.agendarReconexao();
    };
  }

  private agendarReconexao() {
    this.set({ phase: "reconnecting", latency: null });
    const espera = Math.min(500 * 2 ** this.tentativa, BACKOFF_MAX);
    this.tentativa += 1;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.abrir(), espera);
  }

  /** Encerramento pedido pela pessoa. */
  disconnect() {
    this.encerrado = true;
    window.clearTimeout(this.reconnectTimer);
    this.pararPing();
    this.resolverPendentes();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* já estava fechando */
      }
    }
    if (this.estado.phase !== "idle") this.set({ phase: "closed", latency: null });
  }

  /**
   * "Voltei — a conexão ainda está de pé?"
   *
   * Existe por causa do celular. Um aparelho que fica minutos com a tela
   * apagada tem o socket derrubado por NAT ou pelo próprio sistema, e nem
   * sempre o evento `close` chega: a página é congelada antes. Ao acordar, o
   * `readyState` diz `CLOSED` mas nenhuma reconexão foi agendada, e a tela
   * ficaria parada mostrando o terminal de dez minutos atrás.
   *
   * Chamar isto quando o app volta ao primeiro plano custa uma leitura de
   * campo no caso normal e conserta o caso ruim na hora, sem esperar o
   * próximo passo do backoff.
   */
  ensureAlive() {
    if (this.encerrado || !this.cred) return;
    const estado = this.ws?.readyState;
    if (estado === WebSocket.OPEN || estado === WebSocket.CONNECTING) return;
    window.clearTimeout(this.reconnectTimer);
    this.tentativa = 0;
    this.abrir();
  }

  /** Esquece tudo e volta à tela de entrar numa sala. */
  reset() {
    this.disconnect();
    this.cred = null;
    this.resumeToken = null;
    this.estado = { ...VAZIO };
    this.set({});
  }

  get conectado(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.estado.phase === "joined";
  }

  /* ------------------------------ recepção ------------------------------ */

  private tratarBinario(buf: ArrayBuffer) {
    const q = decodeFrame(buf);
    if (!q) return;

    if (q.op === OP_DATA) {
      const cbs = this.dataCbs.get(q.sessionId);
      if (cbs) for (const cb of cbs) cb(q.payload, q.seq);
      return;
    }
    if (q.op === OP_SNAPSHOT) {
      const pend = this.snapshotPend.get(q.sessionId);
      if (pend) {
        window.clearTimeout(pend.timer);
        this.snapshotPend.delete(q.sessionId);
        // Cópia: o `payload` é uma janela sobre o buffer da mensagem, que o
        // navegador pode reaproveitar assim que este handler retornar.
        pend.resolve({ bytes: q.payload.slice(), seq: q.seq });
      }
    }
  }

  private tratarTexto(texto: string) {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(texto) as ServerMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case "welcome": {
        const reconexao = this.resumeToken !== null;
        this.resumeToken = msg.resumeToken;
        this.tentativa = 0;
        this.set({
          phase: "joined",
          message: null,
          room: msg.room,
          me: msg.you,
          terminals: msg.terminals,
          participants: msg.participants,
          chat: msg.chat,
        });
        this.iniciarPing();
        // Só depois de reconectar: na primeira entrada os painéis ainda nem
        // existem, e eles já pedem o estado da tela ao montar.
        if (reconexao) for (const cb of this.resyncCbs) cb();
        break;
      }
      case "pending":
        this.set({
          phase: "pending",
          message: null,
          room: { name: msg.roomName, hostName: msg.hostName, revision: 0 },
        });
        break;
      case "denied":
        // Deliberadamente definitivo: o token é descartado e nenhuma
        // reconexão é agendada. Insistir sozinho contra um "não" do
        // anfitrião seria exatamente o comportamento errado.
        this.resumeToken = null;
        this.set({ phase: "denied", message: msg.reason });
        break;
      case "terminals":
        this.set({ terminals: msg.terminals });
        break;
      case "participants":
        this.set({ participants: msg.participants });
        break;
      case "chat":
        this.set({ chat: [...this.estado.chat, msg.message].slice(-200) });
        break;
      case "exit":
        this.set({
          terminals: this.estado.terminals.map((t) =>
            t.sessionId === msg.sessionId ? { ...t, alive: false } : t,
          ),
        });
        for (const cb of this.exitCbs) cb(msg.sessionId, msg.exitCode);
        break;
      case "size": {
        this.set({
          terminals: this.estado.terminals.map((t) =>
            t.sessionId === msg.sessionId ? { ...t, cols: msg.cols, rows: msg.rows } : t,
          ),
        });
        const cbs = this.sizeCbs.get(msg.sessionId);
        if (cbs) for (const cb of cbs) cb(msg.cols, msg.rows);
        break;
      }
      case "ai":
        for (const cb of this.aiCbs) cb(msg.event);
        break;
      case "pong":
        this.set({ latency: Math.max(0, Math.round(performance.now() - msg.t0)) });
        break;
      case "bye":
        // A sala pode ter caído por queda de rede do lado de lá; a
        // reconexão continua valendo, com a explicação na tela enquanto isso.
        this.set({ message: msg.reason });
        break;
    }
  }

  /* -------------------------------- envio ------------------------------- */

  private enviar(msg: ClientMsg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Teclas para um terminal do anfitrião.
   *
   * Não há verificação de permissão aqui, e isso é proposital: o anfitrião
   * confere a cada quadro (ver `collab/server.rs`). Uma checagem só no
   * cliente seria uma sugestão, não uma regra. O que a tela faz com o modo
   * `ro` é desabilitar a entrada para a pessoa não digitar no vazio.
   */
  sendInput(sessionId: string, bytes: Uint8Array) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeInput(sessionId, bytes));
  }

  requestSnapshot(sessionId: string): Promise<{ bytes: Uint8Array; seq: number } | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    // Um pedido anterior ainda pendente para a mesma sessão é resolvido com
    // `null` em vez de ficar pendurado — acontece quando o painel remonta
    // rápido (troca de aba, StrictMode).
    const anterior = this.snapshotPend.get(sessionId);
    if (anterior) {
      window.clearTimeout(anterior.timer);
      anterior.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.snapshotPend.delete(sessionId);
        resolve(null);
      }, SNAPSHOT_TIMEOUT);
      this.snapshotPend.set(sessionId, { resolve, timer });
      this.enviar({ t: "snapshot", sessionId });
    });
  }

  /**
   * "Este terminal cabe em tantas colunas na minha tela."
   *
   * Vale a pena ser explícito sobre o efeito: enquanto o ajuste estiver
   * valendo, o terminal encolhe **na tela do anfitrião também** — o PTY é um
   * só e fica do tamanho do menor painel. Quem chama isto precisa ter deixado
   * isso claro na interface antes.
   */
  fit(sessionId: string, cols: number, rows: number) {
    this.enviar({ t: "fit", sessionId, cols, rows });
  }

  /** Devolve o tamanho ao anfitrião. Sair da sala tem o mesmo efeito. */
  unfit(sessionId: string) {
    this.enviar({ t: "unfit", sessionId });
  }

  sendChat(text: string) {
    this.enviar({ t: "chat", text });
  }

  askAi(text: string) {
    this.enviar({ t: "ai", text });
  }

  /* ------------------------------ auxiliares ---------------------------- */

  private iniciarPing() {
    this.pararPing();
    const bate = () => this.enviar({ t: "ping", t0: Math.round(performance.now()) });
    bate();
    this.pingTimer = window.setInterval(bate, PING_MS);
  }

  private pararPing() {
    window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Solta quem espera um instantâneo que não vai mais chegar. */
  private resolverPendentes() {
    for (const [, p] of this.snapshotPend) {
      window.clearTimeout(p.timer);
      p.resolve(null);
    }
    this.snapshotPend.clear();
  }
}

/**
 * Uma conexão por app. O convidado está em uma sala por vez, e um singleton
 * mantém a conexão viva enquanto ele navega entre telas — sem isso, sair da
 * aba de colaboração derrubaria a sessão e o anfitrião veria a pessoa entrar
 * e sair a cada clique.
 */
export const collabClient = new CollabClient();
