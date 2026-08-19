import { describe, expect, it } from "vitest";

import { acharOcorrenciasDeImagem, resolverCaminhoDaImagem } from "./imagePreview";

describe("acharOcorrenciasDeImagem", () => {
  it("não acha nada em linhas sem placeholder", () => {
    expect(acharOcorrenciasDeImagem(["PS C:\\projeto>", "git status"])).toEqual([]);
  });

  it("acha uma ocorrência única", () => {
    expect(acharOcorrenciasDeImagem(["> [Image #1]"])).toEqual([{ linha: 0, coluna: 2 }]);
  });

  it("acha várias ocorrências, inclusive mais de uma na mesma linha", () => {
    expect(
      acharOcorrenciasDeImagem(["[Image #1] e [Image #2]", "texto qualquer", "> [Image #1]"]),
    ).toEqual([
      { linha: 0, coluna: 0 },
      { linha: 0, coluna: 13 },
      { linha: 2, coluna: 2 },
    ]);
  });
});

describe("resolverCaminhoDaImagem", () => {
  it("resolve a única ocorrência para a única colagem", () => {
    const linhas = ["> [Image #1]"];
    expect(
      resolverCaminhoDaImagem(linhas, { linha: 0, coluna: 2 }, ["C:\\proj\\a.png"]),
    ).toBe("C:\\proj\\a.png");
  });

  it("ignora o número mostrado e usa a ordem: o agente reinicia o #N a cada mensagem", () => {
    // Mensagem 1 colou duas imagens ([Image #1], [Image #2]); mensagem 2,
    // já enviada, reinicia a contagem e colou só uma — também "[Image #1]".
    const linhas = [
      "[Image #1] [Image #2]",
      "(mensagem 1 enviada, resposta do agente aqui)",
      "> [Image #1]",
    ];
    const historico = ["C:\\proj\\a.png", "C:\\proj\\b.png", "C:\\proj\\c.png"];

    expect(resolverCaminhoDaImagem(linhas, { linha: 0, coluna: 0 }, historico)).toBe(
      "C:\\proj\\a.png",
    );
    expect(resolverCaminhoDaImagem(linhas, { linha: 0, coluna: 11 }, historico)).toBe(
      "C:\\proj\\b.png",
    );
    // O "[Image #1]" da terceira linha é, na ordem de aparição, a TERCEIRA
    // colagem — mesmo mostrando "#1" de novo.
    expect(resolverCaminhoDaImagem(linhas, { linha: 2, coluna: 2 }, historico)).toBe(
      "C:\\proj\\c.png",
    );
  });

  it("casa a partir do fim: sobrevive a colagens antigas podadas do scrollback", () => {
    // A colagem mais antiga (a.png) rolou para fora do buffer visível; só
    // os dois placeholders mais recentes ainda aparecem nas linhas.
    const linhas = ["[Image #1]", "> [Image #1]"];
    const historico = ["C:\\proj\\a.png", "C:\\proj\\b.png", "C:\\proj\\c.png"];

    // A última ocorrência da tela é sempre a última colagem do histórico.
    expect(resolverCaminhoDaImagem(linhas, { linha: 1, coluna: 2 }, historico)).toBe(
      "C:\\proj\\c.png",
    );
    expect(resolverCaminhoDaImagem(linhas, { linha: 0, coluna: 0 }, historico)).toBe(
      "C:\\proj\\b.png",
    );
  });

  it("devolve undefined quando o placeholder não está nas linhas", () => {
    expect(
      resolverCaminhoDaImagem(["nada aqui"], { linha: 0, coluna: 0 }, ["C:\\proj\\a.png"]),
    ).toBeUndefined();
  });

  it("devolve undefined quando não há colagem correspondente no histórico", () => {
    expect(resolverCaminhoDaImagem(["[Image #1]"], { linha: 0, coluna: 0 }, [])).toBeUndefined();
  });
});
