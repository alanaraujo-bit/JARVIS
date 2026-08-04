import { describe, expect, it } from "vitest";

import { leaf, listLeaves, splitPane } from "./layout";
import { parseLayout, restoreLayout, type SavedLayout, type SavedTab } from "./restoreLayout";

/** Aba com um painel só. */
function aba(id: string, sessionId: string, workspaceId: string | null = null): SavedTab {
  const root = leaf(sessionId);
  return { id, title: sessionId, root, activePaneId: root.id, workspaceId };
}

/** Aba dividida em dois painéis. */
function abaDividida(id: string, a: string, b: string): SavedTab {
  const base = leaf(a);
  const r = splitPane(base, base.id, "row", b)!;
  return { id, title: `${a}+${b}`, root: r.root, activePaneId: r.newLeaf.id, workspaceId: null };
}

describe("parseLayout", () => {
  it("rejeita lixo em vez de deixar quebrar na renderização", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout("x")).toBeNull();
    expect(parseLayout({})).toBeNull();
    expect(parseLayout({ tabs: "nao é array" })).toBeNull();
    expect(parseLayout({ tabs: [] })).toBeNull();
  });

  it("descarta abas com árvore malformada e mantém as boas", () => {
    const boa = aba("t1", "s1");
    const salvo = parseLayout({
      tabs: [boa, { id: "t2", title: "x", activePaneId: "p", root: { type: "leaf" } }],
      activeTabId: "t1",
    });
    expect(salvo?.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("rejeita uma divisão sem tamanhos correspondentes", () => {
    const quebrada = {
      id: "s",
      type: "split",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1],
    };
    const salvo = parseLayout({
      tabs: [{ id: "t", title: "t", activePaneId: "p", root: quebrada }],
    });
    expect(salvo).toBeNull();
  });

  it("aceita um arranjo bem formado", () => {
    const salvo = parseLayout({ tabs: [abaDividida("t1", "s1", "s2")], activeTabId: "t1" });
    expect(salvo?.tabs).toHaveLength(1);
    expect(salvo?.activeTabId).toBe("t1");
  });
});

describe("restoreLayout", () => {
  it("devolve o arranjo intacto quando todas as sessões sobreviveram", () => {
    const salvo: SavedLayout = { tabs: [abaDividida("t1", "s1", "s2")], activeTabId: "t1" };
    const r = restoreLayout(salvo, ["s1", "s2"]);

    expect(r.tabs).toHaveLength(1);
    expect(listLeaves(r.tabs[0].root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
    expect(r.activeTabId).toBe("t1");
    expect(r.sessoesSoltas).toEqual([]);
  });

  it("poda o painel cuja sessão sumiu e mantém o resto da aba", () => {
    const salvo: SavedLayout = { tabs: [abaDividida("t1", "s1", "s2")], activeTabId: "t1" };
    const r = restoreLayout(salvo, ["s1"]);

    expect(r.tabs).toHaveLength(1);
    expect(listLeaves(r.tabs[0].root).map((l) => l.sessionId)).toEqual(["s1"]);
  });

  it("descarta a aba que ficou sem nenhum painel", () => {
    const salvo: SavedLayout = {
      tabs: [aba("t1", "s1"), aba("t2", "s2")],
      activeTabId: "t1",
    };
    const r = restoreLayout(salvo, ["s2"]);

    expect(r.tabs.map((t) => t.id)).toEqual(["t2"]);
    // O ativo salvo não existe mais: cai para uma aba que existe.
    expect(r.activeTabId).toBe("t2");
  });

  it("reporta sessões vivas que o arranjo não mencionava", () => {
    const salvo: SavedLayout = { tabs: [aba("t1", "s1")], activeTabId: "t1" };
    const r = restoreLayout(salvo, ["s1", "s2", "s3"]);

    expect(r.sessoesSoltas).toEqual(["s2", "s3"]);
  });

  it("reaponta o painel ativo quando o salvo foi podado", () => {
    const salvo: SavedLayout = { tabs: [abaDividida("t1", "s1", "s2")], activeTabId: "t1" };
    // `abaDividida` deixa o painel novo (s2) como ativo; matamos justamente ele.
    const r = restoreLayout(salvo, ["s1"]);

    const folhas = listLeaves(r.tabs[0].root);
    expect(folhas.some((f) => f.id === r.tabs[0].activePaneId)).toBe(true);
  });

  it("não duplica uma sessão que aparece em duas abas salvas", () => {
    // Não deveria acontecer, mas um arranjo corrompido faria duas abas
    // exibirem a mesma sessão — e dois painéis brigariam pelo mesmo PTY.
    const salvo: SavedLayout = {
      tabs: [aba("t1", "s1"), aba("t2", "s1")],
      activeTabId: "t1",
    };
    const r = restoreLayout(salvo, ["s1"]);

    expect(r.tabs).toHaveLength(1);
    expect(r.sessoesSoltas).toEqual([]);
  });

  it("sem arranjo salvo, todas as sessões vivas ficam soltas", () => {
    const r = restoreLayout(null, ["s1", "s2"]);
    expect(r.tabs).toEqual([]);
    expect(r.activeTabId).toBeNull();
    expect(r.sessoesSoltas).toEqual(["s1", "s2"]);
  });

  it("preserva o workspace de cada aba", () => {
    const salvo: SavedLayout = { tabs: [aba("t1", "s1", "ws-9")], activeTabId: "t1" };
    expect(restoreLayout(salvo, ["s1"]).tabs[0].workspaceId).toBe("ws-9");
  });
});
