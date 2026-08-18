import { describe, expect, it } from "vitest";

import { planejarColagem, planejarColagemDeEvento } from "./clipboard";

/** `DataTransfer` mínimo: só o que `planejarColagemDeEvento` consulta. */
function dados(texto: string, tipos: string[] = []): DataTransfer {
  return {
    getData: (formato: string) => (formato === "text/plain" ? texto : ""),
    items: tipos.map((type) => ({ type })),
  } as unknown as DataTransfer;
}

describe("planejarColagem", () => {
  it("prefere o texto quando existe", () => {
    // Excel e Word põem bitmap da seleção junto com o texto; preferir a
    // imagem faria "copiar células e colar" virar um caminho de PNG.
    expect(planejarColagem("select 1;")).toEqual({
      tipo: "texto",
      texto: "select 1;",
    });
  });

  it("cai para a imagem quando não há texto", () => {
    // É o caso do print puro (Win+Shift+S), que não traz texto nenhum.
    expect(planejarColagem("")).toEqual({ tipo: "imagem" });
  });

  it("força a imagem mesmo com texto no clipboard", () => {
    // Imagem copiada do navegador vem com a URL/alt como texto: sem o
    // atalho dedicado, a colagem normal nunca chegaria na imagem.
    expect(planejarColagem("https://exemplo/foto.png", { forcarImagem: true })).toEqual({
      tipo: "imagem",
    });
  });

  it("força a imagem mesmo com o clipboard vazio", () => {
    expect(planejarColagem("", { forcarImagem: true })).toEqual({ tipo: "imagem" });
  });
});

describe("planejarColagemDeEvento", () => {
  it("ignora evento sem dados", () => {
    expect(planejarColagemDeEvento(null)).toEqual({ tipo: "nada" });
  });

  it("usa o texto do evento quando ele vem", () => {
    expect(planejarColagemDeEvento(dados("olá", ["text/plain"]))).toEqual({
      tipo: "texto",
      texto: "olá",
    });
  });

  it("reconhece imagem sem texto", () => {
    expect(planejarColagemDeEvento(dados("", ["image/png"]))).toEqual({ tipo: "imagem" });
  });

  it("não faz nada quando não há texto nem imagem", () => {
    // Colar um arquivo qualquer não deve disparar leitura de imagem.
    expect(planejarColagemDeEvento(dados("", ["application/zip"]))).toEqual({ tipo: "nada" });
  });
});
