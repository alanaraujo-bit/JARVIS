/**
 * Painel do guardião 24/7 (Claude Session Window Manager).
 *
 * O guardião é um serviço que roda num servidor (Railway) e mantém as
 * janelas de 5h das contas Claude Code sempre rolando — manda um "oi" (haiku)
 * nas contas ociosas para o reset nunca pegar a pessoa de surpresa. Este
 * store é o braço do JARVIS dentro desse mundo:
 *
 * - guarda o endereço e o token do guardião (no config, como tudo);
 * - mostra o estado ao vivo de cada conta (janela 5h/7d, próximo ping,
 *   bloqueios) lendo o `/api/status` do guardião;
 * - cadastra/remove contas em um clique — as credenciais saem daqui direto
 *   para o guardião, que as criptografa em repouso;
 * - o **heartbeat**: enquanto houver terminal aberto numa conta, o JARVIS
 *   renova o "lease" dela a cada minuto, e o guardião não pinga conta em uso.
 *
 * A URL base e o token são o único segredo que mora aqui; as credenciais das
 * contas nunca tocam o estado (entram no `POST /api/accounts` e moram
 * criptografadas no volume do guardião).
 */

import { create } from "zustand";

import {
  claudeAccountCredentials,
  configLoad,
  configSave,
  type GuardianConfigPayload,
} from "../lib/ipc";

/** Espelho da `WindowInfo` do guardião — percentual 0–100 e reset em ms. */
export interface GuardianJanela {
  utilization: number | null;
  resetsAtMs: number | null;
}

export interface GuardianCota {
  ok: boolean;
  erro: string | null;
  fiveHour: GuardianJanela | null;
  sevenDay: GuardianJanela | null;
}

export interface GuardianContaEstado {
  leaseAtivo: boolean;
  bloqueadaSemanal: boolean;
  bloqueadaMensal: boolean;
  cota: GuardianCota | null;
  cotaConsultadaEm: number | null;
  ultimoPing: number | null;
  ultimoPingOk: boolean | null;
  ultimoPingErro: string | null;
  pingsOk: number;
  pingsFail: number;
  proximaAcaoEm: number | null;
}

/** Espelho da `visao()` do guardião — nunca traz credenciais. */
export interface GuardianConta {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  estado: GuardianContaEstado;
}

export interface GuardianStatus {
  agora: number;
  contas: GuardianConta[];
}

interface GuardianStore {
  configuracao: GuardianConfigPayload | null;
  /** O config já foi lido pelo menos uma vez. */
  carregado: boolean;
  status: GuardianStatus | null;
  carregando: boolean;
  erro: string | null;
  painelAberto: boolean;

  carregar: () => Promise<void>;
  salvarConfiguracao: (cfg: GuardianConfigPayload) => Promise<boolean>;
  abrirPainel: () => void;
  fecharPainel: () => void;
  atualizarStatus: () => Promise<void>;
  registrarConta: (id: string, name: string) => Promise<void>;
  removerConta: (id: string) => Promise<void>;
  alternarConta: (id: string, enabled: boolean) => Promise<void>;
  pingarAgora: (id: string) => Promise<void>;
  /**
   * Heartbeat de uso: renova o lease das contas que têm terminal aberto,
   * para o guardião não pingá-las. Só chega a contas já cadastradas no
   * guardião — o resto é ignorado aqui, sem queimar uma chamada.
   */
  sinalizarUso: (ids: string[]) => Promise<void>;
}

/**
 * Chave de ordenação inteligente das contas — a mesma ordem que o PWA do
 * celular usa, porque é como o usuário decide qual conta pegar:
 *
 *   0. **Disponível agora** (janela 5h com folga) → primeiro, pela folga
 *      restante (quem tem mais cota fica acima);
 *   1. **Liberando** (janela 5h esgotada) → quem reseta antes fica acima;
 *   2. Sem dados / não cadastrada no guardião;
 *   3. Pausada (`enabled: false`);
 *   4. Trava semanal (estoque 7d fechado) → sempre por último;
 *   5. Trava mensal de gasto → o fundo do fundo.
 *
 * Menor chave = mais acima na lista.
 */
export function chaveOrdenacao(g: GuardianConta | null | undefined): number[] {
  if (!g) return [2, 0, 0];
  const e = g.estado;
  const fh = e.cota?.fiveHour ?? null;
  if (e.bloqueadaMensal) return [5, 0, 0];
  if (e.bloqueadaSemanal) return [4, 0, 0];
  if (!g.enabled) return [3, 0, 0];
  if (!fh || fh.utilization == null) return [2, 0, 0];
  // Esgotada SEM hora de reset não é "liberando em breve" — é desconhecido.
  // Mandar com chave [1, 0] a colocaria no topo do grupo errado.
  if (fh.utilization >= 100) {
    if (!fh.resetsAtMs) return [2, 0, 0];
    return [1, fh.resetsAtMs, 0];
  }
  return [0, fh.utilization, fh.resetsAtMs ?? 0];
}

/** Compara duas contas pela ordem inteligente (para `sort`). */
export function comparaContas(
  a: GuardianConta | null | undefined,
  b: GuardianConta | null | undefined,
): number {
  const ka = chaveOrdenacao(a);
  const kb = chaveOrdenacao(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

/** Consulta o guardião. Timeout curto: o painel não pode travar esperando. */
async function api(
  cfg: GuardianConfigPayload,
  rota: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const base = cfg.url.trim().replace(/\/+$/, "");
  if (!base) throw new Error("URL do guardião vazia");
  const res = await fetch(base + rota, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(opts?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`guardião respondeu ${res.status}`);
  return res.json();
}

function erroDe(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return "o guardião não respondeu (timeout)";
  if (e instanceof TypeError) return "não foi possível falar com o guardião (rede fora?)";
  return e instanceof Error ? e.message : String(e);
}

export const useGuardianStore = create<GuardianStore>((set, get) => ({
  configuracao: null,
  carregado: false,
  status: null,
  carregando: false,
  erro: null,
  painelAberto: false,

  carregar: async () => {
    try {
      const cfg = await configLoad();
      const configuracao = cfg.guardian ?? { url: "", token: "" };
      set({ configuracao, carregado: true });
      // Já busca o status de largada: o heartbeat (lease) depende de saber
      // quais contas estão cadastradas no guardião.
      if (configuracao.url && configuracao.token) void get().atualizarStatus();
    } catch {
      // Sem config ainda (primeira execução): o painel nasce vazio.
      set({ carregado: true });
    }
  },

  salvarConfiguracao: async (cfg) => {
    set({ carregando: true, erro: null });
    try {
      await configSave({ guardian: cfg });
      set({ configuracao: cfg });
      await get().atualizarStatus();
      set({ carregando: false });
      return true;
    } catch (e) {
      set({ carregando: false, erro: erroDe(e) });
      return false;
    }
  },

  abrirPainel: () => {
    set({ painelAberto: true });
    void get().atualizarStatus();
  },

  fecharPainel: () => set({ painelAberto: false }),

  atualizarStatus: async () => {
    const cfg = get().configuracao;
    if (!cfg || !cfg.url.trim() || !cfg.token) {
      set({ status: null });
      return;
    }
    try {
      const status = (await api(cfg, "/api/status")) as GuardianStatus;
      set({ status, erro: null });
    } catch (e) {
      // Não derruba o painel inteiro: um guardião offline deixa o estado
      // anterior visível e marca o erro lá em cima.
      set({ erro: erroDe(e) });
    }
  },

  registrarConta: async (id, name) => {
    const cfg = get().configuracao;
    if (!cfg) {
      set({ erro: "configure o guardião antes de cadastrar contas" });
      return;
    }
    set({ carregando: true, erro: null });
    try {
      const cred = await claudeAccountCredentials(id);
      if (!cred) {
        set({
          carregando: false,
          erro: "esta conta ainda não tem login salvo — entre nela (botão Entrar) e tente de novo",
        });
        return;
      }
      await api(cfg, "/api/accounts", { method: "POST", body: { id, name, credentialsJson: cred } });
      await get().atualizarStatus();
      set({ carregando: false });
    } catch (e) {
      set({ carregando: false, erro: erroDe(e) });
    }
  },

  removerConta: async (id) => {
    const cfg = get().configuracao;
    if (!cfg) return;
    set({ carregando: true, erro: null });
    try {
      await api(cfg, `/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      await get().atualizarStatus();
      set({ carregando: false });
    } catch (e) {
      set({ carregando: false, erro: erroDe(e) });
    }
  },

  alternarConta: async (id, enabled) => {
    const cfg = get().configuracao;
    if (!cfg) return;
    set({ erro: null });
    try {
      await api(cfg, `/api/accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { enabled },
      });
      await get().atualizarStatus();
    } catch (e) {
      set({ erro: erroDe(e) });
    }
  },

  pingarAgora: async (id) => {
    const cfg = get().configuracao;
    if (!cfg) return;
    set({ erro: null });
    try {
      await api(cfg, `/api/accounts/${encodeURIComponent(id)}/ping`, { method: "POST" });
      // O ping roda no próximo ciclo do guardião (~até 2 min); já aguarda o
      // status novo para o painel refletir.
      window.setTimeout(() => void get().atualizarStatus(), 30_000);
      void get().atualizarStatus();
    } catch (e) {
      set({ erro: erroDe(e) });
    }
  },

  sinalizarUso: async (ids) => {
    const cfg = get().configuracao;
    if (!cfg || ids.length === 0) return;
    // Sem status ainda (guardião fora do ar na abertura, painel nunca
    // aberto), re-busca antes de desistir: sem saber quais contas o guardião
    // conhece não dá para filtrar o lease — e o próx. minuto do heartbeat
    // reusaria o status fresco.
    if (!get().status) {
      void get().atualizarStatus();
      return;
    }
    // Só renova lease de conta que o guardião conhece — as outras dariam
    // 404 e só encheram o log do servidor.
    const registradas = new Set(get().status!.contas.map((c) => c.id));
    const alvo = ids.filter((id) => registradas.has(id));
    if (alvo.length === 0) return;
    for (const id of alvo) {
      void api(cfg, `/api/accounts/${encodeURIComponent(id)}/lease`, { method: "POST" }).catch(
        () => {},
      );
    }
  },
}));
