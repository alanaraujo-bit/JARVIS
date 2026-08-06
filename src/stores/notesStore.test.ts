import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { useNotesStore } from "./notesStore";

describe("notesStore - Bloco de Notas do Vibe Coding", () => {
  beforeAll(() => {
    // Mock de localStorage para o ambiente de testes (Node)
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] || null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
      clear: () => { for (const k in storage) delete storage[k]; },
    };
  });

  beforeEach(() => {
    localStorage.clear();
    useNotesStore.setState({
      panelOpen: false,
      notes: [
        {
          id: "test-note-1",
          title: "Nota Teste 1",
          content: "Conteúdo inicial",
          updatedAt: 1000,
          isMono: true,
        },
      ],
      activeNoteId: "test-note-1",
    });
  });

  test("deve alternar a abertura do painel de notas", () => {
    expect(useNotesStore.getState().panelOpen).toBe(false);
    useNotesStore.getState().togglePanel();
    expect(useNotesStore.getState().panelOpen).toBe(true);
    useNotesStore.getState().setPanelOpen(false);
    expect(useNotesStore.getState().panelOpen).toBe(false);
  });

  test("deve criar uma nova nota e selecioná-la", () => {
    const nota = useNotesStore.getState().createNote("Comandos Rápido", "echo hello");
    const store = useNotesStore.getState();
    expect(store.notes).toHaveLength(2);
    expect(store.activeNoteId).toBe(nota.id);
    expect(nota.title).toBe("Comandos Rápido");
    expect(nota.content).toBe("echo hello");
  });

  test("deve atualizar o conteúdo e título de uma nota existente", () => {
    useNotesStore.getState().updateNote("test-note-1", {
      title: "Título Alterado",
      content: "Novo conteúdo",
      isMono: false,
    });
    const nota = useNotesStore.getState().notes.find((n) => n.id === "test-note-1")!;
    expect(nota.title).toBe("Título Alterado");
    expect(nota.content).toBe("Novo conteúdo");
    expect(nota.isMono).toBe(false);
  });

  test("deve anexar texto ao final da nota ativa (ex: captura do terminal)", () => {
    useNotesStore.getState().appendToActiveNote("--- Log do Terminal --- \nErro de compilação");
    const nota = useNotesStore.getState().notes.find((n) => n.id === "test-note-1")!;
    expect(nota.content).toContain("Conteúdo inicial");
    expect(nota.content).toContain("--- Log do Terminal --- \nErro de compilação");
  });

  test("deve deletar nota e recriar uma nota default se todas forem removidas", () => {
    useNotesStore.getState().deleteNote("test-note-1");
    const store = useNotesStore.getState();
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0].title).toBe("Rascunho Rápido");
    expect(store.activeNoteId).toBe(store.notes[0].id);
  });
});
