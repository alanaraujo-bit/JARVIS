import { describe, expect, it } from "vitest";
import {
  closePane,
  findLeaf,
  leaf,
  listLeaves,
  paneCount,
  resizeSplit,
  splitPane,
  type PaneNode,
} from "./layout";

describe("splitPane", () => {
  it("transforma uma folha isolada em uma divisão de dois filhos", () => {
    const root = leaf("s1");
    const result = splitPane(root, root.id, "row", "s2");
    expect(result).not.toBeNull();
    const { root: next, newLeaf } = result!;
    expect(next.type).toBe("split");
    expect(paneCount(next)).toBe(2);
    expect(newLeaf.sessionId).toBe("s2");
    expect(listLeaves(next).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
  });

  it("divide um alvo aninhado sem afetar os irmãos dele", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b], sizes: [0.5, 0.5] };

    const { root: next } = splitPane(root, a.id, "column", "c")!;
    expect(paneCount(next)).toBe(3);
    // b não deveria ter sido tocado nem duplicado.
    expect(listLeaves(next).filter((l) => l.sessionId === "b")).toHaveLength(1);
  });

  it("inserir na mesma direção do pai vira irmão, não um nível a mais", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b], sizes: [0.5, 0.5] };

    const { root: next } = splitPane(root, a.id, "row", "c")!;
    expect(next.type).toBe("split");
    if (next.type !== "split") throw new Error("esperava split");
    expect(next.children).toHaveLength(3);
    expect(next.children.every((c) => c.type === "leaf")).toBe(true);
  });

  it("inserir em direção diferente da do pai cria um nível aninhado", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b], sizes: [0.5, 0.5] };

    const { root: next } = splitPane(root, a.id, "column", "c")!;
    if (next.type !== "split") throw new Error("esperava split");
    expect(next.children).toHaveLength(2);
    const nested = next.children.find((c) => c.type === "split");
    expect(nested).toBeDefined();
    if (nested?.type === "split") {
      expect(nested.direction).toBe("column");
      expect(nested.children).toHaveLength(2);
    }
  });

  it("as frações somam 1 depois do split", () => {
    const root = leaf("s1");
    const { root: next } = splitPane(root, root.id, "row", "s2")!;
    if (next.type !== "split") throw new Error("esperava split");
    const total = next.sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });

  it("devolve null para um id de painel que não existe", () => {
    const root = leaf("s1");
    expect(splitPane(root, "nao-existe", "row", "s2")).toBeNull();
  });
});

describe("closePane", () => {
  it("fechar o único painel esvazia a árvore (null)", () => {
    const root = leaf("s1");
    expect(closePane(root, root.id)).toBeNull();
  });

  it("fechar um de dois painéis devolve a folha sobrevivente pura, sem envoltório", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b], sizes: [0.3, 0.7] };

    const next = closePane(root, a.id);
    expect(next).not.toBeNull();
    expect(next!.type).toBe("leaf");
    if (next!.type === "leaf") expect(next!.sessionId).toBe("b");
  });

  it("doa o espaço do painel fechado aos irmãos restantes, proporcionalmente", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const root: PaneNode = {
      type: "split",
      id: "root",
      direction: "row",
      children: [a, b, c],
      sizes: [0.2, 0.2, 0.6],
    };

    const next = closePane(root, a.id);
    if (next?.type !== "split") throw new Error("esperava split com 2 filhos");
    expect(next.children).toHaveLength(2);
    const total = next.sizes.reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(1);
    // b e c tinham a mesma proporção entre si (0.2 e 0.6 -> 1:3); depois de
    // herdar o espaço de a, essa proporção precisa se manter.
    expect(next.sizes[1] / next.sizes[0]).toBeCloseTo(0.6 / 0.2, 5);
  });

  it("fechar um painel aninhado colapsa o nó de divisão de um filho só", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const inner: PaneNode = { type: "split", id: "inner", direction: "column", children: [b, c], sizes: [0.4, 0.6] };
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, inner], sizes: [0.5, 0.5] };

    const next = closePane(root, b.id);
    if (next?.type !== "split") throw new Error("esperava split");
    // "inner" tinha que ter colapsado para a folha "c" pura, não sobrar
    // como um split de um filho só.
    expect(next.children).toHaveLength(2);
    expect(next.children.every((ch) => ch.type === "leaf")).toBe(true);
    expect(listLeaves(next).map((l) => l.sessionId).sort()).toEqual(["a", "c"]);
  });

  it("fechar um id que não existe devolve a árvore intacta (mesma referência)", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b], sizes: [0.5, 0.5] };
    expect(closePane(root, "nao-existe")).toBe(root);
  });

  it("splits e closes intercalados nunca perdem nem duplicam uma folha", () => {
    let root: PaneNode = leaf("s0");
    const sessions = ["s0"];

    for (let i = 1; i <= 6; i++) {
      const target = listLeaves(root)[i % listLeaves(root).length];
      const sid = `s${i}`;
      const dir = i % 2 === 0 ? "row" : "column";
      const result = splitPane(root, target.id, dir, sid);
      if (!result) throw new Error(`split ${i} falhou`);
      root = result.root;
      sessions.push(sid);
    }
    expect(paneCount(root)).toBe(sessions.length);
    expect(listLeaves(root).map((l) => l.sessionId).sort()).toEqual([...sessions].sort());

    // Fecha três, checando que a contagem cai exatamente um por vez e que
    // nenhuma folha sobrevivente muda de sessionId no processo.
    for (let i = 0; i < 3; i++) {
      const before = listLeaves(root);
      const victim = before[0];
      const survivorsBefore = before.slice(1).map((l) => l.sessionId).sort();
      const next = closePane(root, victim.id);
      expect(next).not.toBeNull();
      root = next!;
      const survivorsAfter = listLeaves(root).map((l) => l.sessionId).sort();
      expect(survivorsAfter).toEqual(survivorsBefore);
    }
  });
});

describe("findLeaf / listLeaves", () => {
  it("acha uma folha em qualquer profundidade", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const inner: PaneNode = { type: "split", id: "inner", direction: "column", children: [b, c], sizes: [0.5, 0.5] };
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, inner], sizes: [0.5, 0.5] };

    expect(findLeaf(root, c.id)?.sessionId).toBe("c");
    expect(findLeaf(root, "nao-existe")).toBeNull();
  });

  it("lista folhas na ordem visual (esquerda->direita, cima->baixo)", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, b, c], sizes: [0.3, 0.3, 0.4] };
    expect(listLeaves(root).map((l) => l.sessionId)).toEqual(["a", "b", "c"]);
  });
});

describe("resizeSplit", () => {
  it("troca as frações só do nó pedido, preservando o resto da árvore", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const inner: PaneNode = { type: "split", id: "inner", direction: "column", children: [b, c], sizes: [0.5, 0.5] };
    const root: PaneNode = { type: "split", id: "root", direction: "row", children: [a, inner], sizes: [0.5, 0.5] };

    const next = resizeSplit(root, "inner", [0.2, 0.8]);
    if (next.type !== "split") throw new Error("esperava split");
    const nested = next.children[1];
    if (nested.type !== "split") throw new Error("esperava split aninhado");
    expect(nested.sizes).toEqual([0.2, 0.8]);
    // O nó raiz não deveria ter sido afetado.
    expect(next.sizes).toEqual([0.5, 0.5]);
  });
});
