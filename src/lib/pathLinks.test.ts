import { describe, expect, it } from "vitest";

import { findPathMatches } from "./pathLinks";

describe("findPathMatches", () => {
  it("não acha nada em texto sem caminho", () => {
    expect(findPathMatches("git status")).toEqual([]);
  });

  it("acha um caminho simples", () => {
    const [m] = findPathMatches("Está aqui:\nC:\\Users\\Alan Araujo\\Projetos\\CALL\\app-icon.png");
    expect(m.text).toBe("C:\\Users\\Alan Araujo\\Projetos\\CALL\\app-icon.png");
  });

  it("corta pontuação de fim de frase", () => {
    const [m] = findPathMatches("veja C:\\proj\\arquivo.txt.");
    expect(m.text).toBe("C:\\proj\\arquivo.txt");
  });

  it("corta no espaço duplo antes de prosa", () => {
    const [m] = findPathMatches("C:\\proj\\arquivo.txt  é a logo oficial");
    expect(m.text).toBe("C:\\proj\\arquivo.txt");
  });

  it("ignora prompts curtos tipo unidade sozinha", () => {
    expect(findPathMatches("PS C:\\>")).toEqual([]);
  });

  it("acha vários caminhos em linhas separadas", () => {
    const ms = findPathMatches("C:\\a\\b.txt\nC:\\c\\d.txt");
    expect(ms.map((m) => m.text)).toEqual(["C:\\a\\b.txt", "C:\\c\\d.txt"]);
  });
});
