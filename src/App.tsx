import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SplitLayout } from "./components/SplitLayout";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { AiPanel } from "./components/AiPanel";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import type { Command as PaletteCommand } from "./lib/palette";
import { useShortcuts } from "./hooks/useShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useAiStore } from "./stores/aiStore";
import { buildAiContext, buildSystemPrompt, captureTerminalLines } from "./lib/aiContext";
import { getTerminal } from "./lib/terminalRegistry";
import { parseLayout, restoreLayout } from "./lib/restoreLayout";
import { findOrphans, parseHistory, pruneHistory, type HistoryEntry } from "./lib/sessionHistory";
import {
  appHomeDir,
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
  type SessionInfo,
  type ShellProfile,
} from "./lib/ipc";
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
}

function newTabFromSession(info: SessionInfo, workspaceId: string | null = null): TabState {
  const node = leaf(info.id);
  return { id: nextId("tab"), title: info.title, root: node, activePaneId: node.id, workspaceId };
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

  const aiPanelOpen = useAiStore((s) => s.panelOpen);
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const toggleAiPanelRaw = useAiStore((s) => s.togglePanel);
  const setAiPanelOpen = useAiStore((s) => s.setPanelOpen);
  const clearAiMessages = useAiStore((s) => s.clearMessages);

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

  useEffect(() => {
    void shellsDetect().then(setProfiles).catch((e) => setError(String(e)));
    void appHomeDir().then(setHome).catch(() => {});

    // Carrega configuração salva (workspaces + IA)
    void loadWorkspaces();
    void loadAiConfig();

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
    ) => {
      const info = await ptySpawn({
        program: profile?.program,
        args: profile?.args,
        cwd,
        title: title ?? profile?.name,
        profileId: profile?.id,
        initialCommand: initialCommand || undefined,
      });
      setSessions((prev) => ({ ...prev, [info.id]: info }));

      const ws = workspacesRef.current.find((w) => w.id === activeWorkspaceIdRef.current) ?? null;
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

  /** Descarta uma entrada de recuperação, marcando-a como encerrada no histórico. */
  const dismissRecovery = useCallback(
    (id: string) => {
      setRecovery((prev) => prev.filter((e) => e.id !== id));
      markHistoryEnded(id);
    },
    [markHistoryEnded],
  );

  /** Reabre um terminal a partir de uma entrada de recuperação (mesma pasta/comando de antes). */
  const reopenRecovery = useCallback(
    async (entry: HistoryEntry) => {
      try {
        const profile =
          profilesRef.current.find((p) => p.id === entry.profileId) ??
          profilesRef.current.find((p) => p.recommended) ??
          profilesRef.current[0];
        const info = await spawnFor(profile, entry.cwd, entry.title, entry.autoCommand ?? undefined);
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
   * Escolhe qual aba fica ativa depois que `tabId` sai da lista. Separado
   * para os dois caminhos de remoção (fechar a aba, fechar o último painel
   * dela) não divergirem.
   */
  const ativaVizinha = useCallback((antes: TabState[], depois: TabState[], tabId: string) => {
    setActiveTabId((cur) => {
      if (cur !== tabId) return cur;
      const idx = antes.findIndex((t) => t.id === tabId);
      return depois[Math.min(idx, depois.length - 1)]?.id ?? null;
    });
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      const antes = tabsRef.current;
      const tab = antes.find((t) => t.id === tabId);
      if (!tab) return;

      // As sessões são fechadas aqui, fora do updater. Fazer isso lá dentro
      // disparava dois `pty_close` por aba na invocação dupla do StrictMode.
      for (const l of listLeaves(tab.root)) closeSession(l.sessionId);

      const depois = aplicaTabs((prev) => prev.filter((t) => t.id !== tabId));
      ativaVizinha(antes, depois, tabId);
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
        const depois = aplicaTabs((prev) => prev.filter((t) => t.id !== tabId));
        ativaVizinha(antes, depois, tabId);
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
    async (tabId: string, paneId: string) => {
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
          ws?.autoCommand ?? undefined,
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

  /* ---------------------------- atalhos -------------------------------- */

  const shortcutActions = useMemo(
    () => ({
      newTab: openDefaultTab,
      closePane: () => {
        const tabId = activeTabIdRef.current;
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (tab) closePane(tab.id, tab.activePaneId);
      },
      nextTab: () => {
        const list = tabsRef.current;
        if (list.length < 2) return;
        const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
        setActiveTabId(list[(idx + 1) % list.length].id);
      },
      prevTab: () => {
        const list = tabsRef.current;
        if (list.length < 2) return;
        const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
        setActiveTabId(list[(idx - 1 + list.length) % list.length].id);
      },
      gotoTab: (index: number) => {
        const list = tabsRef.current;
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
      clearAiChat: clearAiMessages,
      // Abrir uma sobreposição fecha a outra: as duas ocupam o centro da
      // tela e empilhadas o backdrop de uma comeria os cliques da outra.
      togglePalette: () => {
        setStatsOpen(false);
        setPaletteOpen((v) => !v);
      },
      toggleStats: () => {
        setPaletteOpen(false);
        setStatsOpen((v) => !v);
      },
    }),
    [
      openDefaultTab,
      closePane,
      splitActivePane,
      focusPane,
      openFolderAndAdd,
      toggleSidebar,
      toggleAiPanel,
      clearAiMessages,
    ],
  );

  useShortcuts(shortcutActions);

  // Esc fecha a sobreposição da vez. Fica fora do `useShortcuts` porque lá
  // todo atalho exige Ctrl — e um Esc solto precisa chegar ao terminal
  // quando não há nada aberto por cima (é tecla de uso constante em TUIs).
  useEffect(() => {
    if (!paletteOpen && !statsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(false);
      setStatsOpen(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [paletteOpen, statsOpen]);

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
        id: "app.stats",
        title: "Ver estatísticas de uso",
        group: "Aplicativo",
        shortcut: "Ctrl+Shift+S",
        keywords: "dashboard numeros bytes",
        run: () => setStatsOpen(true),
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

    return lista;
  }, [
    profiles,
    workspaces,
    openDefaultTab,
    openTab,
    splitActivePane,
    shortcutActions,
    openFolderAndAdd,
    toggleSidebar,
    setActiveWorkspace,
    updateWorkspace,
    activeWorkspaceId,
    toggleAiPanel,
    clearAiMessages,
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

  return (
    <div
      className={`app ${sidebarOpen ? "sidebar-open" : ""} ${aiPanelOpen ? "ai-open" : ""}`}
      style={activeWs ? { "--ws-color": activeWs.color } as React.CSSProperties : undefined}
    >
      <header className="topbar">
        <button
          className="topbar-btn"
          onClick={toggleSidebar}
          title="Workspaces (Ctrl+Shift+B)"
        >
          ☰
        </button>
        <span className="brand">JARVIS</span>
        {activeWs && <span className="ws-badge" style={{ background: activeWs.color }}>{activeWs.name}</span>}
        <div className="launchers">
          {profiles.map((p) => (
            <button key={p.id} className="chip" onClick={() => void openTab(p)} title={`Nova aba: ${p.name}`}>
              + {p.name}
            </button>
          ))}
        </div>
        {activeTab && (
          <div className="pane-actions">
            <button
              className="chip"
              title="Dividir ao lado (Ctrl+Shift+D)"
              onClick={() => void splitActivePane("row")}
            >
              ⬒ Ao lado
            </button>
            <button
              className="chip"
              title="Dividir abaixo (Ctrl+Shift+E)"
              onClick={() => void splitActivePane("column")}
            >
              ⬓ Abaixo
            </button>
          </div>
        )}
        <button
          className="topbar-btn"
          onClick={() => setPaletteOpen(true)}
          title="Paleta de comandos (Ctrl+Shift+P)"
        >
          ⌘
        </button>
        <button
          className="topbar-btn"
          onClick={() => setStatsOpen(true)}
          title="Estatísticas de uso (Ctrl+Shift+S)"
        >
          ▤
        </button>
        <button
          className={`topbar-btn ai-toggle ${aiPanelOpen ? "active" : ""}`}
          onClick={toggleAiPanel}
          title="JARVIS AI (Ctrl+Shift+I)"
        >
          ✦
        </button>
      </header>

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        sessions={sessions}
        coresDeWorkspace={coresDeWorkspace}
        onActivate={setActiveTabId}
        onClose={closeTab}
        onReorder={aplicaTabs}
      />

      <div className="body-row">
        <WorkspaceSidebar />

        <main className="stage">
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
                      <button className="chip subtle" onClick={() => dismissRecovery(e.id)}>
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tabs.length === 0 && !error && (
            <div className="empty">
              <h1>JARVIS</h1>
              <p>Escolha um shell na barra de cima para abrir um terminal.</p>
              {workspaces.length === 0 && (
                <button className="chip empty-action" onClick={() => void openFolderAndAdd()}>
                  📂 Abrir pasta de projeto
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
                onFocusPane={(paneId) => focusPane(t.id, paneId)}
                onResize={(splitId, sizes) => resizePane(t.id, splitId, sizes)}
                onClosePane={(paneId) => closePane(t.id, paneId)}
                onRestartPane={(paneId) => void restartPane(t.id, paneId)}
              />
            </div>
          ))}
        </main>

        <AiPanel
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
    </div>
  );
}

/* ------------------------------ barra de abas ----------------------------- */

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  sessions: Readonly<Record<string, SessionInfo>>;
  /** Cor de cada workspace, para pintar o ponto da aba. */
  coresDeWorkspace: Readonly<Record<string, string>>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (updater: (prev: TabState[]) => TabState[]) => void;
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
  activeTabId,
  sessions,
  coresDeWorkspace,
  onActivate,
  onClose,
  onReorder,
}: TabBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);
  const barraRef = useRef<HTMLElement | null>(null);

  const commitRename = (id: string, value: string) => {
    const title = value.trim();
    onReorder((prev) =>
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
      {tabs.map((t, i) => (
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
            dragFrom.current = i;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from === null || from === i) return;
            onReorder((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(i, 0, moved);
              return next;
            });
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
            className="x"
            title="Fechar aba"
            aria-label={`Fechar ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
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
