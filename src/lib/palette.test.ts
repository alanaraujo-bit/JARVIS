import { describe, expect, it } from "vitest";

import { moveSelection, searchCommands, type Command } from "./palette";

const cmd = (id: string, title: string, group = "Abas", keywords?: string): Command => ({
  id,
  title,
  group,
  keywords,
  run: () => {},
});

const repertorio: Command[] = [
  cmd("new", "Nova aba"),
  cmd("close", "Fechar aba"),
  cmd("split-right", "Dividir ao lado", "Painéis"),
  cmd("split-down", "Dividir abaixo", "Painéis"),
  cmd("folder", "Abrir pasta de projeto", "Workspaces", "workspace folder"),
  cmd("ai", "Alternar painel do JARVIS AI", "IA", "chat assistente"),
];

describe("searchCommands", () => {
  it("mostra o repertório inteiro quando a busca está vazia", () => {
    expect(searchCommands(repertorio, "")).toHaveLength(repertorio.length);
    expect(searchCommands(repertorio, "   ")).toHaveLength(repertorio.length);
  });

  it("casa por subsequência, não só por substring", () => {
    const ids = searchCommands(repertorio, "nab").map((m) => m.command.id);
    expect(ids).toContain("new"); // N-ova A-B-a
  });

  it("prefere quem casa em início de palavra", () => {
    const primeiro = searchCommands(repertorio, "ab")[0].command.id;
    expect(primeiro).toBe("folder"); // "AB-rir" vence "Nova A-B-a"
  });

  it("acha por palavra-chave e por grupo, além do título", () => {
    expect(searchCommands(repertorio, "workspace").map((m) => m.command.id)).toContain("folder");
    expect(searchCommands(repertorio, "chat").map((m) => m.command.id)).toContain("ai");
  });

  it("prioriza o casamento no título sobre o casamento por palavra-chave", () => {
    const lista = [
      cmd("titulo", "Chat rápido", "Outros"),
      cmd("keyword", "Alternar painel", "IA", "chat"),
    ];
    expect(searchCommands(lista, "chat")[0].command.id).toBe("titulo");
  });

  it("não devolve nada quando as letras não aparecem em ordem", () => {
    expect(searchCommands(repertorio, "zzz")).toHaveLength(0);
    // "aban" tem as letras, mas não nesta ordem em nenhum título.
    expect(searchCommands([cmd("x", "banana")], "nab")).toHaveLength(0);
  });

  it("devolve os índices que casaram para destacar no título", () => {
    const [match] = searchCommands([cmd("x", "Nova aba")], "nva");
    expect(match.hits).toEqual([0, 2, 3]);
  });

  it("ignora diferença de caixa", () => {
    // Outros títulos também contêm n-o-v-a como subsequência espalhada; o que
    // importa é o casamento exato liderar.
    expect(searchCommands(repertorio, "NOVA")[0].command.id).toBe("new");
    expect(searchCommands(repertorio, "nova")[0].command.id).toBe("new");
  });

  it("respeita o limite pedido", () => {
    expect(searchCommands(repertorio, "", 2)).toHaveLength(2);
  });
});

describe("moveSelection", () => {
  it("circula nas duas pontas", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(1, 1, 3)).toBe(2);
  });

  it("não estoura com lista vazia", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(5, -1, 0)).toBe(0);
  });
});
