/**
 * Painel lateral do Bloco de Notas do Vibe Coding.
 *
 * Abre/fecha com Ctrl+Shift+N ou pelos botões da barra e do menu lateral.
 * Projetado especificamente para rodar ao lado dos terminais do JARVIS,
 * permitindo executar comandos ou trechos de script no terminal ativo,
 * capturar os últimos logs para debugar e manter rascunhos de prompts à mão.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { useNotesStore, type Note } from "../stores/notesStore";
import { Icon } from "./Icon";

interface NotesPanelProps {
  /** Callback para executar um comando no terminal ativo. */
  onRunCommand?: (command: string) => void;
  /** Contexto para capturar linhas recentes do terminal. */
  captureContext: () => { systemPrompt: string; context: import("../lib/aiContext").AiContext };
}

export function NotesPanel({ onRunCommand, captureContext }: NotesPanelProps) {
  const {
    panelOpen,
    notes,
    activeNoteId,
    togglePanel,
    createNote,
    selectNote,
    updateNote,
    deleteNote,
    appendToActiveNote,
  } = useNotesStore();

  const [copied, setCopied] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [captured, setCaptured] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeNote = useMemo<Note | undefined>(
    () => notes.find((n) => n.id === activeNoteId) || notes[0],
    [notes, activeNoteId],
  );

  const handleCopy = useCallback(async () => {
    if (!activeNote) return;
    const el = textareaRef.current;
    let texto = activeNote.content;
    if (el && el.selectionStart !== el.selectionEnd) {
      texto = el.value.substring(el.selectionStart, el.selectionEnd);
    }
    await writeClipboardText(texto);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeNote]);

  const handleExecute = useCallback(() => {
    if (!activeNote || !onRunCommand) return;
    const el = textareaRef.current;
    let comando = "";

    if (el && el.selectionStart !== el.selectionEnd) {
      // Prioridade: executar exatamente o que o programador selecionou
      comando = el.value.substring(el.selectionStart, el.selectionEnd).trim();
    } else if (el) {
      // Se não houver seleção, executa a linha atual do cursor (ou tudo se for 1 linha)
      const text = el.value;
      const cursor = el.selectionStart;
      const startLine = text.lastIndexOf("\n", cursor - 1);
      const firstIndex = startLine === -1 ? 0 : startLine + 1;
      const endLine = text.indexOf("\n", cursor);
      const lastIndex = endLine === -1 ? text.length : endLine;
      comando = text.substring(firstIndex, lastIndex).trim();

      if (!comando) {
        comando = text.trim();
      }
    } else {
      comando = activeNote.content.trim();
    }

    if (!comando) return;

    onRunCommand(comando);
    setExecuting(true);
    setTimeout(() => setExecuting(false), 1500);
  }, [activeNote, onRunCommand]);

  const handleCaptureTerminal = useCallback(() => {
    const { context } = captureContext();
    const linhas = context.terminalLines?.trim();
    if (!linhas) return;

    const timestamp = new Date().toLocaleTimeString();
    const shell = context.shellName || "sh";
    const bloco = `### 💻 Saída Capturada do Terminal (${timestamp})\n\`\`\`${shell}\n${linhas}\n\`\`\``;

    appendToActiveNote(bloco);
    setCaptured(true);
    setTimeout(() => setCaptured(false), 2000);
  }, [captureContext, appendToActiveNote]);

  const stats = useMemo(() => {
    if (!activeNote) return "0 palavras";
    const text = activeNote.content.trim();
    const charCount = text.length;
    if (charCount === 0) return "Vazio";
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split("\n").length;
    return `${words} ${words === 1 ? "palavra" : "palavras"} · ${lines} ${lines === 1 ? "linha" : "linhas"}`;
  }, [activeNote]);

  if (!activeNote) return null;

  return (
    <aside className={`notes-panel ${panelOpen ? "open" : ""}`} aria-hidden={!panelOpen} aria-label="Notas do Vibe Coding">
      <div className="notes-panel-inner">
        <header className="notes-panel-header">
          <span className="notes-panel-title">
            <span className="notes-icon">
              <Icon name="pencil" size={16} />
            </span>
            <span>Notas Vibe Coding</span>
          </span>
          <div className="notes-panel-actions">
            <button
              className="chip subtle notes-action-btn"
              onClick={handleCaptureTerminal}
              title="Capturar últimas linhas da tela do terminal ativo e anexar a esta nota"
              aria-label="Capturar saída do terminal"
            >
              <Icon name={captured ? "check" : "terminal"} size={14} />
              <span>{captured ? "Capturado!" : "Capturar Terminal"}</span>
            </button>
            <button
              className="topbar-btn"
              onClick={() => createNote()}
              title="Criar nova nota de rascunho"
              aria-label="Criar nova nota"
            >
              <Icon name="plus" size={15} />
            </button>
            <button
              className="topbar-btn"
              onClick={togglePanel}
              title="Fechar (Ctrl+Shift+N)"
              aria-label="Fechar painel de notas"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>

        {/* Barra de abas horizontais do bloco de notas */}
        <div className="notes-panel-tabs" role="tablist">
          {notes.map((nota) => {
            const isAtiva = nota.id === activeNote.id;
            return (
              <div
                key={nota.id}
                role="tab"
                aria-selected={isAtiva}
                className={`notes-tab ${isAtiva ? "active" : ""}`}
                onClick={() => selectNote(nota.id)}
                title={nota.title || "Sem título"}
              >
                <span className="notes-tab-title">{nota.title || "Sem título"}</span>
                {notes.length > 1 && (
                  <button
                    className="notes-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNote(nota.id);
                    }}
                    title="Excluir anotação"
                    aria-label="Excluir nota"
                  >
                    <Icon name="close" size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Área de edição: título e conteúdo */}
        <div className="notes-editor-container">
          <div className="notes-editor-header">
            <input
              type="text"
              className="notes-title-input"
              value={activeNote.title}
              placeholder="Título do rascunho ou ideia..."
              onChange={(e) => updateNote(activeNote.id, { title: e.target.value })}
              aria-label="Título da nota"
            />
            <button
              className={`chip subtle notes-mono-toggle ${activeNote.isMono ? "active" : ""}`}
              onClick={() => updateNote(activeNote.id, { isMono: !activeNote.isMono })}
              title="Alternar entre fonte monoespaçada (para código) e UI (para texto e ideias)"
            >
              <span>{activeNote.isMono ? "Mono" : "Prosa"}</span>
            </button>
          </div>

          <textarea
            ref={textareaRef}
            className={`notes-textarea ${activeNote.isMono ? "mono" : "prose"}`}
            value={activeNote.content}
            placeholder="Anote prompts, trechos de código, comandos ou ideias de projeto..."
            onChange={(e) => updateNote(activeNote.id, { content: e.target.value })}
            spellCheck={!activeNote.isMono}
            aria-label="Conteúdo da nota"
          />
        </div>

        {/* Rodapé com botões de ação e contadores do Vibe Coding */}
        <footer className="notes-panel-footer">
          <div className="notes-footer-actions">
            <button
              className="chip run-cmd-btn"
              onClick={handleExecute}
              title="Executar no terminal ativo o trecho de código selecionado ou a linha onde o cursor está"
              disabled={!activeNote.content.trim()}
            >
              <Icon name={executing ? "check" : "play"} size={13} />
              <span>{executing ? "Enviado!" : "Executar no Terminal"}</span>
            </button>
            <button
              className="chip subtle"
              onClick={handleCopy}
              title="Copiar texto selecionado (ou a nota inteira)"
              disabled={!activeNote.content.trim()}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
              <span>{copied ? "Copiado!" : "Copiar"}</span>
            </button>
          </div>
          <span className="notes-footer-stats" title="Métricas do texto atual">
            {stats}
          </span>
        </footer>
      </div>
    </aside>
  );
}
