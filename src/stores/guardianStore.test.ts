import { beforeEach, describe, expect, test, vi } from "vitest";

import { comparaContas, useGuardianStore, type GuardianConta } from "./guardianStore";

/** Mocks do módulo IPC — o store não precisa do Tauri para ser testado. */
const ipc = vi.hoisted(() => ({
  claudeAccountCredentials: vi.fn(),
  claudeUsageByAccount: vi.fn(),
  configLoad: vi.fn(),
  configSave: vi.fn(),
}));

vi.mock("../lib/ipc", () => ipc);

/** Resposta mínima do guardião. */
function respostaDe(_url: string, body: unknown = {}): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("guardianStore — painel do guardião 24/7", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return respostaDe(url, { agora: Date.now(), contas: [] });
      }
      if (url.endsWith("/api/accounts")) {
        return respostaDe(url, { ok: true });
      }
      if (url.endsWith("/lease")) {
        return respostaDe(url, { ok: true, leaseUntil: Date.now() + 120_000 });
      }
      if (url.endsWith("/ping")) {
        return respostaDe(url, { ok: true });
      }
      return respostaDe(url, { ok: true });
    });

    ipc.configLoad.mockResolvedValue({
      guardian: { url: "https://guardian.test", token: "tokentokentokentoken" },
    });
    ipc.configSave.mockResolvedValue({});
    ipc.claudeAccountCredentials.mockResolvedValue('{"claudeAiOauth":{"refreshToken":"x"}}');
    ipc.claudeUsageByAccount.mockResolvedValue([]);

    useGuardianStore.setState({
      configuracao: null,
      carregado: false,
      status: null,
      carregando: false,
      erro: null,
      painelAberto: false,
    });
  });

  test("carregar lê a configuração do config e busca o status de largada", async () => {
    await useGuardianStore.getState().carregar();

    const s = useGuardianStore.getState();
    expect(s.carregado).toBe(true);
    expect(s.configuracao?.url).toBe("https://guardian.test");
    expect(fetch).toHaveBeenCalledWith(
      "https://guardian.test/api/status",
      expect.objectContaining({
        headers: { Authorization: "Bearer tokentokentokentoken" },
      }),
    );
  });

  test("carregar sem configuração deixa o painel vazio sem buscar nada", async () => {
    ipc.configLoad.mockResolvedValue({
      guardian: { url: "", token: "" },
    });

    await useGuardianStore.getState().carregar();

    const s = useGuardianStore.getState();
    expect(s.carregado).toBe(true);
    expect(s.configuracao).toEqual({ url: "", token: "" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("salvarConfiguracao grava no config e conecta", async () => {
    const ok = await useGuardianStore
      .getState()
      .salvarConfiguracao({ url: "https://guardian.test", token: "abc123abc123abc1" });

    expect(ok).toBe(true);
    expect(ipc.configSave).toHaveBeenCalledWith({
      guardian: { url: "https://guardian.test", token: "abc123abc123abc1" },
    });
    expect(useGuardianStore.getState().configuracao?.token).toBe("abc123abc123abc1");
    expect(fetch).toHaveBeenCalledWith(
      "https://guardian.test/api/status",
      expect.objectContaining({ headers: { Authorization: "Bearer abc123abc123abc1" } }),
    );
  });

  test("registrarConta sem login não chama o guardião e explica o motivo", async () => {
    ipc.claudeAccountCredentials.mockResolvedValue(null);
    await useGuardianStore.getState().carregar();

    await useGuardianStore.getState().registrarConta("acc-1", "Minha Conta");

    const s = useGuardianStore.getState();
    expect(s.erro).toMatch(/login/);
    // Nenhuma chamada de atualização: sem credencial não há o que mandar.
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/credentials"))).toBe(false);
  });

  test("registrarConta sem configuração avisa antes de tudo", async () => {
    // Sem carregar(): configuracao ainda é null.
    await useGuardianStore.getState().registrarConta("acc-1", "Minha Conta");

    expect(useGuardianStore.getState().erro).toMatch(/configure o guardião/);
  });

  test("registrarConta envia as credenciais por uma atualização idempotente", async () => {
    await useGuardianStore.getState().carregar();
    await useGuardianStore.getState().registrarConta("acc-1", "Minha Conta");

    expect(ipc.claudeAccountCredentials).toHaveBeenCalledWith("acc-1");
    const put = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith("/api/accounts/acc-1/credentials"),
    );
    expect(put).toBeDefined();
    expect(put![1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        name: "Minha Conta",
        credentialsJson: '{"claudeAiOauth":{"refreshToken":"x"}}',
      }),
    });
  });

  test("carregar reconcilia automaticamente as credenciais locais", async () => {
    ipc.configLoad.mockResolvedValue({
      guardian: { url: "https://guardian.test", token: "tokentokentokentoken" },
      claudeAccounts: [{ id: "acc-1", name: "Minha Conta", color: "#fff", createdAt: 1 }],
    });

    await useGuardianStore.getState().carregar();

    expect(ipc.claudeAccountCredentials).toHaveBeenCalledWith("acc-1");
    expect(fetch).toHaveBeenCalledWith(
      "https://guardian.test/api/accounts/acc-1/credentials",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("sinalizarUso só renova lease de contas cadastradas no guardião", async () => {
    await useGuardianStore.getState().carregar();
    useGuardianStore.setState({
      status: {
        agora: Date.now(),
        contas: [
          {
            id: "acc-a",
            name: "A",
            enabled: true,
            createdAt: 1,
            custo: null,
            estado: {
              leaseAtivo: false,
              bloqueadaSemanal: false,
              bloqueadaMensal: false,
              cota: null,
              cotaConsultadaEm: null,
              ultimoPing: null,
              ultimoPingOk: null,
              ultimoPingErro: null,
              pingsOk: 0,
              pingsFail: 0,
              proximaAcaoEm: null,
            },
          },
        ],
      },
    });

    // acc-c não existe no guardião: não pode gerar uma chamada.
    await useGuardianStore.getState().sinalizarUso(["acc-a", "acc-c"]);

    const leases = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith("/lease"),
    );
    expect(leases).toHaveLength(1);
    expect(String(leases[0][0])).toContain("/api/accounts/acc-a/lease");
  });

  test("sinalizarUso não faz nada sem configuração", async () => {
    ipc.configLoad.mockResolvedValue({ guardian: { url: "", token: "" } });
    await useGuardianStore.getState().carregar();

    await useGuardianStore.getState().sinalizarUso(["acc-a"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  /* ------------------- sincronização de custos ------------------- */

  function sumario(noData: boolean, parcial: Record<string, unknown> = {}) {
    return {
      currentModel: null,
      currentEffort: null,
      byModel: [],
      tokensLast5h: 0,
      tokensLast24h: 0,
      costLast5hUsd: 0,
      costTotalUsd: 0,
      totalEvents: 0,
      noData,
      ...parcial,
    };
  }

  test("sincronizarCustos empurra o custo real de cada conta para o guardião", async () => {
    ipc.claudeUsageByAccount.mockResolvedValue([
      { accountId: "acc-1", summary: sumario(false, { costTotalUsd: 1.23, costLast5hUsd: 0.01, tokensLast5h: 100, tokensLast24h: 5_000 }) },
      { accountId: "acc-2", summary: sumario(false, { costTotalUsd: 9.5, costLast5hUsd: 0.5, tokensLast5h: 2_000, tokensLast24h: 80_000 }) },
    ]);
    await useGuardianStore.getState().carregar();

    await useGuardianStore
      .getState()
      .sincronizarCustos([["acc-1", "dir-1"], ["acc-2", "dir-2"]]);

    expect(ipc.claudeUsageByAccount).toHaveBeenCalledWith([["acc-1", "dir-1"], ["acc-2", "dir-2"]]);
    const usos = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith("/usage"),
    );
    expect(usos).toHaveLength(2);
    const corpo = (i: number) => JSON.parse(String(usos[i][1].body));
    expect(usos[0][1].method).toBe("POST");
    expect(String(usos[0][0])).toContain("/api/accounts/acc-1/usage");
    expect(corpo(0)).toEqual({
      costTotalUsd: 1.23,
      costLast5hUsd: 0.01,
      tokensLast5h: 100,
      tokensLast24h: 5_000,
    });
    expect(corpo(1).costTotalUsd).toBe(9.5);
  });

  test("sincronizarCustos ignora contas sem dados", async () => {
    ipc.claudeUsageByAccount.mockResolvedValue([
      { accountId: "acc-1", summary: sumario(true) },
      { accountId: "acc-2", summary: sumario(false, { costTotalUsd: 2 }) },
    ]);
    await useGuardianStore.getState().carregar();

    await useGuardianStore
      .getState()
      .sincronizarCustos([["acc-1", "dir-1"], ["acc-2", "dir-2"]]);

    const usos = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith("/usage"),
    );
    expect(usos).toHaveLength(1);
    expect(String(usos[0][0])).toContain("/api/accounts/acc-2/usage");
  });

  test("sincronizarCustos não faz nada sem configuração ou sem pares", async () => {
    ipc.configLoad.mockResolvedValue({ guardian: { url: "", token: "" } });
    await useGuardianStore.getState().carregar();

    await useGuardianStore.getState().sincronizarCustos([["acc-1", "dir-1"]]);
    expect(ipc.claudeUsageByAccount).not.toHaveBeenCalled();

    // Sem pares não há o que ler nem enviar.
    await useGuardianStore.getState().sincronizarCustos([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sincronizarCustos nunca quebra quando o IPC falha (custo é melhoria)", async () => {
    ipc.claudeUsageByAccount.mockRejectedValue(new Error("offline"));
    await useGuardianStore.getState().carregar();

    await expect(
      useGuardianStore.getState().sincronizarCustos([["acc-1", "dir-1"]]),
    ).resolves.toBeUndefined();
    // Nenhum POST de custo foi tentado (o fetch do status no carregar é legítimo).
    const usos = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith("/usage"),
    );
    expect(usos).toHaveLength(0);
    expect(useGuardianStore.getState().erro).toBeNull();
  });

  test("sincronizarCustos espera os envios terminarem antes de resolver", async () => {
    ipc.claudeUsageByAccount.mockResolvedValue([
      { accountId: "acc-1", summary: sumario(false, { costTotalUsd: 5 }) },
    ]);
    await useGuardianStore.getState().carregar();

    // O POST de custo fica pendurado até a gente soltar a trava — se o store
    // resolve sem esperar, o botão "sincronizar agora" buscaria o status
    // antes do custo chegar no servidor.
    let soltar!: () => void;
    const trava = new Promise<void>((r) => (soltar = r));
    (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await trava;
      return respostaDe("usage", { ok: true });
    });

    let terminou = false;
    const p = useGuardianStore
      .getState()
      .sincronizarCustos([["acc-1", "dir-1"]])
      .finally(() => {
        terminou = true;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(terminou).toBe(false); // ainda aguardando o POST terminar

    soltar();
    await p;
    expect(terminou).toBe(true);
  });

  test("limparCustos chama DELETE /usage nas contas indicadas e atualiza o status", async () => {
    await useGuardianStore.getState().carregar();

    await useGuardianStore.getState().limparCustos(["acc-1", "acc-2"]);

    const dels = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("/usage"),
    );
    expect(dels).toHaveLength(2);
    expect(String(dels[0][0])).toContain("/api/accounts/acc-1/usage");
    expect(String(dels[1][0])).toContain("/api/accounts/acc-2/usage");
    expect(dels[0][1].method).toBe("DELETE");
    expect(dels[1][1].method).toBe("DELETE");
    // O refresh do status também acontece (o ranking some até o próximo sync).
    const statuses = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith("/api/status"),
    );
    expect(statuses.length).toBeGreaterThanOrEqual(2);
  });

  test("limparCustos não faz nada sem configuração ou sem ids", async () => {
    ipc.configLoad.mockResolvedValue({ guardian: { url: "", token: "" } });
    await useGuardianStore.getState().carregar();

    await useGuardianStore.getState().limparCustos(["acc-1"]);
    expect(fetch).not.toHaveBeenCalled();

    await useGuardianStore.getState().limparCustos([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  /* ------------------- ordenação inteligente ------------------- */

  function conta(parcial: Partial<GuardianConta> & { id: string }): GuardianConta {
    return {
      name: parcial.id,
      enabled: true,
      createdAt: 1,
      custo: null,
      estado: {
        leaseAtivo: false,
        bloqueadaSemanal: false,
        bloqueadaMensal: false,
        cota: null,
        cotaConsultadaEm: null,
        ultimoPing: null,
        ultimoPingOk: null,
        ultimoPingErro: null,
        pingsOk: 0,
        pingsFail: 0,
        proximaAcaoEm: null,
      },
      ...parcial,
    };
  }

  const fh = (utilization: number, resetsAtMs: number) => ({
    ok: true,
    erro: null,
    fiveHour: { utilization, resetsAtMs },
    sevenDay: null,
  });

  test("disponível agora vem antes de liberando, que vem antes de travada", () => {
    const disponivel = conta({ id: "a", estado: { ...conta({ id: "a" }).estado, cota: fh(2, Date.now() + 3 * 3600_000) } });
    const liberando = conta({ id: "b", estado: { ...conta({ id: "b" }).estado, cota: fh(100, Date.now() + 30 * 60_000) } });
    const semanal = conta({
      id: "c",
      estado: { ...conta({ id: "c" }).estado, bloqueadaSemanal: true, cota: fh(0, 0) },
    });

    const ordem = [semanal, liberando, disponivel].sort(comparaContas).map((c) => c.id);
    expect(ordem).toEqual(["a", "b", "c"]);
  });

  test("entre as disponíveis, quem tem mais folga fica acima", () => {
    const folga = conta({ id: "nova", estado: { ...conta({ id: "nova" }).estado, cota: fh(1, Date.now() + 5 * 3600_000) } });
    const quaseCheia = conta({ id: "usada", estado: { ...conta({ id: "usada" }).estado, cota: fh(95, Date.now() + 1 * 3600_000) } });

    const ordem = [quaseCheia, folga].sort(comparaContas).map((c) => c.id);
    expect(ordem).toEqual(["nova", "usada"]);
  });

  test("entre as liberando, quem reseta antes fica acima", () => {
    const logo = conta({ id: "logo", estado: { ...conta({ id: "logo" }).estado, cota: fh(100, Date.now() + 10 * 60_000) } });
    const demora = conta({ id: "demora", estado: { ...conta({ id: "demora" }).estado, cota: fh(100, Date.now() + 4 * 3600_000) } });

    const ordem = [demora, logo].sort(comparaContas).map((c) => c.id);
    expect(ordem).toEqual(["logo", "demora"]);
  });

  test("trava semanal fica sempre por último, mensal ainda mais", () => {
    const mensal = conta({
      id: "mensal",
      estado: { ...conta({ id: "mensal" }).estado, bloqueadaMensal: true },
    });
    const semanal = conta({
      id: "semanal",
      estado: { ...conta({ id: "semanal" }).estado, bloqueadaSemanal: true },
    });
    const pausada = conta({ id: "pausada", enabled: false, estado: { ...conta({ id: "pausada" }).estado, cota: fh(0, 0) } });
    const ativa = conta({ id: "ativa", estado: { ...conta({ id: "ativa" }).estado, cota: fh(10, Date.now() + 2 * 3600_000) } });

    const ordem = [pausada, semanal, ativa, mensal].sort(comparaContas).map((c) => c.id);
    expect(ordem).toEqual(["ativa", "pausada", "semanal", "mensal"]);
  });

  test("conta sem dados (não cadastrada) fica no meio, acima de pausada/travada", () => {
    const semDados = conta({ id: "sem-dados", estado: { ...conta({ id: "sem-dados" }).estado, cota: null } });
    const pausada = conta({ id: "pausada", enabled: false });

    const ordem = [pausada, semDados].sort(comparaContas).map((c) => c.id);
    expect(ordem).toEqual(["sem-dados", "pausada"]);
  });

  test("esgotada sem hora de reset é desconhecida, não 'liberando em breve'", () => {
    const semReset = conta({
      id: "sem-reset",
      estado: { ...conta({ id: "sem-reset" }).estado, cota: fh(100, 0) },
    });
    const liberando = conta({
      id: "liberando",
      estado: { ...conta({ id: "liberando" }).estado, cota: fh(100, Date.now() + 10 * 60_000) },
    });

    const ordem = [semReset, liberando].sort(comparaContas).map((c) => c.id);
    // semReset (bucket 2) fica ABAIXO do liberando (bucket 1): sem hora de
    // reset não dá para dizer que está liberando em breve.
    expect(ordem).toEqual(["liberando", "sem-reset"]);
  });
});
