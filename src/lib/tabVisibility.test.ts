import { describe, expect, it } from "vitest";

import {
  minimizedTabs,
  moveTab,
  nextActiveAfterHiding,
  visibleTabs,
  type AbaVisivel,
} from "./tabVisibility";

const abas = (...spec: [string, boolean?][]): AbaVisivel[] =>
  spec.map(([id, minimized]) => ({ id, minimized }));

describe("visibleTabs / minimizedTabs", () => {
  it("separa as duas listas e trata 'campo ausente' como aberta", () => {
    const lista = abas(["a"], ["b", true], ["c", false]);
    expect(visibleTabs(lista).map((t) => t.id)).toEqual(["a", "c"]);
    expect(minimizedTabs(lista).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("nextActiveAfterHiding", () => {
  it("não mexe no foco quando quem sai é uma aba de fundo", () => {
    const lista = abas(["a"], ["b"], ["c"]);
    expect(nextActiveAfterHiding(lista, "c", "a")).toBe("a");
  });

  it("passa o foco para a vizinha da mesma posição", () => {
    const lista = abas(["a"], ["b"], ["c"]);
    expect(nextActiveAfterHiding(lista, "b", "b")).toBe("c");
  });

  it("na última, recua para a anterior", () => {
    const lista = abas(["a"], ["b"], ["c"]);
    expect(nextActiveAfterHiding(lista, "c", "c")).toBe("b");
  });

  it("pula as já minimizadas ao escolher a vizinha", () => {
    // A vizinha "de tela" de `a` é `c`: `b` não está na barra.
    const lista = abas(["a"], ["b", true], ["c"]);
    expect(nextActiveAfterHiding(lista, "a", "a")).toBe("c");
  });

  it("minimizar a última visível deixa a tela sem aba ativa", () => {
    const lista = abas(["a"], ["b", true]);
    expect(nextActiveAfterHiding(lista, "a", "a")).toBeNull();
  });
});

describe("moveTab", () => {
  it("reordena por id, mesmo com minimizadas no meio", () => {
    // Na tela o usuário vê [a, c] e arrasta `c` para o lugar de `a`; a lista
    // real tem `b` minimizada entre as duas. Por índice de tela isso moveria
    // a aba errada.
    const lista = abas(["a"], ["b", true], ["c"]);
    expect(moveTab(lista, "c", "a").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("id desconhecido ou destino igual à origem não muda nada", () => {
    const lista = abas(["a"], ["b"]);
    expect(moveTab(lista, "a", "a")).toBe(lista);
    expect(moveTab(lista, "z", "a")).toBe(lista);
  });
});
