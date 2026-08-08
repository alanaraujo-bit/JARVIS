import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SplitLayout } from "./components/SplitLayout";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { AiPanel } from "./components/AiPanel";
import { NotesPanel } from "./components/NotesPanel";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdatePanel } from "./components/UpdatePanel";
import { AccountsPanel } from "./components/AccountsPanel";
import { GuardianPanel } from "./components/GuardianPanel";
import { NavRail, type RailDest } from "./components/NavRail";
import { CollabScreen } from "./components/CollabScreen";
import { GuestWorkspace } from "./components/GuestWorkspace";
import { Onboarding } from "./components/Onboarding";
import { SettingsScreen } from "./components/SettingsScreen";
import { ProfileScreen } from "./components/ProfileScreen";
import type { Command as PaletteCommand } from "./lib/palette";
import { useShortcuts } from "./hooks/useShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useAiStore } from "./stores/aiStore";
import { useNotesStore } from "./stores/notesStore";
import { useUiStore } from "./stores/uiStore";
import { useUpdateStore } from "./stores/updateStore";
import { useAccountStore } from "./stores/accountStore";
import { paresDeCusto, useGuardianStore } from "./stores/guardianStore";
import { useCollabStore } from "./stores/collabStore";
import { onCollabAiAsk } from "./lib/collabIpc";
import { Icon, shellIcon } from "./components/Icon";
import { buildAiContext, buildSystemPrompt, captureTerminalLines } from "./lib/aiContext";
import { getTerminal } from "./lib/terminalRegistry";
import { parseLayout, restoreLayout } from "./lib/restoreLayout";
import { findOrphans, parseHistory, pruneHistory, type HistoryEntry } from "./lib/sessionHistory";
import { resolveConta } from "./lib/claudeAccounts";
import {
  minimizedTabs as filtraMinimizadas,
  moveTab as reordena,
  nextActiveAfterHiding,
  visibleTabs as filtraVisiveis,
} from "./lib/tabVisibility";
import { contaDoConfigDir } from "./lib/agentResume";
import {
  agentResumeProbe,
  appHomeDir,
  claudeAccountMigrateSession,
  claudeUsageLive,
  configLoad,
  configSave,
  onPtyExit,
  onWindowCloseFlush,
  ptyClose,
  ptyList,
  ptyResetViews,
  ptySpawn,
  ptyWrite,
  shellsDetect,
  type AgentResume,
  type SessionInfo,
  type ShellProfile,
  type TranscriptMeta,
} from "./lib/ipc";
import { COTA_ALERTA_PCT, formatCountdown } from "./lib/stats";
import {
  closePane as closePaneInTree,
  findLeaf,
  leaf,
  listLeaves,
  nextId,
  replaceSessionId,
  resizeSplit,
  splitPane,
  type Direction,
  type PaneNode,
} from "./lib/layout";

interface TabState {
  id: string;
  title: string;
  root: PaneNode;
  activePaneId: string;
  /**
   * Workspace em que a aba nasceu (null = modo livre). Pinta o ponto da aba
   * com a cor do workspace, que é o que permite achar as abas de um projeto
   * no meio de uma dúzia de outras.
   */
  workspaceId: string | null;
  /**
   * Minimizada: fora da barra de abas, na bandeja, com tudo vivo por trás —
   * sessão rodando, painel montado, saída chegando. É o meio-termo que
   * faltava entre "ativa" e "fechada" (que mata o processo).
   */
  minimized?: boolean;
  /**
   * Quando foi minimizada. Serve só para "restaurar a última": a ordem da
   * lista é a de criação, e a aba minimizada há dez minutos apareceria
   * depois da que acabou de sair da barra.
   */
  minimizedAt?: number;
}

const TEMA_ROTULO: Record<string, string> = {
  system: "seguindo o sistema",
  light: "claro",
  dark: "escuro",
};

const DENSIDADE_ROTULO: Record<string, string> = {
  cozy: "confortável",
  compact: "compacta",
};

function newTabFromSession(info: SessionInfo, workspaceId: string | null = null): TabState {
  const node = leaf(info.id);
  return {
    id: nextId("tab"),
    title: info.title,
    root: node,
    activePaneId: node.id,
    workspaceId,
    minimized: false,
  };
}

export default function App() {
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [home, setHome] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  /**
   * Conta do Claude Code de cada sessão viva, para pintar o ponto da aba e
   * saber em que login um terminal está sem ter que perguntar a ele.
   * Indexado por sessão, não por aba: um split pode nascer noutra conta.
   */
  const [sessionAccounts, setSessionAccounts] = useState<Record<string, string>>({});
  const reconciledRef = useRef(false);

  // Seletores estreitos, e não o objeto inteiro do store. Assinar o store
  // completo faria a identidade do estado mudar a cada `set` — e o painel de
  // IA faz um `set` por token recebido. Todo o `App` (e portanto todos os
  // painéis de terminal montados) reconciliaria dezenas de vezes por segundo
  // durante uma resposta, competindo com a escrita do PTY.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadFromConfig);
  const openFolderAndAdd = useWorkspaceStore((s) => s.openFolderAndAdd);
  const toggleSidebarRaw = useWorkspaceStore((s) => s.toggleSidebar);
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);

  const themeMode = useUiStore((s) => s.themeMode);
  const cycleTheme = useUiStore((s) => s.cycleTheme);
  const hydrateUi = useUiStore((s) => s.hydrate);
  const startSystemWatch = useUiStore((s) => s.startSystemWatch);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const railExpanded = useUiStore((s) => s.railExpanded);
  const setRailExpanded = useUiStore((s) => s.setRailExpanded);
  const onboardingDone = useUiStore((s) => s.onboardingDone);
  const setOnboardingDone = useUiStore((s) => s.setOnboardingDone);

  const contas = useAccountStore((s) => s.contas);
  const statusContas = useAccountStore((s) => s.status);
  const contaEscolhidaId = useAccountStore((s) => s.escolhidaId);
  const contaPadraoId = useAccountStore((s) => s.padraoId);
  const contasPainelAberto = useAccountStore((s) => s.painelAberto);
  const carregarContas = useAccountStore((s) => s.carregar);
  const escolherConta = useAccountStore((s) => s.escolher);
  const abrirPainelContas = useAccountStore((s) => s.abrirPainel);
  const fecharPainelContas = useAccountStore((s) => s.fecharPainel);

  const guardianPainelAberto = useGuardianStore((s) => s.painelAberto);
  const abrirPainelGuardian = useGuardianStore((s) => s.abrirPainel);
  const fecharPainelGuardian = useGuardianStore((s) => s.fecharPainel);
  const carregarGuardian = useGuardianStore((s) => s.carregar);

  const updateFase = useUpdateStore((s) => s.fase);
  const updatePainelAberto = useUpdateStore((s) => s.painelAberto);
  const abrirPainelUpdate = useUpdateStore((s) => s.abrirPainel);
  const fecharPainelUpdate = useUpdateStore((s) => s.fecharPainel);

  const aiPanelOpen = useAiStore((s) => s.panelOpen);
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const toggleAiPanelRaw = useAiStore((s) => s.togglePanel);
  const setAiPanelOpen = useAiStore((s) => s.setPanelOpen);
  const clearAiMessages = useAiStore((s) => s.clearMessages);

  const notesOpen = useNotesStore((s) => s.panelOpen);
  const toggleNotes = useNotesStore((s) => s.togglePanel);

  const collabOpen = useCollabStore((s) => s.panelOpen);
  const abrirCollab = useCollabStore((s) => s.openPanel);
  const fecharCollab = useCollabStore((s) => s.closePanel);
  const pendentesNaPorta = useCollabStore((s) => s.host.room?.pending.length ?? 0);
  /**
   * Enquanto o convidado está numa sala, a área de trabalho inteira passa a
   * ser a da máquina do anfitrião. Os terminais locais continuam vivos por
   * trás — só não são o que está na tela.
   */
  const emSalaDeOutro = useCollabStore((s) => s.guest.phase === "joined");

  /**
   * Abaixo de 900px as duas gavetas passam a flutuar sobre o terminal em vez
   * de disputar espaço com ele (ver `styles.css`). Com as duas abertas ao
   * mesmo tempo elas cobrem a maior parte da tela e o que sobra do terminal
   * fica ilegível, cortado no meio da palavra. Abrir uma fecha a outra
   * automaticamente só nesse regime — em tela larga as duas convivem bem.
   */
  const ESTREITO = 900;
  const toggleSidebar = useCallback(() => {
    if (window.innerWidth <= ESTREITO && !sidebarOpen) setAiPanelOpen(false);
    toggleSidebarRaw();
  }, [sidebarOpen, setAiPanelOpen, toggleSidebarRaw]);
  const toggleAiPanel = useCallback(() => {
    if (window.innerWidth <= ESTREITO && !aiPanelOpen) setSidebarOpen(false);
    toggleAiPanelRaw();
  }, [aiPanelOpen, setSidebarOpen, toggleAiPanelRaw]);

  /**
   * Recolhe ou expande o menu lateral. É o único caminho que alterna o
   * estado — o botão do rodapé do rail e a paleta passam os dois por aqui,
   * para o estado nunca divergir entre si.
   */
  const toggleRail = useCallback(() => {
    setRailExpanded(!railExpanded);
  }, [railExpanded, setRailExpanded]);

  /**
   * Fecha as telas de Configurações e Perfil. Separado porque elas se
   * comportam como as outras sobreposições — só uma na tela por vez — e
   * aparecem em todos os pontos de troca (menu, atalhos, paleta, Esc).
   */
  const fecharTelas = useCallback(() => {
    setSettingsOpen(false);
    setProfileOpen(false);
  }, []);

  /**
   * Roteador do menu lateral: fecha o que estiver aberto e abre a rota
   * pedida. Clicar na rota já ativa a fecha (comportamento de alternância,
   * como o botão da barra lateral de workspaces) — e "Início" só fecha.
   */
  const selecionarRota = useCallback(
    (dest: RailDest) => {
      const eraAtiva =
        (dest === "share" && collabOpen) ||
        (dest === "notes" && notesOpen) ||
        (dest === "stats" && statsOpen) ||
        (dest === "history" && historyOpen) ||
        (dest === "accounts" && contasPainelAberto) ||
        (dest === "guardian" && guardianPainelAberto) ||
        (dest === "settings" && settingsOpen) ||
        (dest === "profile" && profileOpen);

      if (!eraAtiva) {
        setPaletteOpen(false);
        setStatsOpen(false);
        setHistoryOpen(false);
        fecharPainelUpdate();
        fecharPainelContas();
        fecharPainelGuardian();
        fecharTelas();
        fecharCollab();
      }

      switch (dest) {
        case "share":
          if (eraAtiva) fecharCollab();
          else abrirCollab();
          break;
        case "notes":
          toggleNotes();
          break;
        case "stats":
          setStatsOpen(!eraAtiva);
          break;
        case "history":
          setHistoryOpen(!eraAtiva);
          break;
        case "accounts":
          // Alternância como as telas: clicar na conta já aberta a fecha.
          if (eraAtiva) fecharPainelContas();
          else abrirPainelContas();
          break;
        case "guardian":
          if (eraAtiva) fecharPainelGuardian();
          else abrirPainelGuardian();
          break;
        case "settings":
          setSettingsOpen(!eraAtiva);
          break;
        case "profile":
          setProfileOpen(!eraAtiva);
          break;
        default:
          // "Início": o bloco acima já fechou tudo.
          break;
      }
    },
    [
      collabOpen,
      abrirCollab,
      fecharCollab,
      notesOpen,
      toggleNotes,
      statsOpen,
      historyOpen,
      contasPainelAberto,
      guardianPainelAberto,
      settingsOpen,
      profileOpen,
      fecharPainelUpdate,
      fecharPainelContas,
      fecharPainelGuardian,
      fecharTelas,
    ],
  );

  // Refs espelhando o estado mais recente para uso dentro de callbacks
  // estáveis (atalhos de teclado) sem precisar recriá-los a cada mudança.
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const homeRef = useRef(home);
  homeRef.current = home;
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  /**
   * Histórico leve de sessões (workspace, pasta, comando) — não as sessões em
   * si, que morrem com o processo do app. Serve pra avisar, na próxima
   * abertura, o que ficou pendurado quando o app fechou sem passar pelo
   * `pty_close` de cada aba (Alt+F4, queda, "Encerrar tarefa").
   */
  const historyRef = useRef<HistoryEntry[]>([]);
  const [recovery, setRecovery] = useState<HistoryEntry[]>([]);
  // Encadeia os saves em vez de disparar cada um solto: duas ações rápidas
  // (abrir um terminal, fechar outro) geram dois `configSave` cujas respostas
  // podem chegar fora de ordem — sem fila, a mais lenta sobrescreveria a mais
  // nova no disco com um snapshot velho.
  const historySaveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const persistHistory = useCallback(() => {
    historyRef.current = pruneHistory(historyRef.current);
    const snapshot = historyRef.current;
    historySaveChainRef.current = historySaveChainRef.current.then(() =>
      configSave({ sessionHistory: snapshot }).catch(() => {}),
    );
  }, []);

  const markHistoryEnded = useCallback(
    (id: string) => {
      let mudou = false;
      historyRef.current = historyRef.current.map((e) => {
        if (e.id !== id || e.endedAt !== null) return e;
        mudou = true;
        return { ...e, endedAt: Date.now() };
      });
      if (mudou) persistHistory();
    },
    [persistHistory],
  );

  /**
   * Tema: o `index.html` já pintou um palpite vindo do `localStorage`; aqui
   * a preferência real, que mora no config em disco, assume. Corre em
   * paralelo com o resto do arranque de propósito — esperar o config para
   * desenhar a janela seria trocar um flash por uma tela preta.
   */
  useEffect(() => {
    const parar = startSystemWatch();
    void configLoad()
      .then((cfg) =>
        hydrateUi({
          theme: cfg.ui?.theme,
          density: cfg.ui?.density,
          onboardingDone: cfg.ui?.onboardingDone,
        }),
      )
      .catch(() => {});
    return parar;
  }, [hydrateUi, startSystemWatch]);

  /**
   * Atualizações: lê a versão instalada e liga a checagem periódica. A
   * primeira consulta sai com alguns segundos de atraso, fora do caminho
   * crítico da abertura (ver `updateStore`).
   */
  useEffect(() => {
    const store = useUpdateStore.getState();
    void store.init();
    return store.iniciarChecagemAutomatica();
  }, []);

  useEffect(() => {
    void shellsDetect().then(setProfiles).catch((e) => setError(String(e)));
    void appHomeDir().then(setHome).catch(() => {});

    // Carrega configuração salva (workspaces + IA + contas do Claude Code)
    void loadWorkspaces();
    void loadAiConfig();
    void carregarContas();
    void carregarGuardian();

    if (reconciledRef.current) return;
    reconciledRef.current = true;

    // O dono das sessões é o backend, não este `useState`. Um F5, o HMR do
    // Vite ou uma recuperação de crash do WebView zerariam a lista aqui
    // enquanto os shells continuam vivos — inalcançáveis, sem aba e sem como
    // fechar. Reconciliar na montagem devolve todos eles, e o arranjo salvo
    // no config recompõe as divisões em que eles estavam.
    void Promise.all([ptyList(), configLoad().catch(() => null)])
      .then(async ([existentes, cfg]) => {
        if (existentes.length === 0) return;
        await Promise.allSettled(existentes.map((s) => ptyResetViews(s.id)));

        setSessions((prev) => {
          const next = { ...prev };
          for (const s of existentes) next[s.id] = s;
          return next;
        });

        // Acrescenta, não substitui: `ptyList` e o `allSettled` sobre N
        // sessões levam tempo, e uma aba aberta pelo usuário nesse intervalo
        // seria apagada da tela — com a sessão dela sobrando órfã no backend.
        const jaNaTela = new Set(
          tabsRef.current.flatMap((t) => listLeaves(t.root).map((l) => l.sessionId)),
        );
        const pendentes = existentes.filter((s) => !jaNaTela.has(s.id));
        if (pendentes.length === 0) return;

        // O arranjo salvo devolve as divisões; sem ele, cada sessão viraria
        // uma aba solta e um layout de quatro painéis voltaria embaralhado.
        const restaurado = restoreLayout(
          parseLayout(cfg?.layout),
          pendentes.map((s) => s.id),
        );

        const porId = new Map(pendentes.map((s) => [s.id, s]));
        const novasAbas: TabState[] = [
          ...restaurado.tabs,
          // Sessões que o arranjo não mencionava (abertas depois do último
          // save, ou arranjo ausente) entram como abas simples.
          ...restaurado.sessoesSoltas.flatMap((id) => {
            const info = porId.get(id);
            return info ? [newTabFromSession(info)] : [];
          }),
        ];
        if (novasAbas.length === 0) return;

        aplicaTabs((prev) => [...prev, ...novasAbas]);
        setActiveTabId(
          (atual) => atual ?? restaurado.activeTabId ?? novasAbas[novasAbas.length - 1].id,
        );
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Carrega o histórico e descobre "órfãs": entradas que a última execução
   * nunca marcou como encerradas e que não estão entre as sessões vivas
   * agora. Isso só é diferente de vazio quando o app inteiro foi fechado sem
   * passar pelo `pty_close` — recarregar a página (F5/HMR) reconcilia as
   * mesmas sessões vivas acima e não gera órfã nenhuma.
   */
  useEffect(() => {
    void (async () => {
      const [cfg, existentes] = await Promise.all([
        configLoad().catch(() => null),
        ptyList().catch(() => []),
      ]);
      const entries = parseHistory(cfg?.sessionHistory);
      historyRef.current = entries;
      const aliveIds = new Set(existentes.map((s) => s.id));
      const orfas = findOrphans(entries, aliveIds);
      if (orfas.length > 0) setRecovery(orfas);
    })();
  }, []);

  /**
   * Trabalho compartilhado: espelha o estado da sala e responde aos
   * convidados.
   *
   * A pergunta de um convidado é atendida **pelo mesmo caminho** que a do
   * anfitrião — o mesmo provedor, as mesmas chaves, o mesmo contexto de
   * terminal, e o balão aparece na conversa daqui. Ter um segundo caminho
   * "para a IA remota" significaria duas implementações do que é a mesma
   * pergunta, e uma delas envelheceria sem ninguém notar.
   */
  useEffect(() => {
    let soltar: (() => void) | null = null;
    void useCollabStore
      .getState()
      .init()
      .then((fn) => {
        soltar = fn;
      });

    const pedido = onCollabAiAsk((e) => {
      if (e.k !== "ask") return;
      const { systemPrompt, context } = captureAiContextRef.current();
      void useAiStore.getState().sendMessage(e.text, context, systemPrompt, {
        author: { name: e.authorName, color: e.authorColor },
        relayId: e.requestId,
      });
    });

    return () => {
      soltar?.();
      void pedido.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = onPtyExit((e) => {
      markHistoryEnded(e.id);
      setSessions((prev) => {
        const existing = prev[e.id];
        if (!existing) return prev;
        return { ...prev, [e.id]: { ...existing, alive: false, exitCode: e.exitCode } };
      });
    });
    return () => {
      void p.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Fechar a janela pelo X/Alt+F4 é um encerramento normal, não uma queda —
   * mas sem isto ele ficaria indistinguível de uma queda para o histórico
   * (nenhum `pty_close` roda por aba antes do processo morrer). Marca tudo
   * que ainda está aberto como encerrado e espera o save terminar antes de
   * deixar a janela fechar de verdade, senão a escrita corre contra o
   * encerramento do processo e pode nem chegar ao disco.
   */
  useEffect(() => {
    const p = onWindowCloseFlush(async () => {
      let mudou = false;
      const agora = Date.now();
      historyRef.current = historyRef.current.map((e) => {
        if (e.endedAt !== null) return e;
        mudou = true;
        return { ...e, endedAt: agora };
      });
      if (mudou) {
        await configSave({ sessionHistory: pruneHistory(historyRef.current) }).catch(() => {});
      }
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, []);

  /* ------------------------------ ações ------------------------------- */

  /**
   * Única porta de entrada para mudar a lista de abas.
   *
   * A ref é a versão autoritativa, e não um espelho do estado: ela é
   * atualizada na hora, antes do React reconciliar. Isso importa porque as
   * ações que criam painéis são assíncronas (esperam o `spawn` do PTY) e o
   * updater do `setState` só roda no render seguinte — duas divisões em
   * sequência rápida leriam a mesma árvore antiga, e a segunda descartaria o
   * painel da primeira, deixando um shell vivo sem lugar na tela.
   *
   * Também mantém os updaters do React puros: o cálculo acontece aqui fora,
   * então nada de `pty_close` disparando duas vezes pela invocação dupla do
   * StrictMode.
   */
  const aplicaTabs = useCallback((updater: (prev: TabState[]) => TabState[]): TabState[] => {
    const next = updater(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
    return next;
  }, []);

  const spawnFor = useCallback(
    async (
      profile: ShellProfile | undefined,
      cwd: string | undefined,
      title?: string,
      initialCommand?: string,
      /**
       * Conta do Claude Code a forçar, ignorando a precedência normal. Só o
       * fluxo de "Entrar numa conta" usa isto — todo o resto quer justamente
       * a resolução automática.
       */
      contaForcada?: string | null,
    ) => {
      const ws = workspacesRef.current.find((w) => w.id === activeWorkspaceIdRef.current) ?? null;

      // A conta vira uma variável de ambiente e nada mais: a CLI `claude` lê
      // `CLAUDE_CONFIG_DIR` e passa a viver na pasta daquela conta. Sem conta
      // cadastrada o `env` sai vazio e o terminal usa o `~/.claude` de
      // sempre — quem não cadastrou nada não percebe que isto existe.
      const { conta, env } = await useAccountStore
        .getState()
        .envParaTerminal(ws?.claudeAccountId ?? null, contaForcada);

      const info = await ptySpawn({
        program: profile?.program,
        args: profile?.args,
        cwd,
        env,
        title: title ?? profile?.name,
        profileId: profile?.id,
        initialCommand: initialCommand || undefined,
        // Vai junto só para o histórico gravado saber a que projeto esta
        // sessão pertencia quando alguém for relê-la semanas depois.
        workspaceId: ws?.id ?? null,
        workspaceName: ws?.name ?? null,
      });
      setSessions((prev) => ({ ...prev, [info.id]: info }));
      // Guardado por SESSÃO, e não por aba: um split herda a conta do
      // terminal que o gerou, e uma aba com dois painéis pode legitimamente
      // ter duas contas diferentes.
      if (conta) {
        setSessionAccounts((prev) => ({ ...prev, [info.id]: conta.id }));
        // O guardião precisa saber já: um terminal que acabou de nascer numa
        // conta é uso em andamento, e o lease imediato evita que ele pingue
        // a conta no primeiro ciclo do agendador.
        void useGuardianStore.getState().sinalizarUso([conta.id]);
      }

      historyRef.current = [
        ...historyRef.current,
        {
          id: info.id,
          workspaceId: ws?.id ?? null,
          workspaceName: ws?.name ?? null,
          cwd: info.cwd,
          program: info.program,
          args: info.args,
          profileId: info.profileId,
          title: info.title,
          autoCommand: initialCommand || null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ];
      persistHistory();

      return info;
    },
    [persistHistory],
  );

  /** Retorna o cwd correto: workspace ativo > home. */
  const getActiveCwd = useCallback(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    return ws?.path ?? homeRef.current ?? undefined;
  }, [activeWorkspaceId, workspaces]);

  const openTab = useCallback(
    async (profile: ShellProfile) => {
      try {
        const cwd = getActiveCwd();
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        const info = await spawnFor(profile, cwd, undefined, ws?.autoCommand ?? undefined);
        const tab = newTabFromSession(info, activeWorkspaceId);
        aplicaTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [spawnFor, getActiveCwd, aplicaTabs, activeWorkspaceId, workspaces],
  );

  /**
   * Abre um terminal já apontado para a conta e com o `claude` rodando, que é
   * onde o `/login` acontece.
   *
   * O login do Claude Code é um fluxo interativo dentro da própria CLI — não
   * há como o JARVIS fazê-lo por fora. O que ele pode fazer é entregar o
   * terminal certo, na pasta certa, com o comando já digitado: a pessoa só
   * roda `/login` e volta.
   */
  const entrarNaConta = useCallback(
    async (conta: { id: string; name: string }) => {
      try {
        // Shell recomendado da máquina, e não o preferido do workspace: este
        // terminal existe para fazer login, não para trabalhar num projeto.
        const perfil =
          profilesRef.current.find((p) => p.recommended) ?? profilesRef.current[0];
        const info = await spawnFor(
          perfil,
          homeRef.current || undefined,
          `Login · ${conta.name}`,
          "claude",
          conta.id,
        );
        const tab = newTabFromSession(info, null);
        aplicaTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
        fecharPainelContas();
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [spawnFor, aplicaTabs, fecharPainelContas],
  );

  /** Descarta uma entrada de recuperação, marcando-a como encerrada no histórico. */
  const dismissRecovery = useCallback(
    (id: string) => {
      setRecovery((prev) => prev.filter((e) => e.id !== id));
      markHistoryEnded(id);
    },
    [markHistoryEnded],
  );

  /**
   * Reabre um terminal a partir de uma entrada de recuperação.
   *
   * Uma queda leva a aba, não a conversa: o agente gravou o que foi dito do
   * lado dele. Por isso a recuperação pergunta ao backend como retomar antes
   * de abrir — quem perdeu o trabalho num Alt+F4 quer voltar para dentro da
   * conversa, não para um prompt limpo na mesma pasta.
   */
  const reopenRecovery = useCallback(
    async (entry: HistoryEntry) => {
      try {
        const profile =
          profilesRef.current.find((p) => p.id === entry.profileId) ??
          profilesRef.current.find((p) => p.recommended) ??
          profilesRef.current[0];
        // Uma falha aqui não pode impedir a reabertura: sem retomada, o
        // terminal volta como antes — que é exatamente o comportamento que
        // existia até esta versão.
        const resume = await agentResumeProbe(entry.id).catch(() => null);
        const info = await spawnFor(
          profile,
          entry.cwd,
          entry.title,
          resume?.command ?? entry.autoCommand ?? undefined,
          contaDoConfigDir(resume?.configDir, useAccountStore.getState().contas),
        );
        const tab = newTabFromSession(info, entry.workspaceId);
        aplicaTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
      } catch (e) {
        setError(String(e));
      } finally {
        dismissRecovery(entry.id);
      }
    },
    [spawnFor, aplicaTabs, dismissRecovery],
  );

  /**
   * Abre um terminal novo a partir de uma sessão gravada: mesma pasta, mesmo
   * shell — e, quando havia um agente de IA ali, dentro da mesma conversa.
   *
   * O processo não volta: aquele morreu junto com a sessão original. Mas a
   * conversa não vivia no processo, e sim no depósito do agente; `resume`
   * (vindo de `agent_resume_probe`) traz a linha que a reabre pelo id — e a
   * conta em que ela foi gravada, porque um `--resume` na conta errada
   * procuraria uma sessão que não existe lá.
   *
   * Sem `resume`, o comportamento é o de antes: mesma pasta, mesmo comando
   * de auto-início, conversa nova.
   */
  const reopenFromHistory = useCallback(
    async (m: TranscriptMeta, resume?: AgentResume | null) => {
      try {
        const profile =
          profilesRef.current.find((p) => p.id === m.profileId) ??
          profilesRef.current.find((p) => p.program === m.program) ??
          profilesRef.current.find((p) => p.recommended) ??
          profilesRef.current[0];
        const info = await spawnFor(
          profile,
          m.cwd,
          m.title,
          resume?.command ?? m.autoCommand ?? undefined,
          contaDoConfigDir(resume?.configDir, useAccountStore.getState().contas),
        );
        const tab = newTabFromSession(info, m.workspaceId);
        aplicaTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
        setHistoryOpen(false);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [spawnFor, aplicaTabs],
  );

  /**
   * Perfil usado quando o usuário pede "uma aba nova" sem dizer qual shell:
   * o preferido do workspace ativo, se houver, senão o recomendado da
   * máquina. É o que faz um projeto em Node abrir sempre no Git Bash sem
   * o usuário ter que escolher toda vez.
   */
  const perfilPadrao = useCallback(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const doWorkspace = ws?.defaultProfileId
      ? profilesRef.current.find((p) => p.id === ws.defaultProfileId)
      : undefined;
    return (
      doWorkspace ?? profilesRef.current.find((p) => p.recommended) ?? profilesRef.current[0]
    );
  }, [workspaces, activeWorkspaceId]);

  const openDefaultTab = useCallback(() => {
    const perfil = perfilPadrao();
    if (perfil) void openTab(perfil);
  }, [openTab, perfilPadrao]);

  /**
   * Fecha uma sessão no backend e esquece ela por completo do lado do front.
   * Sem o segundo passo, `sessions` cresceria sem limite ao longo de uma
   * sessão de uso longa — toda aba fechada e todo reinício de painel morto
   * deixariam uma entrada morta para trás para sempre.
   */
  const closeSession = useCallback((sessionId: string) => {
    void ptyClose(sessionId).catch(() => {});
    markHistoryEnded(sessionId);
    setSessions((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, [markHistoryEnded]);

  /**
   * Escolhe qual aba fica ativa depois que `tabId` sai da barra. Separado
   * para os três caminhos (fechar a aba, fechar o último painel dela,
   * minimizar) não divergirem — e por índice de *aba visível*, não da lista
   * crua: com minimizadas no meio, o vizinho da lista pode não ser o vizinho
   * que o usuário vê.
   */
  const ativaVizinha = useCallback((antes: TabState[], tabId: string) => {
    setActiveTabId((cur) => nextActiveAfterHiding(antes, tabId, cur));
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      const antes = tabsRef.current;
      const tab = antes.find((t) => t.id === tabId);
      if (!tab) return;

      // As sessões são fechadas aqui, fora do updater. Fazer isso lá dentro
      // disparava dois `pty_close` por aba na invocação dupla do StrictMode.
      for (const l of listLeaves(tab.root)) closeSession(l.sessionId);

      aplicaTabs((prev) => prev.filter((t) => t.id !== tabId));
      ativaVizinha(antes, tabId);
    },
    [aplicaTabs, ativaVizinha, closeSession],
  );

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const antes = tabsRef.current;
      const tab = antes.find((t) => t.id === tabId);
      if (!tab) return;

      const target = findLeaf(tab.root, paneId);
      if (!target) return;
      closeSession(target.sessionId);

      const nextRoot = closePaneInTree(tab.root, paneId);
      if (nextRoot === null) {
        // Era o último painel: a aba inteira vai junto.
        aplicaTabs((prev) => prev.filter((t) => t.id !== tabId));
        ativaVizinha(antes, tabId);
        return;
      }

      const stillActive = findLeaf(nextRoot, tab.activePaneId);
      const nextActive = stillActive ? tab.activePaneId : listLeaves(nextRoot)[0].id;
      aplicaTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, root: nextRoot, activePaneId: nextActive } : t)),
      );
    },
    [aplicaTabs, ativaVizinha, closeSession],
  );

  /**
   * Tira a aba da barra sem tocar na sessão.
   *
   * Nada é desmontado: o `<div className="pane">` da aba continua no DOM,
   * apenas `hidden`, exatamente como já acontece com qualquer aba de fundo.
   * Isso não é economia de código, é o requisito — desmontar destruiria o
   * xterm e o `npm run dev` minimizado perderia todo o scrollback dele.
   */
  const minimizeTab = useCallback(
    (tabId: string) => {
      const antes = tabsRef.current;
      if (!antes.some((t) => t.id === tabId && !t.minimized)) return;

      aplicaTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, minimized: true, minimizedAt: Date.now() } : t)),
      );
      setActiveTabId((cur) => nextActiveAfterHiding(antes, tabId, cur));
    },
    [aplicaTabs],
  );

  const restoreTab = useCallback(
    (tabId: string) => {
      aplicaTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, minimized: false, minimizedAt: undefined } : t,
        ),
      );
      // Restaurar sem focar deixaria a aba reaparecer na barra e o usuário
      // ainda ter que clicar nela — dois passos para um pedido só.
      setActiveTabId(tabId);
    },
    [aplicaTabs],
  );

  const moveTab = useCallback(
    (fromId: string, toId: string) => {
      aplicaTabs((prev) => reordena(prev, fromId, toId));
    },
    [aplicaTabs],
  );

  const focusPane = useCallback(
    (tabId: string, paneId: string) => {
      aplicaTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
      );
    },
    [aplicaTabs],
  );

  const resizePane = useCallback(
    (tabId: string, splitId: string, sizes: number[]) => {
      aplicaTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, root: resizeSplit(t.root, splitId, sizes) } : t)),
      );
    },
    [aplicaTabs],
  );

  const splitActivePane = useCallback(
    async (direction: Direction) => {
      const tabId = activeTabIdRef.current;
      if (!tabsRef.current.some((t) => t.id === tabId)) return;
      try {
        const cwd = getActiveCwd();
        // Sem `autoCommand` de propósito: um split existe pra rodar outra
        // coisa AO LADO do agente já em execução no painel original, não
        // pra abrir um segundo `claude` disputando o mesmo terminal visual.
        const info = await spawnFor(perfilPadrao(), cwd);

        // A árvore só é lida DEPOIS do await. Capturá-la antes e aplicar o
        // resultado depois perdia divisões: duas chamadas rápidas
        // (Ctrl+Shift+D repetido) partiam da mesma raiz antiga, e a segunda
        // descartava o painel criado pela primeira — que ficava vivo no
        // backend, sem folha na árvore e sem como fechar.
        let acomodado = false;
        aplicaTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            const result = splitPane(t.root, t.activePaneId, direction, info.id);
            if (!result) return t;
            acomodado = true;
            return { ...t, root: result.root, activePaneId: result.newLeaf.id };
          }),
        );

        // A aba ou o painel alvo podem ter sumido entre o clique e o spawn.
        // Sem isto, a sessão recém-criada fica órfã: viva, invisível e
        // segurando o que quer que o shell tenha lançado.
        if (!acomodado) {
          void ptyClose(info.id).catch(() => {});
          setSessions((prev) => {
            const next = { ...prev };
            delete next[info.id];
            return next;
          });
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [spawnFor, getActiveCwd, aplicaTabs, perfilPadrao],
  );

  const restartPane = useCallback(
    async (
      tabId: string,
      paneId: string,
      /**
       * Sobrescritas usadas pela troca de conta (ver `switchAccountForPane`):
       * uma conta forçada, ignorando a precedência normal, e um comando de
       * abertura diferente do auto-início do workspace — o `claude --resume`
       * que retoma a conversa na conta nova.
       */
      opts?: { contaForcada?: string | null; comando?: string },
    ) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const target = findLeaf(tab.root, paneId);
      if (!target) return;
      const dead = sessions[target.sessionId];
      if (!dead) return;

      try {
        const profile = profilesRef.current.find((p) => p.id === dead.profileId);
        // Ao contrário do split, reiniciar É o mesmo terminal renascendo —
        // faz sentido reaplicar o auto-início do workspace, não só na
        // primeira abertura.
        const ws = workspacesRef.current.find((w) => w.id === tab.workspaceId);
        const info = await spawnFor(
          profile ?? { id: "", name: dead.title, program: dead.program, args: dead.args, icon: "", recommended: false },
          dead.cwd,
          dead.title,
          opts?.comando ?? ws?.autoCommand ?? undefined,
          opts?.contaForcada,
        );
        closeSession(dead.id);

        let acomodado = false;
        aplicaTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId || !findLeaf(t.root, paneId)) return t;
            acomodado = true;
            return { ...t, root: replaceSessionId(t.root, paneId, info.id) };
          }),
        );
        // A aba pode ter sido fechada entre o clique em "Reiniciar" e o
        // spawn; sem isto o shell novo ficaria rodando sem painel.
        if (!acomodado) {
          void ptyClose(info.id).catch(() => {});
          setSessions((prev) => {
            const next = { ...prev };
            delete next[info.id];
            return next;
          });
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [sessions, spawnFor, closeSession, aplicaTabs],
  );

  /**
   * Troca a conta do Claude Code usada por um painel já aberto.
   *
   * Não existe forma de mudar a variável de ambiente de um processo vivo —
   * `CLAUDE_CONFIG_DIR` só é lida no nascimento do `claude`. Então isto
   * reinicia o shell do painel (como o botão "Reiniciar"), mas antes copia a
   * conversa que estava rodando ali para a pasta da conta nova e pede ao
   * terminal novo para retomá-la (`claude --resume`) — de fora, a conversa
   * continua de onde parou; só o processo por trás é outro.
   *
   * Sem conversa de IA identificada (painel comum, ou sessão do agente que
   * nunca chegou a gravar nada), o painel reinicia do mesmo jeito, só que
   * numa conversa nova — o mesmo que "Reiniciar" já fazia.
   */
  const switchAccountForPane = useCallback(
    async (tabId: string, paneId: string, accountId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const target = findLeaf(tab.root, paneId);
      if (!target) return;
      const session = sessions[target.sessionId];
      if (!session) return;

      try {
        const dirNovo = await useAccountStore.getState().garantirDir(accountId);
        if (!dirNovo) {
          setError("Não foi possível preparar a pasta da conta.");
          return;
        }

        const resume = await agentResumeProbe(session.id).catch(() => null);
        if (resume?.kind === "claude" && resume.sessionId) {
          await claudeAccountMigrateSession({
            fromConfigDir: resume.configDir,
            toConfigDir: dirNovo,
            cwd: session.cwd,
            sessionId: resume.sessionId,
          }).catch((e) => setError(String(e)));
        }

        await restartPane(tabId, paneId, {
          contaForcada: accountId,
          comando: resume?.command,
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [sessions, restartPane],
  );

  /* ----------------------------- IA ----------------------------------- */

  /** Escreve um comando no terminal ativo (usado pelo painel IA "Executar"). */
  const runCommandInTerminal = useCallback((command: string) => {
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (!tab) return;
    const target = findLeaf(tab.root, tab.activePaneId);
    if (!target) return;
    // Envia o texto + Enter para o terminal ativo
    void ptyWrite(target.sessionId, command + "\r").catch(() => {});
  }, []);

  /**
   * Contexto que acompanha cada pergunta ao agente: pasta do workspace,
   * shell e — o que de fato torna o assistente útil — as últimas linhas do
   * terminal ativo, lidas direto do buffer do xterm.
   */
  const captureAiContext = useCallback(() => {
    const ws =
      workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    const target = tab ? findLeaf(tab.root, tab.activePaneId) : null;
    const session = target ? sessions[target.sessionId] : null;

    const term = target ? getTerminal(target.sessionId) : undefined;
    const terminalLines = term ? captureTerminalLines(term) : null;

    return {
      systemPrompt: buildSystemPrompt(),
      context: buildAiContext(ws, session?.title ?? session?.program ?? null, terminalLines),
    };
  }, [activeWorkspaceId, workspaces, sessions]);

  // O ouvinte de perguntas dos convidados é registrado uma vez só, na
  // montagem; sem esta ref ele congelaria o contexto do primeiro render e as
  // respostas passariam a ignorar o terminal e o projeto que estão ativos
  // agora.
  const captureAiContextRef = useRef(captureAiContext);
  captureAiContextRef.current = captureAiContext;

  /**
   * Contas com terminal vivo agora — o que o heartbeat do guardião precisa
   * saber. Espelhado em ref (como `tabsRef`) para o intervalo usar o valor
   * mais recente sem se recriar a cada mudança de sessão.
   */
  const contasEmUsoRef = useRef<Set<string>>(new Set());
  contasEmUsoRef.current = (() => {
    const ids = new Set<string>();
    for (const s of Object.values(sessions)) {
      if (!s.alive) continue;
      const acc = sessionAccounts[s.id];
      if (acc) ids.add(acc);
    }
    return ids;
  })();

  /**
   * Heartbeat do guardião: a cada minuto, renova o lease das contas em uso
   * (o lease do guardião dura 2 min, então há sempre folga). É isso que faz
   * o guardião respeitar o uso real e não mandar "oi" numa conta que você
   * está usando agora.
   */
  useEffect(() => {
    const t = window.setInterval(() => {
      const ids = [...contasEmUsoRef.current];
      if (ids.length > 0) void useGuardianStore.getState().sinalizarUso(ids);
    }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  /**
   * Sincronização de custos com o guardião: o custo real (em $) só existe nos
   * arquivos do PC (a CLI grava lá), então enquanto o JARVIS estiver aberto
   * ele empurra o valor de cada conta para o guardião a cada 10 min. É isso
   * que alimenta a tela de estatísticas do celular — sem o PC aberto o
   * celular mostra a cota ao vivo mesmo assim, só sem o ranking em $.
   */
  useEffect(() => {
    let retry: number | undefined;
    let tentativas = 0;
    const sync = () => {
      const { contas, status } = useAccountStore.getState();
      const pares = paresDeCusto(contas, status);
      // Contas/status ainda carregando (primeiro boot): a primeira sincronização
      // vale a pena — tenta a cada 15s por até ~5 min e então desiste até o
      // próximo ciclo de 10 min (teto evita timer infinito se o status nunca
      // carregar). Em sucesso, o contador zera para o próximo boot.
      if (pares.length === 0) {
        if (tentativas >= 20) return;
        tentativas += 1;
        retry = window.setTimeout(sync, 15_000);
        return;
      }
      tentativas = 0;
      void useGuardianStore.getState().sincronizarCustos(pares);
    };
    sync();
    const t = window.setInterval(sync, 10 * 60_000);
    return () => {
      window.clearInterval(t);
      if (retry) window.clearTimeout(retry);
    };
  }, []);

  /* ---------------------------- atalhos -------------------------------- */

  const shortcutActions = useMemo(
    () => ({
      newTab: openDefaultTab,
      closePane: () => {
        const tabId = activeTabIdRef.current;
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (tab) closePane(tab.id, tab.activePaneId);
      },
      minimizeTab: () => {
        const tabId = activeTabIdRef.current;
        if (tabId) minimizeTab(tabId);
      },
      restoreLastMinimized: () => {
        // A última a ser minimizada é a primeira a voltar: quem pede isso
        // acabou de esconder algo e mudou de ideia.
        const ultima = filtraMinimizadas(tabsRef.current).reduce<TabState | null>(
          (maisNova, t) =>
            !maisNova || (t.minimizedAt ?? 0) >= (maisNova.minimizedAt ?? 0) ? t : maisNova,
          null,
        );
        if (ultima) restoreTab(ultima.id);
      },
      // Sempre sobre as abas VISÍVEIS: parar numa minimizada deixaria a tela
      // em branco, porque o painel dela existe mas não é o ativo — e o
      // Ctrl+1..9 tem que casar com o que está desenhado na barra, não com
      // uma posição na lista interna que ninguém enxerga.
      nextTab: () => {
        const list = filtraVisiveis(tabsRef.current);
        if (list.length < 2) return;
        const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
        setActiveTabId(list[(idx + 1) % list.length].id);
      },
      prevTab: () => {
        const list = filtraVisiveis(tabsRef.current);
        if (list.length < 2) return;
        const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
        setActiveTabId(list[(idx - 1 + list.length) % list.length].id);
      },
      gotoTab: (index: number) => {
        const list = filtraVisiveis(tabsRef.current);
        if (index >= 0 && index < list.length) setActiveTabId(list[index].id);
      },
      splitRight: () => void splitActivePane("row"),
      splitDown: () => void splitActivePane("column"),
      // Navegação por ordem visual das folhas, não geométrica: simples e
      // previsível, ainda que não "pule" na direção literal em layouts
      // muito assimétricos. Suficiente para o número de painéis que um
      // terminal costuma ter; um algoritmo geométrico fica para depois se
      // isso se mostrar insuficiente na prática.
      focusPaneDirection: (dir: "left" | "right" | "up" | "down") => {
        const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        if (!tab) return;
        const leaves = listLeaves(tab.root);
        if (leaves.length < 2) return;
        const idx = leaves.findIndex((l) => l.id === tab.activePaneId);
        const forward = dir === "right" || dir === "down";
        const nextIdx = ((forward ? idx + 1 : idx - 1) + leaves.length) % leaves.length;
        focusPane(tab.id, leaves[nextIdx].id);
      },
      // Etapa 3 — workspaces + IA
      openFolder: () => void openFolderAndAdd(),
      toggleWorkspaceSidebar: toggleSidebar,
      toggleAiPanel,
      toggleNotes,
      clearAiChat: clearAiMessages,
      // Abrir uma sobreposição fecha a outra: as duas ocupam o centro da
      // tela e empilhadas o backdrop de uma comeria os cliques da outra.
      togglePalette: () => {
        setStatsOpen(false);
        setHistoryOpen(false);
        fecharPainelGuardian();
        fecharTelas();
        setPaletteOpen((v) => !v);
      },
      toggleStats: () => {
        setPaletteOpen(false);
        setHistoryOpen(false);
        fecharPainelGuardian();
        fecharTelas();
        setStatsOpen((v) => !v);
      },
      toggleHistory: () => {
        setPaletteOpen(false);
        setStatsOpen(false);
        fecharPainelGuardian();
        fecharTelas();
        setHistoryOpen((v) => !v);
      },
    }),
    [
      openDefaultTab,
      closePane,
      minimizeTab,
      restoreTab,
      splitActivePane,
      focusPane,
      openFolderAndAdd,
      toggleSidebar,
      toggleAiPanel,
      toggleNotes,
      clearAiMessages,
      fecharPainelGuardian,
      fecharTelas,
    ],
  );

  useShortcuts(shortcutActions);

  // Esc fecha a sobreposição da vez. Fica fora do `useShortcuts` porque lá
  // todo atalho exige Ctrl — e um Esc solto precisa chegar ao terminal
  // quando não há nada aberto por cima (é tecla de uso constante em TUIs).
  useEffect(() => {
    if (
      !paletteOpen &&
      !statsOpen &&
      !historyOpen &&
      !settingsOpen &&
      !profileOpen &&
      !updatePainelAberto &&
      !contasPainelAberto &&
      !guardianPainelAberto &&
      !collabOpen
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(false);
      setStatsOpen(false);
      setHistoryOpen(false);
      fecharTelas();
      fecharPainelUpdate();
      fecharPainelContas();
      fecharPainelGuardian();
      fecharCollab();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    paletteOpen,
    statsOpen,
    historyOpen,
    settingsOpen,
    profileOpen,
    updatePainelAberto,
    contasPainelAberto,
    guardianPainelAberto,
    collabOpen,
    fecharCollab,
    fecharTelas,
    fecharPainelUpdate,
    fecharPainelContas,
    fecharPainelGuardian,
  ]);

  /**
   * Guarda o arranjo de abas e divisões para uma recarga poder reconstruí-lo.
   *
   * Com atraso de propósito: arrastar um divisor muda o estado dezenas de
   * vezes por segundo, e gravar em disco a cada quadro seria absurdo. Meio
   * segundo depois da última mudança é indistinguível de instantâneo para o
   * usuário e reduz a escrita a uma por gesto.
   */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void configSave({ layout: { tabs, activeTabId } }).catch(() => {});
    }, 500);
    return () => window.clearTimeout(t);
  }, [tabs, activeTabId]);

  /**
   * Enquanto o painel de estatísticas está aberto, relê os contadores do
   * backend. Eles crescem lá a cada byte do PTY, e o `SessionInfo` que o
   * front guardou é o do instante do spawn — sem esta releitura o painel
   * mostraria "0 B" para sempre, por mais que os shells escrevessem.
   */
  useEffect(() => {
    if (!statsOpen) return;

    const atualiza = () =>
      void ptyList()
        .then((atuais) => {
          setSessions((prev) => {
            const next = { ...prev };
            let mudou = false;
            for (const s of atuais) {
              // Só atualiza o que o front já conhece: uma sessão que ele
              // esqueceu de propósito (aba fechada) não deve voltar.
              if (!(s.id in next)) continue;
              const antes = next[s.id];
              if (antes.bytesOut !== s.bytesOut || antes.bytesIn !== s.bytesIn) {
                next[s.id] = { ...antes, bytesOut: s.bytesOut, bytesIn: s.bytesIn };
                mudou = true;
              }
            }
            return mudou ? next : prev;
          });
        })
        .catch(() => {});

    atualiza();
    const t = window.setInterval(atualiza, 1000);
    return () => window.clearInterval(t);
  }, [statsOpen]);

  /* ------------------------ repertório da paleta ----------------------- */

  const commands = useMemo<PaletteCommand[]>(() => {
    const lista: PaletteCommand[] = [
      {
        id: "tab.new",
        title: "Nova aba",
        group: "Abas",
        shortcut: "Ctrl+Shift+T",
        keywords: "terminal abrir new tab",
        run: openDefaultTab,
      },
      {
        id: "pane.split-right",
        title: "Dividir painel ao lado",
        group: "Painéis",
        shortcut: "Ctrl+Shift+D",
        keywords: "split vertical",
        run: () => void splitActivePane("row"),
      },
      {
        id: "pane.split-down",
        title: "Dividir painel abaixo",
        group: "Painéis",
        shortcut: "Ctrl+Shift+E",
        keywords: "split horizontal",
        run: () => void splitActivePane("column"),
      },
      {
        id: "pane.close",
        title: "Fechar painel atual",
        group: "Painéis",
        shortcut: "Ctrl+Shift+W",
        keywords: "close sair",
        run: shortcutActions.closePane,
      },
      {
        id: "tab.minimize",
        title: "Minimizar a aba atual",
        group: "Abas",
        shortcut: "Ctrl+Shift+M",
        keywords: "esconder ocultar bandeja sem fechar continua rodando",
        run: shortcutActions.minimizeTab,
      },
      {
        id: "ws.open",
        title: "Abrir pasta de projeto",
        group: "Workspaces",
        shortcut: "Ctrl+Shift+O",
        keywords: "folder workspace projeto",
        run: () => void openFolderAndAdd(),
      },
      {
        id: "ws.sidebar",
        title: "Mostrar ou ocultar a barra de workspaces",
        group: "Workspaces",
        shortcut: "Ctrl+Shift+B",
        keywords: "sidebar lateral",
        run: toggleSidebar,
      },
      {
        id: "app.rail",
        title: railExpanded ? "Recolher o menu lateral" : "Expandir o menu lateral",
        group: "Aplicativo",
        keywords: "menu lateral nav rail recolher retrair expandir rótulos",
        run: toggleRail,
      },
      {
        id: "ws.free",
        title: "Modo livre (sem workspace)",
        group: "Workspaces",
        keywords: "nenhum limpar",
        run: () => setActiveWorkspace(null),
      },
      {
        id: "ai.panel",
        title: "Mostrar ou ocultar o painel do JARVIS AI",
        group: "IA",
        shortcut: "Ctrl+Shift+I",
        keywords: "chat assistente",
        run: toggleAiPanel,
      },
      {
        id: "ai.clear",
        title: "Limpar conversa com a IA",
        group: "IA",
        shortcut: "Ctrl+Shift+L",
        keywords: "chat apagar",
        run: clearAiMessages,
      },
      {
        id: "notes.panel",
        title: "Mostrar ou ocultar as Notas do Vibe Coding",
        group: "Vibe Coding",
        shortcut: "Ctrl+Shift+N",
        keywords: "notas anotações bloco de notas notepad rascunho vibe coding",
        run: toggleNotes,
      },
      {
        id: "app.share",
        title: "Trabalho compartilhado — abrir sala ou entrar numa",
        group: "Aplicativo",
        keywords: "compartilhar colaborar junto primo amigo dupla remoto sala convidar terminal compartilhado pair programming",
        run: () => selecionarRota("share"),
      },
      {
        id: "app.accounts",
        title: "Contas do Claude Code",
        group: "Aplicativo",
        keywords: "conta login trocar alternar claude account plano pro",
        run: () => {
          setPaletteOpen(false);
          setStatsOpen(false);
          setHistoryOpen(false);
          fecharPainelGuardian();
          fecharTelas();
          abrirPainelContas();
        },
      },
      {
        id: "app.guardian",
        title: "Guardião — janelas de uso 24/7",
        group: "Aplicativo",
        keywords: "guardiao guardian janela uso 5h reset cota claude pings servidor railway",
        run: () => {
          setPaletteOpen(false);
          setStatsOpen(false);
          setHistoryOpen(false);
          fecharPainelContas();
          fecharTelas();
          abrirPainelGuardian();
        },
      },
      {
        id: "app.update",
        title: "Procurar atualizações",
        group: "Aplicativo",
        keywords: "update versao nova atualizar sobre",
        run: () => {
          // Mesma regra das outras sobreposições: só uma por vez, senão o
          // backdrop de uma come os cliques da outra.
          setPaletteOpen(false);
          setStatsOpen(false);
          fecharPainelContas();
          fecharPainelGuardian();
          fecharTelas();
          abrirPainelUpdate();
        },
      },
      {
        id: "app.history",
        title: "Histórico de terminais",
        group: "Aplicativo",
        shortcut: "Ctrl+Shift+H",
        keywords: "sessoes gravadas conversas claude agente recuperar contexto log",
        run: () => {
          setPaletteOpen(false);
          setStatsOpen(false);
          fecharPainelContas();
          fecharPainelGuardian();
          fecharTelas();
          setHistoryOpen(true);
        },
      },
      {
        id: "app.stats",
        title: "Ver estatísticas de uso",
        group: "Aplicativo",
        shortcut: "Ctrl+Shift+S",
        keywords: "dashboard numeros bytes",
        run: () => {
          fecharPainelContas();
          fecharPainelGuardian();
          fecharTelas();
          setStatsOpen(true);
        },
      },
      {
        id: "app.settings",
        title: "Configurações",
        group: "Aplicativo",
        keywords: "opcoes preferencias tema densidade claude ia atualizacoes",
        run: () => {
          setPaletteOpen(false);
          setStatsOpen(false);
          setHistoryOpen(false);
          fecharPainelContas();
          fecharPainelGuardian();
          setProfileOpen(false);
          setSettingsOpen(true);
        },
      },
      {
        id: "app.profile",
        title: "Perfil — sobre o JARVIS e esta máquina",
        group: "Aplicativo",
        keywords: "sobre versao sistema informacoes maquina app",
        run: () => {
          setPaletteOpen(false);
          setStatsOpen(false);
          setHistoryOpen(false);
          fecharPainelContas();
          fecharPainelGuardian();
          setSettingsOpen(false);
          setProfileOpen(true);
        },
      },
      // Estes quatro só existiam como combinação de teclas: não apareciam em
      // tooltip nenhum, e a paleta — o único lugar onde os atalhos ficam
      // visíveis — não os listava. Aparecer aqui é o que os torna
      // descobríveis, mesmo quando executá-los pela paleta é redundante.
      {
        id: "tab.next",
        title: "Próxima aba",
        group: "Abas",
        shortcut: "Ctrl+Tab",
        keywords: "avancar proxima",
        run: shortcutActions.nextTab,
      },
      {
        id: "tab.prev",
        title: "Aba anterior",
        group: "Abas",
        shortcut: "Ctrl+Shift+Tab",
        keywords: "voltar anterior",
        run: shortcutActions.prevTab,
      },
      {
        id: "pane.focus",
        title: "Ir para o próximo painel",
        group: "Painéis",
        shortcut: "Ctrl+Alt+Setas",
        keywords: "navegar foco",
        run: () => shortcutActions.focusPaneDirection("right"),
      },
      {
        id: "app.palette",
        title: "Abrir a paleta de comandos",
        group: "Aplicativo",
        shortcut: "Ctrl+Shift+P",
        keywords: "comandos busca",
        run: () => setPaletteOpen(true),
      },
    ];

    // Um comando por shell detectado, para abrir direto no que se quer.
    for (const p of profiles) {
      lista.push({
        id: `tab.new.${p.id}`,
        title: `Nova aba: ${p.name}`,
        group: "Abas",
        keywords: `${p.program} shell`,
        run: () => void openTab(p),
      });
    }

    // Define o shell que "nova aba" usa dentro do workspace ativo. Sem isto
    // o campo `defaultProfileId` existia no modelo e no arquivo de config,
    // mas não havia nenhuma forma de preenchê-lo.
    if (activeWorkspaceId) {
      const wsAtivo = workspaces.find((w) => w.id === activeWorkspaceId);
      for (const p of profiles) {
        if (p.id === wsAtivo?.defaultProfileId) continue;
        lista.push({
          id: `ws.default.${p.id}`,
          title: `Usar ${p.name} nas novas abas de “${wsAtivo?.name}”`,
          group: "Workspaces",
          keywords: "shell padrao preferido",
          run: () => updateWorkspace(activeWorkspaceId, { defaultProfileId: p.id }),
        });
      }
    }

    // Contas do Claude Code: uma entrada por conta para os próximos
    // terminais, e — com um projeto ativo — uma para fixar a conta dele.
    for (const c of contas) {
      if (c.id !== contaEscolhidaId) {
        lista.push({
          id: `acc.use.${c.id}`,
          title: `Usar a conta ${c.name} nos próximos terminais`,
          group: "Contas",
          keywords: "claude conta login trocar alternar",
          run: () => escolherConta(c.id),
        });
      }

      if (activeWorkspaceId) {
        const wsAtivo = workspaces.find((w) => w.id === activeWorkspaceId);
        if (wsAtivo && wsAtivo.claudeAccountId !== c.id) {
          lista.push({
            id: `acc.ws.${c.id}`,
            title: `Fixar a conta ${c.name} no projeto “${wsAtivo.name}”`,
            group: "Contas",
            keywords: "claude conta workspace projeto padrao",
            run: () => updateWorkspace(activeWorkspaceId, { claudeAccountId: c.id }),
          });
        }
      }
    }

    // Só aparece quando há o que desfazer: sem uma escolha ativa, "voltar ao
    // padrão" seria um comando que não faz nada.
    if (contaEscolhidaId) {
      lista.push({
        id: "acc.clear",
        title: "Voltar a seguir a conta do projeto",
        group: "Contas",
        keywords: "claude conta limpar padrao automatico",
        run: () => escolherConta(null),
      });
    }

    // Um comando por workspace, para trocar de projeto sem tirar a mão do
    // teclado nem abrir a barra lateral.
    for (const ws of workspaces) {
      lista.push({
        id: `ws.activate.${ws.id}`,
        title: `Ativar workspace: ${ws.name}`,
        group: "Workspaces",
        keywords: ws.path,
        run: () => setActiveWorkspace(ws.id),
      });
    }

    // Um comando por aba minimizada. A bandeja já as mostra, mas quando são
    // muitas o rótulo fica truncado; aqui dá pra achar pelo nome inteiro.
    for (const t of filtraMinimizadas(tabs)) {
      lista.push({
        id: `tab.restore.${t.id}`,
        title: `Restaurar: ${t.title}`,
        group: "Abas",
        keywords: "minimizada bandeja voltar mostrar",
        run: () => restoreTab(t.id),
      });
    }

    return lista;
  }, [
    profiles,
    workspaces,
    tabs,
    restoreTab,
    openDefaultTab,
    openTab,
    splitActivePane,
    shortcutActions,
    openFolderAndAdd,
    toggleSidebar,
    toggleRail,
    railExpanded,
    setActiveWorkspace,
    updateWorkspace,
    activeWorkspaceId,
    toggleAiPanel,
    clearAiMessages,
    abrirPainelUpdate,
    contas,
    contaEscolhidaId,
    escolherConta,
    abrirPainelContas,
    abrirPainelGuardian,
    fecharPainelGuardian,
    fecharTelas,
  ]);

  /* ------------------------------- render ------------------------------- */

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Cor do workspace ativo para destaque visual
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  // `Object.values` num JSX cria um array novo a cada render e invalidaria o
  // `useMemo` que calcula as estatísticas — inclusive com o painel fechado.
  const listaSessoes = useMemo(() => Object.values(sessions), [sessions]);

  const coresDeWorkspace = useMemo(
    () => Object.fromEntries(workspaces.map((w) => [w.id, w.color])),
    [workspaces],
  );

  /**
   * Conta que os próximos terminais vão usar, pela mesma precedência que o
   * `spawnFor` aplica de verdade. A barra mostra o resultado em vez do
   * ajuste: o que interessa a quem está olhando não é "qual conta eu
   * selecionei", é "em que conta o próximo `claude` vai rodar".
   */
  const contaAtiva = useMemo(
    () =>
      resolveConta(contas, {
        escolhidaNaHora: contaEscolhidaId,
        doWorkspace: activeWs?.claudeAccountId ?? null,
        padrao: contaPadraoId,
      }),
    [contas, contaEscolhidaId, activeWs, contaPadraoId],
  );

  const coresDeConta = useMemo(
    () => Object.fromEntries(contas.map((c) => [c.id, c.color])),
    [contas],
  );

  /**
   * Alerta de cota na barra superior: consulta a janela de 5h da conta
   * ativa (a mesma fonte do `/usage` da CLI) de tempos em tempos e acende o
   * badge quando ela passa de 80%. Sem login, o backend responde
   * `available: false` sem tocar na rede — o polling fica barato.
   */
  const [cotaAlta, setCotaAlta] = useState(false);
  const [cotaInfo, setCotaInfo] = useState<{ pct: number; resetsAtMs: number } | null>(null);

  useEffect(() => {
    const verifica = async () => {
      // Janela minimizada ou em segundo plano: a cota não muda aqui, e
      // poupar a consulta (que é de rede quando há login) é o comportamento
      // educado — o próximo tique já reavalia quando ela voltar a aparecer.
      if (document.hidden) return;
      const dir = contaAtiva ? statusContas[contaAtiva.id]?.configDir : undefined;
      try {
        const u = await claudeUsageLive(dir);
        const cota = u.available && u.fiveHour ? u.fiveHour : null;
        setCotaAlta(!!cota && cota.utilizationPct >= COTA_ALERTA_PCT);
        setCotaInfo(
          cota ? { pct: cota.utilizationPct, resetsAtMs: cota.resetsAtMs } : null,
        );
      } catch {
        setCotaAlta(false);
        setCotaInfo(null);
      }
    };
    void verifica();
    const t = window.setInterval(verifica, 300_000);
    return () => window.clearInterval(t);
  }, [contaAtiva, statusContas]);

  // As duas listas que a barra de abas desenha. Todas as abas continuam
  // montadas mais abaixo — isto aqui separa só quem aparece onde.
  const abasVisiveis = useMemo(() => filtraVisiveis(tabs), [tabs]);
  const abasMinimizadas = useMemo(() => filtraMinimizadas(tabs), [tabs]);

  // Rota ativa do menu lateral, derivada do que está aberto. O menu nunca
  // desmente as sobreposições porque é ele quem as abre — e a derivação
  // garante que a marcação acompanhe até o que foi aberto por atalho.
  const railDest: RailDest = collabOpen
    ? "share"
    : settingsOpen
    ? "settings"
    : profileOpen
      ? "profile"
      : contasPainelAberto
        ? "accounts"
        : guardianPainelAberto
          ? "guardian"
          : statsOpen
            ? "stats"
            : historyOpen
              ? "history"
              : "home";

  return (
    <div
      className={`app ${railExpanded ? "rail-expanded" : "rail-collapsed"} ${
        sidebarOpen ? "sidebar-open" : ""
      } ${aiPanelOpen ? "ai-open" : ""} ${emSalaDeOutro ? "guest-mode" : ""}`}
      style={activeWs ? { "--ws-color": activeWs.color } as React.CSSProperties : undefined}
    >
      <UpdateBanner />
      <NavRail
        active={railDest}
        notesOpen={notesOpen}
        onSelect={selecionarRota}
        expanded={railExpanded}
        onToggleRail={toggleRail}
        shareBadge={pendentesNaPorta}
      />
      <header className="topbar">
        <button
          className={`topbar-btn ${sidebarOpen ? "active" : ""}`}
          onClick={toggleSidebar}
          title="Workspaces (Ctrl+Shift+B)"
          aria-label="Workspaces"
          aria-pressed={sidebarOpen}
        >
          <Icon name="sidebar" />
        </button>
        <span className="brand">JARVIS</span>
        {activeWs && (
          <span className="ws-badge">
            <span className="ws-badge-dot" style={{ background: activeWs.color }} />
            {activeWs.name}
          </span>
        )}
        {/* Só aparece para quem cadastrou contas. Sem conta nenhuma, o
            terminal usa o login normal do Claude Code e um distintivo aqui
            não teria o que informar. */}
        {contaAtiva && (
          <button
            className={`ws-badge account-badge ${cotaAlta ? "account-badge-alta" : ""}`}
            onClick={() => {
              setPaletteOpen(false);
              setStatsOpen(false);
              setHistoryOpen(false);
              abrirPainelContas();
            }}
            title={
              cotaAlta && cotaInfo
                ? `${contaAtiva.name}: cota a ${cotaInfo.pct.toFixed(0)}% da janela de 5h — reseta em ${formatCountdown(cotaInfo.resetsAtMs)}. Clique para abrir as contas.`
                : contaEscolhidaId
                  ? `Próximos terminais na conta ${contaAtiva.name} (escolha manual)`
                  : `Próximos terminais na conta ${contaAtiva.name}`
            }
          >
            <span className="ws-badge-dot" style={{ background: contaAtiva.color }} />
            {contaAtiva.name}
            {cotaAlta && (
              <span
                className="account-badge-warn"
                role="img"
                aria-label={`cota quase no limite (${cotaInfo?.pct.toFixed(0)}%)`}
              >
                !
              </span>
            )}
            {contaEscolhidaId && <span className="account-badge-pin">•</span>}
          </button>
        )}
        <div className="launchers">
          {profiles.map((p) => (
            <button
              key={p.id}
              className="chip"
              onClick={() => void openTab(p)}
              title={`Nova aba: ${p.name}`}
            >
              <Icon name={shellIcon(p.icon)} size={14} />
              {p.name}
            </button>
          ))}
        </div>
        {activeTab && (
          <div className="pane-actions">
            <span className="topbar-sep" aria-hidden="true" />
            <button
              className="topbar-btn"
              title="Dividir ao lado (Ctrl+Shift+D)"
              aria-label="Dividir ao lado"
              onClick={() => void splitActivePane("row")}
            >
              <Icon name="split-right" />
            </button>
            <button
              className="topbar-btn"
              title="Dividir abaixo (Ctrl+Shift+E)"
              aria-label="Dividir abaixo"
              onClick={() => void splitActivePane("column")}
            >
              <Icon name="split-down" />
            </button>
          </div>
        )}
        <div className="topbar-right">
          <span className="topbar-sep" aria-hidden="true" />
          {/* Só aparece quando há o que fazer. Um botão permanente de
              "atualizações" ocuparia espaço da topbar 364 dias por ano para
              dizer "está tudo em dia" — quem quiser conferir mesmo assim tem
              o comando na paleta. */}
          {(updateFase === "disponivel" || updateFase === "pronto") && (
            <button
              className="topbar-btn update-flag"
              onClick={() => {
                setPaletteOpen(false);
                setStatsOpen(false);
                abrirPainelUpdate();
              }}
              title={
                updateFase === "pronto"
                  ? "Atualização instalada — reinicie para aplicar"
                  : "Uma versão nova está disponível"
              }
              aria-label="Atualização disponível"
            >
              <Icon name="refresh" />
            </button>
          )}
          <button
            className="topbar-btn"
            onClick={() => setDensity(density === "cozy" ? "compact" : "cozy")}
            title={`Densidade: ${DENSIDADE_ROTULO[density]} — clique para alternar`}
            aria-label={`Densidade: ${DENSIDADE_ROTULO[density]}`}
          >
            <Icon name="layers" />
          </button>
          <button
            className="topbar-btn"
            onClick={cycleTheme}
            title={`Tema: ${TEMA_ROTULO[themeMode]} — clique para alternar`}
            aria-label={`Tema: ${TEMA_ROTULO[themeMode]}`}
          >
            <Icon name={themeMode === "system" ? "monitor" : themeMode === "light" ? "sun" : "moon"} />
          </button>
          <button
            className="topbar-btn"
            onClick={() => setPaletteOpen(true)}
            title="Paleta de comandos (Ctrl+Shift+P)"
            aria-label="Paleta de comandos"
          >
            <Icon name="command" />
          </button>
          <button
            className="topbar-btn"
            onClick={() => {
              setPaletteOpen(false);
              setStatsOpen(false);
              setHistoryOpen(true);
            }}
            title="Histórico de terminais (Ctrl+Shift+H)"
            aria-label="Histórico de terminais"
          >
            <Icon name="history" />
          </button>
          <button
            className="topbar-btn"
            onClick={() => setStatsOpen(true)}
            title="Estatísticas de uso (Ctrl+Shift+S)"
            aria-label="Estatísticas de uso"
          >
            <Icon name="activity" />
          </button>
          <button
            className={`topbar-btn ai-toggle ${aiPanelOpen ? "active" : ""}`}
            onClick={toggleAiPanel}
            title="JARVIS AI (Ctrl+Shift+I)"
            aria-label="JARVIS AI"
            aria-pressed={aiPanelOpen}
          >
            <Icon name="spark" />
          </button>
          <button
            className={`topbar-btn notes-toggle ${notesOpen ? "active" : ""}`}
            onClick={toggleNotes}
            title="Notas Vibe Coding (Ctrl+Shift+N)"
            aria-label="Notas Vibe Coding"
            aria-pressed={notesOpen}
          >
            <Icon name="pencil" />
          </button>
        </div>
      </header>

      <TabBar
        tabs={abasVisiveis}
        minimized={abasMinimizadas}
        activeTabId={activeTabId}
        sessions={sessions}
        coresDeWorkspace={coresDeWorkspace}
        contaDaSessao={sessionAccounts}
        coresDeConta={coresDeConta}
        onActivate={setActiveTabId}
        onClose={closeTab}
        onMinimize={minimizeTab}
        onRestore={restoreTab}
        onMove={moveTab}
        onRename={aplicaTabs}
      />

      <div className="body-row">
        <WorkspaceSidebar />

        {/*
          Em sala de outra pessoa, a área local sai da tela mas **continua
          montada**: desmontá-la destruiria todos os xterms daqui, e o
          `npm run dev` da própria máquina perderia o scrollback só porque
          alguém entrou numa sala por dez minutos. É o mesmo tratamento que
          uma aba de fundo já recebe.
        */}
        <main className="stage" hidden={emSalaDeOutro}>
          {error && <div className="error">{error}</div>}
          {recovery.length > 0 && (
            <div className="recovery-banner">
              <div className="recovery-header">
                <span>
                  {recovery.length === 1
                    ? "1 terminal não foi fechado corretamente da última vez."
                    : `${recovery.length} terminais não foram fechados corretamente da última vez.`}
                </span>
                <div className="recovery-header-actions">
                  <button
                    className="chip"
                    onClick={() => {
                      const todas = recovery;
                      setRecovery([]);
                      for (const e of todas) void reopenRecovery(e);
                    }}
                  >
                    Reabrir todos
                  </button>
                  <button
                    className="chip subtle"
                    onClick={() => {
                      for (const e of recovery) markHistoryEnded(e.id);
                      setRecovery([]);
                    }}
                  >
                    Descartar
                  </button>
                </div>
              </div>
              <ul className="recovery-list">
                {recovery.map((e) => (
                  <li key={e.id} className="recovery-item">
                    <span className="recovery-item-title" title={e.cwd}>
                      {e.workspaceName ? `${e.workspaceName} · ` : ""}
                      {shortenRecoveryPath(e.cwd)}
                      {e.autoCommand ? ` (${e.autoCommand})` : ""}
                    </span>
                    <div className="recovery-item-actions">
                      <button className="chip" onClick={() => void reopenRecovery(e)}>
                        Reabrir
                      </button>
                      <button
                        className="chip subtle"
                        onClick={() => dismissRecovery(e.id)}
                        aria-label="Descartar esta sessão"
                        title="Descartar"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {abasVisiveis.length === 0 && !error && (
            <div className="empty">
              <h1>JARVIS</h1>
              {/* Com tudo minimizado a tela fica igualzinha à de "nenhum
                  terminal aberto" — e aí a pessoa abre outro sem perceber
                  que os antigos continuam rodando ali do lado. */}
              {abasMinimizadas.length > 0 ? (
                <p>
                  {abasMinimizadas.length === 1
                    ? "1 terminal está minimizado e continua rodando."
                    : `${abasMinimizadas.length} terminais estão minimizados e continuam rodando.`}{" "}
                  Clique na bandeja da barra de abas para trazer um de volta.
                </p>
              ) : (
                <p>Escolha um shell na barra de cima para abrir um terminal.</p>
              )}
              {workspaces.length === 0 && (
                <button className="chip empty-action" onClick={() => void openFolderAndAdd()}>
                  <Icon name="folder-open" size={14} />
                  Abrir pasta de projeto
                </button>
              )}
              {/* Os atalhos não aparecem em lugar nenhum até a primeira aba
                  existir; aqui é onde o usuário ainda está olhando. */}
              <ul className="empty-hints">
                <li>
                  <kbd>Ctrl+Shift+T</kbd> nova aba
                </li>
                <li>
                  <kbd>Ctrl+Shift+P</kbd> paleta de comandos
                </li>
                <li>
                  <kbd>Ctrl+Shift+I</kbd> assistente de IA
                </li>
                <li>
                  <kbd>Ctrl+Shift+N</kbd> notas Vibe Coding
                </li>
              </ul>
            </div>
          )}
          {tabs.map((t) => (
            // Todas as abas ficam montadas: desmontar destruiria os xterms e
            // perderia o estado visual a cada troca de aba.
            <div key={t.id} className="pane" hidden={t.id !== activeTabId}>
              <SplitLayout
                node={t.root}
                activePaneId={t.activePaneId}
                sessions={sessions}
                paneCount={listLeaves(t.root).length}
                contaDaSessao={sessionAccounts}
                onFocusPane={(paneId) => focusPane(t.id, paneId)}
                onResize={(splitId, sizes) => resizePane(t.id, splitId, sizes)}
                onClosePane={(paneId) => closePane(t.id, paneId)}
                onRestartPane={(paneId) => void restartPane(t.id, paneId)}
                onSwitchAccount={(paneId, accountId) =>
                  void switchAccountForPane(t.id, paneId, accountId)
                }
              />
            </div>
          ))}
        </main>

        {emSalaDeOutro && <GuestWorkspace />}

        <AiPanel
          onRunCommand={runCommandInTerminal}
          captureContext={captureAiContext}
        />
        <NotesPanel
          onRunCommand={runCommandInTerminal}
          captureContext={captureAiContext}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <StatsPanel open={statsOpen} sessions={listaSessoes} onClose={() => setStatsOpen(false)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onReopen={(m, resume) => void reopenFromHistory(m, resume)}
      />
      <UpdatePanel />
      <AccountsPanel onEntrar={(c) => void entrarNaConta(c)} />
      <GuardianPanel onEntrar={(c) => void entrarNaConta(c)} />
      <SettingsScreen
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenContas={() => {
          setSettingsOpen(false);
          abrirPainelContas();
        }}
        onOpenAtualizacoes={() => {
          setSettingsOpen(false);
          abrirPainelUpdate();
        }}
        onReabrirIntroducao={() => {
          setSettingsOpen(false);
          setOnboardingDone(false);
        }}
      />
      <CollabScreen open={collabOpen} onClose={fecharCollab} sessions={listaSessoes} />
      <ProfileScreen
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        home={home}
        profiles={profiles}
        sessions={listaSessoes}
      />
      {!onboardingDone && <Onboarding />}
    </div>
  );
}

/* ------------------------------ barra de abas ----------------------------- */

interface TabBarProps {
  /** Só as abas visíveis — as minimizadas vêm em `minimized`. */
  tabs: TabState[];
  minimized: TabState[];
  activeTabId: string | null;
  sessions: Readonly<Record<string, SessionInfo>>;
  /** Cor de cada workspace, para pintar o ponto da aba. */
  coresDeWorkspace: Readonly<Record<string, string>>;
  /** Conta do Claude Code de cada sessão, e a cor de cada conta. */
  contaDaSessao: Readonly<Record<string, string>>;
  coresDeConta: Readonly<Record<string, string>>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  onRestore: (id: string) => void;
  /**
   * Reordenar é por id, não por índice: a barra mostra só as visíveis, então
   * "o terceiro da tela" pode ser o quinto da lista real.
   */
  onMove: (fromId: string, toId: string) => void;
  onRename: (updater: (prev: TabState[]) => TabState[]) => void;
}

/** "dead": todo painel morreu. "partial": pelo menos um morreu, mas não todos. */
function tabStatus(tab: TabState, sessions: Readonly<Record<string, SessionInfo>>): "" | "dead" | "partial" {
  const leaves = listLeaves(tab.root);
  const deadCount = leaves.filter((l) => sessions[l.sessionId]?.alive === false).length;
  if (deadCount === 0) return "";
  return deadCount === leaves.length ? "dead" : "partial";
}

function TabBar({
  tabs,
  minimized,
  activeTabId,
  sessions,
  coresDeWorkspace,
  contaDaSessao,
  coresDeConta,
  onActivate,
  onClose,
  onMinimize,
  onRestore,
  onMove,
  onRename,
}: TabBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);
  const barraRef = useRef<HTMLElement | null>(null);
  /**
   * Confirmação dupla para fechar um *conjunto* de terminais — uma aba com
   * mais de um painel dividido. Fechar um terminal sozinho continua no
   * primeiro clique (é o de sempre); é derrubar vários processos de uma vez
   * que merece o segundo clique. Expira sozinha depois de alguns segundos
   * para não deixar um botão de "clique de novo" aceso pra sempre numa aba
   * em que a pessoa desistiu de fechar.
   */
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const confirmTimer = useRef<Record<string, number>>({});

  useEffect(() => {
    const timers = confirmTimer.current;
    return () => {
      for (const id of Object.values(timers)) window.clearTimeout(id);
    };
  }, []);

  const attemptClose = (tabId: string, leafCount: number) => {
    if (leafCount <= 1) {
      onClose(tabId);
      return;
    }
    if (confirmCloseId === tabId) {
      window.clearTimeout(confirmTimer.current[tabId]);
      delete confirmTimer.current[tabId];
      setConfirmCloseId(null);
      onClose(tabId);
      return;
    }
    setConfirmCloseId(tabId);
    confirmTimer.current[tabId] = window.setTimeout(() => {
      setConfirmCloseId((cur) => (cur === tabId ? null : cur));
    }, 3000);
  };

  const commitRename = (id: string, value: string) => {
    const title = value.trim();
    onRename((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)),
    );
    setRenamingId(null);
  };

  // Com muitas abas a ativa pode nascer fora da área visível — e como a
  // barra rola, ela simplesmente não aparece em lugar nenhum.
  useEffect(() => {
    barraRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  return (
    <nav
      className="tabs"
      ref={barraRef}
      // A roda do mouse rola na vertical por padrão, e uma barra que só rola
      // na horizontal não responde a ela: as abas passam da borda e não há
      // como alcançá-las sem arrastar a barra de rolagem.
      onWheel={(e) => {
        const el = barraRef.current;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? "active" : ""} ${tabStatus(t, sessions)}`}
          data-active={t.id === activeTabId}
          draggable
          role="tab"
          tabIndex={0}
          aria-selected={t.id === activeTabId}
          onClick={() => onActivate(t.id)}
          onDoubleClick={() => setRenamingId(t.id)}
          // Clique do meio minimiza. É a convenção oposta à do navegador (onde
          // ele fecha), e de propósito: aqui fechar mata um processo, então o
          // gesto rápido e sem confirmação tem que ser o reversível.
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            onMinimize(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onActivate(t.id);
            } else if (e.key === "F2") {
              e.preventDefault();
              setRenamingId(t.id);
            }
          }}
          onDragStart={() => {
            dragFrom.current = t.id;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from === null || from === t.id) return;
            onMove(from, t.id);
          }}
        >
          <span
            className="dot"
            style={
              t.workspaceId && coresDeWorkspace[t.workspaceId]
                ? { background: coresDeWorkspace[t.workspaceId] }
                : undefined
            }
          />
          {/* Anel na cor da conta do Claude Code em volta do ponto do
              workspace. São duas informações independentes — projeto e login
              — e um terminal do projeto A pode estar em qualquer conta. */}
          {(() => {
            const contaId = contaDaSessao[listLeaves(t.root)[0]?.sessionId];
            const cor = contaId ? coresDeConta[contaId] : undefined;
            return cor ? (
              <span className="tab-conta" style={{ background: cor }} aria-hidden="true" />
            ) : null;
          })()}
          {renamingId === t.id ? (
            <input
              className="tab-rename"
              autoFocus
              defaultValue={t.title}
              // Seleciona o texto ao abrir: sem isto o cursor fica no fim e
              // digitar acrescenta ao nome antigo em vez de substituí-lo.
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(t.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename(t.id, e.currentTarget.value);
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
          ) : (
            <span className="label" title={t.title}>
              {t.title}
            </span>
          )}
          <button
            className="x minimize"
            title="Minimizar (Ctrl+Shift+M) — o terminal continua rodando"
            aria-label={`Minimizar ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onMinimize(t.id);
            }}
          >
            <Icon name="minimize" size={12} />
          </button>
          <button
            className={`x ${confirmCloseId === t.id ? "confirm" : ""}`}
            title={
              confirmCloseId === t.id
                ? `Clique de novo para fechar os ${listLeaves(t.root).length} terminais desta aba`
                : listLeaves(t.root).length > 1
                  ? "Fechar aba — encerra os processos dela"
                  : "Fechar aba — encerra o processo"
            }
            aria-label={`Fechar ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              attemptClose(t.id, listLeaves(t.root).length);
            }}
          >
            <Icon name={confirmCloseId === t.id ? "warning" : "close"} size={12} />
          </button>
        </div>
      ))}

      {/* Bandeja das minimizadas. Fica grudada na direita (`sticky`) para
          continuar alcançável quando a barra de abas rola — o dia em que ela
          rola é justamente o dia em que se quer minimizar algo. */}
      {minimized.length > 0 && (
        <div
          className="tab-tray"
          role="group"
          aria-label={`${minimized.length} terminais minimizados`}
        >
          <Icon name="minimize" size={12} />
          {minimized.map((t) => (
            <button
              key={t.id}
              className={`tab-tray-chip ${tabStatus(t, sessions)}`}
              onClick={() => onRestore(t.id)}
              title={`Restaurar ${t.title}`}
              // Um clique do meio na bandeja fecha: é o par simétrico do
              // clique do meio na aba, que trouxe ela pra cá.
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(t.id);
              }}
            >
              <span
                className="dot"
                style={
                  t.workspaceId && coresDeWorkspace[t.workspaceId]
                    ? { background: coresDeWorkspace[t.workspaceId] }
                    : undefined
                }
              />
              <span className="tab-tray-label">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

function shortenRecoveryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const home = normalized.match(/^[A-Za-z]:\/Users\/[^/]+/)?.[0];
  const base = home && normalized.startsWith(home) ? "~" + normalized.slice(home.length) : normalized;
  const parts = base.split("/").filter(Boolean);
  return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : base;
}
