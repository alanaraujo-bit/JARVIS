/**
 * Sidebar colapsável com a lista de workspaces.
 *
 * Abre/fecha com Ctrl+Shift+B ou pelo botão na topbar.
 * Cada workspace mostra nome, caminho e indicador de cor.
 */

import { useCallback, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { WORKSPACE_COLORS } from "../lib/workspace";
import { usePointerGlow } from "../hooks/usePointerGlow";
import { Icon } from "./Icon";

export function WorkspaceSidebar() {
  const {
    workspaces,
    activeWorkspaceId,
    sidebarOpen,
    setActiveWorkspace,
    removeWorkspace,
    updateWorkspace,
    openFolderAndAdd,
  } = useWorkspaceStore();

  const listaRef = usePointerGlow<HTMLDivElement>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [agentPickerId, setAgentPickerId] = useState<string | null>(null);

  const AGENT_PRESETS = ["claude", "claude --resume", "codex"];
  const dragFrom = useRef<number | null>(null);
  const reorder = useWorkspaceStore((s) => s.reorderWorkspaces);

  const handleAddFolder = useCallback(() => {
    void openFolderAndAdd();
  }, [openFolderAndAdd]);

  const commitRename = useCallback(
    (id: string, value: string) => {
      const name = value.trim();
      if (name) updateWorkspace(id, { name });
      setEditingId(null);
    },
    [updateWorkspace],
  );

  /**
   * A gaveta fica sempre montada.
   *
   * Desmontar ao fechar torna a animação de saída impossível — o elemento
   * some no primeiro quadro e a gaveta "pisca" para fora em vez de deslizar.
   * `inert` devolve o que o desmonte tinha de bom: fechada, ela sai do
   * alcance do Tab e do leitor de tela, então não existe um botão invisível
   * capturando o foco no meio da navegação por teclado.
   *
   * O `ws-sidebar-inner` tem largura fixa de propósito: sem ele o conteúdo
   * se espremeria durante os 240ms da animação, e o que se veria seria o
   * texto refluindo, não a gaveta abrindo.
   */
  return (
    <aside className={`ws-sidebar ${sidebarOpen ? "open" : ""}`} inert={!sidebarOpen}>
      <div className="ws-sidebar-inner">
      <div className="ws-sidebar-header">
        <span className="ws-sidebar-title">Workspaces</span>
        <button
          className="ws-add-btn"
          onClick={handleAddFolder}
          title="Abrir pasta (Ctrl+Shift+O)"
          aria-label="Abrir pasta de projeto"
        >
          <Icon name="plus" size={15} />
        </button>
      </div>

      {/* A rolagem fica na caixa de fora e a luz na de dentro, que encolhe
          até a altura dos itens. Com as duas no mesmo elemento, a mancha
          preenchia a coluna inteira e acendia 500px de vazio abaixo do
          último workspace — ambiência bonita iluminando nada. */}
      <div className="ws-list">
      <div className="ws-list-items fluid-list" ref={listaRef}>
        {workspaces.length === 0 && (
          <div className="ws-empty">
            Nenhum workspace.<br />
            Clique em <strong>+</strong> para abrir uma pasta.
          </div>
        )}

        {workspaces.map((ws, i) =>
          // A confirmação toma o lugar do item em vez de flutuar sobre a
          // lista: um popup posicionado colidia com o cabeçalho quando o
          // workspace era o primeiro, e era cortado pela borda quando era o
          // último.
          confirmandoId === ws.id ? (
            <div key={ws.id} className="ws-item ws-item-confirm">
              <div className="ws-confirm-text">
                <span>Remover “{ws.name}”?</span>
                <span className="ws-confirm-note">
                  Os terminais já abertos continuam onde estão.
                </span>
              </div>
              <div className="ws-confirm-actions">
                <button onClick={() => setConfirmandoId(null)}>Cancelar</button>
                <button
                  className="danger"
                  autoFocus
                  onClick={() => {
                    removeWorkspace(ws.id);
                    setConfirmandoId(null);
                  }}
                >
                  Remover
                </button>
              </div>
            </div>
          ) : (
          <div
            key={ws.id}
            className={`ws-item ${ws.id === activeWorkspaceId ? "active" : ""}`}
            draggable
            // Sem `role`/`tabIndex`/teclado não havia nenhuma forma de trocar
            // de workspace sem mouse.
            role="button"
            tabIndex={0}
            aria-pressed={ws.id === activeWorkspaceId}
            onClick={() => setActiveWorkspace(ws.id)}
            onDoubleClick={() => setEditingId(ws.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveWorkspace(ws.id);
              } else if (e.key === "F2") {
                e.preventDefault();
                setEditingId(ws.id);
              }
            }}
            onDragStart={() => { dragFrom.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = null;
              if (from === null || from === i) return;
              reorder((prev) => {
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(i, 0, moved);
                return next;
              });
            }}
          >
            <button
              className="ws-color-dot"
              style={{ background: ws.color }}
              onClick={(e) => {
                e.stopPropagation();
                setColorPickerId(colorPickerId === ws.id ? null : ws.id);
              }}
              aria-label={`Mudar a cor de ${ws.name}`}
              title="Mudar cor"
            />

            <div className="ws-info">
              {editingId === ws.id ? (
                <input
                  className="ws-rename-input"
                  autoFocus
                  defaultValue={ws.name}
                  // Sem isto o cursor cai no fim e digitar concatena ao nome
                  // antigo em vez de substituí-lo — é o que o TabBar já faz
                  // certo para renomear aba.
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => commitRename(ws.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(ws.id, e.currentTarget.value);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <span className="ws-name">{ws.name}</span>
                  <span className="ws-path" title={ws.path}>
                    {shortenPath(ws.path)}
                  </span>
                </>
              )}
            </div>

            <button
              className={`ws-agent-btn ${ws.autoCommand ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setAgentPickerId(agentPickerId === ws.id ? null : ws.id);
                setColorPickerId(null);
              }}
              aria-label={`Auto-iniciar comando em ${ws.name}`}
              title={
                ws.autoCommand
                  ? `Auto-inicia: ${ws.autoCommand}`
                  : "Auto-iniciar um comando (ex.: claude) em terminais novos"
              }
            >
              <Icon name="agent" size={14} />
            </button>

            <button
              className="ws-remove-btn"
              onClick={(e) => {
                e.stopPropagation();
                // Remover era instantâneo e sem desfazer: um clique errado
                // apagava a pasta da lista e ainda trocava o workspace ativo
                // por baixo dos terminais que já estavam abertos.
                setConfirmandoId(ws.id);
              }}
              aria-label={`Remover ${ws.name}`}
              title="Remover workspace"
            >
              <Icon name="close" size={13} />
            </button>

            {/* Popover de auto-início de agente */}
            {agentPickerId === ws.id && (
              <div className="ws-agent-picker" onClick={(e) => e.stopPropagation()}>
                <span className="ws-agent-picker-label">
                  Iniciar automaticamente em terminais novos:
                </span>
                <input
                  className="ws-agent-picker-input"
                  autoFocus
                  defaultValue={ws.autoCommand ?? ""}
                  placeholder="ex.: claude (vazio = desligado)"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) =>
                    updateWorkspace(ws.id, { autoCommand: e.currentTarget.value.trim() || null })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      updateWorkspace(ws.id, {
                        autoCommand: e.currentTarget.value.trim() || null,
                      });
                      setAgentPickerId(null);
                    }
                    if (e.key === "Escape") setAgentPickerId(null);
                  }}
                />
                <div className="ws-agent-picker-presets">
                  {AGENT_PRESETS.map((cmd) => (
                    <button
                      key={cmd}
                      className={`ws-agent-preset ${ws.autoCommand === cmd ? "selected" : ""}`}
                      onClick={() => {
                        updateWorkspace(ws.id, { autoCommand: cmd });
                        setAgentPickerId(null);
                      }}
                    >
                      {cmd}
                    </button>
                  ))}
                  {ws.autoCommand && (
                    <button
                      className="ws-agent-preset ws-agent-preset-off"
                      onClick={() => {
                        updateWorkspace(ws.id, { autoCommand: null });
                        setAgentPickerId(null);
                      }}
                    >
                      Desligar
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Mini-paleta de cores */}
            {colorPickerId === ws.id && (
              <div className="ws-color-picker" onClick={(e) => e.stopPropagation()}>
                {WORKSPACE_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`ws-color-swatch ${c === ws.color ? "selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => {
                      updateWorkspace(ws.id, { color: c });
                      setColorPickerId(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          ),
        )}
      </div>
      </div>

      {/* Botão "Sem workspace" para modo livre */}
      <div className="ws-sidebar-footer">
        <button
          className={`ws-free-btn ${activeWorkspaceId === null ? "active" : ""}`}
          onClick={() => setActiveWorkspace(null)}
          title="Terminais sem workspace vinculado"
        >
          <Icon name="terminal" size={14} />
          Modo livre
        </button>
      </div>
      </div>
    </aside>
  );
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const home = normalized.match(/^[A-Za-z]:\/Users\/[^/]+/)?.[0];
  if (home && normalized.startsWith(home)) {
    return "~" + normalized.slice(home.length);
  }
  // Se o caminho for muito longo, mostra só os 2 últimos segmentos
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length > 3) {
    return ".../" + parts.slice(-2).join("/");
  }
  return normalized;
}
