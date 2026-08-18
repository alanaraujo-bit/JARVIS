/**
 * Backend simulado para rodar a interface num navegador comum.
 *
 * Fora do app nativo não existe processo Rust, então `invoke` não tem para
 * onde ir e a tela fica vazia. Este módulo instala um `__TAURI_INTERNALS__`
 * falso: os comandos respondem em memória e um PTY de mentira ecoa o que se
 * digita. Serve para mexer no visual com recarga instantânea e para os
 * testes de ponta a ponta rodarem sem compilar o Rust.
 *
 * Só é carregado em desenvolvimento e apenas quando o Tauri real não está
 * presente — no app de verdade este arquivo nunca é importado.
 */

import { snapshotAllText } from "./terminalRegistry";

interface TauriMessage {
  event: number;
  payload: unknown;
}

type Handler = (msg: TauriMessage) => void;

/** Estado do backend de mentira. */
interface FakeSession {
  id: string;
  title: string;
  program: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  profileId: string | null;
  pid: number;
  startedAt: number;
  alive: boolean;
  exitCode: number | null;
  bytesOut: number;
  bytesIn: number;
  jobbed: boolean;
  /** Tudo que já foi escrito na tela, para o instantâneo. */
  buffer: string;
}

/** Versão enxuta do `AgentKind::from_command` do backend. */
function agenteDoComando(cmd: string | null | undefined): string | null {
  const primeiro = (cmd ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const base = primeiro.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/, "") ?? "";
  return ["claude", "opencode", "freebuff"].includes(base) ? base : null;
}

const PROFILES = [
  {
    id: "pwsh7",
    name: "PowerShell 7",
    program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: [],
    icon: "pwsh",
    recommended: true,
  },
  {
    id: "cmd",
    name: "Prompt de Comando",
    program: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    icon: "cmd",
    recommended: false,
  },
  {
    id: "gitbash",
    name: "Git Bash",
    program: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["-i"],
    icon: "bash",
    recommended: false,
  },
];

const encoder = new TextEncoder();

function toB64(texto: string): string {
  const bytes = encoder.encode(texto);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function installDevMock(): void {
  // As sessões vivem no `sessionStorage` porque no app de verdade quem as
  // guarda é o processo Rust: elas sobrevivem a um F5 da janela. Guardar só
  // em memória faria a reconciliação após recarga parecer funcionar quando
  // na prática nunca é exercitada.
  const SESSOES_KEY = "jarvis-dev-sessions";
  const sessions = new Map<string, FakeSession>(
    JSON.parse(sessionStorage.getItem(SESSOES_KEY) ?? "[]") as [string, FakeSession][],
  );
  const salvaSessoes = () =>
    sessionStorage.setItem(SESSOES_KEY, JSON.stringify([...sessions.entries()]));

  const ouvintes = new Map<number, { evento: string; handler: Handler }>();
  let proximoId =
    Math.max(0, ...[...sessions.keys()].map((k) => Number(k.split("-")[1]) || 0)) + 1;
  let proximoCallback = 1;

  // O plugin de clipboard é uma ponte para o Rust; aqui o estado mora em
  // memória, com a API real do navegador como primeira tentativa (os testes
  // e2e concedem permissão de clipboard ao contexto e assim o fluxo inteiro
  // é exercitado de verdade).
  let clipboardMock = "";
  const leClipboard = async (): Promise<string> => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) return txt;
    } catch {
      // sem permissão no navegador: cai no mock
    }
    return clipboardMock;
  };
  const gravaClipboard = async (texto: string) => {
    clipboardMock = texto;
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      // o mock em memória já basta
    }
  };

  // A configuração vive em memória e sobrevive ao F5 via localStorage, para
  // o comportamento de persistência poder ser exercitado no navegador.
  const CONFIG_KEY = "jarvis-dev-config";
  const CLAUDE_SETTINGS_KEY = "jarvis-dev-claude-settings";
  const configPadrao = {
    workspaces: [],
    activeWorkspaceId: null,
    ai: {
      provider: "ollama",
      endpoint: "http://localhost:11434",
      apiKey: "",
      model: "llama3",
      temperature: 0.7,
      maxTokens: 2048,
    },
    ui: {
      sidebarOpen: false,
      aiPanelOpen: false,
      // Menu lateral minimizado por padrão, igual ao app de verdade.
      railExpanded: false,
      theme: "system",
      density: "cozy",
      // E2e: a introdução é uma tela de primeira execução, e os testes
      // funcionais precisam da interface pronta — não da apresentação.
      onboardingDone: true,
    },
    claudeAccounts: [],
    defaultClaudeAccountId: null,
  };

  /**
   * Estado das pastas de conta — o que no app de verdade é a existência do
   * diretório e do `.credentials.json` dentro dele.
   */
  const CONTAS_KEY = "jarvis-dev-claude-accounts";
  const leContasMock = (): Record<string, { loggedIn: boolean }> => {
    try {
      return JSON.parse(localStorage.getItem(CONTAS_KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const gravaContasMock = (v: Record<string, { loggedIn: boolean }>) =>
    localStorage.setItem(CONTAS_KEY, JSON.stringify(v));

  const leConfig = (): Record<string, unknown> => {
    try {
      return { ...configPadrao, ...JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") };
    } catch {
      return { ...configPadrao };
    }
  };

  // Histórico gravado. No app de verdade quem grava é o Rust, num arquivo por
  // sessão; aqui basta acumular a mesma string que o PTY simulado emite.
  const TRANSCRITOS_KEY = "jarvis-dev-transcripts";
  interface FakeTranscript {
    meta: Record<string, unknown>;
    conteudo: string;
  }
  const transcritos = new Map<string, FakeTranscript>(
    JSON.parse(sessionStorage.getItem(TRANSCRITOS_KEY) ?? "[]") as [string, FakeTranscript][],
  );
  const salvaTranscritos = () =>
    sessionStorage.setItem(TRANSCRITOS_KEY, JSON.stringify([...transcritos.entries()]));

  function encerraTranscrito(id: string, exitCode: number | null) {
    const t = transcritos.get(id);
    if (!t || t.meta.endedAt !== null) return;
    t.meta.endedAt = Date.now();
    t.meta.exitCode = exitCode;
    salvaTranscritos();
  }

  function emite(evento: string, payload: unknown) {
    for (const [id, o] of ouvintes) {
      if (o.evento === evento) o.handler({ event: id, payload });
    }
  }

  function escreve(s: FakeSession, texto: string) {
    s.buffer += texto;
    s.bytesOut += texto.length;
    salvaSessoes();
    const t = transcritos.get(s.id);
    if (t) {
      t.conteudo += texto;
      salvaTranscritos();
    }
    emite(`pty:data:${s.id}`, { id: s.id, b64: toB64(texto), seq: s.bytesOut });
  }

  function prompt(s: FakeSession): string {
    return `\r\n\x1b[36m${s.cwd}\x1b[0m> `;
  }

  /** Shell de mentira: reconhece um punhado de comandos e ecoa o resto. */
  function executa(s: FakeSession, linha: string) {
    const cmd = linha.trim();
    if (cmd === "cls" || cmd === "clear") {
      escreve(s, "\x1b[2J\x1b[H");
    } else if (cmd === "exit") {
      s.alive = false;
      s.exitCode = 0;
      escreve(s, "\r\n");
      encerraTranscrito(s.id, 0);
      emite("pty:exit", { id: s.id, exitCode: 0, endedAt: Date.now() });
      return;
    } else if (cmd.startsWith("echo ")) {
      escreve(s, `\r\n${cmd.slice(5)}`);
    } else if (cmd === "ls" || cmd === "dir") {
      escreve(s, "\r\nsrc\r\nsrc-tauri\r\npackage.json\r\nREADME.md");
    } else if (cmd === "npm test") {
      escreve(s, "\r\n\x1b[31mFAIL\x1b[0m src/lib/layout.test.ts\r\n  ✗ divide o painel ao meio\r\n    Esperado 0.5, recebido 0.4");
    } else if (cmd.length > 0) {
      escreve(s, `\r\n'${cmd}' não é reconhecido como um comando.`);
    }
    escreve(s, prompt(s));
  }

  const comandos: Record<string, (args: Record<string, never>) => unknown> = {
    shells_detect: () => PROFILES,
    app_home_dir: () => "C:\\Users\\dev",

    pty_spawn: (args) => {
      const opts = (args as { opts?: Record<string, unknown> }).opts ?? {};
      const id = `sess-${proximoId++}`;
      const perfil = PROFILES.find((p) => p.id === opts.profileId) ?? PROFILES[0];
      const s: FakeSession = {
        id,
        title: (opts.title as string) ?? perfil.name,
        program: (opts.program as string) ?? perfil.program,
        args: (opts.args as string[]) ?? [],
        cwd: (opts.cwd as string) ?? "C:\\Users\\dev",
        cols: 120,
        rows: 30,
        profileId: perfil.id,
        pid: 1000 + proximoId,
        startedAt: Date.now(),
        alive: true,
        exitCode: null,
        bytesOut: 0,
        bytesIn: 0,
        jobbed: true,
        buffer: "",
      };
      sessions.set(id, s);
      salvaSessoes();
      transcritos.set(id, {
        meta: {
          id,
          title: s.title,
          program: s.program,
          args: s.args,
          cwd: s.cwd,
          profileId: s.profileId,
          workspaceId: (opts.workspaceId as string | null) ?? null,
          workspaceName: (opts.workspaceName as string | null) ?? null,
          autoCommand: (opts.initialCommand as string | null) ?? null,
          // Espelha o `agents::preparar_comando_inicial` do backend: é esse
          // vínculo que faz o botão do histórico virar "Continuar conversa".
          agentKind: agenteDoComando(opts.initialCommand as string | null),
          agentSessionId: agenteDoComando(opts.initialCommand as string | null)
            ? `mock-${proximoId}`
            : null,
          startedAt: s.startedAt,
          endedAt: null,
          exitCode: null,
          truncated: false,
        },
        conteudo: "",
      });
      salvaTranscritos();
      const comandoInicial = (opts.initialCommand as string | undefined)?.trim();
      // Assíncrono como o de verdade: o painel monta antes do primeiro byte.
      setTimeout(() => {
        escreve(s, `JARVIS — ${s.title} (backend simulado)`);
        escreve(s, prompt(s));
        // Espelha o `type_command` do backend real: digita sozinho depois do
        // prompt aparecer, como se o usuário tivesse acabado de teclar.
        if (comandoInicial) {
          setTimeout(() => {
            if (!s.alive) return;
            escreve(s, comandoInicial);
            executa(s, comandoInicial);
          }, 200);
        }
      }, 30);
      return { ...s, buffer: undefined };
    },

    pty_write: (args) => {
      const { id, b64 } = args as unknown as { id: string; b64: string };
      const s = sessions.get(id);
      if (!s || !s.alive) return null;
      const texto = fromB64(b64);
      s.bytesIn += texto.length;
      for (const ch of texto) {
        if (ch === "\r" || ch === "\n") {
          const linha = s.buffer.slice(s.buffer.lastIndexOf("> ") + 2);
          executa(s, linha);
        } else if (ch === "\x7f" || ch === "\b") {
          if (!s.buffer.endsWith("> ")) {
            s.buffer = s.buffer.slice(0, -1);
            escreve(s, "\b \b");
          }
        } else {
          escreve(s, ch); // eco local
        }
      }
      return null;
    },

    pty_resize: (args) => {
      const { id, cols, rows } = args as unknown as {
        id: string;
        cols: number;
        rows: number;
      };
      const s = sessions.get(id);
      if (s) {
        s.cols = cols;
        s.rows = rows;
      }
      return { cols, rows };
    },

    pty_detach_view: () => null,
    pty_reset_views: () => null,

    pty_kill: (args) => {
      const s = sessions.get((args as unknown as { id: string }).id);
      if (s?.alive) {
        s.alive = false;
        s.exitCode = 1;
        encerraTranscrito(s.id, 1);
        emite("pty:exit", { id: s.id, exitCode: 1, endedAt: Date.now() });
      }
      return null;
    },

    pty_close: (args) => {
      const { id } = args as unknown as { id: string };
      sessions.delete(id);
      salvaSessoes();
      // Igual ao de verdade: a sessão some, a gravação fica.
      encerraTranscrito(id, null);
      return null;
    },

    transcript_list: () => {
      const lista: Record<string, unknown>[] = [...transcritos.values()].map((t) => ({
        ...t.meta,
        bytes: encoder.encode(t.conteudo).length,
      }));
      return lista
        .filter((m) => (m.bytes as number) > 0 || m.endedAt === null)
        .sort((a, b) => (b.startedAt as number) - (a.startedAt as number));
    },

    transcript_read: (args) => {
      const { id } = args as unknown as { id: string };
      const t = transcritos.get(id);
      if (!t) throw new Error(`sessão não encontrada: ${id}`);
      const bytes = encoder.encode(t.conteudo);
      return { b64: toB64(t.conteudo), totalBytes: bytes.length, truncated: false };
    },

    /**
     * Simula a descoberta da conversa do agente. Sem depósito de agente
     * nenhum aqui, o mock responde a partir do que o próprio spawn gravou:
     * terminal que subiu um agente tem retomada, terminal comum não tem.
     */
    agent_resume_probe: (args) => {
      const { id } = args as unknown as { id: string };
      const meta = transcritos.get(id)?.meta as Record<string, unknown> | undefined;
      const kind = meta?.agentKind as string | undefined;
      if (!meta || !kind) return null;
      const sessionId = (meta.agentSessionId as string | null) ?? null;
      const retomar: Record<string, string> = {
        claude: sessionId ? `claude --resume ${sessionId}` : "claude --continue",
        opencode: sessionId ? `opencode --session ${sessionId}` : "opencode --continue",
        freebuff: sessionId ? `freebuff --continue ${sessionId}` : "freebuff --continue",
      };
      return {
        kind,
        label: kind === "claude" ? "Claude Code" : kind,
        sessionId,
        title: "conversa simulada",
        updatedAt: Date.now(),
        command: retomar[kind] ?? kind,
        configDir: null,
        exact: sessionId !== null,
      };
    },

    transcript_delete: (args) => {
      transcritos.delete((args as unknown as { id: string }).id);
      salvaTranscritos();
      return null;
    },

    transcript_clear: () => {
      transcritos.clear();
      salvaTranscritos();
      return null;
    },

    pty_snapshot: (args) => {
      const s = sessions.get((args as unknown as { id: string }).id);
      return { b64: toB64(s?.buffer ?? ""), seq: s?.bytesOut ?? 0 };
    },

    pty_list: () => [...sessions.values()].map((s) => ({ ...s, buffer: undefined })),

    config_load: () => leConfig(),

    config_save: (args) => {
      const patch = (args as unknown as { patch: Record<string, unknown> }).patch ?? {};
      const atual = leConfig();
      // Espelha o merge campo a campo do backend real, inclusive em `ui`.
      const merged = {
        ...atual,
        ...patch,
        ui: { ...(atual.ui as object), ...((patch.ui as object) ?? {}) },
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
      return merged;
    },

    claude_usage_summary: () => ({
      currentModel: (JSON.parse(localStorage.getItem(CLAUDE_SETTINGS_KEY) ?? "{}").model as string) ?? "sonnet",
      currentEffort: (JSON.parse(localStorage.getItem(CLAUDE_SETTINGS_KEY) ?? "{}").effortLevel as string) ?? "low",
      byModel: [
        {
          model: "claude-sonnet-5",
          inputTokens: 1015,
          outputTokens: 181960,
          cacheCreationTokens: 886921,
          cacheReadTokens: 60444504,
          costUsd: 24.19,
        },
      ],
      tokensLast5h: 12138,
      tokensLast24h: 182975,
      costLast5hUsd: 1.87,
      costTotalUsd: 24.19,
      totalEvents: 508,
      noData: false,
    }),

    claude_settings_get: () => JSON.parse(localStorage.getItem(CLAUDE_SETTINGS_KEY) ?? "{}"),

    claude_settings_set: (args) => {
      const { model, effortLevel } = args as unknown as { model?: string; effortLevel?: string };
      const atual = JSON.parse(localStorage.getItem(CLAUDE_SETTINGS_KEY) ?? "{}");
      if (model) atual.model = model;
      if (effortLevel) atual.effortLevel = effortLevel;
      localStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(atual));
      return null;
    },

    /* --------------------- contas do Claude Code ----------------------- */
    // O estado das contas mora no `localStorage` para sobreviver a um F5,
    // como o de verdade sobrevive no disco: sem isso, "criei a conta e
    // recarreguei" pareceria um bug do app em vez de limitação do mock.

    claude_account_prepare: (args) => {
      const { id } = args as unknown as { id: string };
      const contas = leContasMock();
      contas[id] ??= { loggedIn: false };
      gravaContasMock(contas);
      return `C:\\Users\\dev\\AppData\\Roaming\\JARVIS\\claude-accounts\\${id}`;
    },

    claude_accounts_status: (args) => {
      const { ids } = args as unknown as { ids: string[] };
      const contas = leContasMock();
      return ids.map((id) => ({
        id,
        configDir: `C:\\Users\\dev\\AppData\\Roaming\\JARVIS\\claude-accounts\\${id}`,
        prepared: !!contas[id],
        loggedIn: !!contas[id]?.loggedIn,
        subscriptionType: contas[id]?.loggedIn ? "pro" : null,
        expiresAt: contas[id]?.loggedIn ? Date.now() + 86_400_000 : null,
        rateLimitTier: contas[id]?.loggedIn ? "default_claude_ai" : null,
      }));
    },

    claude_account_import: (args) => {
      const { id } = args as unknown as { id: string };
      const contas = leContasMock();
      contas[id] = { loggedIn: true };
      gravaContasMock(contas);
      return null;
    },

    claude_account_logout: (args) => {
      const { id } = args as unknown as { id: string };
      const contas = leContasMock();
      if (contas[id]) contas[id].loggedIn = false;
      gravaContasMock(contas);
      return null;
    },

    claude_account_forget: (args) => {
      const { id } = args as unknown as { id: string };
      const contas = leContasMock();
      delete contas[id];
      gravaContasMock(contas);
      return null;
    },

    claude_default_login_exists: () => true,

    claude_usage_by_account: (args) => {
      const { accounts } = args as unknown as { accounts: [string, string][] };
      // Números diferentes por conta de propósito: uma coluna que repete o
      // mesmo valor três vezes não prova que o painel está lendo cada pasta.
      return accounts.map(([accountId], i) => ({
        accountId,
        summary: {
          currentModel: "sonnet",
          currentEffort: "low",
          byModel: [],
          tokensLast5h: 120_000 * (i + 1),
          tokensLast24h: 480_000 * (i + 1),
          costLast5hUsd: 1.25 * (i + 1),
          costTotalUsd: 12.5 * (i + 1),
          totalEvents: 100 * (i + 1),
          noData: false,
        },
      }));
    },

    /* ---------------- cota real (API da Anthropic, simulada) ------------ */
    // Percentual determinístico por id: o painel precisa mostrar contas em
    // tons diferentes — inclusive uma acima de 80% para exercitar o alerta
    // da barra superior sem depender de sorte.
    claude_usage_live: (args) => {
      const { configDir } = args as unknown as { configDir?: string };
      const id = configDir?.split("\\").pop();
      const contas = leContasMock();
      const logada = id ? !!contas[id]?.loggedIn : true;
      if (!logada) {
        return {
          available: false,
          error: "esta conta não tem login salvo — entre nela e rode /login",
          fiveHour: null,
          sevenDay: null,
          extraUsage: null,
        };
      }
      const pct = cotaMock(id);
      return {
        available: true,
        error: null,
        fiveHour: { utilizationPct: pct, resetsAtMs: Date.now() + 3 * 3_600_000 + 24 * 60_000 },
        sevenDay: { utilizationPct: 30, resetsAtMs: Date.now() + 2 * 86_400_000 },
        extraUsage: null,
      };
    },

    claude_usage_live_by_account: (args) => {
      const { accounts } = args as unknown as { accounts: [string, string][] };
      const contas = leContasMock();
      return accounts.map(([accountId]) => {
        // Igual ao de verdade: sem login, `available: false` — é o que
        // exercita o aviso "cota ao vivo indisponível" nos cartões.
        if (!contas[accountId]?.loggedIn) {
          return {
            accountId,
            usage: {
              available: false,
              error: "esta conta não tem login salvo — entre nela e rode /login",
              fiveHour: null,
              sevenDay: null,
              extraUsage: null,
            },
          };
        }
        return {
          accountId,
          usage: {
            available: true,
            error: null,
            fiveHour: {
              utilizationPct: cotaMock(accountId),
              resetsAtMs: Date.now() + 3 * 3_600_000,
            },
            sevenDay: { utilizationPct: 30, resetsAtMs: Date.now() + 2 * 86_400_000 },
            extraUsage: null,
          },
        };
      });
    },

    open_folder_dialog: () => {
      // Sem diálogo nativo no navegador: devolve uma pasta plausível para o
      // fluxo de workspace poder ser percorrido inteiro.
      const n = ((leConfig().workspaces as unknown[]) ?? []).length + 1;
      return `C:\\Users\\dev\\projetos\\projeto-${n}`;
    },

    ai_models: () => ["llama3", "llama3:70b", "qwen2.5-coder"],

    ai_chat: (args) => {
      const { requestId, messages } = args as unknown as {
        requestId: string;
        messages: { role: string; content: string }[];
      };
      const pergunta = messages[messages.length - 1]?.content ?? "";
      const resposta = `Recebi: "${pergunta}".\n\nPara listar os arquivos:\n\n\`\`\`powershell\nGet-ChildItem -Force\n\`\`\`\n\nIsso mostra também os ocultos.`;

      // Emite token a token, como um provedor de verdade — é isso que
      // exercita o caminho de streaming da interface.
      const pedacos = resposta.match(/\s*\S+/g) ?? [];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pedacos.length) {
          clearInterval(timer);
          emite(`ai:done:${requestId}`, { requestId });
          return;
        }
        emite(`ai:chunk:${requestId}`, { requestId, text: pedacos[i++] });
      }, 25);
      return null;
    },

    /* ------------------- plugin de clipboard -------------------------- */
    // Espelha os comandos do `tauri-plugin-clipboard-manager`, que o front
    // usa para o copiar/colar do terminal.

    "plugin:clipboard-manager|read_text": async () => await leClipboard(),

    "plugin:clipboard-manager|write_text": async (args) => {
      const { text } = args as unknown as { text?: string };
      await gravaClipboard(text ?? "");
      return null;
    },

    "plugin:clipboard-manager|clear": async () => {
      await gravaClipboard("");
      return null;
    },

    /**
     * Colagem de imagem. No app de verdade quem lê o bitmap é o `arboard` e
     * o retorno é o caminho do PNG gravado; aqui devolvemos um caminho de
     * mentira dentro da pasta da sessão, que é o que o terminal cola.
     *
     * `window.__jarvisMockSemImagem` deixa o e2e simular "não há imagem no
     * clipboard" — o caso em que a colagem precisa não fazer nada em vez de
     * escrever a palavra `null` no shell.
     */
    clipboard_save_image: (args) => {
      const { sessionId } = args as unknown as { sessionId?: string };
      const semImagem = (globalThis as Record<string, unknown>).__jarvisMockSemImagem;
      if (semImagem) return null;
      const sessao = sessions.get(sessionId ?? "");
      const base = sessao?.cwd ?? "C:\\mock";
      return `${base}\\.jarvis\\clipboard\\colado-mock.png`;
    },

    ai_cancel: () => null,
  };

  /** 30–89%, estável para o mesmo id — o alerta de 80% dispara em algumas contas. */
  function cotaMock(id: string | undefined): number {
    let h = 0;
    for (const ch of id ?? "") h = (h * 31 + ch.charCodeAt(0)) % 97;
    return 30 + (h % 60);
  }

  const internals = {
    transformCallback(cb: Handler, once = false) {
      const id = proximoCallback++;
      Object.defineProperty(window, `_${id}`, {
        value: (msg: TauriMessage) => {
          if (once) Reflect.deleteProperty(window, `_${id}`);
          return cb(msg);
        },
        writable: false,
        configurable: true,
      });
      return id;
    },

    async invoke(cmd: string, args: Record<string, never> = {} as Record<string, never>) {
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args as unknown as { event: string; handler: number };
        const fn = (window as unknown as Record<string, Handler>)[`_${handler}`];
        ouvintes.set(handler, { evento: event, handler: fn });
        return handler;
      }
      if (cmd === "plugin:event|unlisten") {
        const { eventId } = args as unknown as { eventId: number };
        ouvintes.delete(eventId);
        return null;
      }

      const impl = comandos[cmd];
      if (!impl) throw new Error(`comando não implementado no mock: ${cmd}`);
      return impl(args);
    },
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    writable: false,
    configurable: true,
  });

  // O `unlisten` de `@tauri-apps/api/event` chama este objeto antes do
  // `invoke`; sem ele, desmontar qualquer painel lança e derruba a árvore.
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: {
      unregisterListener(_evento: string, eventId: number) {
        ouvintes.delete(eventId);
      },
    },
    writable: false,
    configurable: true,
  });

  // Ponte de leitura para os testes de ponta a ponta: com o renderizador
  // WebGL o texto do terminal vive num canvas, sem nó no DOM para inspecionar.
  Object.defineProperty(window, "__jarvisTerminalText", {
    value: snapshotAllText,
    writable: false,
    configurable: true,
  });

  // Sinaliza para os testes que o mock terminou de instalar.
  document.documentElement.dataset.jarvisMock = "on";
}
