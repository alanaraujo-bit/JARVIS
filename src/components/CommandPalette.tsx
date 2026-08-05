/**
 * Paleta de comandos (Ctrl+Shift+P).
 *
 * Tudo que a interface faz por clique ou atalho também aparece aqui, para o
 * usuário não precisar decorar combinação nenhuma.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { moveSelection, searchCommands, type Command } from "../lib/palette";
import { usePointerGlow } from "../hooks/usePointerGlow";

interface Props {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const caixaRef = usePointerGlow<HTMLDivElement>();

  const matches = useMemo(() => searchCommands(commands, query), [commands, query]);

  // Cada abertura começa limpa; manter a busca anterior faria a paleta
  // abrir mostrando um resultado que não tem a ver com o que se quer agora.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  // Digitar encurta a lista: sem isso a seleção ficaria fora do intervalo e
  // o Enter executaria o comando errado (ou nenhum).
  useEffect(() => {
    setSelected((s) => (s >= matches.length ? 0 : s));
  }, [matches.length]);

  // Mantém o item selecionado visível ao navegar pelo teclado.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;


  const executa = (cmd: Command | undefined) => {
    if (!cmd) return;
    // Fecha antes de executar: comandos que abrem diálogos nativos (escolher
    // pasta) bloqueiam a thread, e a paleta ficaria congelada por cima.
    onClose();
    cmd.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        // A luz mora na caixa inteira, e não só na lista: com ela restrita
        // à lista, o brilho terminava numa borda reta logo abaixo do campo
        // de busca — que é justamente onde o ponteiro entra.
        className="palette fluid-list"
        ref={caixaRef}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        onMouseDown={(e) => e.stopPropagation()}
        // Sem prender o Tab, o foco escapa para a topbar e daí para o
        // terminal atrás do backdrop — e o que se digita passa a ir para o
        // shell com a paleta ainda aberta por cima.
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          e.preventDefault();
          e.currentTarget.querySelector<HTMLInputElement>(".palette-input")?.focus();
        }}
      >
        <input
          className="palette-input"
          autoFocus
          placeholder="Digite um comando..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setSelected((s) => moveSelection(s, 1, matches.length));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setSelected((s) => moveSelection(s, -1, matches.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              executa(matches[selected]?.command);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && <div className="palette-empty">Nenhum comando encontrado.</div>}

          {matches.map((m, i) => (
            <button
              key={m.command.id}
              className={`palette-item ${i === selected ? "selected" : ""}`}
              data-selected={i === selected}
              // `mouseMove` e não `mouseEnter`: a lista rola sob o cursor
              // parado quando se navega pelo teclado, e o `enter` sintético
              // roubaria a seleção de volta para onde o mouse estava.
              onMouseMove={() => setSelected(i)}
              onClick={() => executa(m.command)}
            >
              <span className="palette-group">{m.command.group}</span>
              <span className="palette-title">
                <Destaque texto={m.command.title} hits={m.hits} />
              </span>
              {m.command.shortcut && (
                <kbd className="palette-shortcut">{m.command.shortcut}</kbd>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Realça as letras que casaram com a busca. */
function Destaque({ texto, hits }: { texto: string; hits: number[] }) {
  if (hits.length === 0) return <>{texto}</>;
  const marcados = new Set(hits);
  return (
    <>
      {[...texto].map((ch, i) =>
        marcados.has(i) ? (
          <mark key={i} className="palette-hit">
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}
