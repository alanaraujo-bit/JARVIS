import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Espelho de `src-tauri/src/protocol.rs`. Manter os dois lados em sincronia. */

export interface SpawnOptions {
  program?: string;
  args?: string[];
  cwd?: string;
  env?: [string, string][];
  cols?: number;
  rows?: number;
  title?: string;
  profileId?: string;
  initialCommand?: string;
  /** Só alimenta o histórico gravado — o motor não usa para nada. */
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export interface SessionInfo {
  id: string;
  title: string;
  program: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  profileId: string | null;
  pid: number | null;
  startedAt: number;
  alive: boolean;
  exitCode: number | null;
  bytesOut: number;
  bytesIn: number;
  /** Se a árvore de processos foi presa a um Job Object do Windows. Quando
   * `false`, fechar a aba mata só o shell direto — filhos que ele lançar
   * (ex.: `npm run dev`) podem sobreviver como órfãos. */
  jobbed: boolean;
}

export interface ExitEvent {
  id: string;
  exitCode: number;
  endedAt: number;
}

export interface DataEvent {
  id: string;
  b64: string;
  /** Total acumulado de bytes da sessão até o fim deste lote. */
  seq: number;
}

export interface SnapshotPayload {
  b64: string;
  seq: number;
}

export interface ResizeResult {
  cols: number;
  rows: number;
}

export interface ShellProfile {
  id: string;
  name: string;
  program: string;
  args: string[];
  icon: string;
  recommended: boolean;
}

const EV_EXIT = "pty:exit";
const evData = (id: string) => `pty:data:${id}`;

/* -------------------------------------------------------------------------
 * base64 <-> bytes
 * O caminho quente é a saída do PTY; `atob` + loop é a versão mais rápida
 * disponível sem depender de APIs assíncronas.
 * ---------------------------------------------------------------------- */

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  // Fatiado para não estourar o limite de argumentos de `String.fromCharCode`
  // em colagens grandes.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const encoder = new TextEncoder();

export function textToB64(text: string): string {
  return bytesToB64(encoder.encode(text));
}

/** `onBinary` do xterm entrega uma string em que cada caractere é um byte. */
export function latin1ToB64(text: string): string {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return bytesToB64(out);
}

/* ------------------------------- comandos ------------------------------ */

export const ptySpawn = (opts: SpawnOptions) =>
  invoke<SessionInfo>("pty_spawn", { opts });

export const ptyWrite = (id: string, data: string) =>
  invoke<void>("pty_write", { id, b64: textToB64(data) });

export const ptyWriteBinary = (id: string, data: string) =>
  invoke<void>("pty_write", { id, b64: latin1ToB64(data) });

/**
 * `viewId` identifica o painel que pede o tamanho. Com splits, dois painéis
 * exibindo a mesma sessão brigariam pelo resize; o backend aplica o menor.
 */
export const ptyResize = (
  id: string,
  viewId: string,
  cols: number,
  rows: number,
) => invoke<ResizeResult>("pty_resize", { id, viewId, cols, rows });

export const ptyDetachView = (id: string, viewId: string) =>
  invoke<void>("pty_detach_view", { id, viewId });

/**
 * Esquece todos os painéis registrados para a sessão. Chamar sempre que o
 * front reconcilia sessões vindas de uma vida nova de página (montagem
 * inicial, F5, HMR): um painel de antes da recarga nunca roda seu cleanup do
 * React, então o `viewId` dele fica preso em `views` no backend para sempre —
 * prendendo o PTY no menor tamanho que ele tinha pedido, sem qualquer forma
 * de o painel novo se livrar disso, já que nem sabe que o fantasma existe.
 */
export const ptyResetViews = (id: string) =>
  invoke<void>("pty_reset_views", { id });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

export const ptyClose = (id: string) => invoke<void>("pty_close", { id });

export const ptySnapshot = (id: string) =>
  invoke<SnapshotPayload>("pty_snapshot", { id });

export const ptyList = () => invoke<SessionInfo[]>("pty_list");

/* ------------------- histórico gravado dos terminais -------------------- */

/** Espelho de `TranscriptMeta` em `src-tauri/src/transcript.rs`. */
export interface TranscriptMeta {
  id: string;
  title: string;
  program: string;
  args: string[];
  cwd: string;
  profileId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  autoCommand: string | null;
  /** Agente de IA que este terminal subiu, quando foi o JARVIS quem o subiu. */
  agentKind: string | null;
  /** Id da conversa daquele agente — o que permite continuá-la depois. */
  agentSessionId: string | null;
  startedAt: number;
  /** `null` só enquanto a sessão está viva nesta execução. */
  endedAt: number | null;
  exitCode: number | null;
  /** O começo da gravação foi descartado por ter passado do teto de tamanho. */
  truncated: boolean;
  bytes: number;
}

export interface TranscriptData {
  /** Bytes crus do PTY, com as sequências ANSI intactas. */
  b64: string;
  totalBytes: number;
  /** Só a cauda do arquivo veio nesta leitura. */
  truncated: boolean;
}

export const transcriptList = () => invoke<TranscriptMeta[]>("transcript_list");

export const transcriptRead = (id: string, maxBytes?: number) =>
  invoke<TranscriptData>("transcript_read", { id, maxBytes });

/** Espelho de `AgentResume` em `src-tauri/src/agents.rs`. */
export interface AgentResume {
  kind: "claude" | "opencode" | "freebuff";
  /** Nome do agente para mostrar na tela. */
  label: string;
  sessionId: string | null;
  /** Primeira pergunta da conversa, para o usuário reconhecê-la. */
  title: string | null;
  updatedAt: number;
  /** Linha pronta para o terminal novo (ex.: `claude --resume <id>`). */
  command: string;
  /** `CLAUDE_CONFIG_DIR` onde a conversa vive — a conta certa para retomar. */
  configDir: string | null;
  /** `true` = a conversa foi identificada pelo id; `false` = pela pasta e horário. */
  exact: boolean;
}

/**
 * Descobre como continuar a conversa de IA de uma gravação. `null` quando
 * aquele terminal não tinha agente, ou quando a conversa não existe mais do
 * lado do agente.
 */
export const agentResumeProbe = (id: string) =>
  invoke<AgentResume | null>("agent_resume_probe", { id });

export const transcriptDelete = (id: string) => invoke<void>("transcript_delete", { id });

export const transcriptClear = () => invoke<void>("transcript_clear");

export const shellsDetect = () => invoke<ShellProfile[]>("shells_detect");

export const appHomeDir = () => invoke<string>("app_home_dir");

/* -------------------------------- eventos ------------------------------ */

export function onPtyData(
  id: string,
  cb: (bytes: Uint8Array, seq: number) => void,
): Promise<UnlistenFn> {
  return listen<DataEvent>(evData(id), (e) =>
    cb(b64ToBytes(e.payload.b64), e.payload.seq),
  );
}

export function onPtyExit(cb: (e: ExitEvent) => void): Promise<UnlistenFn> {
  return listen<ExitEvent>(EV_EXIT, (e) => cb(e.payload));
}

/* ----------------------------- config ---------------------------------- */

/** Espelho de `AiConfig` em `src-tauri/src/config.rs`. */
export interface AiConfigPayload {
  provider: "ollama" | "openai" | "anthropic" | "gemini";
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface WorkspaceConfigPayload {
  id: string;
  name: string;
  path: string;
  color: string;
  defaultProfileId: string | null;
  autoCommand?: string | null;
  /** Conta do Claude Code dos terminais deste projeto. `null` = a conta padrão. */
  claudeAccountId?: string | null;
  createdAt: number;
}

/** Espelho de `ClaudeAccountConfig` em `src-tauri/src/config.rs`. */
export interface ClaudeAccountPayload {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface UiConfigPayload {
  sidebarOpen: boolean;
  aiPanelOpen: boolean;
  /** Menu lateral expandido (rótulos) ou recolhido (só ícones). */
  railExpanded: boolean;
  /** `"system" | "dark" | "light"` — string livre; o front valida ao ler. */
  theme: string;
  /** `"compact" | "cozy"`. */
  density: string;
  /** Introdução de primeira execução já concluída. */
  onboardingDone: boolean;
}

/** Espelho de `GuardianConfig` em `src-tauri/src/config.rs`. */
export interface GuardianConfigPayload {
  url: string;
  token: string;
}

export interface AppConfig {
  workspaces: WorkspaceConfigPayload[];
  activeWorkspaceId: string | null;
  ai: AiConfigPayload;
  ui: UiConfigPayload;
  /**
   * Arranjo de abas e divisões. O backend guarda como JSON opaco — a forma
   * pertence ao front (veja `src/lib/restoreLayout.ts`), que valida o que
   * lê em vez de confiar no tipo.
   */
  layout?: unknown;
  /** Histórico recente de sessões de terminal, também JSON opaco (veja `src/lib/sessionHistory.ts`). */
  sessionHistory?: unknown;
  claudeAccounts: ClaudeAccountPayload[];
  /** Conta usada por terminais que não herdam nada de um workspace. */
  defaultClaudeAccountId: string | null;
  /** Conexão com o guardião 24/7 (endereço + token da API). */
  guardian: GuardianConfigPayload;
}

/**
 * Fatia parcial do config. Cada tela salva só o que ela é dona — mandar o
 * documento inteiro faria o último a gravar apagar a mudança da outra tela.
 * Omitir um campo preserva o valor guardado; mandar `activeWorkspaceId: null`
 * é um pedido explícito de modo livre.
 */
export type ConfigPatch = Partial<Omit<AppConfig, "ui">> & {
  /** `ui` também é mesclado campo a campo: a barra lateral é dona de
   * `sidebarOpen` e o painel de IA é dono de `aiPanelOpen`. */
  ui?: Partial<UiConfigPayload>;
};

/**
 * Roda `flush` antes da janela realmente fechar e só então deixa o
 * fechamento seguir. Sem isto, sessões ainda abertas no momento do
 * "X"/Alt+F4 nunca são marcadas como encerradas no histórico — a próxima
 * abertura as trataria como órfãs de uma queda, mesmo num fechamento normal.
 */
export async function onWindowCloseFlush(flush: () => Promise<void>): Promise<UnlistenFn> {
  // Fora do app nativo não há janela do Tauri. A guarda testa o caminho que
  // `getCurrentWindow()` de fato lê, e não a mera presença de
  // `__TAURI_INTERNALS__`: o backend simulado instala esse objeto para
  // interceptar os `invoke`, mas não tem `metadata.currentWindow` — checar
  // só a chave raiz passava direto e continuava lançando duas vezes por
  // carga, ruído permanente no console onde se procura por bug real.
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: unknown } } })
    .__TAURI_INTERNALS__;
  if (!internals?.metadata?.currentWindow) return () => {};

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();

  // Segurar o fechamento é uma aposta: se o que vem depois falhar, a janela
  // fica impossível de fechar — nem o X nem o Alt+F4 escapam, porque os dois
  // passam por aqui. Só se segura o que se sabe soltar, então cada caminho
  // abaixo termina com a janela fechada.
  let jaFechando = false;

  return win.onCloseRequested(async (event) => {
    // Segunda passagem: o `close()` de resgate lá embaixo dispara o evento de
    // novo. Deixar seguir, ou o resgate viraria um laço.
    if (jaFechando) return;
    event.preventDefault();

    try {
      // O salvar é uma cortesia, não uma condição. Um `invoke` que não volta
      // (disco travado, backend ocupado) não pode custar o fechamento.
      await Promise.race([flush(), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      // Histórico desatualizado é melhor que janela presa.
    }

    jaFechando = true;
    try {
      await win.destroy();
    } catch {
      // `destroy` depende de `core:window:allow-destroy` na capability. Se
      // um dia sumir de lá de novo, o `close()` ainda fecha — desta vez sem
      // ser interceptado, graças ao `jaFechando`.
      await win.close();
    }
  });
}

export const configLoad = () => invoke<AppConfig>("config_load");

export const configSave = (patch: ConfigPatch) =>
  invoke<AppConfig>("config_save", { patch });

/* ----------------------------- diálogo --------------------------------- */

export const openFolderDialog = () =>
  invoke<string | null>("open_folder_dialog");

/* ------------------------------- IA ------------------------------------ */

export interface AiChatRequest {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiContextPayload {
  workspacePath: string | null;
  shellName: string | null;
  os: string;
  terminalLines: string | null;
}

export interface AiChunkEvent {
  requestId: string;
  text: string;
}

export interface AiErrorEvent {
  requestId: string;
  error: string;
}

/**
 * O `requestId` é gerado aqui no front, de propósito. Os eventos de
 * streaming são nomeados por id; se o id só existisse depois do `invoke`
 * resolver, não haveria como assinar os eventos antes da geração começar —
 * e um Ollama local emite os primeiros tokens em milissegundos. Gerando o id
 * antes, o painel assina primeiro e dispara depois.
 */
export const aiChat = (req: {
  requestId: string;
  messages: AiChatRequest[];
  context: AiContextPayload;
  systemPrompt?: string;
  config?: AiConfigPayload;
}) => invoke<void>("ai_chat", req);

export const aiCancel = (requestId: string) =>
  invoke<void>("ai_cancel", { requestId });

export const aiModels = (config?: AiConfigPayload) =>
  invoke<string[]>("ai_models", { config });

export const onAiChunk = (requestId: string, cb: (text: string) => void) =>
  listen<AiChunkEvent>(`ai:chunk:${requestId}`, (e) => cb(e.payload.text));

export const onAiDone = (requestId: string, cb: () => void) =>
  listen<unknown>(`ai:done:${requestId}`, () => cb());

export const onAiError = (requestId: string, cb: (error: string) => void) =>
  listen<AiErrorEvent>(`ai:error:${requestId}`, (e) => cb(e.payload.error));

/* ------------------------- uso do Claude Code --------------------------- */

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface ClaudeUsageSummary {
  currentModel: string | null;
  currentEffort: string | null;
  byModel: ModelUsage[];
  tokensLast5h: number;
  tokensLast24h: number;
  costLast5hUsd: number;
  costTotalUsd: number;
  totalEvents: number;
  noData: boolean;
}

export interface ClaudeSettings {
  model: string | null;
  effortLevel: string | null;
}

/**
 * `configDir` ausente = a configuração principal (`~/.claude`), que é o que
 * a CLI usa para quem não cadastrou conta nenhuma. Com contas, cada uma tem
 * sua pasta e o mesmo comando serve às duas situações.
 */
export const claudeUsageSummary = (configDir?: string) =>
  invoke<ClaudeUsageSummary>("claude_usage_summary", { configDir });

export const claudeSettingsGet = (configDir?: string) =>
  invoke<ClaudeSettings>("claude_settings_get", { configDir });

export const claudeSettingsSet = (configDir?: string, model?: string, effortLevel?: string) =>
  invoke<void>("claude_settings_set", { configDir, model, effortLevel });

/* ------------------------ contas do Claude Code -------------------------- */

/** Espelho de `claude_accounts::AccountStatus`. Nunca traz token nenhum. */
export interface ClaudeAccountStatus {
  id: string;
  /** Caminho que vira `CLAUDE_CONFIG_DIR` nos terminais desta conta. */
  configDir: string;
  prepared: boolean;
  loggedIn: boolean;
  /** `"pro"`, `"max"`… como a CLI grava. `null` quando não logada. */
  subscriptionType: string | null;
  /** Epoch em ms do fim da validade do token de acesso. */
  expiresAt: number | null;
  rateLimitTier: string | null;
}

export interface ClaudeAccountUsage {
  accountId: string;
  summary: ClaudeUsageSummary;
}

/* --------------------- cota real (API da Anthropic) -------------------- */

/** Uma janela de cota da resposta da Anthropic (o `/usage` da CLI). */
export interface ClaudeWindowUsage {
  /** Percentual da janela já consumido (0–100). */
  utilizationPct: number;
  /** Epoch em ms em que a janela zera. */
  resetsAtMs: number;
}

export interface ClaudeExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
}

/**
 * Cota real de uma configuração. `available: false` não é erro — é o sinal
 * de que não dá para saber a cota agora (sem login, offline) e a interface
 * deve mostrar a estimativa local. Nunca traz token nenhum.
 */
export interface ClaudeLiveUsage {
  available: boolean;
  error: string | null;
  fiveHour: ClaudeWindowUsage | null;
  sevenDay: ClaudeWindowUsage | null;
  extraUsage: ClaudeExtraUsage | null;
}

export interface ClaudeAccountLiveUsage {
  accountId: string;
  usage: ClaudeLiveUsage;
}

/**
 * Cota real da conta (ou da configuração principal, sem `configDir`),
 * consultada na Anthropic com o token OAuth que o Claude Code já salva.
 */
export const claudeUsageLive = (configDir?: string) =>
  invoke<ClaudeLiveUsage>("claude_usage_live", { configDir });

/** Cota ao vivo de várias contas numa chamada só, como o `claudeUsageByAccount`. */
export const claudeUsageLiveByAccount = (accounts: [string, string][]) =>
  invoke<ClaudeAccountLiveUsage[]>("claude_usage_live_by_account", { accounts });

/** Cria a pasta da conta. `seed` copia `settings.json`/`CLAUDE.md` de `~/.claude`. */
export const claudeAccountPrepare = (id: string, seed: boolean) =>
  invoke<string>("claude_account_prepare", { id, seed });

export const claudeAccountsStatus = (ids: string[]) =>
  invoke<ClaudeAccountStatus[]>("claude_accounts_status", { ids });

/** Uma varredura por conta numa chamada só — o painel mostra todas juntas. */
export const claudeUsageByAccount = (accounts: [string, string][]) =>
  invoke<ClaudeAccountUsage[]>("claude_usage_by_account", { accounts });

/** Copia para a conta o login que já existe em `~/.claude`. */
export const claudeAccountImport = (id: string) =>
  invoke<void>("claude_account_import", { id });

/**
 * O `.credentials.json` cru de uma conta, para o cadastro em um clique no
 * guardião 24/7. `null` = conta sem login (o painel pede login antes).
 * É a única leitura de credencial que atravessa o IPC, e vai direto para o
 * guardião, que criptografa em repouso — nunca aparece na interface.
 */
export const claudeAccountCredentials = (id: string) =>
  invoke<string | null>("claude_account_credentials", { id });

/** Sai da conta, preservando preferências e histórico dela. */
export const claudeAccountLogout = (id: string) =>
  invoke<void>("claude_account_logout", { id });

/** Apaga a pasta inteira da conta. */
export const claudeAccountForget = (id: string) =>
  invoke<void>("claude_account_forget", { id });

export const claudeDefaultLoginExists = () => invoke<boolean>("claude_default_login_exists");

/**
 * Copia a conversa (o `.jsonl` da sessão) de uma pasta de conta para outra —
 * o passo que permite trocar de conta num painel já aberto sem perder a
 * conversa: o processo velho morre, mas o `claude --resume` do processo novo
 * encontra a conversa esperando na conta nova.
 */
export const claudeAccountMigrateSession = (opts: {
  fromConfigDir: string | null;
  toConfigDir: string;
  cwd: string;
  sessionId: string;
}) => invoke<void>("claude_account_migrate_session", { opts });
