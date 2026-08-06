import { describe, expect, it } from "vitest";

import { diffTexto, prefixoComum } from "./dictation";

describe("diffTexto", () => {
  it("texto novo digitado vira os caracteres na ordem", () => {
    expect(diffTexto("", "git")).toBe("git");
    expect(diffTexto("git", "git status")).toBe(" status");
  });

  it("nenhuma mudança não manda nada", () => {
    expect(diffTexto("npm run dev", "npm run dev")).toBe("");
  });

  it("apagar do fim vira Backspace por caractere", () => {
    // "git statu" → "git sta" remove duas letras ("tu").
    expect(diffTexto("git statu", "git sta")).toBe("\x7f\x7f");
    expect(diffTexto("abc", "")).toBe("\x7f\x7f\x7f");
  });

  it("apagar no meio perde o texto depois do ponto de edição", () => {
    // A barra é pensada para ferramentas que digitam no fim; editar no meio
    // não é o fluxo, mas não pode quebrar: o que vem depois do corte segue.
    expect(diffTexto("abcXYZ", "abcDEF")).toBe("DEF");
  });

  it("colar um bloco inteiro manda o bloco de uma vez", () => {
    expect(diffTexto("", "git add . && git commit -m x")).toBe(
      "git add . && git commit -m x",
    );
  });

  it("substituição completa (limpar e digitar de novo) manda o texto novo", () => {
    expect(diffTexto("git status", "ls")).toBe("ls");
  });

  it("não manda Backspace quando o campo encolhe por outro motivo (campo vazio)", () => {
    expect(diffTexto("", "")).toBe("");
  });
});

describe("prefixoComum", () => {
  it("conta os caracteres iguais do começo", () => {
    expect(prefixoComum("abc", "abd")).toBe(2);
    expect(prefixoComum("abc", "abc")).toBe(3);
    expect(prefixoComum("abc", "xyz")).toBe(0);
    expect(prefixoComum("", "abc")).toBe(0);
  });
});
