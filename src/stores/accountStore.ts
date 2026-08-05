/**
 * Contas do Claude Code.
 *
 * A lista (nome, cor) mora no config do JARVIS; o estado real de cada conta
 * — pasta existe? tem login? qual plano? — mora no disco, na própria pasta da
 * conta, e é relido sob demanda. Essa separação é deliberada: a pessoa pode
 * deslogar pela CLI, fora do app, e um "logada: true" guardado no config
 * viraria mentira sem ninguém perceber.
 */

import { create } from "zustand";

import {
  claudeAccountForget,
  claudeAccountImport,
  claudeAccountLogout,
  claudeAccountPrepare,
  claudeAccountsStatus,
  claudeDefaultLoginExists,
  configLoad,
  configSave,
  type ClaudeAccountPayload,
  type ClaudeAccountStatus,
} from "../lib/ipc";
import { envDaConta, nomeUnico, novoIdDeConta, proximaCor, resolveConta } from "../lib/claudeAccounts";

export interface AccountStore {
  contas: ClaudeAccountPayload[];
  /** Estado lido do disco, indexado por id. Vazio até o primeiro `atualizarStatus`. */
  status: Record<string, ClaudeAccountStatus>;
  /** Conta dos terminais que não herdam nada de um workspace. */
  padraoId: string | null;
  /**
   * Conta escolhida na barra de cima para as próximas aberturas. `null` =
   * "seguir o workspace/padrão", que é o comportamento normal — este campo
   * só existe para o caso de querer UM terminal noutra conta sem mexer em
   * configuração nenhuma.
   */
  escolhidaId: string | null;
  /** Existe login em `~/.claude` para importar. */
  temLoginPadrao: boolean;
  painelAberto: boolean;
  carregando: boolean;
  erro: string | null;

  carregar: () => Promise<void>;
  atualizarStatus: () => Promise<void>;
  criar: (nome?: string) => Promise<ClaudeAccountPayload | null>;
  renomear: (id: string, nome: string) => void;
  definirPadrao: (id: string | null) => void;
  escolher: (id: string | null) => void;
  importarLoginAtual: (id: string) => Promise<void>;
  sair: (id: string) => Promise<void>;
  remover: (id: string) => Promise<void>;
  abrirPainel: () => void;
  fecharPainel: () => void;

  /** Pasta de configuração de uma conta, ou `null` se ela não existe mais. */
  dirDaConta: (id: string | null | undefined) => string | null;
  /**
   * Resolve a conta de um terminal que está para abrir e devolve o `env`
   * pronto. É o único ponto que o `App` precisa chamar na hora do spawn.
   *
   * `forcada` atropela toda a precedência — inclusive a escolha da barra de
   * cima. É o que o botão "Entrar" precisa: ele abre um terminal *daquela*
   * conta, e não da conta que por acaso está selecionada.
   *
   * É `async` porque garante a pasta antes de responder (ver
   * `garantirDir`): abrir o terminal na conta errada por causa de um estado
   * ainda não carregado gastaria o limite da conta errada, calado.
   */
  envParaTerminal: (
    workspaceAccountId: string | null | undefined,
    forcada?: string | null,
  ) => Promise<{
    conta: ClaudeAccountPayload | null;
    env: [string, string][];
  }>;

  /**
   * Caminho da pasta da conta, criando-a se preciso.
   *
   * `dirDaConta` só sabe o que o último `atualizarStatus` trouxe — e uma
   * falha de leitura ali faria o terminal nascer sem `CLAUDE_CONFIG_DIR`, ou
   * seja, na conta principal, sem nada na tela indicando isso. Aqui a
   * pergunta vai ao backend, que responde o caminho e de quebra garante que
   * ele existe.
   */
  garantirDir: (id: string) => Promise<string | null>;
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  contas: [],
  status: {},
  padraoId: null,
  escolhidaId: null,
  temLoginPadrao: false,
  painelAberto: false,
  carregando: false,
  erro: null,

  carregar: async () => {
    try {
      const cfg = await configLoad();
      const contas = cfg.claudeAccounts ?? [];
      set({
        contas,
        // Um padrão apontando para conta apagada vira "sem padrão", e não um
        // id fantasma que faria todo terminal cair no `~/.claude` sem
        // explicação visível na interface.
        padraoId: contas.find((c) => c.id === cfg.defaultClaudeAccountId)?.id ?? null,
      });
      await get().atualizarStatus();
      set({ temLoginPadrao: await claudeDefaultLoginExists().catch(() => false) });
    } catch {
      // Sem config ainda, ou fora do app nativo: a lista fica vazia e a
      // interface oferece criar a primeira conta.
    }
  },

  atualizarStatus: async () => {
    const ids = get().contas.map((c) => c.id);
    if (ids.length === 0) {
      set({ status: {} });
      return;
    }
    try {
      const lista = await claudeAccountsStatus(ids);
      set({ status: Object.fromEntries(lista.map((s) => [s.id, s])) });
    } catch (e) {
      set({ erro: String(e) });
    }
  },

  criar: async (nome) => {
    const { contas } = get();
    const conta: ClaudeAccountPayload = {
      id: novoIdDeConta(),
      name: nomeUnico(nome ?? `Conta ${contas.length + 1}`, contas.map((c) => c.name)),
      color: proximaCor(contas.map((c) => c.color)),
      createdAt: Date.now(),
    };

    set({ carregando: true, erro: null });
    try {
      // A pasta nasce junto com a conta, semeada com as preferências da
      // configuração principal: uma conta que não herda o `settings.json` nem
      // o `CLAUDE.md` começa se comportando diferente das outras, e a pessoa
      // não tem como saber por quê.
      await claudeAccountPrepare(conta.id, true);
    } catch (e) {
      set({ carregando: false, erro: String(e) });
      return null;
    }

    const proximas = [...contas, conta];
    set({
      contas: proximas,
      carregando: false,
      // A primeira conta criada vira a padrão sozinha: cadastrar uma conta e
      // ela não ser usada por nada seria um resultado surpreendente.
      padraoId: get().padraoId ?? conta.id,
    });
    await persistir(get);
    await get().atualizarStatus();
    return conta;
  },

  renomear: (id, nome) => {
    const limpo = nome.trim();
    if (!limpo) return;
    set((s) => ({
      contas: s.contas.map((c) =>
        c.id === id
          ? { ...c, name: nomeUnico(limpo, s.contas.filter((o) => o.id !== id).map((o) => o.name)) }
          : c,
      ),
    }));
    void persistir(get);
  },

  definirPadrao: (id) => {
    set({ padraoId: id });
    void persistir(get);
  },

  escolher: (id) => set({ escolhidaId: id }),

  importarLoginAtual: async (id) => {
    set({ carregando: true, erro: null });
    try {
      await claudeAccountImport(id);
    } catch (e) {
      set({ erro: String(e) });
    } finally {
      set({ carregando: false });
      await get().atualizarStatus();
    }
  },

  sair: async (id) => {
    try {
      await claudeAccountLogout(id);
    } catch (e) {
      set({ erro: String(e) });
    }
    await get().atualizarStatus();
  },

  remover: async (id) => {
    try {
      await claudeAccountForget(id);
    } catch (e) {
      set({ erro: String(e) });
    }
    set((s) => ({
      contas: s.contas.filter((c) => c.id !== id),
      padraoId: s.padraoId === id ? null : s.padraoId,
      escolhidaId: s.escolhidaId === id ? null : s.escolhidaId,
    }));
    await persistir(get);
    await get().atualizarStatus();
  },

  abrirPainel: () => {
    set({ painelAberto: true });
    void get().atualizarStatus();
  },

  fecharPainel: () => set({ painelAberto: false }),

  dirDaConta: (id) => {
    if (!id) return null;
    return get().status[id]?.configDir ?? null;
  },

  garantirDir: async (id) => {
    const conhecido = get().status[id]?.configDir;
    if (conhecido) return conhecido;
    try {
      // `prepare` é idempotente: numa conta que já existe ele só confirma a
      // pasta e devolve o caminho.
      const dir = await claudeAccountPrepare(id, false);
      set((s) => ({
        status: {
          ...s.status,
          [id]: {
            ...(s.status[id] ?? {
              id,
              prepared: true,
              loggedIn: false,
              subscriptionType: null,
              expiresAt: null,
              rateLimitTier: null,
            }),
            configDir: dir,
            prepared: true,
          },
        },
      }));
      return dir;
    } catch {
      return null;
    }
  },

  envParaTerminal: async (workspaceAccountId, forcada) => {
    const { contas, escolhidaId, padraoId } = get();
    const conta = forcada
      ? (contas.find((c) => c.id === forcada) ?? null)
      : resolveConta(contas, {
          escolhidaNaHora: escolhidaId,
          doWorkspace: workspaceAccountId,
          padrao: padraoId,
        });
    if (!conta) return { conta: null, env: [] };

    const dir = await get().garantirDir(conta.id);
    // Sem caminho não dá para honrar a escolha. Devolver a conta assim mesmo
    // faria a aba se pintar como "Conta X" enquanto o terminal roda na
    // principal — melhor a interface não afirmar nada do que mentir.
    if (!dir) return { conta: null, env: [] };

    return { conta, env: envDaConta(dir) };
  },
}));

/**
 * Manda só a fatia das contas. Mesmo motivo do `workspaceStore.persist`:
 * mandar o documento inteiro faria a última tela a gravar apagar o que a
 * outra acabou de escrever.
 */
async function persistir(get: () => AccountStore) {
  const { contas, padraoId } = get();
  try {
    await configSave({ claudeAccounts: contas, defaultClaudeAccountId: padraoId });
  } catch {
    // Persistência não-crítica: a conta continua utilizável nesta execução.
  }
}
