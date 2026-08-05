/**
 * Store Zustand para gerenciamento de workspaces.
 *
 * Persiste a lista de workspaces, workspace ativo e recentes via
 * comandos Tauri (config_load / config_save) para sobreviver ao
 * fechamento do app.
 */

import { create } from "zustand";
import { createWorkspace, type Workspace } from "../lib/workspace";
import { configLoad, configSave, openFolderDialog } from "../lib/ipc";

export interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sidebarOpen: boolean;

  // Actions
  loadFromConfig: () => Promise<void>;
  addWorkspace: (path: string, name?: string) => Promise<Workspace>;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  updateWorkspace: (
    id: string,
    patch: Partial<Pick<Workspace, "name" | "color" | "defaultProfileId" | "autoCommand">>,
  ) => void;
  reorderWorkspaces: (updater: (prev: Workspace[]) => Workspace[]) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  openFolderAndAdd: () => Promise<Workspace | null>;
  persist: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  sidebarOpen: false,

  loadFromConfig: async () => {
    try {
      const config = await configLoad();
      const workspaces: Workspace[] = (config.workspaces ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        color: w.color,
        defaultProfileId: w.defaultProfileId,
        autoCommand: w.autoCommand ?? null,
        createdAt: w.createdAt,
      }));
      set({
        workspaces,
        // Um id salvo que não bate com nenhum workspace (pasta removida à mão
        // do config) tem que virar modo livre, não um ativo fantasma que
        // faria os terminais abrirem num cwd inexistente.
        activeWorkspaceId:
          workspaces.find((w) => w.id === config.activeWorkspaceId)?.id ?? null,
        sidebarOpen: config.ui?.sidebarOpen ?? false,
      });
    } catch {
      // Config ainda não existe — começa vazio.
    }
  },

  addWorkspace: async (path, name) => {
    const { workspaces } = get();
    // Evita duplicatas pelo caminho
    const existing = workspaces.find((w) => normalizePath(w.path) === normalizePath(path));
    if (existing) {
      set({ activeWorkspaceId: existing.id });
      return existing;
    }
    const ws = createWorkspace(path, workspaces.length, name);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
      sidebarOpen: true,
    }));
    await get().persist();
    return ws;
  },

  removeWorkspace: (id) => {
    set((s) => {
      const next = s.workspaces.filter((w) => w.id !== id);
      const active = s.activeWorkspaceId === id
        ? (next[0]?.id ?? null)
        : s.activeWorkspaceId;
      return { workspaces: next, activeWorkspaceId: active };
    });
    void get().persist();
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    void get().persist();
  },

  updateWorkspace: (id, patch) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));
    void get().persist();
  },

  reorderWorkspaces: (updater) => {
    set((s) => ({ workspaces: updater(s.workspaces) }));
    void get().persist();
  },

  toggleSidebar: () => {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    void get().persist();
  },

  setSidebarOpen: (open) => {
    set({ sidebarOpen: open });
    void get().persist();
  },

  openFolderAndAdd: async () => {
    const path = await openFolderDialog();
    if (!path) return null;
    return get().addWorkspace(path);
  },

  /**
   * Manda só a fatia desta tela. Ler o config inteiro para reescrevê-lo
   * (o padrão anterior) perdia o que o painel de IA tivesse gravado entre a
   * leitura e a escrita; o merge agora acontece no backend, sob lock.
   */
  persist: async () => {
    const { workspaces, activeWorkspaceId, sidebarOpen } = get();
    try {
      await configSave({
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          color: w.color,
          defaultProfileId: w.defaultProfileId,
          autoCommand: w.autoCommand,
          createdAt: w.createdAt,
        })),
        activeWorkspaceId,
        ui: { sidebarOpen },
      });
    } catch {
      // Silencia erros de persistência — não-crítico.
    }
  },
}));

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}
