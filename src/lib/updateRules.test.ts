import { describe, expect, it } from "vitest";

import {
  INTERVALO_CHECAGEM_MS,
  compareVersions,
  deveAvisar,
  linhasDeNotas,
  pctBaixado,
  podeChecarDeNovo,
} from "./updateRules";

describe("compareVersions", () => {
  it("compara número a número, não string a string", () => {
    // O caso que uma comparação alfabética erraria: "0.10.0" < "0.9.0".
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.2.0", "0.3.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  it("trata segmentos ausentes como zero e ignora o 'v' da tag", () => {
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("v0.3.1", "0.3.0")).toBe(1);
  });

  it("põe o pré-lançamento antes da versão final", () => {
    expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBe(1);
    expect(compareVersions("0.3.0-rc.2", "0.3.0-rc.1")).toBe(1);
  });

  it("não estoura com lixo no lugar da versão", () => {
    expect(compareVersions("", "0.1.0")).toBe(-1);
    expect(compareVersions("abc", "0.0.0")).toBe(0);
  });
});

describe("deveAvisar", () => {
  it("avisa quando nada foi dispensado", () => {
    expect(deveAvisar("0.3.0", null)).toBe(true);
  });

  it("silencia exatamente a versão dispensada", () => {
    expect(deveAvisar("0.3.0", "0.3.0")).toBe(false);
  });

  it("volta a avisar numa versão posterior à dispensada", () => {
    // É o ponto todo do "Agora não": recusar a 0.3.0 não pode significar
    // nunca mais saber de uma atualização.
    expect(deveAvisar("0.4.0", "0.3.0")).toBe(true);
  });

  it("não avisa de uma versão anterior à que já foi recusada", () => {
    expect(deveAvisar("0.2.0", "0.3.0")).toBe(false);
  });
});

describe("pctBaixado", () => {
  it("calcula a porcentagem quando o total é conhecido", () => {
    expect(pctBaixado(50, 200)).toBe(25);
    expect(pctBaixado(200, 200)).toBe(100);
  });

  it("devolve null sem content-length, em vez de fingir progresso", () => {
    expect(pctBaixado(1234, null)).toBeNull();
    expect(pctBaixado(1234, 0)).toBeNull();
  });

  it("segura a barra dentro de 0–100 se o servidor mentir no tamanho", () => {
    expect(pctBaixado(300, 200)).toBe(100);
    expect(pctBaixado(-5, 200)).toBe(0);
  });
});

describe("linhasDeNotas", () => {
  it("tira as marcas de lista e descarta títulos", () => {
    // O título vira nada, e não um item: o painel já escreve o próprio
    // cabeçalho, e "Novidades" apareceria como uma novidade.
    expect(linhasDeNotas("## Novidades\n- Terminal mais rápido\n* Correção do X")).toEqual([
      "Terminal mais rápido",
      "Correção do X",
    ]);
  });

  it("descarta linhas vazias e aceita a ausência de notas", () => {
    expect(linhasDeNotas("uma\n\n\noutra")).toEqual(["uma", "outra"]);
    expect(linhasDeNotas(null)).toEqual([]);
    expect(linhasDeNotas("   ")).toEqual([]);
  });

  it("corta changelogs longos", () => {
    const body = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join("\n");
    expect(linhasDeNotas(body)).toHaveLength(12);
  });
});

describe("podeChecarDeNovo", () => {
  const agora = 1_000_000_000;

  it("libera a primeira checagem da execução", () => {
    expect(podeChecarDeNovo(null, agora)).toBe(true);
  });

  it("segura uma segunda checagem dentro do intervalo", () => {
    expect(podeChecarDeNovo(agora - 1000, agora)).toBe(false);
  });

  it("libera de novo depois do intervalo", () => {
    expect(podeChecarDeNovo(agora - INTERVALO_CHECAGEM_MS, agora)).toBe(true);
  });
});
