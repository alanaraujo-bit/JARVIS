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

  // A configuração vive em memória e sobrevive ao F5 via localStorage, para
  // o comportamento de persistência poder ser exercitado no navegador.
  const CONFIG_KEY = "jarvis-dev-config";
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
    ui: { sidebarOpen: false, aiPanelOpen: false },
  };

  const leConfig = (): Record<string, unknown> => {
    try {
      return { ...configPadrao, ...JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") };
    } catch {
      return { ...configPadrao };
    }
  };

  function emite(evento: string, payload: unknown) {
    for (const [id, o] of ouvintes) {
      if (o.evento === evento) o.handler({ event: id, payload });
    }
  }

  function escreve(s: FakeSession, texto: string) {
    s.buffer += texto;
    s.bytesOut += texto.length;
    salvaSessoes();
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
      // Assíncrono como o de verdade: o painel monta antes do primeiro byte.
      setTimeout(() => {
        escreve(s, `JARVIS — ${s.title} (backend simulado)`);
        escreve(s, prompt(s));
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
        emite("pty:exit", { id: s.id, exitCode: 1, endedAt: Date.now() });
      }
      return null;
    },

    pty_close: (args) => {
      sessions.delete((args as unknown as { id: string }).id);
      salvaSessoes();
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

    ai_cancel: () => null,
  };

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
