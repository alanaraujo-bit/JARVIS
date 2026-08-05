import { describe, expect, it } from "vitest";

import {
  ENV_CONFIG_DIR,
  envDaConta,
  nomeUnico,
  novoIdDeConta,
  proximaCor,
  resolveConta,
  rotuloDeStatus,
  tokenVencido,
} from "./claudeAccounts";
import type { ClaudeAccountPayload, ClaudeAccountStatus } from "./ipc";

function conta(id: string, name = id): ClaudeAccountPayload {
  return { id, name, color: "#fff", createdAt: 0 };
}

function status(over: Partial<ClaudeAccountStatus> = {}): ClaudeAccountStatus {
  return {
    id: "a",
    configDir: "C:/cfg/a",
    prepared: true,
    loggedIn: true,
    subscriptionType: "pro",
    expiresAt: null,
    rateLimitTier: null,
    ...over,
  };
}

describe("novoIdDeConta", () => {
  it("gera id aceito pelo backend (só letras, números, hífen)", () => {
    for (let i = 0; i < 50; i++) {
      expect(novoIdDeConta()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it("não repete em chamadas seguidas", () => {
    const ids = new Set(Array.from({ length: 200 }, () => novoIdDeConta()));
    expect(ids.size).toBe(200);
  });
});

describe("resolveConta", () => {
  const contas = [conta("a"), conta("b"), conta("c")];

  it("a escolha da hora ganha do workspace e do padrão", () => {
    expect(resolveConta(contas, { escolhidaNaHora: "a", doWorkspace: "b", padrao: "c" })?.id).toBe("a");
  });

  it("sem escolha na hora, o workspace ganha do padrão", () => {
    expect(resolveConta(contas, { doWorkspace: "b", padrao: "c" })?.id).toBe("b");
  });

  it("sem nada específico, cai no padrão", () => {
    expect(resolveConta(contas, { padrao: "c" })?.id).toBe("c");
  });

  it("id de conta apagada cai para o próximo nível em vez de quebrar", () => {
    // O caso que importa: a pessoa apagou a conta que um workspace usava.
    // O terminal tem que abrir na conta padrão, não recusar-se a abrir.
    expect(resolveConta(contas, { doWorkspace: "sumiu", padrao: "c" })?.id).toBe("c");
    expect(resolveConta(contas, { escolhidaNaHora: "sumiu", doWorkspace: "b" })?.id).toBe("b");
  });

  it("sem conta nenhuma configurada devolve null", () => {
    expect(resolveConta([], { padrao: "c" })).toBeNull();
    expect(resolveConta(contas, {})).toBeNull();
  });
});

describe("envDaConta", () => {
  it("aponta CLAUDE_CONFIG_DIR para a pasta da conta", () => {
    expect(envDaConta("C:/cfg/a")).toEqual([[ENV_CONFIG_DIR, "C:/cfg/a"]]);
  });

  it("sem conta não injeta nada — o terminal usa ~/.claude como sempre", () => {
    expect(envDaConta(null)).toEqual([]);
    expect(envDaConta(undefined)).toEqual([]);
    expect(envDaConta("")).toEqual([]);
  });
});

describe("rotuloDeStatus", () => {
  it("descreve os três estados que a interface precisa distinguir", () => {
    expect(rotuloDeStatus(status({ prepared: false }))).toBe("não preparada");
    expect(rotuloDeStatus(status({ loggedIn: false }))).toBe("sem login");
    expect(rotuloDeStatus(status({ subscriptionType: "pro" }))).toBe("PRO");
  });

  it("logada sem tipo de assinatura ainda diz que está logada", () => {
    expect(rotuloDeStatus(status({ subscriptionType: null }))).toBe("logada");
  });

  it("conta sem status conhecido não quebra", () => {
    expect(rotuloDeStatus(null)).toBe("não preparada");
  });
});

describe("tokenVencido", () => {
  const agora = 1_000_000;

  it("acusa vencimento só quando há login e data passada", () => {
    expect(tokenVencido(status({ expiresAt: agora - 1 }), agora)).toBe(true);
    expect(tokenVencido(status({ expiresAt: agora + 1 }), agora)).toBe(false);
  });

  it("sem login ou sem data não há o que vencer", () => {
    expect(tokenVencido(status({ loggedIn: false, expiresAt: agora - 1 }), agora)).toBe(false);
    expect(tokenVencido(status({ expiresAt: null }), agora)).toBe(false);
  });
});

describe("nomeUnico", () => {
  it("mantém o nome quando ele não existe ainda", () => {
    expect(nomeUnico("Pessoal", ["Trabalho"])).toBe("Pessoal");
  });

  it("numera a partir de 2 quando repete", () => {
    expect(nomeUnico("Conta", ["Conta"])).toBe("Conta 2");
    expect(nomeUnico("Conta", ["Conta", "Conta 2"])).toBe("Conta 3");
  });

  it("nome vazio vira 'Conta'", () => {
    expect(nomeUnico("   ", [])).toBe("Conta");
  });
});

describe("proximaCor", () => {
  it("evita cor já usada", () => {
    const primeira = proximaCor([]);
    expect(proximaCor([primeira])).not.toBe(primeira);
  });

  it("com todas usadas ainda devolve uma cor válida", () => {
    const todas = [proximaCor([])];
    for (let i = 0; i < 10; i++) todas.push(proximaCor(todas));
    expect(todas.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
  });
});
