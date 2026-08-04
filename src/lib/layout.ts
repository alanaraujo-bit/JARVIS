/**
 * Árvore de painéis de uma aba. Cada aba tem uma dessas — uma folha é um
 * terminal (uma sessão de PTY própria; splits nunca compartilham sessão,
 * cada painel novo nasce com o seu), um nó de divisão empilha folhas ou
 * outras divisões em linha ("row", lado a lado) ou coluna ("column",
 * empilhadas).
 *
 * As funções aqui são puras — não tocam DOM nem IPC — de propósito: são a
 * parte fácil de testar de forma exaustiva, e o componente React só decide
 * "o que desenhar", nunca "o que a árvore vira depois de um split".
 */

export type Direction = "row" | "column";

export interface LeafNode {
  type: "leaf";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: Direction;
  children: PaneNode[];
  /** Frações que somam 1, uma por filho, na mesma ordem de `children`. */
  sizes: number[];
}

export type PaneNode = LeafNode | SplitNode;

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function leaf(sessionId: string): LeafNode {
  return { type: "leaf", id: nextId("pane"), sessionId };
}

/** Todas as folhas da árvore, na ordem em que aparecem visualmente. */
export function listLeaves(node: PaneNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(listLeaves);
}

export function findLeaf(node: PaneNode, paneId: string): LeafNode | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

/**
 * Divide o painel `targetId` na direção dada, inserindo uma folha nova com
 * `newSessionId`. Se o pai do alvo já divide na mesma direção, o novo painel
 * entra como mais um filho dali (lado a lado com os irmãos), em vez de criar
 * um nó aninhado desnecessário — evita que dividir repetidamente na mesma
 * direção produza uma árvore profunda de divisões de um filho só.
 *
 * `newSessionId` já vem pronto (o spawn no backend acontece antes, no
 * chamador) para a árvore nunca passar por um estado intermediário com uma
 * folha sem sessão de verdade.
 */
export function splitPane(
  root: PaneNode,
  targetId: string,
  direction: Direction,
  newSessionId: string,
): { root: PaneNode; newLeaf: LeafNode } | null {
  const newLeaf = leaf(newSessionId);

  function walk(node: PaneNode): PaneNode | null {
    if (node.type === "leaf") {
      if (node.id !== targetId) return null;
      const twin: SplitNode = {
        type: "split",
        id: nextId("split"),
        direction,
        children: [node, newLeaf],
        sizes: [0.5, 0.5],
      };
      return twin;
    }

    const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
    if (idx !== -1 && node.direction === direction) {
      // Mesma direção do pai: inserir como irmão, redistribuindo o espaço
      // do alvo em vez de criar um nível de divisão a mais.
      const children = [...node.children];
      const targetSize = node.sizes[idx];
      children.splice(idx + 1, 0, newLeaf);
      const sizes = [...node.sizes];
      sizes.splice(idx, 1, targetSize / 2, targetSize / 2);
      return { ...node, children, sizes };
    }

    for (let i = 0; i < node.children.length; i++) {
      const replaced = walk(node.children[i]);
      if (replaced) {
        const children = [...node.children];
        children[i] = replaced;
        return { ...node, children };
      }
    }
    return null;
  }

  const result = walk(root);
  if (!result) return null;
  return { root: result, newLeaf };
}

/**
 * Remove o painel `paneId` da árvore. Devolve `null` se isso esvaziar a
 * árvore inteira (era o único painel) — sinal para o chamador fechar a aba.
 * Um nó de divisão com um único filho restante é substituído pelo próprio
 * filho, para a árvore nunca acumular envoltórios de um elemento só. O
 * espaço do painel removido é doado aos irmãos, proporcionalmente ao que
 * cada um já tinha — sem isso, fechar um painel deixaria um buraco vazio ou
 * encolheria a divisão inteira.
 */
export function closePane(root: PaneNode, paneId: string): PaneNode | null {
  function walk(node: PaneNode): PaneNode | null {
    if (node.type === "leaf") {
      return node.id === paneId ? null : node;
    }

    const results = node.children.map(walk);
    const changed = results.some((r, i) => r !== node.children[i]);
    if (!changed) return node;

    const newChildren: PaneNode[] = [];
    const newSizes: number[] = [];
    let freed = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r === null) {
        freed += node.sizes[i];
      } else {
        newChildren.push(r);
        newSizes.push(node.sizes[i]);
      }
    }

    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];

    const total = newSizes.reduce((a, b) => a + b, 0) || 1;
    const sizes = freed > 0 ? newSizes.map((s) => s + (s / total) * freed) : newSizes;
    return { ...node, children: newChildren, sizes };
  }

  return walk(root);
}

/** Substitui as frações de um nó de divisão específico (arraste de divisor). */
export function resizeSplit(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  function walk(node: PaneNode): PaneNode {
    if (node.type === "leaf") return node;
    if (node.id === splitId) return { ...node, sizes };
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

/** Troca a sessão de uma folha (usado ao reiniciar um terminal morto). */
export function replaceSessionId(root: PaneNode, paneId: string, sessionId: string): PaneNode {
  function walk(node: PaneNode): PaneNode {
    if (node.type === "leaf") {
      return node.id === paneId ? { ...node, sessionId } : node;
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

export function paneCount(node: PaneNode): number {
  return listLeaves(node).length;
}
