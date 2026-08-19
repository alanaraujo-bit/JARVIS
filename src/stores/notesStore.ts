/**
 * Estado do Bloco de Notas do Vibe Coding.
 *
 * Persistido no `localStorage` para acesso instantâneo e sem depender do backend
 * ou aguardar chamadas IPC. As anotações são pensadas para acompanhar o desenvolvedor
 * lado a lado com o terminal: rascunhos de prompts, comandos úteis e logs capturados.
 */

import { create } from "zustand";

export interface Note {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
  /** Se a nota usa fonte monoespaçada por padrão. */
  isMono?: boolean;
}

export const NOTES_PANEL_WIDTH_MIN = 260;
export const NOTES_PANEL_WIDTH_MAX = 720;
const NOTES_PANEL_WIDTH_DEFAULT = 360;

function clampPanelWidth(w: number): number {
  return Math.min(NOTES_PANEL_WIDTH_MAX, Math.max(NOTES_PANEL_WIDTH_MIN, Math.round(w)));
}

export interface NotesStore {
  panelOpen: boolean;
  panelWidth: number;
  notes: Note[];
  activeNoteId: string | null;

  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  createNote: (title?: string, content?: string) => Note;
  selectNote: (id: string) => void;
  updateNote: (id: string, updates: Partial<Pick<Note, "title" | "content" | "isMono">>) => void;
  deleteNote: (id: string) => void;
  /** Anexa texto (ex: captura de log do terminal) ao final da nota ativa. */
  appendToActiveNote: (text: string) => void;
}

const STORAGE_KEY = "jarvis_vibe_notes_state";

const NOTA_INICIAL_DEFAULT: Note = {
  id: "vibe-init-1",
  title: "💡 Bloco de Notas do Vibe Coding",
  content: `# ⚡ Bem-vindo às suas Anotações do Vibe Coding!
Este bloco de notas vive lado a lado com seu terminal, para você nunca mais perder um prompt, comando ou log importante enquanto está no fluxo.

## 🚀 Como acelerar seu Vibe Coding aqui:
1. **Executar no Terminal:** Selecione qualquer linha ou bloco de código (ou deixe sem seleção para mandar a linha atual) e clique em "Executar no Terminal" abaixo. O comando roda direto no seu terminal ativo!
2. **Capturar Terminal:** Clicou no botão de terminal na barra acima? As últimas linhas da tela do seu terminal ativo são copiadas instantaneamente para cá. Perfeito para guardar erros e debugar com o Claude.
3. **Múltiplas Abas de Rascunho:** Crie quantas notas quiser (+) para separar ideias do projeto, snippets de código ou comandos frequentes.
4. **Fonte Prosa ou Código:** Alterne entre fonte UI (prosa/ideias) e Monoespaçada no botão da barra superior da nota.
5. **Atalho Rápido:** Pressione "Ctrl+Shift+N" de qualquer lugar para abrir ou fechar este painel sem tirar a mão do teclado.

## 📋 Experimente rodar no terminal:
echo "Vibe Coding é o futuro!"
git status
`,
  updatedAt: Date.now(),
  isMono: true,
};

type PersistedState = {
  notes: Note[];
  activeNoteId: string | null;
  panelOpen: boolean;
  panelWidth: number;
};

function readStorage(): PersistedState {
  const fallback: PersistedState = {
    notes: [NOTA_INICIAL_DEFAULT],
    activeNoteId: NOTA_INICIAL_DEFAULT.id,
    panelOpen: false,
    panelWidth: NOTES_PANEL_WIDTH_DEFAULT,
  };
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const notes: Note[] = Array.isArray(parsed.notes) && parsed.notes.length > 0
      ? parsed.notes
      : [NOTA_INICIAL_DEFAULT];
    const activeNoteId = parsed.activeNoteId && notes.some((n: Note) => n.id === parsed.activeNoteId)
      ? parsed.activeNoteId
      : notes[0].id;
    return {
      notes,
      activeNoteId,
      panelOpen: typeof parsed.panelOpen === "boolean" ? parsed.panelOpen : false,
      panelWidth:
        typeof parsed.panelWidth === "number"
          ? clampPanelWidth(parsed.panelWidth)
          : NOTES_PANEL_WIDTH_DEFAULT,
    };
  } catch {
    return fallback;
  }
}

function writeStorage(state: PersistedState) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Falha em cota de localStorage ou ambiente restrito: ignora em silêncio.
  }
}

export const useNotesStore = create<NotesStore>((set) => {
  const initial = readStorage();

  return {
    panelOpen: initial.panelOpen,
    panelWidth: initial.panelWidth,
    notes: initial.notes,
    activeNoteId: initial.activeNoteId,

    togglePanel: () => {
      set((s) => {
        const next = !s.panelOpen;
        writeStorage({ notes: s.notes, activeNoteId: s.activeNoteId, panelOpen: next , panelWidth: s.panelWidth });
        return { panelOpen: next };
      });
    },

    setPanelOpen: (open) => {
      set((s) => {
        if (s.panelOpen === open) return s;
        writeStorage({ notes: s.notes, activeNoteId: s.activeNoteId, panelOpen: open , panelWidth: s.panelWidth });
        return { panelOpen: open };
      });
    },

    setPanelWidth: (width) => {
      set((s) => {
        const panelWidth = clampPanelWidth(width);
        if (panelWidth === s.panelWidth) return s;
        writeStorage({ notes: s.notes, activeNoteId: s.activeNoteId, panelOpen: s.panelOpen, panelWidth });
        return { panelWidth };
      });
    },

    createNote: (title = "Nova Anotação", content = "") => {
      const nova: Note = {
        id: "note-" + Math.random().toString(36).substring(2, 9) + "-" + Date.now(),
        title,
        content,
        updatedAt: Date.now(),
        isMono: true,
      };
      set((s) => {
        const notes = [nova, ...s.notes];
        writeStorage({ notes, activeNoteId: nova.id, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
        return { notes, activeNoteId: nova.id };
      });
      return nova;
    },

    selectNote: (id) => {
      set((s) => {
        if (s.activeNoteId === id) return s;
        writeStorage({ notes: s.notes, activeNoteId: id, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
        return { activeNoteId: id };
      });
    },

    updateNote: (id, updates) => {
      set((s) => {
        const notes = s.notes.map((n) => (n.id === id ? { ...n, ...updates, updatedAt: Date.now() } : n));
        writeStorage({ notes, activeNoteId: s.activeNoteId, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
        return { notes };
      });
    },

    deleteNote: (id) => {
      set((s) => {
        const notes = s.notes.filter((n) => n.id !== id);
        if (notes.length === 0) {
          const defaultNote: Note = {
            id: "note-" + Math.random().toString(36).substring(2, 9),
            title: "Rascunho Rápido",
            content: "",
            updatedAt: Date.now(),
            isMono: true,
          };
          writeStorage({ notes: [defaultNote], activeNoteId: defaultNote.id, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
          return { notes: [defaultNote], activeNoteId: defaultNote.id };
        }
        const activeNoteId = s.activeNoteId === id ? notes[0].id : s.activeNoteId;
        writeStorage({ notes, activeNoteId, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
        return { notes, activeNoteId };
      });
    },

    appendToActiveNote: (text) => {
      set((s) => {
        if (!s.activeNoteId || !text) return s;
        const notes = s.notes.map((n) => {
          if (n.id === s.activeNoteId) {
            const separator = n.content.trim().length > 0 ? "\n\n" : "";
            return {
              ...n,
              content: n.content + separator + text,
              updatedAt: Date.now(),
            };
          }
          return n;
        });
        writeStorage({ notes, activeNoteId: s.activeNoteId, panelOpen: s.panelOpen , panelWidth: s.panelWidth });
        return { notes };
      });
    },
  };
});
