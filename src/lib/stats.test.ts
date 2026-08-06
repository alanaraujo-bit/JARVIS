import { describe, expect, it } from "vitest";

import type { SessionInfo } from "./ipc";
import {
  COTA_ALERTA_PCT,
  computeStats,
  estadoCota,
  formatBytes,
  formatCountdown,
  formatDuration,
  formatFaltaSegundos,
  formatResetAbsoluto,
  pctDeUso,
  tomCota,
} from "./stats";

function sessao(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "PowerShell",
    program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: [],
    cwd: "C:\\",
    cols: 80,
    rows: 24,
    profileId: "pwsh7",
    pid: 100,
    startedAt: 1_000,
    alive: true,
    exitCode: null,
    bytesOut: 0,
    bytesIn: 0,
    jobbed: true,
    ...patch,
  };
}

describe("computeStats", () => {
  it("soma os contadores de todas as sessões, vivas ou mortas", () => {
    const s = computeStats([
      sessao({ id: "a", bytesOut: 100, bytesIn: 10 }),
      sessao({ id: "b", bytesOut: 50, bytesIn: 5, alive: false }),
    ]);
    expect(s.totalSessions).toBe(2);
    expect(s.aliveSessions).toBe(1);
    expect(s.bytesOut).toBe(150);
    expect(s.bytesIn).toBe(15);
  });

  it("mede o tempo ativo só das sessões vivas", () => {
    const s = computeStats(
      [
        sessao({ id: "viva", startedAt: 1_000 }),
        // Mais antiga, mas morta: não deve ganhar o "maior tempo ativo".
        sessao({ id: "morta", startedAt: 0, alive: false }),
      ],
      11_000,
    );
    expect(s.longestUptimeMs).toBe(10_000);
  });

  it("não produz tempo ativo negativo se o relógio andou para trás", () => {
    const s = computeStats([sessao({ startedAt: 50_000 })], 10_000);
    expect(s.longestUptimeMs).toBe(0);
  });

  it("agrupa por perfil e ordena do mais usado para o menos", () => {
    const s = computeStats([
      sessao({ id: "a", profileId: "pwsh7", bytesOut: 10 }),
      sessao({ id: "b", profileId: "pwsh7", bytesOut: 10 }),
      sessao({ id: "c", profileId: "gitbash", bytesOut: 90 }),
    ]);
    expect(s.byShell.map((g) => g.label)).toEqual(["pwsh7", "gitbash"]);
    expect(s.byShell[0].sessions).toBe(2);
    expect(s.byShell[1].bytesOut).toBe(90);
  });

  it("cai no nome do executável quando a sessão não tem perfil", () => {
    const s = computeStats([sessao({ profileId: null })]);
    expect(s.byShell[0].label).toBe("pwsh.exe");
  });

  it("devolve zeros sem sessão nenhuma", () => {
    const s = computeStats([]);
    expect(s).toMatchObject({ totalSessions: 0, aliveSessions: 0, longestUptimeMs: 0 });
    expect(s.byShell).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("mostra bytes crus abaixo de 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("sobe de unidade e larga a casa decimal quando o número cresce", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 20)).toBe("20 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("não quebra com entrada inválida", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("escolhe a maior unidade que ainda faz sentido", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1min");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_600_000 + 14 * 60_000)).toBe("1h 14min");
  });
});

describe("formatCountdown", () => {
  it("arredonda para cima para nunca prometer um reset que ainda não chegou", () => {
    // 181min e 1s arredonda para cima: 182min (3h 2min), nunca 3h.
    expect(formatCountdown(3 * 3_600_000 + 61_000, 0)).toBe("3h 2min");
    expect(formatCountdown(3_600_000, 0)).toBe("1h");
    expect(formatCountdown(45_001, 0)).toBe("1min");
  });

  it("abaixo de uma hora mostra só minutos (60min vira 1h, como o formatDuration)", () => {
    expect(formatCountdown(3_600_000 - 1, 0)).toBe("1h");
    expect(formatCountdown(90_000, 0)).toBe("2min");
  });

  it("janela vencida ou inválida vira 'agora'", () => {
    expect(formatCountdown(10_000, 50_000)).toBe("agora");
    expect(formatCountdown(0, 0)).toBe("agora");
    expect(formatCountdown(NaN, 0)).toBe("agora");
  });
});

describe("tomCota", () => {
  it("acende o alerta só a partir do limite", () => {
    expect(tomCota(79.9)).toBe("atencao");
    expect(tomCota(COTA_ALERTA_PCT)).toBe("alta");
    expect(tomCota(100)).toBe("alta");
  });

  it("passa por atenção antes do alerta", () => {
    expect(tomCota(0)).toBe("ok");
    expect(tomCota(59.9)).toBe("ok");
    expect(tomCota(60)).toBe("atencao");
  });
});

describe("formatFaltaSegundos", () => {
  it("mostra segundos — a precisão que o painel aberto precisa", () => {
    expect(formatFaltaSegundos(45_000, 0)).toBe("45s");
    expect(formatFaltaSegundos(90_000, 0)).toBe("1min 30s");
    expect(formatFaltaSegundos(3_600_000 + 14 * 60_000 + 58_000, 0)).toBe("1h 14min 58s");
  });

  it("acima de um dia larga os segundos e mostra dias e horas", () => {
    expect(formatFaltaSegundos(5 * 86_400_000 + 14 * 3_600_000, 0)).toBe("5d 14h");
    // Sem horas quebradas, "2d" — nunca "2d 0h".
    expect(formatFaltaSegundos(2 * 86_400_000, 0)).toBe("2d");
  });

  it("janela vencida ou inválida vira 'agora'", () => {
    expect(formatFaltaSegundos(10_000, 50_000)).toBe("agora");
    expect(formatFaltaSegundos(NaN, 0)).toBe("agora");
  });
});

describe("formatResetAbsoluto", () => {
  // Meio-dia de 06/08/2026 (quinta), horário local da máquina de teste.
  const agora = new Date(2026, 7, 6, 12, 0).getTime();

  it("diz 'hoje' quando o reset é no mesmo dia", () => {
    expect(formatResetAbsoluto(new Date(2026, 7, 6, 15, 19).getTime(), agora)).toBe(
      "hoje às 15:19",
    );
  });

  it("diz 'amanhã' no dia seguinte", () => {
    expect(formatResetAbsoluto(new Date(2026, 7, 7, 0, 59).getTime(), agora)).toBe(
      "amanhã às 00:59",
    );
  });

  it("mostra a data para resets mais distantes, com ano só se mudar", () => {
    expect(formatResetAbsoluto(new Date(2026, 7, 12, 3, 59).getTime(), agora)).toBe(
      "12/08 às 03:59",
    );
    expect(formatResetAbsoluto(new Date(2027, 0, 2, 8, 0).getTime(), agora)).toBe(
      "02/01/2027 às 08:00",
    );
  });

  it("timestamp inválido vira travessão", () => {
    expect(formatResetAbsoluto(NaN, agora)).toBe("—");
  });
});

describe("estadoCota", () => {
  it("100% é 'Esgotada', não 'Quase no limite'", () => {
    expect(estadoCota(100)).toEqual({ tom: "alta", rotulo: "Esgotada" });
  });

  it("cobre as três faixas com os rótulos certos", () => {
    expect(estadoCota(0)).toEqual({ tom: "ok", rotulo: "Folga" });
    expect(estadoCota(70)).toEqual({ tom: "atencao", rotulo: "Atenção" });
    expect(estadoCota(85)).toEqual({ tom: "alta", rotulo: "Quase no limite" });
  });
});

describe("pctDeUso", () => {
  it("divide usado pelo limite e prende em 0–100", () => {
    expect(pctDeUso(25, 100)).toBe(25);
    expect(pctDeUso(150, 100)).toBe(100);
    expect(pctDeUso(-5, 100)).toBe(0);
  });

  it("limite inválido ou zero vira 0", () => {
    expect(pctDeUso(10, 0)).toBe(0);
    expect(pctDeUso(10, NaN)).toBe(0);
  });
});
