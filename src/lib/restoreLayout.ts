/**
 * Restauração do arranjo de abas e divisões depois de uma vida nova de
 * página (F5, HMR do Vite, recuperação de crash do WebView).
 *
 * As sessões de PTY vivem no processo Rust e sobrevivem à recarga; o estado
 * do React não. Sem isto, um layout de quatro painéis voltava como quatro
 * abas soltas — as sessões certas, no arranjo errado.
 *
 * A regra é simples e conservadora: o arranjo salvo só vale para as sessões
 * que o backend ainda reporta. Qualquer folha órfã é podada, e qualquer
 * sessão viva que o arranjo não mencione vira uma aba nova — nada se perde
 * em nenhuma das duas direções.
 */

import { closePane, listLeaves, type PaneNode } from "./layout";

/** Forma persistida de uma aba. Espelha o `TabState` do `App`. */
export interface SavedTab {
  id: string;
  title: string;
  root: PaneNode;
  activePaneId: string;
  workspaceId: string | null;
}

export interface SavedLayout {
  tabs: SavedTab[];
  activeTabId: string | null;
}

/** Aceita qualquer coisa vinda do disco e só devolve o que tem forma válida. */
export function parseLayout(bruto: unknown): SavedLayout | null {
  if (!bruto || typeof bruto !== "object") return null;
  const obj = bruto as Partial<SavedLayout>;
  if (!Array.isArray(obj.tabs)) return null;

  const tabs = obj.tabs.filter(
    (t): t is SavedTab =>
      !!t &&
      typeof t.id === "string" &&
      typeof t.title === "string" &&
      typeof t.activePaneId === "string" &&
      arvoreValida(t.root),
  );
  if (tabs.length === 0) return null;

  return {
    tabs,
    activeTabId: typeof obj.activeTabId === "string" ? obj.activeTabId : null,
  };
}

function arvoreValida(no: unknown): no is PaneNode {
  if (!no || typeof no !== "object") return false;
  const n = no as Record<string, unknown>;
  if (typeof n.id !== "string") return false;
  if (n.type === "leaf") return typeof n.sessionId === "string";
  if (n.type === "split") {
    return (
      (n.direction === "row" || n.direction === "column") &&
      Array.isArray(n.children) &&
      n.children.length >= 2 &&
      Array.isArray(n.sizes) &&
      n.sizes.length === n.children.length &&
      n.children.every(arvoreValida)
    );
  }
  return false;
}

export interface Restaurado {
  tabs: SavedTab[];
  activeTabId: string | null;
  /** Sessões vivas que o arranjo salvo não mencionava. */
  sessoesSoltas: string[];
}

/**
 * Casa o arranjo salvo com as sessões que o backend ainda tem.
 *
 * `sessoesVivas` é a verdade: o arranjo é apenas uma memória do que a tela
 * mostrava antes.
 */
export function restoreLayout(
  salvo: SavedLayout | null,
  sessoesVivas: string[],
): Restaurado {
  const vivas = new Set(sessoesVivas);
  const usadas = new Set<string>();
  const tabs: SavedTab[] = [];

  for (const tab of salvo?.tabs ?? []) {
    let root: PaneNode | null = tab.root;

    // Poda as folhas cujas sessões morreram junto com a recarga.
    for (const folha of listLeaves(tab.root)) {
      if (vivas.has(folha.sessionId) && !usadas.has(folha.sessionId)) continue;
      if (root) root = closePane(root, folha.id);
    }
    if (!root) continue; // a aba inteira ficou sem painéis

    for (const folha of listLeaves(root)) usadas.add(folha.sessionId);

    const folhas = listLeaves(root);
    const ativoAindaExiste = folhas.some((f) => f.id === tab.activePaneId);
    tabs.push({
      ...tab,
      root,
      activePaneId: ativoAindaExiste ? tab.activePaneId : folhas[0].id,
    });
  }

  return {
    tabs,
    activeTabId: tabs.some((t) => t.id === salvo?.activeTabId)
      ? (salvo?.activeTabId ?? null)
      : (tabs[tabs.length - 1]?.id ?? null),
    sessoesSoltas: sessoesVivas.filter((id) => !usadas.has(id)),
  };
}
